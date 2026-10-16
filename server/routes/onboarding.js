// Intent-onboarding routes (openspec: intent-onboarding). Self-service: the
// questionnaire's answers, the provisioning plan the user confirms, and the
// activation that runs it. Mounted from misc.js next to the roles/layout
// routes; every path is scoped to the REQUESTING identity (the preference
// table is per-cell, and a cell can host several identities).
//
// The role write goes through the same assignment storage the admin surface
// uses (role-system), with one hard rule the self channel enforces: it writes
// business roles only and preserves the existing admin flag verbatim — a
// self-service answer is never a privilege escalation.

import * as packStore from "../../pack-store.js";
import { fetchLatestPackVersion } from "../pack-manifest-source.js";
import { readyRoles } from "../../packages/core/src/lib/recipes.ts";
import {
  buildPlan,
  effectiveIntent,
  needsQuestionnaire,
  selfAssignment,
  validateAnswers,
  writeIntent,
} from "../onboarding.js";
import { parseStoredAssignments, resolveAssignment } from "../roles.js";

export function registerOnboardingRoutes(ctx) {
  const { app, db, broadcast } = ctx;

  const emailOf = (req) => req.user?.email ?? null;

  // The assignment document writer (same key the role routes use).
  const readDoc = () => (db.isDbReady() ? parseStoredAssignments(db.getDeploymentConfig("roles.assignments")) : null);
  const writeAssignment = (email, assignment) => {
    const doc = readDoc() ?? { assignments: {}, default: null };
    const normalized = String(email || "").trim().toLowerCase();
    const neutral = assignment.primary === "standard" && !assignment.secondary.length && !assignment.admin;
    if (neutral) delete doc.assignments[normalized];
    else doc.assignments[normalized] = assignment;
    db.setDeploymentConfig("roles.assignments", JSON.stringify(doc));
  };

  const planFor = (role) =>
    buildPlan({
      role,
      installed: db.isDbReady() ? db.listInstalledPacks().map((p) => p.packId) : [],
      marketplaceOff: process.env.PACK_MARKETPLACE !== "1",
    });

  // Profile read: what the questionnaire should render, plus the ready-role
  // list (the server decides readiness — the client never guesses).
  app.get("/api/onboarding/profile", (req, res) => {
    const intent = effectiveIntent({ db, email: emailOf(req) });
    res.json({
      profile: {
        roles: intent.roles,
        note: intent.note,
        skipped: intent.skipped,
        answeredAt: intent.answeredAt,
        source: intent.source,
      },
      needsQuestionnaire: needsQuestionnaire({ db, email: emailOf(req) }),
      readyRoles: readyRoles(),
    });
  });

  // Answers: profile + role assignments in ONE write. Returns the provisioning
  // plan so the confirmation list the user sees is exactly what would run.
  app.post("/api/onboarding/answers", (req, res) => {
    if (!db.isDbReady()) return res.status(503).json({ error: "Database unavailable" });
    const result = validateAnswers(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    const email = emailOf(req);
    if (!email) return res.status(400).json({ error: "No identity on the request" });

    const current = resolveAssignment({ user: { email }, db });
    const profile = {
      roles: result.value.roles,
      note: result.value.note,
      skipped: result.value.skipped,
      answeredAt: new Date().toISOString(),
    };

    if (!profile.skipped) {
      const assignment = selfAssignment(profile.roles, current);
      // Atomicity: both writes touch the same SQLite handle sequentially; a
      // throw between them would leave the profile answered but the roles
      // stale, so the assignment lands FIRST (it is the load-bearing half) and
      // the profile write is the cheap confirmation.
      writeAssignment(email, assignment);
      writeIntent({ db, email }, profile);
    } else {
      writeIntent({ db, email }, profile);
    }

    const primary = result.value.skipped ? current.primary : result.value.roles[0];
    res.json({
      profile,
      assignment: resolveAssignment({ user: { email }, db }),
      plan: result.value.skipped ? null : planFor(primary),
    });
  });

  // Activation: install the recipe's packs (idempotent), select the recipe's
  // default expert, and report each item's outcome. Add-only: nothing is ever
  // uninstalled, and re-activation with unchanged answers changes nothing.
  app.post("/api/onboarding/provision", async (req, res) => {
    if (!db.isDbReady()) return res.status(503).json({ error: "Database unavailable" });
    const email = emailOf(req);
    if (!email) return res.status(400).json({ error: "No identity on the request" });

    const intent = effectiveIntent({ db, email });
    const role = intent.roles[0];
    if (!role) return res.status(400).json({ error: "Answer the questionnaire first" });
    const plan = planFor(role);
    if (!plan) return res.status(400).json({ error: `No recipe for role '${role}'` });

    const viewer = req.user ?? (ctx.authEnabled ? null : { email: ctx.cellUserEmail || "owner@local", groups: [] });
    const results = [];

    for (const item of plan.packs) {
      if (item.status === "installed") {
        results.push({ packId: item.packId, status: "already-installed" });
        continue;
      }
      try {
        const { version, manifest } = await fetchLatestPackVersion({
          packId: item.packId,
          viewer,
          localMarket: ctx.localPackMarket ?? null,
        });
        await packStore.installPack({
          packId: item.packId,
          version,
          manifest,
          user: req.user,
          // Server-driven installs carry no interactive acknowledgment; a
          // script-bearing pack answers "script-confirm-required" and is
          // reported as such rather than forced through (the user can install
          // it from the market dialog with the explicit confirm).
          confirm: false,
          hooks: {
            onMcpChanged: () => {
              broadcast({ type: "extensions_changed", resource: "mcp", action: "pack-install", name: manifest?.name || item.packId });
              ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined).catch((e) =>
                console.warn(`[onboarding] dsh MCP update failed: ${e.message}`),
              );
            },
            onCatalogChanged: () => {
              broadcast({ type: "catalog_changed" });
              void ctx.syncCatalogAgentPresets?.();
            },
          },
        });
        results.push({ packId: item.packId, status: "installed", version });
      } catch (err) {
        // One failing item never blocks the rest (design D5).
        results.push({
          packId: item.packId,
          status: "failed",
          error: err?.message || String(err),
          ...(err?.code ? { code: err.code } : {}),
        });
      }
    }

    if (results.some((r) => r.status === "installed")) {
      await ctx.dshUpdateSkills?.().catch((e) => console.warn(`[onboarding] skills patch update failed: ${e.message}`));
    }

    // Default expert last: the packs' personas must exist before the selection
    // names one. `switchAgent` owns the restart + persistence; a failure here
    // is reported, never fatal to the installs that already landed.
    let expert = { status: "skipped" };
    if (plan.defaultExpert) {
      try {
        const switched = await ctx.switchAgentTo?.(plan.defaultExpert, null);
        expert = switched === false ? { status: "failed" } : { status: "selected", id: plan.defaultExpert };
      } catch (err) {
        expert = { status: "failed", error: err?.message || String(err) };
      }
    }

    res.json({ role, results, expert, layoutPreset: plan.layoutPreset });
  });
}
