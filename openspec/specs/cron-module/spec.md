## Purpose

Defines the in-cell scheduled-task engine: creating, persisting, and firing prompt jobs bound to a specific agent preset and session, with timezone-aware schedules and deterministic behavior around busy turns, runtime restarts, and downtime.

## Requirements

### Requirement: Job scheduling API
The system SHALL support three schedule forms for tasks whose trigger is a schedule: one-shot at an absolute time, one-shot at a relative delay from acceptance, and recurring either on a cron expression or on an every-N interval rule (number 1–200 × unit minute/hour/day/week/month/year, optionally pinned to a time-of-day phase). A recurring task MAY carry a maximum run count; on reaching it the task transitions to completed automatically. Each task carries a prompt and its target-persona/session binding. Management operations — list, remove, pause, resume, run-now, and **update** (change name/prompt/schedule/max-runs while preserving the task id, its execution history, and its paused state) — SHALL remain available over the existing cell WebSocket surface using the existing `cron_*` message and event types.

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

### Requirement: Relative one-shots are anchored to the server's real clock
A create request carrying a relative delay SHALL be resolved by the server at acceptance time into an absolute run time computed from its own clock; the server SHALL NOT accept a client-computed wall time for the relative form, and SHALL reject delays that are not positive. The stored task SHALL carry the resolved absolute time so restart restores it unchanged.

#### Scenario: 「8 分钟后」 lands eight minutes out
- **WHEN** a client creates a one-shot with a 8-minute relative delay
- **THEN** the resolved run time is creation time + 8 minutes on the server clock, and the broadcast shows that absolute occurrence

#### Scenario: stale client cannot schedule in the past
- **WHEN** a client tries to express a one-shot for a moment that has already passed
- **THEN** the create is rejected with a structured error instead of silently deferring to a future date

### Requirement: Interval rules are the truth, human text is derived
For a recurring task on an every-N interval, the next occurrence SHALL be computed from the stored rule (anchor, unit, number, optional time-of-day phase), not from a coerced cron approximation. Unit/number combinations the five-field cron cannot express (e.g. every 40 days) SHALL be schedulable. Locale human-readable renderings are presentation only and MUST NOT feed back into scheduling math.

#### Scenario: every 40 days schedules correctly
- **WHEN** a task is created with interval unit=day, number=40
- **THEN** occurrences step 40 days apart from the anchor and the list renders a localized phrase without any cron coercion

### Requirement: Finite runs close themselves out
A recurring task with a maximum run count SHALL count completed scheduled executions (run-now and re-runs included as completed executions), transition to `completed` on reaching the cap, stop firing, and expose progress (executed/cap) on the task record.

#### Scenario: task retires at its cap
- **WHEN** the third run completes for a max-runs=3 recurring task
- **THEN** the task shows `completed`, no further occurrences fire, and history retains all three runs

### Requirement: Update preserves identity and history
An update changing the schedule SHALL recompute the next occurrence from the new form while keeping the task id, its execution history, and its paused state. An update MAY change name, prompt, schedule form, and max-runs; changing the target persona/session binding is not part of update.

#### Scenario: reschedule keeps the record
- **WHEN** a running-since-weeks daily job is updated to `0 10 * * 1-5`
- **THEN** the same id keeps its history rows and now fires weekday 10:00, unpaused if it was unpaused

### Requirement: 驻留回合的岗位持有自身 persona 的工具面

驻留（parked）回合的岗位 SHALL 以**该回合自身的目标 preset** 组合其工具面：其可用的
MCP server 与工具 allowlist SHALL 来自该 preset 自身的声明，SHALL NOT 来自运行时部署默认
preset 的组合。运行时部署默认 preset 不被定时车道移动这一纪律 SHALL 保持成立。

实现上 SHALL 以「按 preset 分段」的方式供给（每个已装 persona 一节精确面 + 一份并集上界），
SHALL NOT 通过「为每回合重写部署级 patch」实现——后者需要子进程重载，等于退回重启。

#### Scenario: 驻留岗位拿到自己的工具

- **WHEN** 一个 persona 岗位以驻留方式执行回合，其 pack 声明了若干 MCP server 与工具 allowlist
- **THEN** 该回合会话内可按工具检索命中该 pack 声明的工具，SHALL NOT 缺位

#### Scenario: 驻留岗位不被默认 persona 的面顶替

- **WHEN** 某 cell 的运行时部署默认 persona 声明了另一组 server 与工具
- **THEN** 驻留回合的工具面按该岗位自己的声明组合，不被默认 persona 的 allowlist 顶替

#### Scenario: 未声明 allowlist 的岗位按既有语义回落

- **WHEN** 某 persona 未声明自己的工具清单，但其所属 pack 在 pack 级声明了 allowTools
- **THEN** 该岗位的面按既有派生语义回落到 pack 级声明，SHALL NOT 凭空收窄或放大

#### Scenario: 默认 persona 不动仍成立

- **WHEN** 驻留回合执行前后
- **THEN** 运行时部署默认 preset 与其组合面保持回合前的值，用户对话车道不受影响
