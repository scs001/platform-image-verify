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

## 5. 上产后发现的缺陷：闸门被「开场压缩风暴」绕过（2026-11-09，已修 `1726c40ff`）

> 这一节是 4.1 之后的实测回归：策略写对了，闸门的位置错了。

- [x] 5.1 归因 — 判定只在 `compaction/start` 事件里做，且要求「计数达阈值」与
  「已跑够 `earlyStopAfterMs`(60s)」在**同一事件**上同时成立。于是最常见的形状
  ——**前 60 秒内连压 4 次、之后再没有压缩事件**——永远判不中：4 次判定时 elapsed
  都 <60s，之后再无事件可判，回合一路跑满 600s 预算，占着 cell 唯一的串行槽。
  - 证据（4 个在用 cell、4493 行 history、2026-10-23→11-09）：
    `turn stopped early` **3 行** vs `turn timed out — context pressure` **48 行**；
    44 次超时的压缩数已过阈值（其中 8 次恰好 n=4）；
    `job_1794128300056_hwmvbw` **同时出现在两张单子上**——差别不在任务、也不在
    舰队标记（44 次里 43 次是舰队岗位回合、`carrier` 为空即主槽），而在压缩是否
    恰好跨过时间下限。
  - 时间线：3 次真早停全部落在 04:46–05:10 且都是 n=6（当时阈值仍是 6）；
    阈值降到 4 之后仍有 8 次 n≥4 的超时——与阈值无关，是判定时机的问题。
- [x] 5.2 修法 — 闸门收成唯一入口 `maybeEarlyStop()`；计数达阈值但未到时间下限时，
  挂一次性定时器在下限到点复判（`settle` 时清除、`unref` 不吊住进程）。
  策略本身一字未改：同阈值、同下限、仅舰队回合、同样以压力口径收口并走收尾补数。
- [x] 5.3 测试 — `test-fleet-context-pressure` 14 条（新增 2 条：风暴后静默在下限处
  停；未达阈值仍跑满预算）。**旧 4 条全部注入 `earlyStopAfterMs: 0`，这正是这个缺陷
  从未在 CI 见红的原因**——测试把被测策略的前提给抹掉了。
  变异检查：还原旧闸门 → 新用例 2 秒内转红。相邻套件全绿：fleet-turn-events 15 /
  worker-pool 16 / queue-health 12 / cron-catchup 11 / history-kinds 9。biome 干净。
- [ ] 5.4 上产验证（随 4.1 一起）— 镜像更新后 24h 内应看到：
  `turn stopped early` 显著上升、`turn timed out — context pressure` 中 n≥4 的降到 0。
  复算用 `paas/scripts/queue-history-stats.mjs --hours 24 --json`（唯一读面，别再自己写 `cls()`）。

