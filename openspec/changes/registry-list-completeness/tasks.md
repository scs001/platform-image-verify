# registry-list-completeness — 任务清单

> 目标：registry 列表读取按分页契约取全量，截断可观测。生产当前 `/api/agents` 裸读丢 3 条
> （含活跃条目 `daas-analyst`），`/api/servers` 在 `facet/cli` 侧丢 2 条。

## 1. 测试先行（红）

- [x] 1.1 `scripts/test-registry-bridge.mjs` 的桩响应补齐 `total_count`/`limit`/`offset`/
       `has_next` 信封，且按 `offset` 返回切片；跑 `node scripts/test-registry-bridge.mjs`
       现有用例仍全绿（证明信封改动未破坏既有断言）
- [x] 1.2 新增多页用例：桩里放 25 个 agent（`limit=20` 语义下两页），断言
       `getAgentEntries()` 取回全部 enabled 条目；在当前实现上跑**必须红**（证明用例有效，
       不是恒真断言）
- [x] 1.3 新增截断告警用例：桩返回 `has_next=true` 但只给一页，断言捕获到 warn 且消息含
       端点名与 `total_count`；当前实现上跑必须红

## 2. 实现（绿）

- [x] 2.1 `registry-bridge.js` 新增 `fetchAllPages(endpoint)`：`limit=500` 起读，按
       `has_next` 推进 `offset`，返回 `{items, complete}`；终止条件覆盖"本页 0 条"与
       "`offset` 未推进"两种死循环防护；`has_next` 缺失时按 `total_count` 退化判定；
       **非 2xx（尤其 limit 越界的 422）必须抛错而非当空页**，走 last-good
- [x] 2.2 `doRefresh()` 三处读取统一改用该助手（servers / skills / agents），删掉 agents 的
       裸读；`complete === false` 时 `console.warn` 含端点、`total_count`、实际条数
- [x] 2.3 其余四处 `limit=500` 硬顶改走同一读法（普查所得，同一假设的潜伏副本）：
       `lib/agent-serving.js`（端口占用，失败降级）、`agent-runner/registry.js`
       （runner 分片）、`gateway/packs.js`（fleet scheduler）、
       `server/routes/wanxing-fleet.js`（8s 超时，截断时返回已取部分并告警）
- [x] 2.4 `facet/cli/facet.js` 的 `verifyCallerKey` 可见 server 列表改走同一读法（best-effort
       语义不变：失败仍不阻断验活）；跑 `node scripts/test-registry-bridge.mjs` 全绿
- [x] 2.5 突变自检：临时把助手改成"只读一页"，1.2/1.3 必须转红，确认断言非恒真后还原
       （实测：突变后 1.2/1.3 转红、其余 7 用例保持绿，已还原全绿）

## 3. 出片与验收

- [ ] 3.1 `fd-build-channel` 判路 → 出片（GitHub Actions，禁节点本地 build）→ 滚产
- [ ] 3.2 生产验收（模块级）：日志无截断 warn；`GET /api/catalog` 的 agents 数量与
       registry `total_count`（enabled 口径）一致。**只断言条数完整**——当前实测净差 1 条
       （`daas-analyst`），但它是孤儿（pack 404、`num_skills=0`），不要断言其"可用"
- [ ] 3.3 生产验收（真机）：以真实账号打开市场/Agents 页面，**眼见**目录条目数与 registry
       enabled 口径一致（模块级全绿 ≠ 端到端可用，见 memory `module-vs-e2e-acceptance-gap`）
- [ ] 3.4 台账 `docs/registry-maintenance.md` 记录本次修正（含 digest 与验收证据）

## 4. 跨仓后续（不在本仓实施，登记以免丢失）

- [ ] 4.1 `finddata-skills`（Gitee）`scripts/register_skills.py` 仍为裸读版；需把
       `docs/wire-presets/register_skills.py` 的分页实现回推至该仓并推送
- [ ] 4.2 `docs/wire-presets/register_skills.py` 的 `--rescan` 分支引用未赋值的
       `after_items`（分页改造遗留），带 `--rescan` 跑必 NameError；修掉并实跑验证
- [ ] 4.3 网关侧（跨仓）：评估是否对未带 `limit` 的列表请求返回告警头，或提高默认页大小；
       需与网关仓所有者确认契约变更
