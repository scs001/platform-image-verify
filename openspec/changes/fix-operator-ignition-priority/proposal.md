## Why

人的点火（`run now` / owner 的 `execute now`）在**两套执行路径**下的优先级语义是分裂的，而正式 spec 断言它已被保证：

`openspec/specs/worker-pool/spec.md` 写着「人的唤醒的**排队优先级**不属于本规则——它由主槽串行链按 `task-engine` 的执行槽排序自行保证（越过未开始的排队执行），与池是否启用无关」。

这句话在池激活时**不成立**：池激活（`TASK_WORKER_MAX > 0`）后，派发器直接 `beginExecution` 认领排队任务，**从不进入串行链**（`server/worker-slots.js` 自述如此）。于是三方互相指认——spec 说串行链保证、串行链说池不归它管、池只按 FIFO 认领——谁都没做。

实测代价（2026-11-09）：`hotel-watch-scout` 以 `queuedBy=human` 在队列里等了 20 分钟，而它的 `nextRun` 已经是第二天。它被**礼貌地饿死**：老化不丢它、顶替不动它、又抢不到槽，系统认为自己「正确地没丢它」。

同时，新增的池侧排序策略（`be6c0318b`）**没有带任何 spec 增量**，所以正式 spec 至今仍留着上面那句不成立的断言。

## What Changes

- **修正 spec 断言**：删除「排队优先级由串行链自行保证」，改为「池激活时由池的派发器保证」，并明确上限为 0（串行模式）时仍按 `task-engine` 的既有排序。
- **把「排序不是容量」写进规范**：人的点火的排队次序 SHALL 可越过未开始的排队执行；但该次序 SHALL NOT 扩大并发容量——保留的额外槽仍只属于人的**唤醒**（`humanPriority`），不属于 `run now` 打在既有 cadence 任务上的情形（`queuedBy`）。
- **把两个标记的区别写成需求**：`queuedBy === "human"`（requestor，决定排序与老化豁免）与 `humanPriority`（capacity grant，决定额外槽）是两件事，SHALL NOT 互相替代。
- **开关的缺省行为写清**：`QUEUE_HUMAN_PRIORITY` 缺省关闭时，池的派发次序 SHALL 与变更前逐字节一致。

**BREAKING**：无。缺省行为不变（开关默认关闭），只是把已存在的语义写进 spec。

## Capabilities

### New Capabilities

（无——这是既有行为与既有 spec 的对齐，不引入新能力。）

### Modified Capabilities

- `worker-pool`: 「人的唤醒在人满时仍有通道」这条需求里关于**排队优先级归属**的断言不成立（它把责任推给串行链，而池路径绕开串行链）。改为由池的派发器保证，并补「排序不扩大容量」与「两个标记不可互替」两条约束。

## Impact

- **代码**：`server/worker-slots.js`（派发器，已实现，本次不改逻辑）；`task-engine.js` 的 `runTaskNow` / `enqueueExecution`（标记来源，只读引用）。
- **测试**：`scripts/test-worker-pool.mjs` 已新增三条用例钉住两半语义（顺序 / 默认关闭 / 不扩容量），本 change 保留它们为验收依据。
- **文档**：`.env.example`、`DEPLOY.md` 已登记 `QUEUE_HUMAN_PRIORITY` 与 `WORKER_POOL_DEBUG`（本次之前零记载）。
- **不改变**：串行模式（cap 0）的行为、额外槽的归属、任何生产调度顺序（开关缺省关闭）。
- **待裁决**：`run now` 打在既有 cadence 任务上时，是否也应获得额外槽。本 change 按「不授予」写（与现状一致）；若裁决为「授予」，需另开 change 扩容量语义。
