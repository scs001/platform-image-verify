#!/usr/bin/env node
// ── Blueprint studio Slice 1 tests (add-blueprint-studio tasks 1.x/3.x) ─────
//
// Route-level coverage over injected seams (db on a tmp file, publishClient
// and packResolver mocked — the real market gate is never touched); identity
// rides the same resolveUserFactory semantics as fleets.js (auth-on →
// req.user only). Covers the four gates from the implementation notes:
//   ① 不当 expectVersion 的批准报 409      ② 校验不绿的批准报 422
//   ③ 未批准的铸造报 409                    ④ 顺利铸造记录 cast_pack_id
// plus the storage credential wall (task 1.3), the version/approval
// discipline, dependency-placeholder fill/drift, self-reference continuity,
// and the trial-report slot.
//
//   node --test scripts/test-blueprints.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

const tmp = mkdtempSync(path.join(tmpdir(), "blueprints-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const { createBlueprintDatabase } = await import("../server/routes/blueprints-db.js");
const { createBlueprintRoutes } = await import("../server/routes/blueprints.js");

// 合法底稿：四段校验链全绿的最小蓝图（凭据/形状/fleet 段/manifest 段/
// 工具面 consult 一支不过都不行）。
const VALID_CONTENT = {
  boundary: { name: "政策盯梢", oneLine: "盯跨境电商政策变化", outOfScope: "不做报关" },
  dataSources: [{ ref: "policy-feed" }],
  fleet: {
    name: "政策盯梢集群",
    members: [
      {
        ref: "watch",
        title: "盯梢岗",
        target: { kind: "tool", id: "websearch::web_search" },
        cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "{\"query\":\"cross-border policy\"}" },
      },
      {
        ref: "brief",
        title: "简报岗",
        parentRef: "watch",
        target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "brief-agent" },
        kpiSlots: [{ key: "briefs", label: "简报数", unit: "份" }],
      },
    ],
  },
  agents: [{ id: "brief-agent", name: "简报岗", persona: "你是简报岗，汇总盯梢结果出晨报。" }],
  mcpServers: [],
  monitoring: { escalate: { threshold: 3 } },
  acceptance: [{ id: "first-brief", kind: "report-landed", target: "简报岗" }],
  board: { sections: ["daily"] },
};

function mount({ db, publishCalls = [], resolverResult = {}, trialDeps = undefined } = {}) {
  const store = db ?? createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Test seam: identity rides a header; absent = unauthenticated (auth-on).
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  const publishClient = {
    async publish(args) {
      publishCalls.push(args);
      return { ok: true, packId: args.packId ?? "pk_cast_1", version: (args.packId ? 2 : 1), body: {} };
    },
  };
  const packResolver = async ({ refs }) =>
    Object.fromEntries(refs.filter((r) => resolverResult[r] !== null).map((r) => [r, resolverResult[r] ?? { packId: `pk_${r}`, name: r }]));
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver, trialDeps });
  const server = http.createServer(app);
  server.listen(0);
  return { server, store, publishCalls, base: `http://127.0.0.1:${server.address().port}` };
}

const as = (email, init = {}) => ({
  ...init,
  headers: { "Content-Type": "application/json", ...(email ? { "x-test-user": email } : {}), ...(init.headers ?? {}) },
});
const j = (res) => res.json();
const close = (server) => new Promise((r) => server.close(r));

test("1.2 草稿生命周期：创建→清单不含 content→详情→版本纪律", async () => {
  const { server, base } = mount();
  try {
    // 未带身份：auth-on 下 401。
    assert.equal((await fetch(`${base}/api/blueprints`, as(null))).status, 401);

    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    assert.equal(created.blueprint.status, "draft");
    assert.equal(created.blueprint.version, 1);
    assert.equal(created.blueprint.name, "政策盯梢");
    assert.deepEqual(created.warnings, []);
    const id = created.blueprint.id;

    // 清单不含 content；他人清单为空、他人详情 404（存在性不外泄）。
    const list = await fetch(`${base}/api/blueprints`, as("alice@x")).then(j);
    assert.equal(list.blueprints.length, 1);
    assert.equal(list.blueprints[0].content, undefined);
    assert.deepEqual(await fetch(`${base}/api/blueprints`, as("bob@x")).then(j), { blueprints: [] });
    assert.equal((await fetch(`${base}/api/blueprints/${id}`, as("bob@x"))).status, 404);

    // expectVersion 不符 → 409 指名当前版；相符 → version+1。
    const conflict = await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 9, content: VALID_CONTENT }) }));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).currentVersion, 1);
    const edited = await fetch(
      `${base}/api/blueprints/${id}`,
      as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 1, content: { ...VALID_CONTENT, boundary: { ...VALID_CONTENT.boundary, outOfScope: "不做报关、不做退税" } } }) }),
    ).then(j);
    assert.equal(edited.blueprint.version, 2);
    // 归一化 diff 记录字段级变化。
    assert.match(edited.blueprint.diffSummary, /boundary\.outOfScope/);
  } finally {
    await close(server);
  }
});

test("1.3 凭据禁带闸：存储层硬拒端点/秘密字面值，软契约发现照报不阻", async () => {
  const { server, base } = mount();
  try {
    // 禁键 + 秘密字面值 → 422，且什么都没存下。
    const carried = {
      ...VALID_CONTENT,
      mcpServers: [{ registryName: "ext", headers: { Authorization: "Bearer sk-abcdef0123456789" } }],
    };
    const rejected = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: carried }) }));
    assert.equal(rejected.status, 422);
    assert.match((await rejected.json()).error, /credentials|endpoints/);
    assert.deepEqual(await fetch(`${base}/api/blueprints`, as("alice@x")).then(j), { blueprints: [] });

    // dataSources 带了端点形 ref：草稿照存（201）+ warnings 逐字段指名；
    // 全链校验与批准面再拦（见下）。
    const soft = await fetch(
      `${base}/api/blueprints`,
      as("alice@x", { method: "POST", body: JSON.stringify({ content: { ...VALID_CONTENT, dataSources: [{ ref: "https://evil.example/feed" }] } }) }),
    );
    assert.equal(soft.status, 201);
    const softBody = await soft.json();
    assert.match(softBody.warnings[0]?.error ?? "", /registry server name or internal-library logical name/);
  } finally {
    await close(server);
  }
});

test("校验链：既有校验器原文逐字段，approve 短路 ②", async () => {
  const { server, base } = mount();
  try {
    const bad = await fetch(
      `${base}/api/blueprints`,
      as("alice@x", {
        method: "POST",
        body: JSON.stringify({
          content: {
            ...VALID_CONTENT,
            dataSources: [{ ref: "https://evil.example/feed" }],
            fleet: { name: "坏集群", members: [] },
          },
        }),
      }),
    ).then(j);
    const id = bad.blueprint.id;

    const verdict = await fetch(`${base}/api/blueprints/${id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(verdict.ok, false);
    // 错误文本与既有校验器同源：parseFleetTemplate 的原文 + shape 闸指名。
    assert.ok(verdict.errors.some((e) => e.error === "fleet.members must be a non-empty array"));
    assert.ok(verdict.errors.some((e) => e.entry === "dataSources[0].ref"));
    assert.equal(verdict.manifestPreview.category, "fleet");

    // ② 校验不绿的批准报 422，指名未过项。
    const blocked = await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    assert.equal(blocked.status, 422);
    assert.match((await blocked.json()).error, /validation must be fully green/);
  } finally {
    await close(server);
  }
});

test("成环 handoff 边被既有编排校验指名（spec 非法蓝图 scenario）", async () => {
  const { server, base } = mount();
  try {
    const cyclic = {
      ...VALID_CONTENT,
      fleet: {
        ...VALID_CONTENT.fleet,
        orchestration: { edges: [{ kind: "handoff", from: "watch", to: "watch" }] },
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: cyclic }) })).then(j);
    const verdict = await fetch(`${base}/api/blueprints/${created.blueprint.id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => /a post cannot hand off to itself/.test(e.error)));
  } finally {
    await close(server);
  }
});

test("3.1 批准闸：①版本不符 409；批准后编辑即清批准（旧批准不延用）", async () => {
  const { server, base } = mount();
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const id = created.blueprint.id;

    // ① 不当 expectVersion 的批准报 409。
    const conflict = await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 7 }) }));
    assert.equal(conflict.status, 409);

    const approved = await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) })).then(j);
    assert.equal(approved.blueprint.status, "approved");
    assert.equal(approved.blueprint.approvedBy, "alice@x");
    assert.ok(approved.blueprint.approvedAt);

    // 编辑 = 新草稿版：version+1、status 回 draft、批准清空。
    const edited = await fetch(
      `${base}/api/blueprints/${id}`,
      as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 1, content: { ...VALID_CONTENT, monitoring: { escalate: { threshold: 5 } } } }) }),
    ).then(j);
    assert.equal(edited.blueprint.version, 2);
    assert.equal(edited.blueprint.status, "draft");
    assert.equal(edited.blueprint.approvedBy, null);
  } finally {
    await close(server);
  }
});

test("3.2/3.3 铸造：③未批准 409、非批准人 403、④顺利铸造带 _casting 与占位落实", async () => {
  const publishCalls = [];
  const { server, base } = mount({ publishCalls });
  try {
    const withDep = {
      ...VALID_CONTENT,
      fleet: {
        name: "政策盯梢集群",
        members: [
          ...VALID_CONTENT.fleet.members,
          { ref: "disc", title: "纪律岗", target: { kind: "pack-preset", packId: "{{PACK_ID:政策纪律包}}", presetId: "brief-agent" } },
        ],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: withDep }) })).then(j);
    const id = created.blueprint.id;

    // ③ 未批准的铸造报 409。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }))).status, 409);

    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    // 非批准人铸造 403（批准纪律：apply 与批准同人）。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/cast`, as("bob@x", { method: "POST" }))).status, 404); // 他人资产 404
    const notApprover = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    assert.equal(notApprover.status, 200);

    // ④ 顺利铸造：cast_pack_id 落账；发布客户端收到带追溯的 manifest。
    const castBody = await notApprover.json();
    assert.equal(castBody.blueprint.status, "cast");
    assert.equal(castBody.blueprint.castPackId, "pk_cast_1");
    assert.equal(publishCalls.length, 1);
    const sent = publishCalls[0].manifest;
    assert.equal(sent.category, "fleet");
    assert.equal(sent.name, "政策盯梢");
    assert.equal(sent._casting.source, "fleet-blueprint-studio");
    assert.equal(sent._casting.blueprintId, id);
    assert.equal(sent._casting.approvedBy, "alice@x");
    // 依赖占位逐项落实，包自引用首铸保持（谱系在续铸回补）。
    const disc = sent.fleet.members.find((m) => m.ref === "disc");
    assert.equal(disc.target.packId, "pk_政策纪律包");
    const brief = sent.fleet.members.find((m) => m.ref === "brief");
    assert.equal(brief.target.packId, "{{PACK_ID}}");
    assert.equal(castBody.cast.selfPending, true);
  } finally {
    await close(server);
  }
});

test("依赖漂移拒：市场解析不出的占位名指名 409", async () => {
  const { server, base } = mount({ resolverResult: { "政策纪律包": null } });
  try {
    const withDep = {
      ...VALID_CONTENT,
      fleet: {
        name: "政策盯梢集群",
        members: [{ ref: "disc", title: "纪律岗", target: { kind: "pack-preset", packId: "{{PACK_ID:政策纪律包}}", presetId: "brief-agent" } }],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: withDep }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));

    const refused = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.deepEqual(body.missing, ["政策纪律包"]);
    // 未铸造成功：状态仍是 approved，可修正后重批重铸。
    const after = await fetch(`${base}/api/blueprints/${id}`, as("alice@x")).then(j);
    assert.equal(after.blueprint.status, "approved");
  } finally {
    await close(server);
  }
});

test("续铸谱系：publish 携既有 packId 续版，包自引用回补（D5）", async () => {
  const publishCalls = [];
  const { server, base } = mount({ publishCalls });
  try {
    const withDep = {
      ...VALID_CONTENT,
      fleet: {
        name: "政策盯梢集群",
        members: [
          ...VALID_CONTENT.fleet.members,
          { ref: "disc", title: "纪律岗", target: { kind: "pack-preset", packId: "{{PACK_ID:政策纪律包}}", presetId: "brief-agent" } },
        ],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: withDep }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    assert.equal((await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }))).status, 200);

    // 编辑→重批→重铸：publish 携上一铸的 packId 续版，manifest 里
    // 依赖占位与包自引用双双落实。
    await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 1, content: withDep }) }));
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 2 }) }));
    const cast2 = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(cast2.blueprint.castPackVersion, 2);
    assert.equal(publishCalls[1].packId, "pk_cast_1");
    const brief2 = publishCalls[1].manifest.fleet.members.find((m) => m.ref === "brief");
    assert.equal(brief2.target.packId, "pk_cast_1");
    assert.equal(cast2.cast.selfPending, false);
  } finally {
    await close(server);
  }
});

test("下限规则：全引用无内联件在 draft-validate 即以既有原文报出（D3 不另造友好版）", async () => {
  const { server, base } = mount();
  try {
    // 编制全引用、零内联件的蓝图：pack floor 规则在 /validate 已由
    // validatePackManifest 原文报出——不需要 shape 闸另造改写版错误文案
    // （spec D3：错误来源=既有校验器原文，不得超其字段粒度另写措辞）。
    const noInline = {
      ...VALID_CONTENT,
      agents: [],
      mcpServers: [],
      fleet: {
        name: "全引用集群",
        members: [{ ref: "ext", title: "外援岗", target: { kind: "existing-persona", id: "someone" } }],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: noInline }) })).then(j);
    const verdict = await fetch(`${base}/api/blueprints/${created.blueprint.id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => /at least one skill, MCP reference, agent, or bot/.test(e.error)));
  } finally {
    await close(server);
  }
});

test("试跑报告位：铸造前拒落，铸造后落/读（Slice 3 执行器挂点）", async () => {
  const { server, base } = mount();
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const id = created.blueprint.id;
    const report = { assertions: [{ id: "first-brief", pass: true, evidence: "trace://t1" }], firstTurn: true };

    const early = await fetch(`${base}/api/blueprints/${id}/trial-report`, as("alice@x", { method: "POST", body: JSON.stringify({ report }) }));
    assert.equal(early.status, 409);

    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));

    const saved = await fetch(`${base}/api/blueprints/${id}/trial-report`, as("alice@x", { method: "POST", body: JSON.stringify({ report }) }));
    assert.equal(saved.status, 200);
    const readBack = await fetch(`${base}/api/blueprints/${id}/trial-report`, as("alice@x")).then(j);
    assert.deepEqual(readBack.report, report);
    assert.equal((await fetch(`${base}/api/blueprints/${id}/trial-report`, as("bob@x"))).status, 404);
  } finally {
    await close(server);
  }
});

test("4.1 试跑闸：非铸造态 409；铸造后装一台跑一轮并落报告（注入执行器）", async () => {
  const trialDeps = {
    now: () => 1000,
    fetchManifest: async () => ({ fleet: { name: "政策盯梢", members: [] } }),
    install: async () => {},
    provision: async () => ({ ok: true, fleetId: "fleet_trial_1" }),
    startFleet: async () => {},
    fireRound: async () => [{ jobId: "job_1", memberId: "m1", at: 1010 }],
    collectAndWait: async ({ since }) => ({
      members: [{ memberId: "m1", title: "简报岗", targetId: "brief-agent" }],
      turns: [{ memberId: "m1", at: since + 1, jobId: "job_1", turnId: "turn_1" }],
      reports: [{ memberId: "m1", reportId: "report_1", createdAt: since + 2, turnId: "turn_1" }],
      escalations: 0,
    }),
  };
  const { server, base } = mount({ trialDeps });
  try {
    const withGrammar = {
      ...VALID_CONTENT,
      acceptance: [{ id: "first-brief", kind: "report-landed", target: "简报岗" }],
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: withGrammar }) })).then(j);
    const id = created.blueprint.id;

    // 非铸造态：409（草稿阶段任何实体零副作用，试跑也不许开跑）。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/trial`, as("alice@x", { method: "POST" }))).status, 409);

    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));

    const trial = await fetch(`${base}/api/blueprints/${id}/trial`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(trial.report.green, true);
    assert.equal(trial.report.fleetId, "fleet_trial_1");
    assert.deepEqual(trial.report.assertions[0].evidence.reportIds, ["report_1"]);

    // 报告落账（既有存储位）并可读回。
    const readBack = await fetch(`${base}/api/blueprints/${id}/trial-report`, as("alice@x")).then(j);
    assert.equal(readBack.report.green, true);
    assert.equal(readBack.report.fleetId, "fleet_trial_1");

    // 他人读同一报告 404（owner 作用域）。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/trial-report`, as("bob@x"))).status, 404);
  } finally {
    await close(server);
  }
});

test("3.3 发布客户端身份头：user 必须是对象（base64url 身份契约回归）", async () => {
  // 2026-10-28 生产走查逮住的真缺陷：传裸邮箱串 → facetForwardHeaders 取
  // user.email 得 undefined → 身份头空 → facet 判匿名 401。此处锁住形状：
  // 无论收到串还是对象，发出去的必须是 {email, groups} 对象。
  const { createFacetPublishClient } = await import("../server/routes/blueprints.js");
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: "pk_x", version: 1 }) };
  };
  const client = createFacetPublishClient({ env: { FACET_BASE_URL: "http://facet.test", FACET_INTERNAL_TOKEN: "tok" }, fetchImpl: fakeFetch });
  const out = await client.publish({ manifest: { name: "m" }, user: "a@b.c" });
  assert.equal(out.ok, true);
  const decoded = JSON.parse(Buffer.from(seen[0].headers["x-facet-user"], "base64url").toString("utf8"));
  assert.deepEqual(decoded, { email: "a@b.c", groups: [] });
  assert.equal(seen[0].headers["x-facet-token"], "tok");

  // 无邮箱的身份 → 401，不发请求。
  const before = seen.length;
  const anon = await client.publish({ manifest: { name: "m" }, user: { groups: [] } });
  assert.equal(anon.status, 401);
  assert.equal(seen.length, before);
});

test("跨仓契约兼容：finddata 蓝图格式 v1 原样粘入即可编辑/校验/铸造", async () => {
  // 2026-10-28 跨仓对账：finddata fleet-packs/blueprints/schema.md 的字段名
  // （vertical/sources/boards）与本仓（boundary/dataSources/board）不同。归一化
  // 保证按他们 schema 写的蓝图不会静默变空壳；自由文本断言如实指名不支持。
  const finddata = {
    vertical: { name: "跨境电商政策盯梢", tagline: "盯四路政策与公告面，异动即报", non_goals: ["商品价格监控", "汇率预测"] },
    sources: [{ registryName: "fd-info", purpose: "部委公告与政策流", allowTools: ["list_since", "get_item"] }],
    fleet: {
      name: "政策盯梢集群",
      members: [{ ref: "watch", title: "盯梢岗", target: { kind: "tool", id: "websearch::web_search" },
        cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "{\"query\":\"policy\"}" } }],
    },
    boards: [{ artifact: "doc", title: "政策日报", discipline: "draft+提案制" }],
    monitoring: { anomaly_criteria: ["部委公告异动"], escalate: { threshold: 3 }, notify: "proposal-channel" },
    acceptance: ["巡检员一个成功回合", "主编日报合成"],
    _casting: { source_blueprint: "fleet-packs/blueprints/x/blueprint.json", packDependencies: {} },
  };
  const { server, base } = mount();
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: finddata }) })).then(j);
    // 名从 vertical.name 归一到 boundary.name。
    assert.equal(created.blueprint.name, "跨境电商政策盯梢");
    assert.equal(created.blueprint.content.boundary.oneLine, "盯四路政策与公告面，异动即报");
    assert.match(created.blueprint.content.boundary.outOfScope, /商品价格监控/);
    assert.equal(created.blueprint.content.dataSources[0].ref, "fd-info");
    assert.equal(created.blueprint.content.dataSources[0].note, "部委公告与政策流");
    assert.ok(Array.isArray(created.blueprint.content.board));

    // 校验：fleet 段过既有链，自由文本断言被如实指名（不静默通过）。
    const verdict = await fetch(`${base}/api/blueprints/${created.blueprint.id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => /unsupported assertion kind 'free-text'/.test(e.error)));
    assert.equal(verdict.errors.some((e) => e.entry === "fleet"), false, "fleet 段必须零错误");
  } finally {
    await close(server);
  }
});

test("删除：从未铸造的草稿可删；已铸造的拒删（市场包才是账）", async () => {
  const { server, base } = mount();
  try {
    const a = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const draftId = a.blueprint.id;
    assert.equal((await fetch(`${base}/api/blueprints/${draftId}`, as("bob@x", { method: "DELETE" }))).status, 404);
    const del = await fetch(`${base}/api/blueprints/${draftId}`, as("alice@x", { method: "DELETE" }));
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${base}/api/blueprints/${draftId}`, as("alice@x"))).status, 404);

    // 已铸造：拒删并指名 castPackId。
    const b = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const id = b.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    const refused = await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "DELETE" }));
    assert.equal(refused.status, 409);
    assert.ok((await refused.json()).castPackId);
    // 仍在。
    assert.equal((await fetch(`${base}/api/blueprints/${id}`, as("alice@x"))).status, 200);
  } finally {
    await close(server);
  }
});
