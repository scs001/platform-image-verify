# 多智能体协同审计：单 agent 配置面 × 多 agent 协同面（multi-agent-collaboration）

> 2026-11-08 `/opsx:explore` 收口。**状态：调研完成、未立项**——本文是后续 change 切片的单一事实源。
> 起点命题：用户问「系统现在的多智能体协同有什么地方需要优化」，收窄为两面——**单 agent 的可配置项** 与
> **多 agent 的协同**。
> 伞文档关系：执行底座（承载/并行/记忆/计量）归 `docs/agent-parallel-execution-explore.md`；编排范式
> （编导代数 O1-O5 / 三层承载）归 `docs/fleet-orchestration-scale-explore.md`；产品路线归
> `docs/roadmap-agents-native-teams.md`。**本文只做一件事：把「声明」与「事实」逐条对照**，不改范式、不提新范式。
> 调研基线：paas 仓生产代码逐处读证（行号在案）+ `docs/registry-maintenance.md` 台账 + 既有测试断言；
> 两轮共 11 个并行切片 + 主线 8 处直核。证据等级见 §二。

---

## 一、结论先行

1. **骨架没有问题，欠的是「声明与事实的差」。** 六种边（trigger/dispatch/handoff/fanout/event/report）×
   三种聚合（all/first/judge），执行面永远只有任务引擎 + delegation 车道，没有第二调度器。这套语法比
   多数开源框架清楚；问题全部出在**声明了但没兑现**的地方。
2. **八类回合，只有两类拿到完整团队上下文。** 定时/补跑回合有报数 + 自己历史 + 健康 + 决策 + 记忆 + 文档；
   派发/接棒/扇出/事件唤醒四类**零上下文**（只有一段手拼的散文）；裁决回合有历史但没有上下文；web 聊天只有花名册。
   同一个岗位在「定时回合」和「接棒回合」是两个不同的人。
3. **两个配置旋钮死在 600s 硬编码上。** `cadence.turnTimeoutMs`（岗位回合预算）与
   `constraints.budgetPerEdgeMin`（每跳预算）同一根因失效；而驾驶舱**对外展示了「每跳预算:10min」**
   （默认值恰好也是 600s，所以一直没人发现）。
4. **A2A 委托的超时是空转，且定时器写错了对象。** 本机实证：`timeoutMs=400` 的委托调用在 3009ms 仍未结算
   （【实】）；而定时器回调里写的是 `signal?.abort()`——`AbortSignal` 没有 `abort()`，任何传了 signal 的调用方
   会在定时器里抛未捕获 `TypeError`（全仓无 `uncaughtException` handler）。现行人聊形态靠「调用方自己的 timer
   先注册、先 abort、`finally` 清掉内部 timer」侥幸不炸（实测 416ms 干净 `ABORTED`），属**定时器顺序掩护下的地雷**。
5. **成本记了但看不见。** `member_turn_daily` 已有四个 USD 估算列，但没有任何读 API 暴露；`/spend`、
   `/runs`、`/cockpit` 全只给 token。裁决/汇总回合连成本行都没有。
6. **改动窗口是干净的。** 台账 15 条协同缺陷已修，仓内**无在途 fleet change**，不会与并行会话撞车。

---

## 二、方法与自我纠错

证据等级：**【码】** 代码直读（file:line 在案）｜**【产】** 生产台账/文档实证｜
**【实】** 本机可复现实验（脚本与实测数字在案）｜**【推】** 推断未验证。

第一轮给出的三条判断在第二轮被推翻，记录在此以免后来者重踩：

| 首轮判断 | 纠正 | 证据 |
|---|---|---|
| `{{fleetContext}}` 只在定时车道展开 | 注入缝已统一到引擎 `beforeTurn`，覆盖四条入队路径；但**只在 prompt 含占位符时替换**。结论（下游没上下文）成立，机理不同 | `cron.js:295-350`、`task-engine.js:662-671` |
| 记忆说话权只在 pack 层 | 每岗 `d/<fleetId>/<memberId>` 隔离 + 舰队共享 `d/<fleetId>/shared` + 遗留 `f/<fleetId>` 可读，三者都注入 | `yongyi-client/dist/facts.js:26-32,162-207` |
| persona 串行因 `cron-runner.js:943` 注释 | 那句说的是 **cluster 成员**；fleet fanout 串行真因是 `TASK_WORKER_MAX=0` + 单条 `executionQueue` | `cron-runner.js:941-946`、`worker-slots.js:55-58`、`task-engine.js:616-618` |
| `cadence.turnTimeoutMs` 生效 | **全路径失效**（见 §3.2 D1；11-07 已挂账、有生产实证） | `task-engine.js:683` |

另有一条方法论教训沿用 §15.20：**判断「未发生」前先质疑探针的过滤面**（fanout「未起」曾是假阴性）。

---

## 三、单 agent 可配置面

### 3.1 配置矩阵（含运行时有效性）

| 字段 | 写入面 | 生效? | 证据 |
|---|---|---|---|
| title / parentId | POST `fleets.js:3086-3087` + PATCH `:3122,3142` | ✅ | 环检测 `:3138` |
| targetKind / targetId（在岗者） | POST `:3088-3089` + 换防 `:3284` | ✅ | 枚举/存活门 `:3045,3048` |
| kpiSlots | POST `:3090` + PATCH `:3127` | ✅ | 上限 `KPI_SLOT_LIMIT` |
| cadence.cron/tz/promptTemplate/enabled | POST `:3091` + PATCH `:3154` | ✅ | 归一 `:191-233` |
| **cadence.turnTimeoutMs** | PATCH `:212-222` | ❌ **死** | 见 D1 |
| model / fallbackModel | POST `:3092-3093` + PATCH `:3159-3160` | ✅ 真降级重试 | `cron-runner.js:810-891` |
| effort | **仅 PATCH** `:3169` | ✅ `setModel({effort})` | `cron-runner.js:464`、`agent-session.js:224-271` |
| contextBudget | **仅 PATCH** `:3170` | ⚠️ 只事后判超，不进请求 | `fleet-events.js:122-145` |
| carrier / packId | **仅 PATCH** `:3175,3185` | ✅ 路由生效；`auto` 简化（永不路由 runner） | `cron-runner.js:35-53,1378-1397` |

舰队级（`fleets` 行 + `orchestration`）：`name/state/default_model/effort/context_budget/orchestration/delegation_policy`
（`fleets.js:2959,2975,2966,2993,2994,2986,2237`）；`constraints.maxChainDepth` 默认 8 上限 32、
`spanMax` 默认 8（**仅警告**）、`budgetPerEdgeMin` 默认 10（**失效**）、`constraints.carrier`
（`fleet-orchestration.js:17-38,228`）。

**无写入面（全仓 NOT FOUND）**：岗位级工具白名单、岗位级花费上限、岗位级重试策略、
`cadence.promptTemplate` 之外的常驻岗位说明。

### 3.2 五个问题

| # | 问题 | 证据 | 等级 |
|---|---|---|---|
| D1 | **`cadence.turnTimeoutMs` 全路径失效**：引擎每次回合硬写 `{turnTimeoutMs: TURN_TIMEOUT_MS}`（600s），`cron-runner` 的 `turnTimeoutMs || resolveTurnBudgetMs(job)` 因此永不回落岗位声明。生产实证：设 1200000 仍 621s 被杀（`detail.kind=turn_budget_exceeded`） | `task-engine.js:24,683`、`cron-runner.js:114-128,1284` | 【码】【产】 |
| D2 | **建岗静默丢 4 字段**：POST 只读 title/parentId/target*/kpiSlots/cadence/model/fallbackModel，带 effort/contextBudget/carrier/packId 建岗 → 201、值丢、不报错 | `fleets.js:3036-3094` vs `:3169-3185` | 【码】 |
| D3 | **`effort: null` 不清活体等级**：只跳过 switch，运行时会沿用上一岗的等级 | `agent-session.js:224-271` | 【码】 |
| D4 | **无岗位级花费闸**：唯一事前闸是按模型的 `checkBudget(model)`（日/月 token，拦的是模型跳变不是回合）；`dailyBudget` 是拍板条数不是钱 | `model-budget.js:145-155`、`fleets.js:1812` | 【码】 |
| D5 | **配置与 UI 声明不一致**：驾驶舱对外显示「链深上限:8 / 每跳预算:10min」，其中每跳预算是死的；默认值 600s 恰好等于硬编码值，掩盖了失效 | `§15.21 补记`、`fleet-orchestration.js:21` | 【产】【码】 |

---

## 四、多 agent 协同面

### 4.1 回合输入矩阵（本文核心）

| 回合类型 | 身份行 | 团队上下文 | 记忆 | 决策 | 上游/简报（截断） | 会话历史 |
|---|---|---|---|---|---|---|
| 定时 fire | ✅ `cron-runner.js:728-729` | ✅ 4KB/子 + 24KB 池 + 自历 3 轮 | ✅ 2400 | ✅ ≤5 条 | — | ✗ 轮转清空 |
| 补跑 fire | ✅ | ✅ 同上 + `【补跑】`前缀 | ✅ | ✅ | — | ✗ |
| 手动立即执行 | ✅ | ❌ 被决策段**顶掉** | ❌ | ✅ 仅决策 | — | ✗ |
| 派发子回合 | ✅ persona｜❌ a2a/tool | ❌ | ❌ | ❌ | brief 4000 字 | ✗ |
| 接棒子回合 | ✅ persona｜❌ a2a/tool | ❌ | ❌ | ❌ | 上游 2000 字 / 失败 500 字 | ✗ |
| 扇出子回合 | ✅ persona｜❌ a2a | ❌ | ❌ | ❌ | 同接棒 | ✗ |
| 事件唤醒 | ✅ persona｜❌ a2a | ❌ | ❌ | ❌ | 消息 4000 字 | ✗ |
| 裁决汇总回合 | ❌ | ❌ | ❌ | ❌ | 每任务 120 + 400 字 | ✅ 有 |
| web 聊天 | ❌ | 花名册（仅标题，无 id） | ✅ 1500 | ❌ | 用户文本 | ✅ |

根因【码】：注入缝是占位符驱动的（`cron.js:327-333`），而派发/接棒/扇出/唤醒的 prompt 是手拼的、都不含
占位符（`fleets.js:1084-1086`、`fleet-handoffs.js:101-108,153-164`、`fleet-event-wake.js:44-49`）。
裁决回合则根本不经过任务引擎（`delegation-aggregator.js:151-175` 直接 prompt），所以连身份行都没有。

### 4.2 分组与回投语义（initiator 三个值域）

`groupFor(initiator)` 只按 `trigger==="manual" && initiator===X && !aggregated` 分组，**没有 wave/run 维度**
（`delegation-aggregator.js:30-34`）；`wave` 字面量恒为 1 且从不被读（`fleet-handoffs.js:159`）。

三个创建点决定三套语义：

| 创建点 | initiator 取值 | 后果 |
|---|---|---|
| 扇出（无 judge） | `job.sessionId`（上游岗的镜像会话） | 同一岗的多波会并成一组；**未传 `initiatorPreset`** → 聚合器 reanchor 拿 null 直接返回 → 汇总回合跑在运行时默认人格上（`fleet-handoffs.js:160-162`、`delegation-aggregator.js:96`） |
| 扇出（judge） | `fleet:<fleetId>:<judgeId>` + `initiatorPreset` | 同一 judge 的多条边/多波会并成一组；合并还是分开取决于时序 |
| 派发 dispatch_post | `chatHistory.currentSessionId()` = **UI 会话指针** | web 聊天车道正确（派发者就是当前会话）；**定时车道错位**——落进人类当前聊天或没人读的 `platform-*` 会话，派发岗下一回合收不到（`fleets.js:1112`、`chat-history.js:330`、`server.js:1013`） |

派发车道的错位行为被 `test-fleet-orchestration.mjs:237`（`assert.equal(task.initiator, "sess-sup")`）钉住，
但该测试只覆盖 web 车道，没有覆盖定时巡逻里的派发。

### 4.3 报数 / 决策 / 横向可见性

- **报数可见性 = 直属下级一层**（`fleet-context.js:325-327,341-353`）：同级互不可见，上级看不见下级以外，
  祖辈只能靠中间岗转述。
- **`report` 边是死语法**：枚举里有 `report`（`fleet-orchestration.js:14`），全仓没有任何按
  `kind==="report"` 的消费者；报数拓扑实际只由 `parentId` 决定。声明一条与 `parentId` 相悖的 report 边，零效果。
- **决策只能上行到本舰队 owner/deputy**（`fleets.js:1781-1807`、`fleets-db.js:1795-1801`）；
  无岗位→岗位的磋商通道。唯一的横向读面是 deputy 队列（读同舰队 `route=deputy` 条目 + 来源岗一行摘要，
  `fleets.js:1951-2006`）。
- **跨舰队结构性不可能**：派发目标只在本舰队解析（`fleets.js:1057`），点火时外舰队目标直接 `continue`
  （`fleet-handoffs.js:49,134`），事件唤醒同理（`fleet-event-wake.js:93-95`）。
- **peer / blackboard 是保留未实现**（`turn-request.js:16-21`），`assertTurnRequest` 全仓**无调用方**
  → agent-turn-contract 未强制。

### 4.4 记忆与产物

- **记忆是三层**：每岗 `d/<fleetId>/<memberId>` 隔离、舰队共享 `d/<fleetId>/shared`
  （turn/health 落 own；decision-opened/resolved/swap 落 shared）、遗留 `f/<fleetId>` 可读
  （`facts.js:26-32,162-207`）。注入梯有降级（digest → 标题 → 无），记忆缺席不阻塞回合。
- **产物只能传散文**：接棒/扇出把上游 `out.text.slice(0,2000)` 拼进 prompt（`fleet-handoffs.js:98-100`）；
  `dispatch_post` 只收 `{to, brief}`、brief 截 4000（`fleet-mcp.js:124-137`、`fleets.js:1091-1094`）；
  `delegate_task` 只收 `{persona|agent, prompt, name}`。**没有任何 payload 能携带附件/句柄**。
- **现成最好的句柄**：workspace 相对路径（所有岗位共享同一个 cwd，`server.js:810`、`dsh-bridge.js:117`）
  或 library doc id（agent 可经 `mcp__library__read_document` 读，`server/library-mcp.js:45-115`）——
  但两者都只能靠模型自己在散文里抄写。
- 共享 cwd 是双面的：它事实上是当前唯一的跨岗协作通道，同时没有 per-member 文件隔离。

### 4.5 跨部署（A2A）

- 端点/头：`message/stream` + `X-Authorization`（owner 个人 registry 凭据，否则服务凭据）+ `Authorization`
  （agent 凭据）+ `X-Delegation-Depth`（`a2a-client.js:63-70`）。
- **深度界在代码里是 3**（`a2a-client.js:13,71-73`；runner 侧同样 3，`agent-runner/a2a.js:126`），
  但**出站恒 `depth: 1`**（`cron-runner.js:518`，"chains get +1" 被标为 future state）→ spec 的逐跳 +1 未实现。
- **超时是空转**：`const timeout = setTimeout(() => signal?.abort(), timeoutMs)`，而委托路径不传 signal
  （`a2a-client.js:54,75`、`cron-runner.js:515-522`），且全仓无 `Promise.race` → 不响应远端可无限期占住串行槽。
- **不做能力协商**：不读远端 `/.well-known/agent-card.json`，discovery 只有 `id/name/description/category/tags/url`；
  `search_agents` 上限硬编码 8（`delegation.js:170-178`）。
- **市场侧没有「团队即一个 agent」**：部署严格按 role 单条注册（`openspec/specs/a2a-agent-serving/spec.md:10,17`），
  无 team 级 AgentCard；舰队目前只能**逐个调**远端 agent，不能被当成一个 agent 调。

### 4.6 并发与准入【码】

- `TASK_WORKER_MAX=0` → `attachWorkerPool` 在注册 slotDispatcher 前就返回，全部回合落到单条
  `executionQueue` 串行链 → fanout「并行波」墙钟 = Σ 各目标。
- `TASK_WORKER_MAX>0` → 真并发；**同 persona 的两个目标会各起一个 worker**（池不按 persona 去重）。
- 主链无优先级/抢占（`task-engine.js:56,616-631`）；人类聊天只靠 `waitForIdle` 让路，worker 回合不调它。
  人优先槽只在池激活时存在，且只由 owner execute-now 打标。
- `FLEET_MAX_INFLIGHT`（默认 4）只在池激活时生效；cap=0 时准入只有派发频次（3/岗/15min、30/舰队/h）
  与深度界、事件唤醒 30/岗/h。
- 无整链/整 run 花费闸；无取消 run 的入口；`spanMax` 只 warn。

### 4.7 计量与可见性

- `member_turn_events` 已有 usage×5、`queue_wait_ms`、`spin_up_ms`、`ttft_ms`、`carrier`、`provider`、
  `effort`、`depth`、`wave`、`pricing_at`（`fleets-db.js:301-379`、`fleet-events.js:159-263`）。
- `member_turn_daily` 已有四个 USD 估算列 + 保留期永久（`fleets-db.js:393-441`），同一缝原子 upsert。
- **但没有任何读 API 暴露美元**：`GET /:id/spend`、`/owner/board`、`/:id/runs(/:runId)`、`/:id/cockpit`
  全只给 token；`edgeTraffic` 只有 turns/ok/failed；`cost_*_usd` 的唯一读者是内部周报记忆摘要
  （`fleet-cost-digest.js:161-166`）。
- **裁决/汇总回合零成本行**：`recordFleetTurnEvent` 只在 `cron-runner.js:1308,1402`；聚合器走
  `ctx.session.prompt` / `dshBridge.prompt`，不过任务引擎 → 无任务、无 row、无 run。

---

## 五、缺陷清单

### P0 — 语义违背 / 可用性

| # | 缺陷 | 证据 | 等级 |
|---|---|---|---|
| P0-1 | 五类回合零团队上下文（§4.1） | `cron.js:327-333` + 各 prompt 构造点 | 【码】 |
| P0-2 | **A2A 委托超时空转 + 定时器对象写错**（【实】timeoutMs=400 在 3009ms 仍未结算；传 signal 时定时器抛未捕获 `TypeError: signal?.abort is not a function`，无全局 handler；现行人聊形态靠 timer 注册顺序侥幸不炸，实测 416ms 干净 ABORTED） | `a2a-client.js:54,75`、`cron-runner.js:515-522`、`agent-session.js:751-769` | 【码】【实】 |
| P0-3 | 每跳预算 + 岗位回合预算双双失效（D1） | `task-engine.js:683` | 【码】【产】 |
| P0-4 | dispatch 结果回投错位（web 车道对、定时车道错） | `fleets.js:1112`、`server.js:1013` | 【码】 |
| P0-5 | 非 judge 扇出未传 `initiatorPreset` → 汇总人格错位 | `fleet-handoffs.js:160-162`、`delegation-aggregator.js:96` | 【码】 |

### P0′ — 产线实测新增（2026-11-08 夜，读面取证，未立项）

> 来源：今晚五次滚动后在产逐 cell 读 `fleets.db/member_turn_events` 与 `trace.db`（48 个 cell、14 个有舰队库）。
> 记录在此是因为它**比清单里任何一条 P2 都严重**，且与本轮改动无关——不是今晚弄坏的。

| # | 缺陷 | 证据 | 等级 |
|---|---|---|---|
| P0′-1 | **（已修，见下行归档）** 单轮任务量超过上下文预算 → 压缩反复触发 → 到点被砍且零产出**：今日 143 回合仅 82 成功（57%）；28 条失败为 `turn_budget_exceeded`（都卡在 600s），其中 **22 条该窗口内没有任何报数**——整轮白跑。抽一条 trace：240 事件跨 535s，大间隔（15–49s）全在 `compaction/start|summary|end` 与 `platform/stream`，最后事件停在 `compaction/start`。**已排除**「边回合未轮转会话 id」：`roundChildSessionId` 生效（trace 落的是镜像 id，见 `fleet-runs.js:349-357` 注释），且这些任务 647/805 条有 `sourceTag.fleetId`。故归因是**单轮内容 >> 上下文窗口**（容量/口径），修法涉及压缩策略与单轮输入上界，属产品决策 | `trace.db` turn_78aae05dca1642a982dd；`fleets.db` 28 条 `turn timed out`；`member_reports` 交叉查询；`jobs.json` sourceTag 统计 | 【产】 |
| P0′-2 | ~~已修~~ **（2026-11-08 收口，镜像 sha-e8799d7）** 昨日额度打满的余波：**441 条 `budget_exhausted: all candidate models over daily/monthly budget`**（最后一条 2026-11-07T22:17Z），集中在两个 cell（350/91）。不是代码缺陷，但说明舰队在额度耗尽时是**成批静默失败**，管理面没有上限预警 | `member_turn_events.error` 聚合 | 【产】 |

**处置（2026-11-08 收口）**：`fix-fleet-output-salvage`（镜像 sha-41b95d9）——①超时归因点名 `contextPressure` + 压缩次数，文案改成 `turn timed out — context pressure (N compactions)`；②空产出且压力超时的**舰队**回合，失败收口后向同一子会话追加一次「只交报数、拒绝其他工具、90s 预算」的收尾询问，回合仍记 failed、`detail.wrapUp` 如实记录是否补到内容；四类排除（已有文本/非舰队/运行时中断/未达阈值）。规格落 `cron-module`。

**开 worker 池 cap=1（2026-11-09，产线实证）**：单串行槽是通过率的结构性瓶颈（`oldestQueuedMs` 92–103 分钟）。7Gi 上限本就是为开池抬的，那一步一直没走。准入算术：门槛 `7Gi×0.85=5.95Gi` > `used+足迹 4.07–4.16Gi` → 放行；对照 11-08 的 4Gi（门槛 3.4Gi < 4.07Gi → 拒醒、空转 608s）。**实证**：连发 3 条不同岗位任务后队列采样 6 次持续 `running=2`（主链 + worker 各一），`overBudget=0`；真实 spawn `worker-1 for persona hotel-watch-chief / xb-poster`；内存 1.76–2.14Gi / 7Gi（不升反降）。改的是 GitOps 真源（非 kubectl patch），故并发会话反复滚镜像后 `TASK_WORKER_MAX=1` 仍随 ArgoCD 对齐保住。

**队列「忙」被当成「卡」（2026-11-09，已修并产线实证，镜像 sha-b4d3952）**：`/api/ready` 把「最老等待 > 10 分钟」判为 degraded→503，而舰队 cell 的最老等待常年 90–100 分钟，同期每 4–5 分钟就有回合成功收口——**繁忙被报成不可用**。现以 `lastSettledAt`（每次收口都写，失败也算推进）为证据：**积压 103 分钟但刚收口 → ready=true；积压 97 分钟且无收口 → ready=false**，同一镜像同一时刻同时观测到两态。真停滞仍降级，原「假绿」事故的可检测性不变。

**重启成本已量化（2026-11-09，实测日志时间戳）**：pod 重建后 `gateway listening` 在 3 秒、三个 cell 的 HTTP 面在 9 秒，但 **dsh runtime ready 分别要 29 / 62 / 97 秒**（`[cell …] [dsh] runtime ready`）——这段是 dsh 初始化（35 个 MCP 源串行），`awaitRuntimeReadyForJob` 的 120s 轮询把它兜住了，所以**重启丢的不是回合，是约 90 秒的推迟**；风险在于推迟窗口里撞上上游 429/503 就会被记成失败。**并行化 MCP 初始化在 dsh 内部，平台侧无旋钮**（与工具输出上限同一结论），故此项不做代码改动，仅记录。

**留痕立刻破案（2026-11-09，产线实证）**：`salvageSkipped={"isFleet":true,"interrupted":false,"pressure":true,"reported":true}` —— 那条 12 次压缩后超时的回合**已经交过报数**，所以收尾车道按设计拒绝补第二次（否则写重复报数）。此前两次「原因已点名却没收尾」的怀疑，答案大概率一直是这个——**实现没有 bug，判据是对的**。这条也验证了留痕字段的价值：一个字段省掉了一整轮从外部猜。

**P0′-1 第五批 + 产线观测（2026-11-09）**：
- **overflow 与压缩风暴归一**：`pi-ai detected context overflow` 此前从 collector 的 error 分支返回、`detail` 为空，收尾车道看不到它；现与超时共用 `contextPressureDetail()`，error 分支同规格补数（`attributeFailureAndSalvage`）。
- **收尾判据改按报数**：上线后头 6 条压力回合里 5 条有文本却零报数，旧判据（有文本就不补）恰在最需要时不动作；现以「已完成的 `report_status` 调用」为准，窗口 90s→240s，prompt 更硬。
- **留痕 `salvageFacts`**：当晚两次出现「原因已点名却没收尾」，所有解释只能从外面猜；现在每次压力失败都带 `{isFleet,interrupted,pressure,reported}`（拒绝时带 `salvageSkipped`）。
- **实测**：新镜像上触发 17 回合 16 ok（94%）；但 03Z 时段被上游 502/429 打穿（3 ok / 12 bad），那段失败与我的改动无关，且**压力判据正确未误伤**（`salvageFacts=0` 因为没有压力类失败）。
- **观测的结构性障碍（重要）**：今天 `platform.yaml` 被改 12 次（7 次滚镜像），Deployment 是 `Recreate` + 单副本，**每次重建都销毁所有 cell 子进程**：队列清空、在飞回合丢弃、runtime 重新初始化。这既是「触发—等待—统计」拿不到干净样本的原因，也是产线通过率的真实成本之一（重启后的回合以 5xx/429 形态失败）。

**P0′-1 第四批（2026-11-08，镜像 sha-7b92fa7）**：`cron_list` —— **单次最大**（12 次共 1.3MB，均 112KB/次）。根因不是格式而是构成：一个 cell 817 个任务里 **659 个是舰队物化的节奏任务**（85%）。现按 scope（user 默认/fleet/all）分域、分页默认 30 上限 200、头部永远报全量账目；未知 scope 回落最窄。实弹：同一 cell 默认页 30 行、输出 ~5KB。

**P0′-1 第三批（2026-11-08，镜像 sha-6f121f5）**：`fleet_list` —— 53 次调用 × **单次 31.5KB**（共 1.7MB），而每行只 6 个短字段：体积全在 `JSON.stringify(…,null,2)` 的缩进。改紧凑 + 六字段投影，**名册仍完整下发**（漏项=谎报不存在）；200 行病态上限并回带 total/truncated。剩余最大单次：`cron_list` **112KB/次**（12 次 1.3MB）。

**P0′-1 第二批（2026-11-08，镜像 sha-00b4640 / fd-memory sha-28db31e）**：按工具归账后修自家第二大与第三大输出——`fleet_turns_read`（100 条全字段美化缩进 → 诊断字段 + 紧凑 JSON + 默认 20 条 + truncated）与 `memory_overview`（旧判据只看分区数 ≥50 → 分区 25 / 每区标题 3 双维度上限，truncated 如实）。两处均保留原视图、只减少字节并说出「这是页不是全部」。自家工具剩余：`fleet_list`(1.7MB)、`cron_list`(1.3MB)、`list_concepts`(1.1MB)。

**P0′-1 第一步实际落地（2026-11-08，镜像 sha-d2bd68b）**：`fix-fleet-workspace-hygiene`——巡逻纪律段末尾追加**可核对的工作区现状**（文件数 / 体积 / 自己的往轮文件数）与代价说明（重复、过期副本、直接扣本轮预算）。产线实证：某 cell 工作区 325 文件 / 3.2MB / 该岗位往轮 59 个，渲染正确。只报告不删除（文件是岗位产出）。这是**让代价可见**，不是硬约束；机械性约束仍需 dsh 上游加每轮工具结果字节上限（见下）。

**P0′-1 根因的处置边界（2026-11-08 二次取证，结论=平台侧无切口）**：
- 量到的事实：单 cell trace 里 `tool/result` 共 **47MB / 5728 条（均 8KB）**，最大会话 3MB；单条最大仅 26KB，超时回合整轮 533KB / 240 事件。**不是某条工具结果爆炸，而是逐条累积**把 128K 窗口占满后反复压缩。
- 可写面勘察：`dsh` 的 patch 面只有九类（mcp/skills/presets/permissions/toolSearch/chartBind/userQuestions/pluginSupply/saveLibrary），**无上下文/压缩/工具输出上限旋钮**；`settings.yaml` 只有 `contextWindow` / `maxTokens`；结果进入模型前的那层截断在 dsh 内部。
- 因此「只对舰队回合收紧上下文进入量」**在平台侧不可实现**。三条备选（需投入决策）：①改 dsh 上游（给每轮工具结果加字节上限 + 截断标记）；②只约束**我们自家** MCP 工具（`fd-open-data`/`fd-memory`/`wire-*` 加 `limit` 参数与默认上限）——治标但可控、当天可落；③按岗位把回合预算调高——已验证是推墙，不建议。

**P0′-2 处置**：`fix-fleet-budget-visibility`——`ERROR_KINDS` 增 `budget` 且**排在 `model_upstream` 之前**（原分类被 `model` 字样吞掉，441 条失败的读面因此与上游抖动混同）；`fleets-db.budgetPressure` 按舰队聚合 24h 内额度失败（岗位数/次数/最早时刻，无则 null）；驾驶舱健康区渲染醒目提示，无该状态不渲染。e2e 顺带抓到一个真缺陷：文案占位符写 `{{windowHours}}`、代码传 `hours`，**占位符当字面量显示给了用户**——五语种已统一并由 e2e 断言真实数字。

**今晚滚动的验证结论（正面）**：`turn_contract_refused=0`（新加的 turn 契约门在产零误伤）；四个 cell 的滚动后小时段与滚动前同量级，无新塌方。

### P1 — 重复花钱 / 串味 / 不可见

| # | 缺陷 | 证据 | 等级 |
|---|---|---|---|
| P1-1 | 聚合分组无 wave/run 维度（多波/同 judge 合并，时序相关） | `delegation-aggregator.js:30-34` | 【码】 |
| P1-2 | 点火不幂等：重跑中游岗 → 下游翻倍；开自动重试 → N+1 | `cron-runner.js:1445-1451`、`fleet-handoffs.js:21-168`、`task-engine.js:798-800` | 【码】 |
| P1-3 | 裁决回合无 O1 / 无 run / 无成本 → 多轮辩论的承接面不存在 | `delegation-aggregator.js:151-175` | 【码】 |
| P1-4 | 成本只见 token 不见钱（USD 列无读面） | `fleets-db.js:420-441` vs `fleets.js:1331,841,1639` | 【码】 |
| P1-5 | ~~决策送达丢上下文（execute-now 顶掉占位符）~~ **已修**：判据抽成 `cron.keepFleetContextPlaceholder`（带占位符且渲染器在位→保留，裁定随注入段到达；渲染器缺席→预拼裁定）；手动 persona 车道补占位符 → `openspec/changes/archive/2026-11-08-fix-decision-delivery-context/`（镜像 sha-c721105） | `fleets.js:2645`、`cron.js` | 【码】 |
| P1-6 | 建岗静默丢 4 字段（D2） | `fleets.js:3036-3094` | 【码】 |

### P2 — 规模化 / 表达力

| # | 缺陷 | 证据 |
|---|---|---|
| P2-1 | ~~报数只有直属下级一层可见~~ **已修**：直接下级段之后追加「更深层报数」紧凑块（标题带层号与路径、槽值/阻塞/摘要/时间；BFS 近层优先、防环、独立 6KB 子池、最多 8 条，永不挤占直接下级；超量显式标注）→ `openspec/changes/archive/2026-11-08-fix-fleet-descendant-reports/`（镜像 sha-2d084d4）。两层舰队（现网 6 套官方模板）该段为空、上下文逐字节不变 | `server/fleet-context.js` | 【码】 |
| P2-2 | ~~`report` 边死语法~~ **文档陈旧，早已修**：`fix-report-edge` 把 report 边改成 **parentId 的读时投影**（每个父子对一条，不落库），与树相符的声明接受且不重复，**与树相悖的声明直接校验失败并指出真实上级**——`scripts/test-report-edge-derived.mjs` 5 条实证（含「report 边不授予 dispatch」） | `openspec/changes/archive/2026-11-08-fix-report-edge/` | —— |
| P2-3 | ~~产物只能传散文~~ **文档陈旧，已修**：`add-fleet-artifact-handoff` 让上游回合产物以资源库句柄（库 id + workspace 相对路径）随点火/接棒跨边传递；**残留口径**：persona 目标才带句柄（a2a 是另一服务，句柄无意义） | `server/fleet-handoffs.js:97-170`、`archive/2026-11-08-add-fleet-artifact-handoff/` | —— |
| P2-4 | 所有岗位共享同一 workspace cwd（无 per-member 隔离）。**危害口径已核实收窄（2026-11-08）**：产物**不会**串——`storeFileCopy` 复制字节进库、按内容哈希去重，`file_path` 是库内路径而非工作区路径（`resources.js:293,365`），交接给下游的是资源库 id + 库内路径（`fleet-handoffs.js:124`），同名不同内容 = 两个不同条目。剩余风险仅「同轮读到别人留下的临时文件」，而巡逻纪律已明令不读工作区旧副本、上下文每轮现算，产线又串行。**结论：per-member 私有 scratch 是功能项（要动 `/api/files`、侧栏分组、资源抓取三处读面语义），不是缺陷**，待拍板 | `resources.js:293-365`、`fleet-handoffs.js:113-131` | 【待裁】 |
| P2-5 | ~~fanout 在产串行；主链无公平性~~ **主链已修**：`humanPriority` 从「只有 worker 池认」改为主槽串行链出队时选序（越过未开始的执行，不抢正在跑的；cap 0 同样生效，`idle()` 同步等清空）→ `openspec/changes/archive/2026-11-08-fix-main-chain-human-priority/`（镜像 sha-e58cf30）。**残留**：产线 fanout 仍串行——一条 dsh 运行时是物理限制，要并行只能开 `TASK_WORKER_MAX>0`（基建决定，未动） | `task-engine.js:727-756`、`worker-slots.js:45-70` | 【码】 |
| P2-6 | ~~无 run 预算闸 / 无取消 run / 取消无 UI 入口~~ **已收口**：三闸（maxTurns/maxTokens/maxMinutes，`handoffs.js:85` 拦截）+ `fleet-runs.stopRun` 取消（中断在飞会话）+ **驾驶舱停止入口**（详情头「停止这一轮」→ 危险态确认 → 如实回执已停止/此前已停止/失败，停止后呈停止标记与原因）→ `openspec/changes/archive/2026-11-08-add-cockpit-run-stop/`。**残留（设计如此）**：`spanMax` 只 warn 不拦（advisory） | `fleet-orchestration.js:29-44,311`、`web/src/components/fleet/RunTimeline.tsx` | 【码】 |
| P2-7 | 跨舰队不可能；peer/blackboard 保留未实现（`RESERVED_SOURCES`/`RESERVED_RESULT_SINKS` 只声明不给路）。~~`assertTurnRequest` 无生产调用方~~ **已修**：起轮前按**当前**声明再校验派生的 turnRequest（声明在入队后收紧时，已排队的超界回合会被拒并落事件）→ `openspec/changes/archive/2026-11-08-fix-turn-contract-admission/` | `server/fleet-runs.js`（admission）、`server/cron-runner.js` | 【码】 |
| P2-8 | ~~discovery N=8 硬编码~~ **已修**：发现面改为 `{agents,total,truncated}`（total=匹配数）、确定性排序、limit 默认 8 上限 50，工具文案写「showing 8 of 12 matches」→ `openspec/changes/archive/2026-11-08-fix-agent-discovery-honesty/`（镜像 sha-e4d4b3a）。**仍开**：A2A 不做能力协商、出站恒 depth=1、市场无「团队即 agent」 | `server/agent-discovery.js` | 【码】 |
| P2-9 | ~~event 边无去抖~~ **已修**：`add-event-wake-coalesce` 在窗口内合并同源消息，合并回合记录 `coalesced` 条数 | `server/fleet-event-wake.js:64-106`、`archive/2026-11-08-add-event-wake-coalesce/` | —— |

---

## 六、已经修过的（勿重做）

台账 `docs/registry-maintenance.md` 中协同类缺陷 15 条**已修**：多岗归属歧义（§15.13/14）、派发桥 401
（§15.18/84）、假绿灯 on_duty（§15.54）、超时不可归因 + 车道熔断（§15.55/129）、0 秒失败污染（§15.59）、
静默模型漂移（§15.63）、拍板队列只进不出（§15.82/85）、digest 从未执行（§15.87）、巡逻上下文超重
（§15.88，49KB 交接清单/56KB 自积累文件）、统一舰队控制台九处 unit-green/prod-red（§15.90）、parked 回合
报数归属（§15.119）、judge 评测内生性（§15.135/136）。

**fanout + judge 全链已在生产真跑过**（§15.20，2026-10-24）：dispatch → 投资部 → 自动起扇出波
（两 manual 任务，initiator=`fleet:<id>:CEO` + initiatorPreset）→ 聚合器自动注入并起 **CEO 裁决回合**，
会话留档可读，裁决还点破「波 2 未完」。**所以裁决回合不是坏的，是看不见、不计费、不能辩论。**

**无在途 fleet change**：`openspec/changes` 仅剩 add-connector-bindings（23/26）、add-erp-miniapp-pagesets
（20/21）、add-lex-line-board（6/7），均与舰队无关。

### 测试覆盖的真相

| 面 | 覆盖 |
|---|---|
| 图校验 / 六类边 / 深度界 | ✅ `scripts/test-fleet-orchestration.mjs` |
| 派发 initiator = UI 会话 | ✅ 已钉（`test-fleet-orchestration.mjs:237`），但只覆盖 web 车道 |
| run 链账本 | ✅ `scripts/test-fleet-runs.mjs` |
| reanchor / 不动运行时默认 | ✅ `scripts/test-persona-park-lane.mjs:260-268` |
| **judge 裁决回合端到端** | ❌ 无（全是 fake：`dshBridge:{isReady}`、手写 `triggerFleetHandoffs` 镜像、`runPersona` stub） |
| **聚合人格断言** | ❌ 无（`本会话委派的` 只存在于实现里） |
| **点火幂等 / 重放** | ❌ 无（`igniteFleetEdges` 每处只调一次） |

---

## 七、实证状态

### 7.1 已实证（本机可复现）

探针：本地假端点接受 POST 后永不响应；三种调用形态。**【实】**

| # | 命题 | 实测结果 | 结论 |
|---|---|---|---|
| E1 | 派发路径（不传 signal）的超时是否生效 | `timeoutMs=400` → 3009ms 仍未结算（watchdog） | **空转**，串行槽可被无限期占住 |
| E2 | 传了真 signal 时定时器行为 | 300ms 定时器回调抛 `TypeError: signal?.abort is not a function`，未捕获 | **写错对象**（`AbortSignal` 无 `abort()`） |
| E3 | 现行人聊形态（signal + 同刻 300s 双定时器）会不会炸 | 416ms 干净 `ABORTED` | 靠 **timer 注册顺序**掩护：调用方 timer 先注册→先 abort→`finally` 清掉内部 timer |

E3 说明：这是**顺序掩护的地雷，不是当前故障**。任何调用方把 `timeoutMs` 调到早于自己的 abort 时刻，
或改变 timer 注册顺序，E2 就会变成进程级崩溃（全仓无 `uncaughtException` handler）。

**E4（立项时补查的第三个调用方，最该先摘）**：`gateway/zhiyu/agent-lane.js:48-62` 传自己的
`controller.signal` 且**从不 abort** → 没有 timer 掩护，内部 300s 定时器必然到点、必然执行
`signal.abort()` → 任何一次智语 agent 座席回答超过 300s 即**网关进程退出**。三个调用方对照：

| 调用方 | signal | timeoutMs | 结局 |
|---|---|---|---|
| `cron-runner.js:515`（委托回合） | 无 | 有（回合预算） | 定时器空转 → **永不结算**（E1） |
| `agent-session.js:764`（人聊） | 有 | 无（吃默认 300s） | 调用方 timer 先到、掩护内部 timer（E3） |
| `gateway/zhiyu/agent-lane.js:54`（智语座席） | 有（从不 abort） | 无（吃默认 300s） | 内部 timer 到点 → **`TypeError` → 进程死**（E2 的实弹版） |

### 7.2 待实证（进 change 前必补）

| # | 命题 | 怎么验 | 现状 |
|---|---|---|---|
| U1 | 定时回合的 dispatch 汇总落进人类会话 / `platform-*` | 单测：`getSessionId` stub 成 `platform-x`，跑一次派发 → 子任务完成 → 断言注入目标 | 【码】已确认，未跑 |
| U2 | 裁决回合 `dispatch_post` 是 409 还是误归属到别的岗 | 真机：judge 波起后让裁决岗派发；或单测造 `currentPreset` 唯一命中 | 【推】 |
| U4 | `effort` 在 worker 槽（每 worker 一桥）上的实际生效面 | 真机：同队两岗不同 effort，查 `request/header` | 【推】 |
| U5 | E1 的空转在生产是否已发生（有无超长 a2a 回合） | 查 `member_turn_events` 里 carrier=remote 且 `ended_at-started_at` 远超 300s 的行 | 【推】 |

---

## 八、切片序列（建议，未立项）

```
第 0 层 修谎：把「声明了但没兑现」的旋钮变成事实（改几行）
  ① fix-fleet-turn-budget      去 task-engine:683 硬编码，让 resolveTurnBudgetMs 生效
                               → 一次修好 cadence.turnTimeoutMs + budgetPerEdgeMin
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-fix-fleet-turn-budget/`
                               （镜像 sha-482b815；边>岗>默认 + [2min,30min] 夹紧；镜像内 38/38 绿）**
  ② fix-member-config-complete 建岗接 4 字段 + effort:null 清等级
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-fix-member-config-complete/`
                               （镜像 sha-d41ac58；建岗与改岗同闸同落；清档按「目标≠运行中」判定，实弹探针发 switchEffortTo(null)）**
  ③ fix-a2a-call-timeout       内部定时器改持 AbortController（不是 signal）并在无 signal 时自建一个
                               控制器；超时落 failed 不落 hang。证据见 §7.1 E1-E4
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-fix-a2a-call-timeout/`
                               （15/15、strict 绿；镜像 sha-7fa7e37，A2A 超时归因两处实弹）**

第 1 层 协同质量：不动基建，纯 prompt/账本层
  ④ add-fleet-edge-context     派发/接棒/扇出/唤醒四类回合接上（裁短版）上下文
                               缝已在，只需 prompt 带占位符 + renderer 支持非模板回合
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-add-fleet-edge-context/`
                               （镜像 sha-cf1f2f0；第二个占位符 {{fleetEdgeContext}}，8KB 池、无巡逻纪律、
                               不消耗决策送达；a2a/tool 零注入；镜像内 47/47 + 17/17 绿）**
  ⑤ fix-fanout-aggregation     非 judge 补 initiatorPreset；分组加 runId/wave；合并语义写进 spec
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-fix-fanout-aggregation/`
                               （镜像 sha-4018509；分组键改用**点火键**而非 wave/runId——wave 恒 1 且无人读、
                               runId 无 ledger 时为 null；无 judge 波带 `initiatorPreset: job.preset`；
                               镜像内 5/5 绿 + 全量扫 3869/3869 零红）**
  ⑥ fix-dispatch-delivery      定时车道 initiator 改用派发岗会话（web 车道行为不变）
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-fix-dispatch-delivery/`
                               （镜像 sha-aeb58e6；initiator 改按归因分支取：在飞回合→镜像会话、运行中任务→任务会话、
                               聊天车道→指针；并补 initiatorPreset + 每派发独立分组键；镜像内 17/17 绿）**

第 2 层 防重复花钱
  ⑦ add-fleet-ignition-idem    点火幂等（key = runId + turnId + edge），重跑/重试不翻倍
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-add-fleet-ignition-idem/`
                               （镜像 sha-0b02f37；键 = `回合身份:边种类:目标岗`，回合身份取账本 turnId、缺席退执行序号；
                               键写进 `origin.fleet.ignition`，判定回读已落库任务、无新存储、跨重启成立；
                               已知边界两条见 design（下游任务被删/重启恢复轮次）；镜像内 18/18 绿）**
  ⑧ add-fleet-run-budget       整 run 预算闸 + 取消 run 入口
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-add-fleet-run-budget/`
                               （镜像 sha-571b018；`constraints.runBudget` 三维 maxTurns/maxTokens/maxMinutes，
                               执行点在**边点火**（越界不建下游 + 写停车原因 + 落「点火被拒」事实行）；
                               `POST /:id/runs/:runId/cancel` 记停车事实、按 run 中止在飞回合（落 interrupted）、幂等；
                               `fleet_runs` 加 stopped_at/stop_reason，finalizeRun 不覆盖；镜像内 35/35 绿）**

第 3 层 要设计
  ⑨ add-fleet-ruling-ledger    裁决回合纳入编导（O1 行 + run header + chain）→ 多轮辩论才成立
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-add-fleet-ruling-ledger/`
                               （镜像 sha-cc3b5d2；点火侧 hop 记 `byMemberId`，注入前用合成 job 开回合节点
                               （join 本波 run、parentTurnId=该波发起回合、edgeKind=fanout），结束后写 O1 行
                               （collector 带真实 usage、live 如实留空）再收口；归属不可判则不造节点；
                               账本不可用只告警；镜像内 7/7 绿）**
  ⑩ add-fleet-artifact-handoff 产物句柄进 payload（workspace 路径或 library doc id）
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-add-fleet-artifact-handoff/`
                               （镜像 sha-c4b5573；点火时按「该回合会话 + 起止窗口」读资源库，persona 下游 prompt
                               追加【上游产物】段（库标识 + workspace 相对路径 + 「不要重新生成」），
                               散文在前、上下文占位符在后；无产物/库不可读整段缺席零变化；a2a/tool 不下发；
                               全量扫 449 文件/4003 条零红）**
  ⑪ add-fleet-cost-read-face   member_turn_daily 的 USD 列接 API，按 岗/run/边 三切面
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-add-fleet-cost-read-face/`
                               （镜像 sha-873377b；四分量 USD 同缝也落到**回合行**（可空，未定价=null 不冒充 0），
                               因为日汇总的键没有 run/边维度、现价重算会改写历史；run 列表一次分组查询无 N+1、
                               详情与逐回合带 cost、`edgeTraffic` 带 hop 金额（取下游回合）、spend 各窗口带
                               costUsd+pricedTurns、owner board 累加；有意推翻 add-turn-pricing D4a，
                               并用「回合行与日汇总必须一致」交叉校验钉住；镜像内 12/12 绿）**
  ⑫ fix-report-edge            实现 report 边或从枚举删除（消除死语法）
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-fix-report-edge/`
                               （镜像 sha-18d0c79；选"投影"第三条路——report 边由 `parentId` 派生
                               （读时计算、标 derived），声明与树一致才收、矛盾则拒并指名真上级；
                               顺带修模板投影没带 `parentId` 导致官方种子真声明被误判；克隆内全量
                               439 文件/3938 条、3936 绿；镜像内 seed 断言跑不了=种子不打进镜像）**
  ⑬ add-event-wake-coalesce    event 边按 (botId, chatKey) 窗口去抖合并
                               **→ 已归档并上产：`openspec/changes/archive/2026-11-08-add-event-wake-coalesce/`
                               （镜像 sha-963400e；入口按 (信号源,会话) 缓冲 800ms（`EVENT_WAKE_COALESCE_MS`，
                               0=逐条同步旧语义），窗口关闭时整段对话只建一个回合；合并如实：`coalesced` 条数、
                               超长截断留标记、略去条数显式声明、发言人取末位、被点名取并、跨会话不合并；
                               全量扫 440 文件/3944 条零红）**
```

依赖：①③ 独立可先走；④ 依赖①（else 上下文里渲染的历史/预算仍是错的）；⑤⑥ 同属聚合语义，宜同 change；
⑦ 依赖 §八 的分组键（runId 已在 `origin.fleet.chain`，只差写入分组）；⑨ 依赖 ⑦（否则辩论轮与新 run 分不清）。

---

## 九、明确不做

- 不引开源编排运行时（LangGraph/Dify/AutoGen/Temporal）——借语义不借引擎，cell 隔离/计费/trace/凭据闸一个不绕。
- 不做全连接拓扑 / 自由对话（边必须显式、有界、可审计）。
- 不建共享消息总线（event 只接已有信号源）。
- 不引入第二调度器 / 第二执行路径。
- 不在本文范围内抬 pod 内存开 worker 槽（那是 `agent-parallel-execution-explore.md` 的 B 路线，按真机数据再定）。
- 不改代码键/API/事件/spec 目录名（`fleet` 恒在）。

---

## 十、实证坐标索引

```
回合输入与注入缝   cron.js:295-350 · task-engine.js:662-683,737 · server/cron-runner.js:114-128,1284
                  · server/fleet-context.js:14-16,325-353,398-441 · server/fleet-chat-context.js:41-82
边点火与聚合       server/fleet-handoffs.js:21-168 · server/delegation-aggregator.js:21-175
                  · server/fleet-runs.js:66-300
归属解析           server/fleet-reports.js:115-149,162-186 · server/routes/fleets.js:1030-1115,1781-1807
串行/并发/准入     task-engine.js:56,601-700 · server/worker-slots.js:42-320 · k8s/deployment.yaml:96-97
计量               server/routes/fleets-db.js:297-441,1052-1201 · server/fleet-events.js:122-263
记忆               yongyi-client/dist/facts.js:26-32,162-207 · server/routes/memory.js:120-152
A2A                server/a2a-client.js:13,54-141 · server/delegation-mcp.js:49-181 · agent-runner/a2a.js:124-129
产物/工作区         server.js:810 · dsh-bridge.js:117,155 · server/library-mcp.js:45-115 · server/routes/files.js:79
台账/实证           docs/registry-maintenance.md §15.13-15.21,§15.51-15.136 · docs/fleet-round-discipline-fix-report.md
                  · docs/fleet-turn-reliability-response.md · docs/agent-parallel-execution-explore.md
测试               scripts/test-fleet-orchestration.mjs:217-237,484-534,678-703
                  · scripts/test-fleet-runs.mjs:182,323 · scripts/test-persona-park-lane.mjs:260-268
本机实证探针       /tmp/a2a-timeout-probe/{probe.mjs,prod.mjs}（一次性，未入库；形态见 §7.1）
                  复现：node probe.mjs nosig｜node probe.mjs sig｜node prod.mjs
                  需 NO_PROXY=127.0.0.1,localhost（本机 7892 系统代理会劫持回环）
```
