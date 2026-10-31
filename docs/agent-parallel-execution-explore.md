# 多 agents 并行运行 × 记忆 × 计量 × 自迭代 整体方案调研底稿（agent-parallel-execution）

> 2026-10-31 `/opsx:explore` 收口。**状态：调研完成、未立项**——本文是后续 change 切片的单一事实源。
> 起点命题：用户「现在的 agents 部署后只能串行，这个方案对于多 agents 运行不是很合适，需要有一个整体方案」。
> 过程中用户三次收窄定调：①「我的设想是用户的 agents 决定怎么处理」（平台不做调度器，只给执行单元+派活工具+准入预算）；
> ②「承载这点要可配置」「记账要细致，方便后期优化」；③「记忆的事情和永忆搭配起来」「词元价目应该是现成的」「每个 agent 可自定义构造长期记忆，喂给自迭代方案」。
>
> 伞文档关系：多 harness 运行层归 `docs/wanxing-multi-harness-runtime-explore.md`（切片② pod adapter 已归档，
> 本文直接吃它的 D1 判读）；记忆面真源归 `docs/memory-architecture-v2.md`（ADR-0030），统计面决策出处归
> `docs/memory-and-stats-plane-explore.md`（S1-S5）；编排范式与三层承载归 `docs/fleet-orchestration-scale-explore.md`；
> 产品计划归 `docs/roadmap-agents-native-teams.md`（§4 线5 + §5 自迭代闭环）。本文只管**执行底座 + 闭环整合层**。
> 调研基线：本仓生产代码逐处读证（行号在案）+ dsh 0.2.0-rc.2 上游源码 + sub2api fork 后端路由 +
> fd-memory src 面。

## 命题拆解

1. agents 部署后只能串行 → 要一个整体方案。
2. 用户的 agents 自己决定怎么处理（平台不编排拓扑，提供 actor + 派活工具 + 准入预算）。
3. 承载（跑在哪）要可配置。
4. 记账要细（方便后期优化）。
5. 记忆与永忆一体；词元价目现成或补接口。
6. 每个 agent 自定义长期记忆 → 喂自迭代（单个 agent 与团队都自动迭代）。

## 一、诊断：「串行」是四层叠加，只有一层是物理

```
用户视角：一轮团队回合 = 成员 A → B → C → D …（串行）

① 进程层【物理】  dsh 回合收尾（finish/idle）进程级串行——两会话各持独立 agent 上下文，
                  派发可并发、收尾照样饿死（0.2.0-rc.2 / 0.2.1-a1 双版本实证）。
                  证据：scripts/probe-concurrent-turn-close.mjs；判读订正
                  openspec/changes/archive/2026-10-14-add-dsh-pod-adapter/design.md:9（D1）。
                  推论：真并发 = N 个进程；进程内多会话只给「派发重叠、收尾排队」。

② 平台层【实现】  persona 是进程级单值：桥 agentPreset 在 initialize 烤死（dsh-bridge.js:418），
                  换人设 = restart() 整 child 重启 5-10s（docs/vertical-packs.md:224），
                  每次重启按当前 preset 重建所有会话的 agent 上下文。
                  证据：server/agent-session.js:889 switchPresetToInner → dshBridge.restart；
                  server/cron-runner.js:601-608（persona 成员恒串行的注释）。
                  但桥已有 preset/set（会话级 persona，parked 语义）：
                  dsh-profile-template/platform-preset-bridge.js:26/:338——只有 agent-runner 在用
                  （agent-runner/harness/dsh.js:321），cell 未接。

③ 引擎层【实现】  task-engine 一条 executionQueue 串行链（task-engine.js:440 chainExecution）；
                  唯一并发出口 worker pool（server/worker-slots.js），fd-prod
                  TASK_WORKER_MAX="0"（k8s/deployment.yaml:96-97，注释：4GB 节点塞不下并行 child）。

④ 容量层【预算】  cell pod 硬顶 1536Mi、峰值 1530/1536MB；基座 770-870MB；child 新鲜 117-136MB、
                  重会话 480-540MB、每 active child 另带 55-60MB MCP sidecar
                  → 实际并发 ≈2-3 新鲜 child（docs/facet-wanxing-roadmap.md:194-200）。
                  TASK_WORKER_MAX=0 不是保守，是算不过账。
```

**代价账**（product-intro 六人队一轮）：6 × (5-10s 重启) = 30-60s 纯开销 + 全程队首阻塞 +
轮间用户对话被 waitForIdle 挡。

## 二、承载档位 × 并发语义 × 成本（全图）

```
档位                      并发语义            内存/单元        适合谁
────────────────────────────────────────────────────────────────────────
C0 cell 单 child（现状）   串行 + 每次换人设    共享 130-190MB   单人轻用
                          重启 5-10s
C1 cell worker 槽          真并发（每槽一进程） 190-250MB/槽     小团队快车道
C2 runner solo child       真并发（每 agent     130-190MB/agent  热 agent
                          一进程）
C3 runner pod 共宿（在产）  派发重叠、收尾串行   摊销 1 进程      长尾/温态
                          （①的硬限制）       (floor 160MB)
C4 磁盘会话（cold，在产）  无（有回合才起）    ~0              数百在线但闲
```

规模账：100 全热 solo ≈ 13-19GB（4Gi pod 实测并发 5-6 → 要 ~18 pod ≈ 70-80GB，不可行）；
100 温态共宿（10 pack）≈ 1.6-1.9GB（1 pod，可行）；cold ≈ 0。
**数百 agent「在线」靠 C3+C4 摊密度，真并发只属于少数热单元。**

## 三、路线对比与定案

| 路线 | 机制 | 内存 | 风险 | 买到 / 买不到 |
|---|---|---|---|---|
| A 会话级 persona 入 cell | cell 侧首 prompt 前 `preset/set` park | **0** | 低（桥能力在产，只差接线；`ctx.currentPreset` 40 处读取要改按会话） | N×重启→0；**不给真并发** |
| B cell worker 槽 | `TASK_WORKER_MAX≥2` | +190-250MB/槽 | 中（pod 须抬到 ~2.5Gi；patch 目录 per-worker；drift 放大） | ≤3 真并发；cell 物理封顶 |
| C 团队回合外派 runner | a2a 车道（已在产）+ registry entry + 结算 | cell ~0 | 中高（跨机身份/凭据/回投） | **水平扩**；agent 间 a2a 派活=「agents 自己决定」 |
| D 三层承载落地 | T1 skill 岗走动作闸 | 0 | 中（新执行分支） | 把热单元数量压下来 |
| E 准入与预算 | 波次/超时/并发上限 | ~0 | 低 | 「agent 自由决定」不失控 |

**用户定调（2026-10-31）**：全部要（延迟 + 真并发 + 规模），且「用户的 agents 决定怎么处理」。
对应落地顺序见 §六切片序列；B 路线放最后甚至不做（要动 pod 内存与配额，收益面被 C 覆盖）。

## 四、决策清单（两轮对话定案，用户逐条确认）

### 承载可配（carrier）

- **D1 carrier 是 targetKind 之外的正交维度**：`"cell" | "worker" | "runner" | "auto"`；
  配置三层由细到粗：member.carrier → orchestration.constraints.carrier → 部署默认
  （`CELL_CARRIER_DEFAULT` / `TASK_WORKER_MAX` / `AGENT_RUNNER_POD_MODE`）；解析顺序 member→fleet→部署→auto。
- **D1a auto 判据**（v1 只做前二）：registry 有该员 runner 部署且健康 → runner；cell 有空闲 worker 槽 → worker；
  cell 无在途回合 → cell；其余排队**不失败**（与 pod 纪律一致）。
- **D1b fail-open 降级**：声明 runner 无部署 / 声明 worker 而 cap=0 → 落 cell + 可见告警。
  **永不因配置拒绝一次回合。**
- **D1c 换身体不换会话**：dsh 会话按 id 从磁盘 resume（platform-preset-bridge.js:272 persisted 分支），
  specDrift 加「只改承载不动 task id / 会话」的 diff（fleet-reconcile.js:66 materializedSpec 带上 carrier）。
  **此可移动性的前提是切片①（会话级 persona）先落。**
- **D1d 准入硬闸**：per-fleet / per-cell in-flight 上限（形态照搬上游 `maxActiveSubagents=8`）；
  现状 `spanMax` 只 warn 不拦（fleet-orchestration.js:221）——真预算必须成硬闸。

### 记账细粒度（一回合一行）

- **D2 明细加列**（聚合字段成列建索引，不塞 detail JSON——detail 按行读不按列查，fleets-db.js:341）：
  `carrier + carrier_instance`（分档成本对照）、`preset_id + preset_source`（人格岗开销归因）、
  `provider`（同名模型跨 provider 异价）、`effort`、`cached_input + cache_write`（提示词缓存命中率）、
  `reasoning_tokens`、时相 `queued_at`（派生 queue_wait_ms）/`spin_up_ms`（重启税）/`first_token_at`（ttft）、
  `fallback_trail`、`billing_key_ref + account_id`（谁付钱）、`depth / wave`。
- **D2a 日汇总表** `member_turn_daily`（fleet×member×carrier×provider×model×day 聚合 token/成本/延迟分位）——
  「后期优化」真正要读的表。
- **D2b 保留期（默认值，用户未反对）**：明细维持每成员 200 行 + 30 天（现状纪律），
  日汇总永久——对齐统计面「13 个月滚动 + 每日聚合永久」既有决策。

### 记忆 × 永忆一体

- **D3 统一锚**：turn fact 写永忆时页面头部带
  `turn_id · run_id · member · carrier · model · tokens · status`——「每页记忆都知道自己是谁花的钱买的」；
  台账 `trace_turn_id` 反向链。「搭配起来」的本体即此一跳互查。
- **D3a 事实/观测分流**：**事实跟舰队走，观测跟部署走**——
  事实（五类，低频语义）恒落 `f/<fleetId>`（现状 fleet-memory.js 车道），跨承载合并；
  观测（L0 高频）落各承载 `d/<…>`（runner 照旧），不进舰队命名空间；
  runner 的五类事实镜像 `f/`（带 carrier 标记），L0 不镜像。
- **D3b 换防连续性**：carrier 迁移与岗位 swap 强制走一次永忆 handoff（claim-once 现成）——
  「身体换了，记忆跟着走」；清史改为「交接后清」。顺手治 B2 静默删教训（supply-open 实录）。
- **D3c 记账反哺蒸馏（轻）**：日汇总异常（成本突增 / queue_wait 走高）按周折「舰队成本周报」页进 `f/`，
  作 L2 蒸馏的 L1 源。蒸馏器现成，只加一类输入。
- **D3d 降级开**：capture 永不阻塞回合（fleet-memory.js 既有纪律原样保持）。

### 词元价目

- **D4 现成，平台只补读**：sub2api fork 已有
  `GET /api/v1/admin/channels/model-pricing`、组级价目 map（groups 表）、
  `GET /api/v1/admin/dashboard/*`（趋势/模型/分组/keys 批量）、`GET /api/v1/admin/users/:id/usage`
  （backend/internal/server/routes/admin.go:285-294/:311/:783-784）。
  平台 `lib/sub2api-admin.js`（ADR-0011 唯一门）加 3 个只读方法：
  `readModelPricing` / `readGroupPricing` / `readUserUsage`。不新增写面、不动 fork。
- **D4a 口径（S3/S5 不变，只落细）**：词元永远唯一计费真源；turn 行记 tokens+model+provider+
  `pricing_at`（价目版本戳）**不记钱**；日汇总按词元价目折算并与 dashboard 真数对账（漂移>阈值告警）；
  per-turn 成本语义=「按价目估算」，per-day per-key=词元真数，估算永不混进计费数字。
- **D4b 升级触发**：仅当需要 per-call 成本直读时才在词元开发接口（v1 判断不需要）。

### 自迭代闭环（每 agent 自定义长期记忆 → 自动迭代）

- **D5 自定义落在章程层，不落在格式层**：OKF 页面类型保持规范；每 agent 在 persona/pack 声明
  **记忆章程**（write 哪些类型 / trigger 何时自写 / recall 召回时机与条数 / 自有 tag 词表）；
  章程随 pack 版本走，**章程本身是被迭代对象**。
- **D5a 每员回合前召回梯**：`beforeTurn` 缝（唯一汇合点）扩展注入该员记忆 digest；
  降级三梯照抄 cluster-memory（digest 面 → 标题列表 → 无），**记忆缺席永不阻塞回合**。
- **D5b 记忆→提案桥（三车道各一提案器，不建新机制）**：
  经验页 → skill candidate（evidence=turn_ids+页面链接）；蒸馏出的编排瓶颈 → config-change 提案；
  台账异常（queue_wait 持续高 / 长期空闲低耗）→ tier/carrier 升降提案——**记账是证据源，carrier 提案器是消费者**。
- **D5c 防中毒四闸**（全部借用现成结构）：provenance（author=agent|platform + 来源 turn_id）；
  证据强制（无证据不受理）；评测前置（skill 双臂盲评 / 编排蓝图试跑 / 承载 14 天冷却）；
  人批终闸——**自动迭代 ≠ 自动生效**（三车道结构保证原样）。

## 五、三轴一张图（整体方案的骨架）

```
                同一身份锚：fleet_id · member_id · turn_id
                                │
   ┌────────────────┬──────────┴──────────┬───────────────────┐
   │ 执行承载轴      │      记忆轴          │    计量计费轴       │
   │ carrier 可配    │   永忆 fd-memory     │   词元 sub2api     │
   │ cell/worker/   │  L0观测→L1事实→L2蒸馏│   唯一计费真源      │
   │ runner/auto    │  事实f/ · 观测d/     │   估算≠计费         │
   └────────────────┴─────────────────────┴───────────────────┘
        ①在哪跑            ②记得什么            ③花了多少
                    ↕ ⑥自迭代闭环（三提案车道 + 人批闸）↕
```

## 六、切片序列（未立项，按序；②③④可并行）

```
① cell 会话级 persona        dsh-bridge 加 preset/set wrapper + cron-runner 去
                             switchPresetForJob 改 park + currentPreset 40 处按会话化
                             〔零内存；承载可移动的前提〕
② 台账加列 + member_turn_daily〔量尺先于换身体〕
③ 词元价目接入               sub2api-admin 3 只读方法 + 折算 + 对账
④ 永忆四补丁                 锚 / 事实观测分流 / 换防交接 / 周报
⑤ carrier 配置面             三层配置 + auto 判据 + fail-open + 准入硬闸
⑥ 自迭代闭环                 章程 → 召回梯 → 三提案器（与⑤共享台账证据面）→ 防中毒纪律
```

每步独立可交付。B 路线（cell worker 槽）不单列切片：待 ⑤ 落地后按真机数据决定是否抬 pod 内存开槽。

## 七、未决问题（进 change 设计期再答）

- **U1** 准入预算挂哪层：fleet constraints（spec 面）还是部署 env（运维面）——倾向 fleet 定宽度、env 定绝对上限，两层取 min。
- **U2** runner 五类事实镜像 `f/` 的去重与噪声边界：产物类（deliverable）事实算不算「事实」随行镜像。
- **U3** 记忆章程的存放位：pack manifest 段（版本化、随装走）vs `d/` 首页自述（agent 可自改）——
  倾向 manifest 声明 + d/ 首页缓存自改视图，改动走迭代提案。
- **U4** `current_preset` 事件流的 UI 口径（「运行时默认」→「下个新会话默认」）迁移期兼容。
- **U5** 词元 dashboard 聚合粒度是否够日对账（per-key per-day）——接入时实证，不够再提词元接口单。

## 附：本文引用的实证坐标

- 串行四层：scripts/probe-concurrent-turn-close.mjs；archive/2026-10-14-add-dsh-pod-adapter/design.md:9；
  dsh-bridge.js:418；server/agent-session.js:889；server/cron-runner.js:601；task-engine.js:440；
  server/worker-slots.js:40；k8s/deployment.yaml:96；docs/facet-wanxing-roadmap.md:194-200；docs/vertical-packs.md:224。
- 会话级 persona 现成件：dsh-profile-template/platform-preset-bridge.js:26/:338；agent-runner/harness/dsh.js:321。
- 承载/密度：agent-runner/config.js:154-170（budget 3072 / podCost 160 / podMaxInflight 1）；docs/wanxing-multi-harness-runtime-explore.md:38-39。
- 编排/准入：server/fleet-orchestration.js:216-222；docs/fleet-orchestration-scale-explore.md:74（T1/T2/T3）。
- 记忆/统计：server/fleet-memory.js:1-23；agent-runner/memory-capture.js:7-10；server/cluster-memory.js（三梯）；
  docs/memory-and-stats-plane-explore.md（S3/S5）；fd-memory src/mcp.ts:125-240（八工具含 memory_write_page）；
  fd-memory src/distill.ts（supersede-not-delete）。
- 提案车道：server/skill-evolution.js:1-15；server/fleet-iteration.js:1-20；tier-promotion（10-30 上产）。
- 词元：lib/sub2api-admin.js:1-23；~/finddata/sub2api backend/internal/server/routes/admin.go:285-294/:311/:783-784。
