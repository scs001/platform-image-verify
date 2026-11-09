# Tasks — fix-legacy-fleet-task-tags

## 1. 判据

- [x] 1.1 `fleetTagOf(job)`：`sourceTag.fleetId ?? origin.fleet.fleetId`，memberId 同样双源回填
- [x] 1.2 替换 6 处单源判定：`roundChildSessionId`、就绪门、`earlyStop`、两处 `isFleet`（收尾/诊断）、`cron.js` 的上下文注入门

## 2. 测试（`test-legacy-fleet-task-tags.mjs`，3 条）

- [x] 2.1 双源解析：现代 / 存量 / 混合（sourceTag 赢、memberId 从 origin 补）/ 都不是 → null
- [x] 2.2 存量任务轮转子进程对话；真非舰队任务不轮转
- [x] 2.3 存量任务进入收尾判据；真非舰队任务不进
- [x] 2.4 反证：退回单源 → 3 条全红；还原 3/3 绿
- [x] 2.5 28 个 cron-runner 消费套件全绿

## 3. 规格

- [x] 3.1 `cron-module`：舰队回合条款补双源归属 + 1 场景

## 4. 上线

- [ ] 4.1 快照 → GHA → relay → digest → GitOps → ArgoCD → 舱内实测
- [ ] 4.2 归档
