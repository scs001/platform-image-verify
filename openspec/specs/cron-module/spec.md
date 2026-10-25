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
