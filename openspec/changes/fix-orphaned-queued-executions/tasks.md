# Tasks — fix-orphaned-queued-executions

## 1. 可检出

- [x] 1.1 `queueHealth()` 增 `orphaned` 计数（排队态但不在待取集合，且排除在途窗口）
- [x] 1.2 `orphaned > 0` 并入 `degraded`（否则孤悬永远静默）

## 2. 可自愈

- [x] 2.1 `enqueueExecution` 的 already 分支判定「是否真在链上」，不在则 `dispatch(id)` 补挂
- [x] 2.2 返回值带 `requeued: true` 供调用方区分「本来就在跑」与「刚被补挂」
- [x] 2.3 记录 `inFlightExecutionId`（drain 摘取 → 回合开跑之间的窗口），判定时排除

## 3. 验证

- [x] 3.1 `test-queue-staleness` **9/9**：新增「孤悬被重新挂链并真的开跑」用例
- [x] 3.2 `test-queue-health` **12/12**：既有「阈值内积压仍健康」在新语义下仍成立（在途窗口排除生效）
- [x] 3.3 相邻：watchdog 3/3、turn-events 15/15、boot-guard 2/2、cron-round-rotation 5/5
- [x] 3.4 `node --check` + biome 通过

## 4. 收口

- [ ] 4.1 出片 + GitOps 滚版，并在产上确认：`queue.queued` 与 `fairness` pending 不再背离，
      `orphaned` 字段出现在 `/api/ready`，孤悬时 degraded 为 true
