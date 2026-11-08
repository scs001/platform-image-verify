# Tasks — fix-tool-result-cost

## 1. fleet_turns_read（paas）

- [x] 1.1 新增 `server/fleet-turns-view.js`：`shapeTurnsPage(turns, limit)` 纯函数（默认 20 / 上限 100 / 错误截 240 字 / 仅诊断字段）
- [x] 1.2 `fleet-architect-mcp.js` 改用该视图，紧凑 JSON，响应带 count/page/truncated
- [x] 1.3 工具 schema 的 limit 描述改为「默认 20（上限 100），回带是否截断」

## 2. memory_overview（fd-memory）

- [x] 2.1 两个维度设上限：分区 25、每分区标题 3（`OVERVIEW_PARTITIONS` / `OVERVIEW_TITLES`）
- [x] 2.2 `truncated` 改为「分区被裁 或 任一分区页数 > 已列标题数」，并回带 `total_partitions`
- [x] 2.3 工具描述写明两个上限与 truncated 语义

## 3. 测试

- [x] 3.1 paas `scripts/test-fleet-turns-view.mjs`（3 条）：默认页与上限/投影与错误截断/页比美化输出小一个数量级
- [x] 3.2 fd-memory overview 用例：40 分区 → 页 25 / total 40 / truncated；单分区 9 页 → truncated=true
- [x] 3.3 反证：paas 视图退回「全字段不截断」→ 3 条全红；fd-memory 恢复旧判据 → 新用例红
- [x] 3.4 fd-memory 全量 181 测绿；paas `test-fleet-architect`(11) / `test-fleet-runs`(26) / `test-fleet-turn-events`(15) 绿

## 4. 规格

- [x] 4.1 `agent-fleet-architect`：回合读面分页 + 1 场景
- [x] 4.2 `agent-memory-foundation`：overview 双维度上限 + 2 场景

## 5. 上线

- [ ] 5.1 fd-memory 出片 → relay → digest → GitOps → ArgoCD → 舱内实测
- [ ] 5.2 paas 出片 → relay → digest → GitOps → ArgoCD → 舱内实测
- [ ] 5.3 归档（`openspec validate --strict` 通过后）
