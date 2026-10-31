## 1. 归因：读该回合的执行上下文，不读运行时默认

- [x] 1.1 `resolveAttribution`（`server/fleet-reports.js`）新增**在飞回合**分支：
  以运行账本 `openTurns()` 的 `{fleetId, memberId}` 为准，唯一命中才采纳。完成判据=
  parked 回合（部署默认为别的 persona）仍归属本岗位。
- [x] 1.2 运行中任务分支放宽：由「仅 `targetType==="cluster"`」放宽到「带 `sourceTag.fleetId`
  的运行中任务」，`kind` 区分 `cluster-task` / `job-sourceTag`。完成判据=既有 cluster
  场景字节不变 + persona 回合命中 `job-sourceTag`。
- [x] 1.3 唯一性收敛：在飞回合/运行中任务多命中时**不猜**，退回下一级；最终 `none`/
  `ambiguous` 诚实拒收。完成判据=多岗位共用 persona 仍拒收。
- [x] 1.4 六处归因调用点（`server/routes/fleets.js` 的 `/report` `/dispatch` `/escalate`
  `/deputy/queue` `/deputy/resolve` `/deputy/escalate-to-owner`）补传 `openTurns()`。
  完成判据=六处全部传参（grep 计数 6）。
- [ ] 1.5 真机判据：驻留回合的 persona 岗位 `report_status` 正常受理（不再 409
  「not a member of any fleet」）。完成判据=出片后真机一次驻留回合报数落到正确岗位。

## 2. 事实列

- [x] 2.1 `server.js` 加一次性事实桥 `recordFleetAttribution` / `takeFleetAttribution`
  （与既有 `takeFleetModelNotices` 同款纪律）。
- [x] 2.2 报数受理处按 `memberId` stash `{source, fleetId, memberId}`。
- [x] 2.3 回合收尾（`ctx.recordFleetTurnEvent`）取用并合入
  `member_turn_events.detail.attribution`；无 stash 的回合 detail 逐字节不变。
- [ ] 2.4 完成判据：出片后真机回合台账可读 `detail.attribution`（归属成功与失败两种结局）。

## 3. 工具面：按 preset 分段供给

- [x] 3.1 cell 侧 `writeMcpPatch` 补 `packPersonaToolFaces()`：每个已装 pack 的 persona
  一节，内容 = `effectiveMcpTools` 既有派生。完成判据=单测断言「某 persona 的段只含自己的
  server」。
- [x] 3.2 形状纪律：`byPreset` 非空才用 `{mcpTools, byPreset}` 包装形状，为空保持裸 map
  逐字节不变。完成判据=既有「flag off 逐字节等价」用例仍绿（真机自测曾写出
  `{"mcpTools":{"mcpTools":null}}`，此纪律即其来由）。
- [x] 3.3 `applyMcpToolRestrict(agentCtx, presetId)` 在 cell 侧能取到 `byPreset[presetId]`
  段（reader 未改，靠 own `byPreset` 键区分）。完成判据=reader 用例全绿。
- [x] 3.4 聊天车道零回归：既有 chat 车道用例全绿。
- [ ] 3.5 真机判据：驻留岗位会话内可按工具检索命中自己声明的工具。完成判据=出片后
  本体建设舰队盘账岗能命中 `wire_datasets_list`。

## 4. 测试

- [x] 4.1 `scripts/test-fleet-report-lane.mjs` 补三例：在飞回合胜出（parked）、多回合不猜、
  chat 车道不变。完成判据=41/41 绿。
- [x] 4.2 `scripts/test-full-mode-tool-scope-integration.mjs` 补四例：每 persona 自己的段、
  未声明回落 pack 级、无 MCP 引用不给段、卸载随删。完成判据=10/10 绿。
- [x] 4.3 相邻套件回归：`test-fleet-turn-attribution` / `test-tool-scope-bridge` /
  `test-tool-scope-register-seam` / `test-focus-overlay` 全绿（合计 87/87）。
- [x] 4.4 `openspec validate fix-parked-preset-attribution --strict` 绿；
  `validate --specs` 225/0。

## 5. 出片与验收

- [ ] 5.1 出片（走 `fd-build-channel` 判路，私仓 ubuntu 经济门）。
- [ ] 5.2 **硬判据**：复算「首个 parked 事件之后 `member_reports`（`source='self'`）不再
  归零」——两个 cell 各算一次，出前 6h 与后 N h 的对照表。完成判据=后窗报数笔数 > 0。
- [ ] 5.3 本体建设舰队首轮重跑：盘账岗能命中 `wire_datasets_list` 并产出报数
  （`member_reports` 出现该岗位行）。
- [ ] 5.4 台账 `docs/registry-maintenance.md` 记实录（时间线/根因/两缺陷/判据数据），
  并把「parked 不动默认 preset」的 grep 复核补上 `server/routes/`（原 tasks 5.1 漏项，
  记为复核纪律缺口：grep 复核必须覆盖 `server/routes/`）。

## 6. 挂账（不在本 change）

- [ ] 6.1 **server 级集合差异**：`mcp.patch.yml` 按部署默认 persona 组合时被丢掉的 server
  （如 `wire-ops-mcp`）对任何 persona 都不在——per-preset 段只管 allowlist，管不到 server
  供给。独立立项。
- [ ] 6.2 **`registryName` 语义分叉**：「注册表服务名」vs「部署别名」两条清单须在 pack
  校验层分开校验（现只校字符形状不校存在性）。挂给柏讯侧需求书 B 段。
- [ ] 6.3 柏讯侧「registry 未在册」的取证口径：其查的 `GET /api/servers` 是 MCP 服务注册表，
  非 pack 市场货架——回执时一并订正。
- [ ] 6.4 **他人在途缺陷（实测 2026-10-31，不属本 change）**：
  `server/routes/fleets.js` 的 member PATCH 解构缺 `carrier`（`const { … } = req.body ?? {}`
  未取 `carrier`，下方 `if (carrier !== undefined)` 直接引用）→ 每次 member PATCH 抛
  `carrier is not defined` → 500。证据=`scripts/test-fleet-core.mjs` 两条路由用例在
  **本 change 改动之前**即红（stash 对照已证）。归属=`add-fleet-carrier` 在途车道。
- [ ] 6.5 **既有红（与本 change 无关）**：`scripts/test-fleet-event-wake.mjs` 1 条
  （`actual 'cron' !== expected 'event'`）在改动前即红（stash 对照已证）。交回该车道。
