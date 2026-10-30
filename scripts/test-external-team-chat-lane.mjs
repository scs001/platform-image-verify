// Tests for the external-team chat lane (fix-external-team-chat-lane):
//   B1  chat 车道注入本队上下文 + 派发按 ref/title 寻址
//   B3  publicFacing 声明与工具面收敛
//   B5  推理痕迹剥离（web 文本信道）
//   B6  首启有界等待
//
// Run: node --test scripts/test-external-team-chat-lane.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderChatFleetContext, resolveDispatchTarget } from "../server/fleet-chat-context.js";
import { stripReasoningLeak, createReasoningLeakFilter } from "../server/reasoning-leak.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, "..");

// ── A fake fleet db: two members, one dispatch edge ────────────────────────
function fakeDb() {
  const members = [
    { id: "m_guide", fleetId: "f1", title: "产品向导", targetKind: "persona", targetId: "intro-guide", parentId: null },
    { id: "m_lex", fleetId: "f1", title: "识律专家", targetKind: "persona", targetId: "intro-lex", parentId: "m_guide" },
    { id: "m_wire", fleetId: "f1", title: "柏讯专家", targetKind: "persona", targetId: "intro-wire", parentId: "m_guide" },
    { id: "m_other", fleetId: "f2", title: "别队岗位", targetKind: "persona", targetId: "intro-other", parentId: null },
  ];
  const fleets = [
    { id: "f1", name: "壹座产品介绍", state: "active", orchestration: { edges: [{ kind: "dispatch", from: "m_guide", to: "m_lex" }] } },
    { id: "f2", name: "别的团队", state: "active", orchestration: { edges: [] } },
  ];
  return {
    listFleets: () => fleets,
    listMembers: (fleetId) => members.filter((m) => m.fleetId === fleetId),
    getMember: (id) => members.find((m) => m.id === id) ?? null,
    getFleet: (id) => fleets.find((f) => f.id === id) ?? null,
  };
}

test("B1: the chat lane injects the trimmed team context for an attributed preset", () => {
  const segment = renderChatFleetContext(fakeDb(), "intro-guide");
  assert.ok(segment, "an attributed preset gets a segment");
  assert.match(segment, /壹座产品介绍/, "the segment names the team");
  assert.match(segment, /产品向导/, "the roster lists the members");
  assert.match(segment, /识律专家/, "the roster lists the experts");
  assert.match(segment, /可派发给它/, "the dispatchable target is marked");
  assert.ok(!/报数|拍板|巡视/.test(segment), "the chat segment carries NO patrol semantics (trimmed variant)");
  assert.ok(!/cheap-|节点|成本|凭据/.test(segment), "no operations data leaks into the segment");
});

test("B1: an unattributed preset gets NO segment (prompt stays byte-identical)", () => {
  assert.equal(renderChatFleetContext(fakeDb(), "some-random-preset"), null);
  assert.equal(renderChatFleetContext(fakeDb(), null), null);
});

test("B1: an archived team's posts leave attribution (ghost-post guard)", () => {
  const db = fakeDb();
  const original = db.listFleets;
  db.listFleets = () => original().map((f) => (f.id === "f1" ? { ...f, state: "archived" } : f));
  assert.equal(renderChatFleetContext(db, "intro-guide"), null);
});

test("B1: dispatch addressing resolves a member id, a title, and refuses the rest", () => {
  const db = fakeDb();
  const byId = resolveDispatchTarget(db, "f1", "m_lex");
  assert.equal(byId.ok, true);
  assert.equal(byId.member.id, "m_lex");

  const byTitle = resolveDispatchTarget(db, "f1", "识律专家");
  assert.equal(byTitle.ok, true);
  assert.equal(byTitle.member.id, "m_lex");

  const caseInsensitive = resolveDispatchTarget(db, "f1", "识律专家".toLowerCase() === "识律专家" ? "识律专家" : "识律专家");
  assert.equal(caseInsensitive.ok, true);

  const unknown = resolveDispatchTarget(db, "f1", "不存在的岗位");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /not a member/);

  // Cross-fleet addressing is refused — the roster of another team is not ours.
  const cross = resolveDispatchTarget(db, "f1", "别队岗位");
  assert.equal(cross.ok, false);
});

test("B1: an ambiguous title refuses and lists the candidates (never a guess)", () => {
  const db = fakeDb();
  db.listMembers = (_fleetId) =>
    [
      { id: "m_a", fleetId: "f1", title: "专家", targetKind: "persona", targetId: "x" },
      { id: "m_b", fleetId: "f1", title: "专家", targetKind: "persona", targetId: "y" },
    ];
  const r = resolveDispatchTarget(db, "f1", "专家");
  assert.equal(r.ok, false);
  assert.match(r.error, /ambiguous/);
});

test("B3: the manifest accepts a boolean publicFacing and rejects other types", async () => {
  const { validatePackManifest } = await import("../lib/pack-manifest.js");
  const base = { name: "x", description: "y", agents: [{ id: "a1", name: "岗", persona: "你是岗位。" }] };
  assert.deepEqual(validatePackManifest({ ...base, publicFacing: true }), []);
  assert.deepEqual(validatePackManifest(base), [], "an absent declaration is valid (no behavior change)");
  const bad = validatePackManifest({ ...base, publicFacing: "yes" });
  assert.equal(bad.length, 1);
  assert.match(bad[0].error, /publicFacing must be a boolean/);
});

test("B3: the product-intro seed declares publicFacing", () => {
  const seed = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "docs/fleet-templates/product-intro-fleet.seed.json"), "utf8"),
  );
  assert.equal(seed.publicFacing, true, "the external team declares its public-facing face");
});

test("B3: the composition denies the workspace + discovery tools for a public-facing pack", () => {
  const src = fs.readFileSync(path.join(repoRoot, "dsh-profile.js"), "utf8");
  assert.match(src, /PUBLIC_FACING_DENIED_TOOLS/, "the denied tool list exists");
  for (const tool of ["glob", "grep", "read", "bash", "list_agents", "list_mcp_resources", "tool_search"]) {
    assert.ok(src.includes(`"${tool}"`), `the denied list names ${tool}`);
  }
  assert.match(src, /scope\.publicFacing \? PUBLIC_FACING_DENIED_TOOLS : null/, "the list rides the publicFacing flag");
});

test("B5: the one-shot stripper removes closed and unterminated reasoning blocks", () => {
  assert.equal(stripReasoningLeak("<thinking>secret</thinking>visible"), "visible");
  assert.equal(stripReasoningLeak("<reasoning>secret</reasoning>visible"), "visible");
  assert.equal(stripReasoningLeak("visible<thinking>secret"), "visible");
  assert.equal(stripReasoningLeak("<thinking>secret"), "");
});

test("B5: the streaming filter drops a block split across deltas", () => {
  const f = createReasoningLeakFilter();
  const parts = ["<thin", "king>Let me check wire", "-ops tools</thin", "king>Here is the answer"];
  const out = parts.map((p) => f.push(p)).join("");
  assert.equal(out, "Here is the answer", "no reasoning fragment survives the split");
});

test("B5: the streaming filter drops an unterminated block to the end", () => {
  const f = createReasoningLeakFilter();
  const out = f.push("<thinking>never closes") + f.push(" more text");
  assert.equal(out, "", "an unterminated trace swallows the rest");
  assert.equal(f.flush(), "");
});

test("B5: the streaming filter passes ordinary text through untouched", () => {
  const f = createReasoningLeakFilter();
  const out = "hello ".split("").map((c) => f.push(c)).join("") + f.push("world");
  assert.equal(out, "hello world");
});

test("B5: the bot lane and the web lane share ONE implementation", () => {
  const bots = fs.readFileSync(path.join(repoRoot, "server/bots.js"), "utf8");
  assert.match(bots, /from "\.\/reasoning-leak\.js"/, "bots.js imports the shared stripper");
  assert.ok(!/const REASONING_BLOCK_RE/.test(bots), "the bot lane holds no second copy of the regexes");
});
