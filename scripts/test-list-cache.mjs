// Unit tests for the web list-cache core (openspec: polish-web-surfaces, task
// 1.1). The repo has no browser-side unit runner, so — like test-qr-svg.mjs —
// the framework-free core is imported under plain node (type stripping) and the
// React binding's DOM behavior is covered by e2e. Runs under `npm run test:unit`.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  __listCacheSubscriberCount,
  listCacheClear,
  listCacheGet,
  listCacheHas,
  listCacheInvalidate,
  listCacheSet,
  listCacheSubscribe,
} from "../web/src/lib/listCache.ts";

test("cold key has no cached value", () => {
  listCacheClear();
  assert.equal(listCacheHas("catalog"), false);
  assert.equal(listCacheGet("catalog"), undefined);
});

test("round-trips a payload", () => {
  listCacheClear();
  listCacheSet("catalog", { agents: ["a"], apps: ["b"] });
  assert.equal(listCacheHas("catalog"), true);
  assert.deepEqual(listCacheGet("catalog"), { agents: ["a"], apps: ["b"] });
});

test("invalidate drops the exact key and informs its subscriber", () => {
  listCacheClear();
  listCacheSet("fleets", [1, 2, 3]);
  let hits = 0;
  const off = listCacheSubscribe("fleets", () => {
    hits += 1;
  });
  listCacheInvalidate("fleets");
  assert.equal(listCacheHas("fleets"), false);
  assert.equal(hits, 1);
  off();
});

test("invalidate by prefix drops children and spares siblings", () => {
  listCacheClear();
  listCacheSet("catalog", 1);
  listCacheSet("catalog:agents", 2);
  listCacheSet("connections", 3);
  const dropped = listCacheInvalidate("catalog");
  assert.equal(dropped, 2);
  assert.equal(listCacheHas("catalog"), false);
  assert.equal(listCacheHas("catalog:agents"), false);
  assert.equal(listCacheHas("connections"), true);
});

test("invalidate notifies only matching subscribers", () => {
  listCacheClear();
  listCacheSet("catalog:agents", 1);
  listCacheSet("fleets", 2);
  let catalogHits = 0;
  let fleetHits = 0;
  const offA = listCacheSubscribe("catalog:agents", () => {
    catalogHits += 1;
  });
  const offB = listCacheSubscribe("fleets", () => {
    fleetHits += 1;
  });
  listCacheInvalidate("catalog");
  assert.equal(catalogHits, 1);
  assert.equal(fleetHits, 0);
  offA();
  offB();
});

test("clear empties everything and informs all subscribers", () => {
  listCacheClear();
  listCacheSet("a", 1);
  listCacheSet("b", 2);
  let hits = 0;
  const off = listCacheSubscribe("a", () => {
    hits += 1;
  });
  listCacheClear();
  assert.equal(listCacheHas("a"), false);
  assert.equal(listCacheHas("b"), false);
  assert.equal(hits, 1);
  off();
});

test("unsubscribe stops notifications", () => {
  listCacheClear();
  listCacheSet("catalog", 1);
  let hits = 0;
  const off = listCacheSubscribe("catalog", () => {
    hits += 1;
  });
  off();
  assert.equal(__listCacheSubscriberCount(), 0);
  listCacheInvalidate("catalog");
  assert.equal(hits, 0);
});

test("the store is bounded, evicting the least-recently-written entry", () => {
  listCacheClear();
  for (let i = 0; i < 60; i += 1) listCacheSet(`k${i}`, i);
  // 50-cap: the first ten writes are gone, the last fifty survive.
  assert.equal(listCacheHas("k0"), false);
  assert.equal(listCacheHas("k9"), false);
  assert.equal(listCacheHas("k10"), true);
  assert.equal(listCacheHas("k59"), true);
  // Re-writing refreshes order: k10 becomes newest, so the next overflow evicts k11.
  listCacheSet("k10", 10);
  listCacheSet("k60", 60);
  assert.equal(listCacheHas("k11"), false);
  assert.equal(listCacheHas("k10"), true);
  listCacheClear();
});
