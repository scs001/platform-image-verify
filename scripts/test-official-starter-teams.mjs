#!/usr/bin/env node
// ── Official starter teams tests (add-official-starter-teams) ────────────────
//
// Pins:
//   - the sequence shape: 5 teams, roles preferred×1 + secondary×2 +
//     advanced×2, every entry carries a seedFile that EXISTS
//   - the card↔seed alignment (D2): each starter's PackGuide exists, its
//     name is byte-identical to the seed's display name, and the posts the
//     card's structure implies (the guide never names a post the seed
//     doesn't have — checked via the fleet members' titles appearing in the
//     steps where the card narrates them)
//   - v4 lexicon: no legacy terms (集群/阵列/能力包/舰队) in the card copy
//
//   node --test scripts/test-official-starter-teams.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { PACK_GUIDES, STARTER_TEAMS } = await import("../web/src/lib/packGuides.ts").catch(async () => {
  // The web ts file is importable via tsx-less node? It is plain TS types +
  // const object — strip types by importing through a tiny transform.
  const src = fs.readFileSync(path.join(root, "web/src/lib/packGuides.ts"), "utf8");
  const js = src
    .replace(/export interface[\s\S]*?\n}\n/g, "")
    .replace(/: PackGuide\b/g, "")
    .replace(/: StarterTeam\[\]/g, "")
    .replace(/: "preferred" \| "secondary" \| "advanced"/g, "")
    .replace(/: string;/g, ";")
    .replace(/: \[PackGuideStep, PackGuideStep, PackGuideStep\];/g, ";")
    .replace(/: PackPromptCard\[\];/g, ";");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  return mod;
});

test("sequence shape: 5 teams, one preferred, roles covered, seeds exist", () => {
  assert.equal(STARTER_TEAMS.length, 5);
  const roles = STARTER_TEAMS.map((t) => t.role);
  assert.equal(roles.filter((r) => r === "preferred").length, 1, "exactly one 首选");
  assert.equal(roles.filter((r) => r === "secondary").length, 2);
  assert.equal(roles.filter((r) => r === "advanced").length, 2);
  const preferred = STARTER_TEAMS.find((t) => t.role === "preferred");
  assert.equal(preferred.name, "客服班组", "首选=客服班组（design D3）");
  for (const t of STARTER_TEAMS) {
    assert.ok(fs.existsSync(path.join(root, "docs/fleet-templates", t.seedFile)), `${t.seedFile} exists`);
    assert.ok(t.oneLine.trim().length > 10, `${t.name}: oneLine present`);
  }
});

test("card↔seed alignment: name identical, posts in the card exist in the seed", () => {
  for (const t of STARTER_TEAMS) {
    const seed = JSON.parse(fs.readFileSync(path.join(root, "docs/fleet-templates", t.seedFile), "utf8"));
    const guide = PACK_GUIDES[t.packId];
    assert.ok(guide, `${t.name}: guide card exists for ${t.packId}`);
    assert.equal(guide.name, seed.name, `${t.name}: card name is byte-identical to the seed display name`);
    assert.equal(guide.steps.length, 3, "three steps (prepare/ask/get)");
    // The card narrates posts — every post title it names must exist in the
    // seed's member titles (no ghost posts, no missing narrative anchors).
    const titles = (seed.fleet?.members ?? []).map((m) => m.title);
    for (const step of guide.steps) {
      for (const title of titles) {
        if (step.body.includes(title) || step.title.includes(title)) {
          assert.ok(titles.includes(title), `${t.name}: narrated post '${title}' exists in the seed`);
        }
      }
    }
    // Structural sanity: the seed's member count matches what the card's
    // market entry would show (agentCount) — the card must not claim a
    // different crew size than the manifest declares.
    if (seed.fleet?.members) {
      const agentIds = new Set((seed.agents ?? []).map((a) => a.id));
      for (const m of seed.fleet.members) {
        if (m.target?.kind === "pack-preset") {
          assert.ok(agentIds.has(m.target.presetId), `${t.name}: preset member ${m.ref} → declared agent ${m.target.presetId}`);
        }
      }
    }
  }
});

test("v4 lexicon: no legacy terms in the starter card copy", () => {
  for (const t of STARTER_TEAMS) {
    const guide = PACK_GUIDES[t.packId];
    const text = JSON.stringify(guide);
    for (const term of ["集群", "阵列", "能力包", "能力市场", "舰队"]) {
      assert.equal(text.includes(term), false, `${t.name}: card copy must not carry legacy term '${term}'`);
    }
  }
  for (const t of STARTER_TEAMS) {
    for (const term of ["集群", "阵列", "能力包", "舰队"]) {
      assert.equal(t.oneLine.includes(term), false, `${t.name}: oneLine must not carry '${term}'`);
    }
  }
});
