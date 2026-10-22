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
