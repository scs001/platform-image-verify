// connections.spec.js — settings-connect-center acceptance: the aggregated
// /api/connections projection, the connections section surface, and the
// retired websearch deep link resolving into it.

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { pinLocaleEn, tempDbPath } from "./helpers.js";

test.describe("GET /api/connections", () => {
  test("projects every connection with state only — no credential material", async ({ request }) => {
    const res = await request.get("/api/connections");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.connections)).toBeTruthy();

    const ids = body.connections.map((c) => c.id);
    // One entry per connect card / line row, plus search.
    for (const id of [
      "registry",
      "facet-market",
      "connector",
      "line-wire-customer",
      "line-lex",
      "ciyuan-account",
      "paper-trading",
      "search",
    ]) {
      expect(ids).toContain(id);
    }

    // Fresh hermetic store: nothing connected yet. Whitelist projection: the
    // four state fields only (search additionally carries userKey/shared; the
    // connector entry carries the binding projection added by
    // add-connector-bindings 6.1 — still states only, no credential material).
    for (const c of body.connections) {
      expect(["connected", "stale", "disconnected", "not-configured"]).toContain(c.state);
      if (c.id === "connector") {
        expect(Object.keys(c).sort()).toEqual(["bindingSummary", "bindings", "id", "name", "reason", "state"]);
      } else if (c.id !== "search") {
        expect(Object.keys(c).sort()).toEqual(["id", "name", "reason", "state"]);
      }
    }
    // No credential material anywhere in the payload, at any nesting.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/sk-|fdt_|oct_|Bearer\s|eyJ[A-Za-z0-9_-]{10,}/);
  });
});

test.describe("connections section", () => {
  test("renders glossary and every connect card; panel deep link highlights", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/connections");
    await expect(page.getByTestId("settings-section-connections")).toBeVisible();

    // Brand quick-reference: collapsed by default, expands in place.
    const glossary = page.getByTestId("connections-glossary");
    await expect(glossary).toBeVisible();
    await expect(glossary.getByTestId("connections-glossary").locator("dl")).toBeHidden();
    await glossary.locator("summary").click();
    await expect(glossary.locator("dl")).toBeVisible();

    // The connect cards moved here from the extensions market tab.
    await expect(page.getByTestId("registry-connect-panel")).toBeVisible();
    await expect(page.getByTestId("search-service-card")).toBeVisible();

    // Panel deep link scrolls to and marks the search card.
    await page.goto("/settings/connections?panel=search");
    await expect(page.getByTestId("search-service-card")).toBeVisible();
    const anchor = page.locator("[data-panel='search']");
    await expect(anchor).toHaveAttribute("data-panel-active", "true");

    // Unknown panel degrades gracefully.
    await page.goto("/settings/connections?panel=nonsense");
    await expect(page.getByTestId("settings-section-connections")).toBeVisible();
    await expect(page.locator("[data-panel-active='true']")).toHaveCount(0);
  });

  test("the scope pointer's panel id lands on the connector card", async ({ page }) => {
    // chat-connect-guidance 6.3 points scope gaps at `connector-bindings`
    // (credential-refs' panel map) while the card's own anchor is `connector`.
    // Both must resolve, or the "grant this" CTA opens the page and highlights
    // nothing.
    await pinLocaleEn(page);
    await page.goto("/settings/connections?panel=connector-bindings");
    await expect(page.getByTestId("connector-connect-panel")).toBeVisible();
    await expect(page.locator("[data-panel='connector']")).toHaveAttribute("data-panel-active", "true");
  });

  test("retired /settings/websearch redirects to the connections search panel", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/websearch");
    await expect(page).toHaveURL(/\/settings\/connections\?panel=search$/);
    await expect(page.getByTestId("search-service-card")).toBeVisible();
    // The BYOK zone moved verbatim (same testids as the former section).
    await expect(page.getByTestId("websearch-byok")).toBeVisible();
  });

  test("market tab is a pure shelf — no connect cards", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/mcp?tab=market");
    await expect(page.getByTestId("mcp-market-section")).toBeVisible();
    await expect(page.getByTestId("registry-connect-panel")).toHaveCount(0);
    await expect(page.getByTestId("connector-connect-panel")).toHaveCount(0);
  });
});

// ── Binding view (add-connector-bindings 6.2) ────────────────────────────────
//
// The connector card leads with what the installed packs declare, and renders
// the ledger's four states as themselves. Seeded straight into the run's
// SQLite: the ledger is written by the install/grant flows, which this test is
// not about — here it is the rendering contract that is under test.

// Auth is off in the e2e run, so /api/connections answers for the machine-owner
// identity (registry-credentials ownerKey).
const OWNER = "machine-owner";

function seedLedger(rows) {
  // Migrations apply after the server starts answering, so wait for the table
  // instead of racing it (same reason as artifact-delivery.spec.js).
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = new Database(tempDbPath());
    try {
      const ready = probe
        .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'connector_binding_ledger'")
        .get().c;
      if (ready === 1) {
        const now = new Date().toISOString();
        const insert = probe.prepare(
          `INSERT OR REPLACE INTO connector_binding_ledger
             (email, pack_id, pack_version, binding_key, provider, operations,
              connection_id, status, optional, granted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const r of rows) {
          insert.run(OWNER, r.packId, "1", r.key, r.provider, JSON.stringify(r.operations), r.connectionId ?? null, r.status, r.optional ? 1 : 0, r.grantedAt ?? null, now);
        }
        return;
      }
    } finally {
      probe.close();
    }
    if (Date.now() > deadline) throw new Error("connector_binding_ledger never appeared");
  }
}

// A live binding token. `granted` in the projection is asked of the credential,
// not inferred from the ledger, so the revoke action only exists when this row
// does — seeding the ledger alone would prove nothing about it.
function seedBindingToken(packId, bindingKey, token) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = new Database(tempDbPath());
    try {
      const ready = probe
        .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'user_connector_credentials'")
        .get().c;
      if (ready === 1) {
        probe
          .prepare(
            `INSERT OR REPLACE INTO user_connector_credentials
               (email, kind, slot, token, pat_id, purpose, source_account, stale, active, updated_at)
             VALUES (?, 'binding', ?, ?, NULL, ?, NULL, 0, 0, ?)`,
          )
          .run(OWNER, `${packId}:${bindingKey}`, token, `e2e/${bindingKey}`, new Date().toISOString());
        return;
      }
    } finally {
      probe.close();
    }
    if (Date.now() > deadline) throw new Error("user_connector_credentials never appeared");
  }
}

// The console's address comes from the deployment baseline (mcp.json), which the
// hermetic e2e store does not have. Add one so the connect/reconnect links have
// somewhere real to point — the same row production carries.
function seedConnectorBaseline(origin) {
  const mcpPath = path.join(path.dirname(tempDbPath()), "mcp.json");
  const current = fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, "utf8")) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.connector = { url: `${origin}/mcp`, credentialRef: "connector" };
  fs.writeFileSync(mcpPath, JSON.stringify(current, null, 2));
}

test.describe("connector binding view", () => {
  test("four states render distinctly; unwired reads as a capability gap; account area stays", async ({ page }) => {
    seedConnectorBaseline("https://connector.e2e.test");
    seedLedger([
      // Granted: a live token exists, so the row offers revoke + shows when.
      { packId: "pack-e2e", key: "kingdee", provider: "kingdee", operations: ["read", "write"], status: "satisfied", optional: false, connectionId: "conn-e2e", grantedAt: "2026-11-01T00:00:00.000Z" },
      // Satisfied but never granted: the one-click grant is what is missing.
      { packId: "pack-e2e", key: "alipay", provider: "alipay", operations: ["read"], status: "satisfied", optional: false, connectionId: "conn-al" },
      { packId: "pack-e2e", key: "wms", provider: "wms", operations: ["read"], status: "missing", optional: false },
      { packId: "pack-e2e", key: "erp-legacy", provider: "erp-legacy", operations: ["read"], status: "stale", optional: false },
      { packId: "pack-e2e", key: "carrier", provider: "carrier", operations: ["read"], status: "unwired", optional: true },
      // A key the pack no longer declares: history, not a requirement.
      { packId: "pack-e2e", key: "gone", provider: "gone", operations: ["read"], status: "deprecated", optional: false },
    ]);
    seedBindingToken("pack-e2e", "kingdee", "oct_e2e_kingdee");

    await pinLocaleEn(page);
    await page.goto("/settings/connections");
    const view = page.getByTestId("connector-bindings-view");
    await expect(view).toBeVisible();

    // Summary excludes the deprecated row: 1 pack, 5 live bindings, 2 the user
    // owes (missing + stale; the unwired one is optional), 1 capability gap.
    await expect(page.getByTestId("connector-bindings-summary")).toHaveText(
      "1 packs · 5 bindings · 2 to resolve · 1 capability gaps",
    );

    const row = (key) => page.locator(`[data-testid='connector-binding-row'][data-binding-key='${key}']`);
    await expect(row("kingdee")).toHaveAttribute("data-state", "satisfied");
    await expect(row("kingdee").getByTestId("connector-binding-state")).toHaveText("Connected");
    await expect(row("wms")).toHaveAttribute("data-state", "missing");
    await expect(row("wms").getByTestId("connector-binding-state")).toHaveText("Not connected");
    await expect(row("erp-legacy")).toHaveAttribute("data-state", "stale");
    await expect(row("erp-legacy").getByTestId("connector-binding-state")).toHaveText("Expired");
    await expect(row("carrier")).toHaveAttribute("data-state", "unwired");
    await expect(row("carrier").getByTestId("connector-binding-state")).toHaveText("Capability gap");
    await expect(row("carrier").getByTestId("connector-binding-optional")).toBeVisible();

    // `unwired` never degrades to `missing`, and it explains itself: no account
    // closes a catalog gap, so the hint must say so rather than send the user to
    // the connect button.
    await expect(page.getByTestId("connector-bindings-unwired-hint")).toBeVisible();
    await expect(row("wms").getByTestId("connector-binding-state")).not.toHaveText("Capability gap");

    await expect(page.locator("[data-testid='connector-binding-row'][data-binding-key='gone']")).toHaveCount(0);

    // ── The one action each row offers (6.2) ────────────────────────────────
    const action = (key) => row(key).getByTestId("connector-binding-action");

    // Granted: revoke, plus when it was granted.
    await expect(row("kingdee")).toHaveAttribute("data-granted", "1");
    await expect(action("kingdee")).toHaveAttribute("data-action", "revoke");
    await expect(action("kingdee")).toHaveText("Revoke access");
    await expect(row("kingdee").getByTestId("connector-binding-granted-at")).toBeVisible();

    // Satisfied but never granted: the missing step is the grant itself.
    await expect(row("alipay")).toHaveAttribute("data-granted", "0");
    await expect(action("alipay")).toHaveAttribute("data-action", "grant");
    await expect(action("alipay")).toHaveText("Grant access");

    // A dead or absent connection is repaired in the connector console; both
    // point at the baseline origin's /me shell.
    await expect(action("wms")).toHaveAttribute("data-action", "connect");
    await expect(action("wms")).toHaveAttribute("href", "https://connector.e2e.test/me");
    await expect(action("erp-legacy")).toHaveAttribute("data-action", "reconnect");
    await expect(action("erp-legacy")).toHaveAttribute("href", "https://connector.e2e.test/me");

    // No gesture closes a catalog gap, and an outage is not a todo: neither row
    // offers an action at all (a dead button would be worse than none).
    await expect(row("carrier").getByTestId("connector-binding-action")).toHaveCount(0);

    // Bindings lead, the account area follows — and the manual-paste fallback
    // (always available, console link needs a baseline connector row) is intact.
    await expect(page.getByTestId("connector-connect-panel")).toBeVisible();
    await expect(page.getByTestId("connector-paste-toggle")).toBeVisible();
  });
});
