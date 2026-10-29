## 1. 渲染器：本岗位最近轮次段

- [x] 1.1 在 `server/fleet-context.js` 新增「按轮次归并」纯函数（入参：该岗位报数数组；出参：最近 N 个不同 `session_id` 轮次的代表报数，`session_id` 为空的行按 `created_at` 就近归并）——验证：单测覆盖「一轮内三次报数只算一轮」「跨轮按时间倒序」「session_id 全空时按时间归并」三种输入
- [x] 1.2 新增 `renderSelfBlock(member, rounds)` 渲染本岗位段：段首 data-not-instruction 声明 + 每轮一行摘要（时间/声明槽值/blockers/`summary` ≤300 字符）——验证：单测断言段首含声明文案、每轮只出现 `summary` 前 300 字符、不含整轮助手文本
- [x] 1.3 在 `buildFleetContext` 中接入本岗位段，位置在下级段之后、决策摘要之前，并让**无下级岗位同样渲染**（保留「本岗位无直接下级」行）——验证：既有 `scripts/test-fleet-report-lane.mjs:303` 用例仍绿（`本岗位无直接下级` 仍在），新增断言单岗文本包含本岗位段且非空

## 2. 渲染器：近期执行健康段

- [x] 2.1 新增 `renderExecutionHealth(turns)` 渲染最近 N 轮执行结局（成败/`error_kind`/耗时），数据取自 `db.listTurnEvents(memberId, {limit})`——验证：单测喂入含 `turn_budget_exceeded` 的 turn 行，断言输出含该 `error_kind` 与耗时
- [x] 2.2 把该段接入 `buildFleetContext`（与本岗位报数段分离渲染，独立小节）——验证：单测断言超时轮在报数史为空时仍出现在健康段（即「超时对岗位可见」场景）

## 3. 预算与截断

- [x] 3.1 落实预算顺序：下级段先占 `TOTAL_LIMIT`，本岗位段与健康段吃剩余预算，超限以 `…[截断]` 标记——验证：扩充 `scripts/test-fleet-report-lane.mjs:324` 的胖数据用例，构造「下级段已接近 24KB」的场景，断言下级段完整且本岗位段带截断标记
- [x] 3.2 核算单次渲染的最坏体积：本岗位段（3 轮 × ≤300 字符摘要 + 槽值）与健康段（N 轮）之和的上界写入代码注释——验证：单测断言最坏构造下渲染总长不超过 `TOTAL_LIMIT` 的既有上限语义（或在超过时靠标记截断，不抛错）

## 4. 接线与回归

- [x] 4.1 确认 `server.js:1490-1499` 的 deps 无需扩展（`db.listReports` / `db.listTurnEvents` 已在 `getFleetDatabase()` 上）——验证：`node scripts/test-fleet-report-lane.mjs` 与 `node scripts/test-fleet-decision-lane.mjs` 全绿，无 dep 缺失报错
- [x] 4.2 确认既有 `PATROL_DISCIPLINE` 文案与新段不矛盾（「不要再去工作区找更全的报数」仍成立，因为注入内容仍非「更全」而是有界摘要）——验证：审阅 `fleet-context.js:28-34` 文案与新段输出，二者并读无冲突；必要时只加一句指向新段

## 5. 真机验收（apply 后）

- [ ] 5.1 出片并在生产舰队上观察至少 6 轮，用 `member_turn_events.error_kind` 统计 CEO 岗 `turn_budget_exceeded` 发生率——验证：注入前后同岗位同比，占比不下降即视为未达成（本变更唯一硬验收线）
- [ ] 5.2 检查自我强化退化：抽查若干轮，比对本轮 `summary` 与上一轮摘要——验证：不存在「高比例轮次仅复述上轮、无新增观测」；若出现则下调 N 或收窄注入字段
