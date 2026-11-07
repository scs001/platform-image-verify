// Unit tests for the cell-side cluster shared-memory lane
// (add-memory-scopes-and-cluster-sharing). Mock fetch — no fd-memory
// instance needed; the HTTP contract is pinned by fd-memory's own suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterMemoryFor, clusterProjectId } from "../server/cluster-memory.js";

function tmpData() {
  return mkdtempSync(join(tmpdir(), "cluster-mem-"));
}

function baseEnv(data, url = "http://memory.test") {
  return {
    CELL_MEMORY_ENABLED: "1",
    CELL_MEMORY_URL: url,
    CELL_MEMORY_PLATFORM_TOKEN: "plat",
    CELL_MEMORY_DATA: data,
  };
}

// A fetch impl that mints once and then serves /pages GET/POST.
function stubFetch(pages = [], writes = [], { failPages = false } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/admin/mint")) {
      return { ok: true, status: 200, json: async () => ({ token: "fdm_stub", id: "t1" }) };
    }
    if (u.includes("/pages") && !failPages) {
      if (init.method === "POST") {
        writes.push({ url: u, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ project: "c1", path: "c1/notes/x.md" }) };
      }
      return { ok: true, status: 200, json: async () => ({ project: "c1", pages }) };
    }
    if (u.includes("/pages") && failPages) return { ok: false, status: 503, json: async () => ({}) };
    throw new Error(`unexpected fetch ${u}`);
  };
}

test("clusterMemoryFor: config off or owner missing → null (hooks no-op)", async () => {
  const data = tmpData();
  try {
    assert.equal(await clusterMemoryFor({ CELL_MEMORY_ENABLED: "0" }, "o@x"), null);
    assert.equal(await clusterMemoryFor(baseEnv(data), null), null);
    assert.equal(await clusterMemoryFor(baseEnv(data), ""), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("clusterMemoryFor: mints the person token (cached) and reads/writes the cluster project", async () => {
  const data = tmpData();
  try {
    const fetches = [];
    const impl = async (url, init) => {
      fetches.push(String(url));
      return stubFetch([{ title: "首轮 digest", updated_at: "2026-10-22T01:00:00.000Z" }])(url, init);
    };
    const mem = await clusterMemoryFor(baseEnv(data), "owner@test.local", impl);
    assert.ok(mem, "client built");
    const pages = await mem.readShared("cluster-42");
    assert.equal(pages.length, 1);
    assert.equal(pages[0].title, "首轮 digest");
    assert.ok(fetches.some((u) => u.includes("/admin/mint")));
    assert.ok(fetches.some((u) => u.includes("/pages?project=cluster-42")));
    const writes = [];
    const wimpl = stubFetch([], writes);
    const mem2 = await clusterMemoryFor(baseEnv(data), "owner@test.local", wimpl);
    await mem2.writeDigest("cluster-42", "集群回合 t", "digest 正文");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.project, "cluster-42");
    assert.equal(writes[0].body.body, "digest 正文");
    // person token cache landed on disk (one mint per owner, restart-stable)
    assert.ok(existsSync(join(data, "cell-memory-tokens", "owner@test.local.json")));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("clusterMemoryFor: person token cache is honored — no second mint", async () => {
  const data = tmpData();
  try {
    mkdirSync(join(data, "cell-memory-tokens"), { recursive: true });
    writeFileSync(
      join(data, "cell-memory-tokens", "owner@test.local.json"),
      JSON.stringify({ token: "fdm_cached", namespace: "u/owner@test.local", mintedAt: "2026-10-22T00:00:00.000Z" }),
      { mode: 0o600 },
    );
    const fetches = [];
    const impl = async (url, init) => {
      fetches.push({ url: String(url), auth: init?.headers?.authorization ?? "" });
      return stubFetch([])(url, init);
    };
    const mem = await clusterMemoryFor(baseEnv(data), "owner@test.local", impl);
    await mem.readShared("c");
    assert.ok(!fetches.some((f) => f.url.includes("/admin/mint")), "cached token, no mint");
    assert.ok(fetches.some((f) => f.auth === "Bearer fdm_cached"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("clusterMemoryFor: mint failure → null (degrade open); read/write failures throw to the caller", async () => {
  const data = tmpData();
  try {
    const broken = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal(await clusterMemoryFor(baseEnv(data), "o@x", broken), null);
    const writes = [];
    const failing = stubFetch([], writes, { failPages: true });
    const mem = await clusterMemoryFor(baseEnv(data), "o@x", failing);
    await assert.rejects(() => mem.readShared("c"), /503/);
    await assert.rejects(() => mem.writeDigest("c", "t", "b"), /503/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("clusterProjectId: sanitized, path-safe, defaulted", () => {
  assert.equal(clusterProjectId("dyn_abc-1"), "dyn_abc-1");
  assert.equal(clusterProjectId("a/b\\c"), "a-b-c");
  assert.equal(clusterProjectId("  "), "cluster");
  assert.equal(clusterProjectId(null), "cluster");
});

// ── digest injection ladder (add-cluster-digest-injection) ──────────────────
import { memoryInjectionFor } from "../server/cluster-memory.js";

function ladderMemory({ digest = null, digestError = null, pages = [], pagesError = null } = {}) {
  return {
    async readDigest() {
      if (digestError) throw digestError;
      return digest;
    },
    async readShared() {
      if (pagesError) throw pagesError;
      return pages;
    },
  };
}

test("ladder: digest face wins — rendered block appended verbatim", async () => {
  const d = "## 记忆摘要 / Memory digest（fd-memory，截至 2026-10-25）\n\n### 相关记忆 / Related memory\n- 〔L2·experience｜置信 0.80｜2026-10-24〕集群巡检：先读 digest 再分派";
  const out = await memoryInjectionFor(ladderMemory({ digest: { digest: d } }), "c1", "本轮任务");
  assert.equal(out.source, "digest");
  assert.ok(out.prompt.startsWith("本轮任务\n\n## 记忆摘要"));
  assert.ok(!out.prompt.includes("【集群共享记忆】"), "digest block carries its own header, no legacy wrapper");
});

test("ladder: digest failure falls back to the exact historical title-list shape", async () => {
  const pages = [
    { title: "集群回合 2026-10-24 08:00", updated_at: "2026-10-24T00:00:00.000Z" },
    { title: "集群回合 2026-10-23 08:00", updated_at: "2026-10-23T00:00:00.000Z" },
  ];
  const out = await memoryInjectionFor(ladderMemory({ digestError: new Error("digest HTTP 503"), pages }), "c1", "本轮任务");
  assert.equal(out.source, "titles");
  assert.equal(out.prompt, "本轮任务\n\n【集群共享记忆】本集群此前回合的沉淀，供参考：\n- 集群回合 2026-10-24 08:00（2026-10-24）\n- 集群回合 2026-10-23 08:00（2026-10-23）");
});

test("ladder: both rungs fail → task prompt unchanged, no throw", async () => {
  const out = await memoryInjectionFor(ladderMemory({ digestError: new Error("x"), pagesError: new Error("y") }), "c1", "本轮任务");
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "本轮任务");
});

test("ladder: CELL_MEMORY_DIGEST=0 skips the digest rung (rollback lever); env k/budget ride the call", async () => {
  const seen = [];
  const mem = {
    async readDigest(_c, q, opts) {
      seen.push({ q, ...opts });
      return { digest: "## 记忆摘要" };
    },
    async readShared() { return []; },
  };
  const out = await memoryInjectionFor(mem, "c1", "任务A", { CELL_MEMORY_DIGEST_K: "3", CELL_MEMORY_DIGEST_BUDGET: "800" });
  assert.equal(out.source, "digest");
  assert.deepEqual(seen, [{ q: "任务A", k: 3, budget: 800 }]);
  const off = await memoryInjectionFor(mem, "c1", "任务A", { CELL_MEMORY_DIGEST: "0" });
  assert.equal(off.source, "none");
  assert.equal(seen.length, 1, "digest face not called when disabled");
});

test("ladder: null clusterMemory → no calls, prompt unchanged (switch off = byte-identical)", async () => {
  const out = await memoryInjectionFor(null, "c1", "本轮任务");
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "本轮任务");
});

// ── chat lane (add-chat-memory-injection) ───────────────────────────────────
import { chatMemoryInjectionFor, chatMemoryClientFor, chatPromptWithMemory } from "../server/cluster-memory.js";

test("chat ladder: digest read targets project default; k/budget ride the shared env; block only appends", async () => {
  const seen = [];
  const mem = {
    async readDigest(project, q, opts) {
      seen.push({ project, q, ...opts });
      return { digest: "## 记忆摘要" };
    },
    async readShared() {
      return [];
    },
  };
  const out = await chatMemoryInjectionFor(mem, "帮我继续昨天的事", { CELL_MEMORY_DIGEST_K: "6", CELL_MEMORY_DIGEST_BUDGET: "1200" });
  assert.equal(out.source, "digest");
  assert.deepEqual(seen, [{ project: "default", q: "帮我继续昨天的事", k: 6, budget: 1200 }]);
  assert.ok(out.prompt.startsWith("帮我继续昨天的事"), "injection appends, never rewrites the user text");
});

test("chat ladder: CELL_MEMORY_CHAT_DIGEST=0 → byte-identical prompt, zero fd-memory calls", async () => {
  let anyCall = 0;
  const mem = {
    async readDigest() {
      anyCall += 1;
      return { digest: "## 记忆摘要" };
    },
    async readShared() {
      anyCall += 1;
      return [{ title: "旧沉淀", updated_at: "2026-10-24T00:00:00.000Z" }];
    },
  };
  const out = await chatMemoryInjectionFor(mem, "原文照旧", { CELL_MEMORY_CHAT_DIGEST: "0" });
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "原文照旧");
  assert.equal(anyCall, 0, "total kill switch: neither digest nor titles face runs");
});

test("chat ladder: digest failure → generic working-memory title rung; both fail → unchanged", async () => {
  const pages = [{ title: "偏好：周报用中文", updated_at: "2026-10-24T00:00:00.000Z" }];
  const out = await chatMemoryInjectionFor(ladderMemory({ digestError: new Error("digest HTTP 503"), pages }), "继续");
  assert.equal(out.source, "titles");
  assert.equal(out.prompt, "继续\n\n【工作记忆】此前会话的沉淀，供参考：\n- 偏好：周报用中文（2026-10-24）");
  assert.ok(!out.prompt.includes("集群"), "chat rung must not carry cluster wording");
  const none = await chatMemoryInjectionFor(ladderMemory({ digestError: new Error("x"), pagesError: new Error("y") }), "继续");
  assert.equal(none.source, "none");
  assert.equal(none.prompt, "继续");
});

test("chat client: resolved client cached per email; transient mint failure retried (not cached dark)", async () => {
  const data = tmpData();
  try {
    const env = baseEnv(data);
    let mintOk = false;
    let mints = 0;
    const impl = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/admin/mint")) {
        mints += 1;
        if (!mintOk) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ token: "fdm_ok", id: "t1" }) };
      }
      return stubFetch([])(url, init);
    };
    const email = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@t.local`;
    assert.equal(await chatMemoryClientFor(email, env, impl), null, "mint 503 → null this turn");
    assert.equal(mints, 1);
    mintOk = true;
    const cm = await chatMemoryClientFor(email, env, impl);
    assert.ok(cm, "transient failure heals on the next turn");
    assert.equal(mints, 2);
    assert.equal(await chatMemoryClientFor(email, env, impl), cm, "resolved client cached for the process lifetime");
    assert.equal(mints, 2, "no re-mint once resolved");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("chat wiring: no identity or config off → prompt untouched, zero fetch", async () => {
  assert.equal(await chatPromptWithMemory(null, "原样"), "原样");
  const data = tmpData();
  try {
    const boom = async (u) => {
      throw new Error(`unexpected fetch ${u}`);
    };
    const env = { ...baseEnv(data), CELL_MEMORY_ENABLED: "0" };
    const email = `off-${Date.now()}@t.local`;
    assert.equal(await chatPromptWithMemory(email, "原样", env, boom), "原样");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
