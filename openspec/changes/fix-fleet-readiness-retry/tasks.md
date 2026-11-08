# Tasks — fix-fleet-readiness-retry

## 1. 观测能力（桥）

- [x] 1.1 `dsh-bridge` 暴露 `isRestarting()`（复用既有 `#restarting` 私有态）
  - 实现：`isRestarting() { return this.#restarting === true; }`，紧邻 `isReady()`

## 2. 就绪等待（吸收重启 + 可重试信号）

- [x] 2.1 观察到重启中时粘性延长等待（至多多一个等待窗，不随重启结束收回）
  - 实现：`if (isRestarting()) bound = Math.max(bound, now() + waitMs)`；`bound` 初值 = 原始 deadline
- [x] 2.2 等待耗尽返回 `retryable: true`（调度侧据此决定重排队）
  - 实现：`return { ok:false, retryable:true, error:"the agent runtime is not ready (waited for fleet round)" }`
- [x] 2.3 非舰队任务语义不变（立即拒绝、零轮询）
  - 实现：`if (!job.sourceTag?.fleetId) return { ok:false, error:"the agent runtime is not ready" }` 在轮询之前

## 3. 重试阶梯（不丢轮次）

- [x] 3.1 阶梯常量 30s/90s/180s
  - 实现：`export const RUNTIME_READY_RETRY_LADDER_MS = [30_000, 90_000, 180_000]`
- [x] 3.2 引擎侧按延迟重排队同一任务（非 run-now）
  - 实现：`task-engine.scheduleReenqueue(id, delayMs)`：`setTimeout` → `enqueueExecution(id)`；任务不存在或已 queued/running 时返回 false/true 且不重复入队；`timer.unref()`
- [x] 3.3 经 `cron.js` 导出 `reenqueueJob`，`server.js` 接线 `ctx.reenqueueFleetTurn`
  - 实现：`function reenqueueJob(id, delayMs) { return engine.scheduleReenqueue(id, delayMs); }`；
    `ctx.reenqueueFleetTurn = (id, delayMs) => cron.reenqueueJob(id, delayMs);`（`attachCronRunner(ctx)` 之后）
- [x] 3.4 就绪前置闸：可重试时重排队并记 `retried:true` 的 skipped；阶梯耗尽才记终局 skipped
  - 实现：`readyRetryByJob`（模块级 Map，键=任务 id）计数；成功起轮或阶梯耗尽时 `delete`
- [x] 3.5 计数不得挂在回合物件副本上
  - 原因：`runCronJobTurn` 入口 `job = { ...job, roundSeq }` 做浅拷贝，写在副本上的计数会丢
    （实现中先踩到：第 4 次仍在重试）

## 4. 验证

- [x] 4.1 `node --test scripts/test-fleet-turn-events.mjs` → **15/15 绿**（含 3 条新增）
  - 新增：重启窗内等待不提前耗尽 / 超时可重试 / 阶梯耗尽仍如实 skipped 且只重排队 3 次
  - 坑：阶梯用例需 `FLEET_TURN_READY_WAIT_MS=20`（否则 4 次 × 120s）
- [x] 4.2 相邻套件不回归
  - 实证：`test-cron-parity` + `test-cron-catchup` + `test-task-engine-boot-guard` **21/21**；
    `test-cron-round-rotation` + `test-agent-runner` **78/78**
- [x] 4.3 语法检查
  - 实证：`node --check` 五个改动文件全通过

## 5. 收口

- [x] 5.1 `openspec validate fix-fleet-readiness-retry --strict` 绿
- [ ] 5.2 出片 + GitOps 滚版，并在餐厅舰上验证「重连凭据后 run-now 不再 lost」
  - 判据：`runtime not ready — re-enqueued in 30s` 出现于日志，随后该轮 turn 状态为 `ok`；
    或重启窗被吸收时无任何 skipped 记录
