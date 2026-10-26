## Purpose

Defines the in-cell scheduled-task engine: creating, persisting, and firing prompt jobs bound to a specific agent preset and session, with timezone-aware schedules and deterministic behavior around busy turns, runtime restarts, and downtime.

## Requirements

### Requirement: Job scheduling API
The system SHALL support creating one-shot tasks (run once at a specific time) and recurring tasks (run on a cron schedule) — tasks whose trigger is a schedule — each with a prompt and its target-persona/session binding carried by the task. Management operations — list, remove, pause, resume, and run-now — SHALL remain available over the existing cell WebSocket surface using the existing `cron_*` message and event types, operating on tasks with schedule triggers.

#### Scenario: Create a recurring job
- **WHEN** a client sends a job-create request with a cron expression and a prompt
- **THEN** the system SHALL create a task with a schedule trigger and broadcast its status with an identifier, schedule, and next-run time

#### Scenario: Create a one-shot job
- **WHEN** a client sends a job-create request with an absolute time and a prompt
- **THEN** the system SHALL create a task scheduled to run once at that time

#### Scenario: Pause and resume
- **WHEN** a task with a schedule trigger is paused
- **THEN** its schedule SHALL stop firing until it is resumed
- **AND** on resume a recurring task SHALL continue from the next future occurrence

#### Scenario: Run now
- **WHEN** a run-now request is sent for a task
- **THEN** the task SHALL execute once immediately regardless of its schedule, without affecting future scheduled occurrences

### Requirement: Jobs persist across restarts
All tasks with schedule triggers SHALL be persisted atomically with the engine's task records and restored when the cell starts, with recurring schedules rescheduled automatically; execution-level restart semantics (queued resumes, running becomes interrupted) are the engine's.

#### Scenario: Restore after restart
- **WHEN** the cell starts and persisted schedule-triggered tasks exist
- **THEN** enabled recurring schedules SHALL be rescheduled
- **AND** one-shot schedules whose time has not passed SHALL remain scheduled

#### Scenario: Atomic persistence
- **WHEN** a task or schedule mutation is persisted
- **THEN** the storage write SHALL be atomic, such that a crash mid-write cannot corrupt previously stored tasks

### Requirement: Schedules are timezone-aware
A job MAY carry an IANA timezone identifier. When present, its cron schedule SHALL be evaluated in that timezone. When absent, the schedule SHALL be evaluated in the cell's local timezone.

#### Scenario: User timezone applies
- **WHEN** a job is created with cron `0 9 * * *` and timezone `Asia/Shanghai` on a cell running in UTC
- **THEN** the job SHALL fire at 09:00 Asia/Shanghai time

#### Scenario: Legacy job falls back to cell timezone
- **WHEN** a persisted job carries no timezone
- **THEN** its schedule SHALL be evaluated in the cell's local timezone, matching pre-change behavior

### Requirement: Downtime and expiry lifecycle
Recurring schedules whose occurrences passed entirely while the runtime was down SHALL NOT catch up; the gap SHALL be recorded on the task as a missed marker. One-shot schedules whose time passed while down SHALL mark their task expired at load.

#### Scenario: Missed occurrences are not replayed
- **WHEN** a daily task's cell was down across one scheduled occurrence and starts afterwards
- **THEN** the missed occurrence SHALL NOT execute
- **AND** the task SHALL record a missed marker for it
- **AND** future occurrences SHALL fire normally

#### Scenario: One-shot expired during downtime
- **WHEN** the cell starts and a one-shot task's time is in the past
- **THEN** the task SHALL be marked expired without executing

### Requirement: 舰队成员回合的子进程对话逐回合全新

舰队成员岗位（任务携带 fleetId sourceTag——节奏触发、委托唤醒、事件唤醒同一执行缝）的
回合在设计上无状态：提示模板与舰队上下文（直属岗位末次报数、在岗总览）每回合现算注入，
历史对话对回合产出没有贡献。实现 SHALL 与该模型一致：每个舰队成员回合 SHALL 以**全新
的子进程对话**执行——运行时子进程 MUST NOT 回放此前回合的对话状态，回合启动 MUST NOT
因旧账压缩而显著劣化。子进程对话 id 与宿主专属会话（镜像）id 解耦：镜像 SHALL 维持单一
稳定会话、每回合转写行继续追加供人阅读，侧栏 SHALL NOT 因轮换出现每回合一个新会话；
子进程侧对话在回合收尾（子进程转闲）SHALL 获得 best-effort 清理，清理失败 MUST NOT
影响后续回合（后续回合的全新对话 id 不依赖清理成功）。不携带 fleetId sourceTag 的普通
定时任务 SHALL 维持既有「绑定会话续执行」语义，本需求不改变其行为。

#### Scenario: 舰队回合不续旧账

- WHEN 一个舰队成员岗位第 N+1 次节奏触发，第 N 回合及更早的转写已完整落盘
- THEN 本回合以全新子进程对话执行，子进程不回放第 N 回合及更早的历史
- AND 连续多回合执行中，回合启动耗时 SHALL NOT 随回合数增长而显著上升

#### Scenario: 镜像会话稳定可读

- WHEN 一个舰队成员岗位逐回合执行
- THEN 岗位专属会话保持单一镜像会话，每回合的用户提示与产出继续追加其中可读
- AND 会话列表不因子进程对话轮换而增加条目

#### Scenario: 子进程孤儿回收且失败无害

- WHEN 一个舰队成员回合收尾、子进程转闲
- THEN 平台对该回合的子进程对话发起 best-effort 清理
- WHEN 清理被运行时拒绝或不支持
- THEN 记一条警告日志，下一回合仍以全新对话 id 正常执行

#### Scenario: 普通定时任务语义不变

- WHEN 一个不携带 fleetId sourceTag 的普通定时任务触发
- THEN 其绑定会话的续执行语义与本 change 之前一致

### Requirement: 模型车道按身份键控熔断与降级重试

模型车道 SHALL 以**车道身份**为熔断与降级的判定单元:车道 id SHALL 由该车道实际使用的 provider 派生(`providerId|baseURL|凭据指纹` 的哈希前缀,MUST NOT 含明文密钥)。当日 cell 内全部模型解析到同一 provider 时,行为自然退化为 cell 级;未来 per-agent/per-岗位 车道配置落地时,各车道 SHALL 自动获得独立熔断,本机制 MUST NOT 因车道拓扑变化而需要语义迁移。

熔断 SHALL 采用滑动窗:窗口内(默认 10 分钟,可配)该车道模型上游失败达阈值(默认 5 次,可配)即开窗一段冷却期(默认 10 分钟,可配),并提供总闸(默认开)。开窗期内触发的舰队成员回合 SHALL 被**跳过**而非失败——记 skipped 回合事件、不消耗模型预算、不计入岗位连续失败;在岗派生照常推进。窗口内出现成功调用 SHALL 立即关闭熔断(半开探测即成功)。被跳过与熔断状态 SHALL 在管理面可见(车道 id、开窗截止时刻、窗口内失败数)。

上游失败(5xx/连接类,快速失败)时,若该岗位模型解析链存在未试候选,SHALL 以下一候选模型**重试一次**(同回合内),并在回合 detail 记 `degradedTo`;重试仅限上游类失败且回合启动未超过短窗(默认 60 秒)——超时与工具类失败 SHALL NOT 触发重试。链上全部候选耗尽 SHALL 如实失败。

#### Scenario: 单车道退化为 cell 级

- **WHEN** cell 内全部岗位解析到同一 provider 且 10 分钟内该 provider 连续 5 次上游 5xx
- **THEN** 该车道熔断开窗,后续节奏回合被跳过并记 skipped,窗口结束后下一回合正常执行

#### Scenario: 多车道各自独立

- **WHEN** 两个岗位分别配置不同 provider(key/baseURL 各异),车道 A 上游持续 5xx 而车道 B 正常
- **THEN** 仅车道 A 熔断;车道 B 的岗位回合照常执行,互不影响

#### Scenario: 成功即关闸

- **WHEN** 熔断开窗冷却结束后的第一个回合成功
- **THEN** 熔断关闭,计数清零

#### Scenario: 明文密钥不落日志

- **WHEN** 任意车道事件与熔断日志输出
- **THEN** 只出现车道 id 哈希前缀与 baseURL,不出现 key 材料

#### Scenario: 降级重试一次

- **WHEN** 岗位声明模型链 [A, B],回合以 A 启动后 20 秒收到上游 502
- **THEN** 本回合换 B 重试一次并继续完成;detail.degradedTo=B;若 B 也失败则回合如实失败

#### Scenario: 超时不触发重试

- **WHEN** 某回合因预算超时结束(非上游快速失败)
- **THEN** 不发生模型重试,回合按既有超时语义记 failed + detail 归因
