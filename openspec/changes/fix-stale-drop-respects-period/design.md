# Design — fix-stale-drop-respects-period

## Context

动机与代价数字见 proposal.md。本文件只记判据怎么算、以及为什么不是"改上限"或"改文案"。

现状（读码）：

| 事实 | 位置 |
|---|---|
| 丢弃判据只看等待时长，不看周期 | `task-engine.js` 的 `dropIfStaleQueued`：`t.trigger !== "schedule" \|\| t.queuedBy === "human"` 即豁免，然后是纯年龄比较 |
| 两处生效：出队时与周期清扫 | 同函数被出队路径与 `sweepStaleQueuedFires` 共用，所以改一处即两处生效 |
| 丢弃即终局 | `finishExecution(t, ..., { skipped: true })`，不补跑、不计 `missed`，下一次排期才重来 |
| 周期字段已存在 | `task-engine.js` 的 `t.interval`（unit/number/anchor），与 `clientShape` 一同序列化 |
| 产线上限 | `QUEUE_MAX_AGE_MS=600000`（`fd-infra-deploy/all-services/prod/platform.yaml`） |

## Goals / Non-Goals

**Goals**

- 让丢弃判据认识"这个任务的下一班多久来"，使丢弃的代价有界。
- 让 error 文案不再对长周期任务说谎。

**Non-Goals**

- 不改 `QUEUE_MAX_AGE_MS` 的默认值或产线取值（那是容量/延迟权衡，不是本 bug）。
- 不改 `queuedBy === "human"` 的豁免（点火的那一轮从不因老化被丢，这是既有正确行为）。
- 不引入补跑机制（那是另一个议题：`missed` 的语义与 catch-up 窗口）。

## Decisions

### D1. 判据用「周期 > 上限 ⟹ 豁免」，而不是「周期 ≤ 上限 × K ⟹ 豁免」

理由：代码只可能知道"周期"与"上限"两个数，任何常数 K 都是凭空的。选择语义上最干净的那条——**丢弃必须在时限内有接替者**，这正好等价于「周期 ≤ 上限」。

**替代方案**：豁免所有 `interval` 为天的任务（硬编码白名单）。否决——周更、月更、以及"每 40 天"这类区间单位（cron 五段表达不了，本仓已支持）都会被漏掉。

### D2. 判不出周期时保持既有行为（丢弃），不放宽

数据不全时收紧方向应当偏向"不改变现状"。若反过来（判不出就豁免），一个字段缺失就会让队列里堆满永不丢弃的过龄轮，等于把有界策略静默关掉——这是更坏的失败模式。

**替代方案**：判不出周期也豁免。否决，理由同上。

### D3. 文案与处置一致，而不是统一文案

现有文案断言"由下一次排期接替"。对豁免的那批这正是**不能**说的话。让文案跟着分支走，比统一成模糊表述更好：读日志的人能直接看出这一轮是丢了还是留着。

### D4. 落点是同一个函数，不是新加一层过滤

`dropIfStaleQueued` 同时服务出队与清扫两条路径。在函数内加周期判定，两条路径自动一致；若在调用处各加一次，将来很容易只改一条（本仓已有这类前例）。

## Risks / Trade-offs

- **[风险] 豁免会把 `queueHealth().degraded` 顶成 true，进而让 `/readyz` 常亮 503** —— 这是本单最尖锐的一条，链条已核实：
  ```
  degraded = stalled || overBudget > 0 || orphaned > 0
  stalled  = oldestQueuedMs > QUEUE_MAX_OLDEST_QUEUED_MS && !settledRecently
  ```
  被豁免的长周期轮会一直留在 `queued`，`oldestQueuedMs` 持续累积 → `queuedTooLong` 恒真。
  只要该 cell 还有别的回合在settle，`settledRecently` 为真、`stalled` 为假，没事。
  **但一旦它是队列里最后一条、且 cell 再没有回合收口**（豁免期间正好空闲），
  `settledRecently` 在 10 分钟后转假 → `stalled` 为真 → `degraded` → cell 侧 `/api/ready` 503
  → 网关 `/readyz` 聚合出 `degradedCells` → 200 变 503。**一条在等槽的日更轮，能把整个平台标成未就绪。**

  → 缓解（纳入实施要求）：**被豁免的轮 SHALL NOT 参与 `oldestQueuedMs` 的取最大**，或等价的显式豁免——
  即"永不丢弃"的任务不能同时充当"队列卡住"的证据。宁可让健康指标看不见它，
  也不能让它把一个健康但空闲的 cell 判成 stalled。
- **[风险] 被豁免的长周期轮长期占位，看起来像积压** → 缓解：豁免只影响"是否丢弃"，不占用槽位；观测面按上一条处理后，`oldestQueuedMs` 反映的仍只是可丢弃的那批。
- **[风险] 日更轮被豁免后仍要等槽，可能等到下一班才跑（跑了也是过期的）** → 缓解：这是取舍的另一半。至少它跑过；若将来要区分"过期但仍有意义"，那是内容层判断，不属于队列策略。
- **[风险] 与 `fix-operator-ignition-priority` 同时上线时，队列瞬时深度上升** → 缓解：两单的建议上线顺序是**先本单、再开点火开关**，观察一轮 `oldestQueuedMs` 与 `skipped` 计数后再决定。

## Migration Plan

- 无数据迁移、无部署顺序硬要求；但建议顺序：本 change 出片 → 观察一个日更周期 → 再设 `QUEUE_HUMAN_PRIORITY=1`。
- 回滚：反向改判据即可（无状态、无迁移）；`QUEUE_MAX_AGE_MS=0` 是最快的应急总闸。

## Open Questions

（无——判据、边界与文案都已定；剩下的是实施与观测。）
