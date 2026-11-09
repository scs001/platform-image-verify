# Tasks — add-fleet-early-stop

## 1. 策略

- [x] 1.1 collector 在 `compaction/start` 达阈值（6）且已运行 ≥60s 时原生取消并结算为压力（`earlyStop: true`）
- [x] 1.2 仅舰队回合（`sourceTag.fleetId` 决定 `earlyStop`）；人类/普通定时不受影响
- [x] 1.3 `FLEET_EARLY_STOP=0` 开关；`earlyStopAfterMs` 可注入（测试用，不改变默认 60s）

## 2. 测试（12 条，含新增 3 条）

- [x] 2.1 达标即取消、结算带 `contextPressure`/`compactions`/`earlyStop`、并调用了一次 `cancelSession`
- [x] 2.2 无 `earlyStop` 标记时不取消（8 次压缩仍按完整预算）
- [x] 2.3 `FLEET_EARLY_STOP=0` 关闭策略
- [x] 2.4 反证：阈值改到 9999 不触发 → 该用例超时红；还原 12/12 绿
- [x] 2.5 28 个 cron-runner 消费套件全绿

## 3. 规格

- [x] 3.1 `cron-module`：回合预算条款 + 3 场景

## 4. 上线

- [ ] 4.1 快照 → GHA → relay → digest → GitOps → ArgoCD → 舱内实测
- [ ] 4.2 归档（`openspec validate --strict` 通过后）
