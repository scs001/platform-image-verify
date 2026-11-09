## Why

`cell-execution-queue` 的有界陈旧度按「排队年龄 > `QUEUE_MAX_AGE_MS`」丢弃排期轮，判据只看等待时长，**不看这个任务多久才轮到下一次**。于是同一句处置对两种任务是两种后果：

| 任务周期 | 丢弃一轮的代价 | 现在的处置 |
|---|---|---|
| 每小时 | 损失 1 小时，下一次火很快到 | 可接受 |
| 每天 | **当天的整轮没了**，下一个火是明天 | 与每小时同罪 |
| 每周 | 一周没了 | 与每小时同罪 |

丢弃时的 error 文案写着「the next cadence fire supersedes it」——这句话对小时级成立，对日更/周更**是假的**：它没有"下一次"能接替，`skipped` 既不补跑也不记 `missed`，那一轮就是永久丢失。

产线两条硬约束让这件事从理论变成可达：

- `QUEUE_MAX_AGE_MS = 600000`（10 分钟，`fd-infra-deploy/all-services/prod/platform.yaml`）；
- 单回合实测 4–5 分钟收口。

即 **3 个插队者就吃掉 12–15 分钟 > 10 分钟**。而正式 spec 已经把"人工点火持续插队 → 过龄轮被丢"写成正确行为（`cell-execution-queue` 的 Scenario「被持续插队的过龄排期轮也被丢弃」），于是这条路径今天没有任何东西拦着。

本 change 不改上限、不改丢弃机制，只让判据认识"这个任务的下一班什么时候来"。

## What Changes

- 陈旧度丢弃 SHALL 增加**周期感知**：仅当该任务的排期周期**不大于**陈旧度上限时，才允许按 `skipped` 丢弃（丢弃的代价有界，下一班在时限内到来）。
- 周期**大于**上限的任务（日更/周更等）SHALL 豁免陈旧度丢弃，继续排队等待真正执行——宁可等，不整轮丢失。
- 丢弃时的 error 文案 SHALL 与实际一致：不再对长周期任务宣称"由下一次排期接替"，因为对它们不成立。
- `QUEUE_MAX_AGE_MS = 0`（关闭策略）时行为不变。
- 无排期周期可判（周期缺失/非法，或非排期触发）时 SHALL 保持既有行为——**不**因判不出周期就放宽丢弃，避免策略在数据不全时静默失效。

**BREAKING**：无。默认上限 30 分钟，受影响的是"周期 > 30 分钟"的任务；产线 10 分钟下受影响的是所有小时级以上任务。这一改动**减少**丢弃，不增加任何执行量上限——被豁免的任务仍需排队等槽。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `cell-execution-queue`: 「排期轮的有界队列陈旧度」增加周期感知条件，并把"被持续插队的过龄轮一律丢弃"收窄为"周期在上限之内的过龄轮丢弃"。

## Impact

- **代码**：`task-engine.js` 的 `dropIfStaleQueued`（判据）与 `sweepStaleQueuedFires`（同一判据的清扫路径）；`t.interval` 字段已存在（unit/number/anchor），无需新依赖。
- **接口/契约**：`skipped` 的语义不变；`error` 文案措辞微调（仅长周期任务不再出现"下一次接替"）。
- **测试**：`scripts/test-queue-staleness.mjs`（既有陈旧度用例必须继续绿）+ 新增周期感知用例。
- **运维**：产线 `QUEUE_MAX_AGE_MS=600000` 不变；本 change 上线后，日更/周更舰队回合不再因插队被整轮丢弃，队列瞬时深度可能略高（被豁免的那几条会继续占位等待）。
- **与另一个 change 的关系**：`fix-operator-ignition-priority` 让人工点火在池路径上能越过排队；本 change 是它的前置保护——**先有本 change，才建议开 `QUEUE_HUMAN_PRIORITY=1`**，否则点火插队会直接把日更回合推过线丢掉。
