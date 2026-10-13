# 萬星多 harness 运行层 调研底稿（谦面×萬星×壹座 agent 规模线）

> 2026-10-14 `/opsx:explore` 调研收口。**状态：调研完成、未立项**——本文是后续 change
> 的单一事实源，切片序列见文末；伞文档关系：产品计划归 `facet-wanxing-roadmap.md`，
> 壹座端矩阵归 `yizuo-platform-roadmap.md`，本文只管**运行底座的机制层**。
> 调研基线：dsh-matrix 0.2.0-rc.2 锁步树逐包实证 + DS Bot（Fei2411/DeepSeek-Bot）
> 源码对照 + 本仓生产代码（agent-runner / platform-preset-bridge）。

## 命题（用户原话拆解）

1. **谦面兼容**：pack 要能装进主流 AI harness（dsh 之外：Claude Code / Codex / Gemini CLI…）。
2. **萬星底座抽象**：萬星部署运行 agent 的底座不只 dsh，还包括主流 harness。
3. **萬星=运行管理层**：统一监控管理常驻 agents 和短期 agents。
4. **规模**：壹座上数百个 agents 的运行和管理。

## 现状与硬约束（调研实证）

### harness 耦合线：上半身无关，下半身 dsh 专用

```
facade / A2A / chat 车道 / console / fleet board / 计费分成     ← harness 无关
registry（agent entries + 部署描述符 + agent_runners 机群表）
──────────────────────────────────────────────────────────────
agent-runner 上半身：A2A adapter / rhythm / warm-zone / 日滚动  ← harness 无关
══════════════════════════════════════════════════════════════ ← 抽象缝
下半身：child.js（stdio JSON-RPC）/ compose.js+dsh-profile.js
（DSH_HOME 物化）/ 模型名册（llm-pi-ai）/ usage 事件形状        ← dsh 专用
```

`compose.js` 已是「one composition pipeline, two execution targets」（cell 交互车道与
runner 服务车道共用 dsh-profile.js 写入器）——抽象缝是**下沉**不是发明。

### 未进文档的两条硬闸门

1. **端口天花板：每 runner 至多 32 agents**。`lib/agent-serving.js` 的
   `agentPortFor`（base 8791, span 32，port-per-agent，环探测避撞，满 span 拒部署）。
   数百 agents = 十几个 runner，或改单监听+路径路由（pod 模式顺带解此题：端口按 pod）。
2. **内存账：常驻是奢侈形态**。实测 child 新鲜 117-136MB、重会话 480-540MB、每 active
   child 另带 ~55-60MB MCP sidecar；serving runner 4Gi 实际并发 5-6。数百常驻进程死路，
   「温态为主、热态少数」是唯一可行形状（agent-residency 的 warm zone 本为此设计）。

### 生命周期现状裂缝

常驻 agents 住在 runner 舰队（萬星域），短期 agents 住在壹座 cell 内 task engine +
worker-pool（用户的 cell）。「萬星作为运行管理层」有甲/乙两种读法（只管 runner 舰队
vs 全壹座统一管理面），是本线最上游的待决分叉（见未决问题）。

## DS Bot 参照（github.com/Fei2411/DeepSeek-Bot）

他们解出了「dsh 内多 bot」：**bot = 普通 root session，不是进程**。一个 dsh 进程托管
整个团队；关键手法（全部源码实证）：

- **bot=会话**：扩展单位从进程变会话，会话不活跃时只是磁盘历史，仅活跃回合吃上下文内存。
- **per-agent 工具面**：`agent/created` 事件时挂 `agent.ctx.tools.restrict({deny})`，
  带 5 秒重试直到钉住——运行期 per-agent 工具裁剪实战可用（他们实测 dsh 0.2.1-alpha.1）。
- **多 bot 并发回合**：waiter/inbox 编排（exchange id、hop 计数、room inbox）；dsh agent
  原生收件箱有 `nextStep`（steer 进当前回合）/`nextTurn`（排队下回合）两种语义。
- **上下文管理=context steward**：过检查线后小模型决定 checkpoint 压缩或写 handoff note
  换新 part；对 bot 会话**禁用** dsh 自带 compaction——与我们日滚动+纪要同题可参照。
- **用量记账**：从 session 日志按 bot 按模型读 token——会话级归属上游本就成立。
- **他们没做的**：多租户/计费/白名单/对外 serving——我们的墙；**共宿边界=pack** 保持
  （同 pack 的 N agent 共享 MCP refs/凭据形状/allowTools 本就同源，跨 owner/pack 永不共宿）。

## dsh 0.2.0 能力面盘点（本线最大发现：pod 所需机制上游已原生）

逐包实证于 dsh-matrix 0.2.0-rc.2 锁步树（2026-10-14 物化核对）：

| # | 能力 | 包 | 对本线的意义 |
|---|---|---|---|
| 1 | **ctx.agents 多 agent 原语**：create/resume 各带 per-agent provider/model/effort/maxTokens + `setup(agentCtx)` 作用域；`agent/created` 事件；AgentHandle.dispose | dsh-agent | pod 的地基原语；per-agent 组合是公开 API |
| 2 | **subagent 服务=进程内多 agent 编排**：槽位池 `maxActiveSubagents`（默认 8）；one-shot（跑完即收+结构化输出）vs continuable（持久会话/后续消息/可中断）；per-child options 覆写；子代理 crash 隔离+独立 flat 作用域 | dsh-subagent | 短期/常驻两种生命周期的上游原生形状；槽位池=现成准入控制 |
| 3 | **外部 harness 子代理后端**：「A composition can offer in-process, ACP, SDK, Codex, or Claude Code children side by side」 | dsh-subagent + dsh-acp 等 | dsh 已是**元 harness**——委派面（agent↔agent/短期任务）的多 harness 现成 |
| 4 | **preset 注册表会话级选择**：「Declare several presets and let sessions select one」 | dsh-agent-preset（0.1.1 的 agent-presets 重组改名） | 0.1.1 缺的 per-session persona 那根线**上游已补**；桥只差接线 |
| 5 | **ACP profile=标准协议会话管理服务端**：create/resume/list/close、选模型+effort、挂 MCP、submit/cancel、跨进程重启持久化 | dsh-acp | 萬星↔harness 缝的标准化候选（ACP 生态已有 Claude Code/Gemini 适配器） |
| 6 | **headless profile**：`dsh --profile headless "job"` 一次性持久会话跑完打印退出 | dsh | 短期 agent 的独立进程原生形状 |
| 7 | **MCP sidecar 进程级共享**：每服务器一行插件、进程一份 | dsh-mcp-client | pod 内 sidecar 数量**不随 agent 数增长**（内存分摊结构保证；per-agent 只差可见性 scope） |
| 8 | 会话=事件源日志：内存态+可插持久化 backend、fork、compaction 隐藏不删 | dsh-session | warm zone（杀进程留状态）语义上游本就支持 |

### 四问四答（spike 代码侧，2026-10-14 完成）

| 问题 | 结论 | 证据 |
|---|---|---|
| 一个 dsh 进程多会话 | ✅ 已在产 | child.js `#collectors` 按 sessionId 分键；A2A 多 contextId 并发跑一个 child |
| 按会话模型 | ✅ 已上线 | platform-preset-bridge `model/set {sessionId,...}` + pendingSelections 停靠（sha-bd84e6f） |
| 按会话 persona | ✅ 上游原生、桥待接线 | 0.2.0 agent-preset-registry 支持会话选择；我们桥的 `agentPresetId` 仍是进程级单值（浅 rebase 保持旧线） |
| 按会话 token 归属 | ✅ 结构成立 | session.event 带 sessionId；usage 挂 assistant/message（0cc933b 修准）；DS Bot 同款实证 |

## 架构定调

### 抽象缝形态：一套代码一个 HarnessAdapter 接口 + 每 harness 一个镜像

- 接口保持 **agent 级**（spawn/turn/usage/lifecycle），pod 密度是 **DshAdapter 内部实现
  细节**（session-multiplexing 是 dsh 独有能力，Claude Code/Codex 本质是一进程一对话的
  CLI，接口层不可泄漏此概念）。
- 镜像按 harness 分开（dsh runner / claude-code runner…）挂进既有 `agent_runners`
  机群表（add-serving-runner-split 预留的自报名标签+多 runner 路由直接用上）——
  单镜像塞全部 harness 运行时依赖会把 dsh-matrix 版本纪律乘出灾难。

### 缝的协议基线：ACP 做面、平台插件做深度

- **ACP**（标准、多 harness 生态）做统一驾驶面：dsh 原生 ACP profile，其他 harness 经
  ACP 适配器接入。
- **平台插件**（自有 JSON-RPC：model/set、tools/set、preset、preset/list）做 dsh 深控。
- 待实证：ACP 面上 usage/token 事件流与会话归属戳的形状（README 明言「intentionally
  omits DSH-specific presentation data」）——决定计量走 ACP 还是仍走平台插件。

### pod 模型（DshPodAdapter）：共宿键=pack 部署

```
HarnessAdapter（agent 级接口）
  ├─ DshSoloAdapter    今日 child.js（1 agent:1 进程）= 高隔离/高吞吐档
  ├─ DshPodAdapter     1 进程:N agents（共宿键=pack 部署）★新
  │    · 端口按 pod 不按 agent → 解 32 端口天花板
  │    · preset 会话级选择（上游原生）→ per-agent persona
  │    · per-agent restrict（原生）+ 全局 guard 挂 pack allowTools → 工具面语义严丝合缝
  │    · MCP sidecar 进程级共享 → 内存大头分摊
  │    · 槽位池/准入、warm-zone 预算按 pod 粒度
  └─ ClaudeCodeAdapter 等   天然 solo 形；ACP 基线接入
```

硬约束：**跨 owner / 跨 pack 永不共宿**（sidecar 凭据共享面 + allowTools pack 粒度语义）。

### 规模数学（数百 agents 的三本账）

- 300 agents ≈ 40 个 pack 部署 ≈ 40 pods × ~180MB（dsh 基座+pack sidecar）≈ 7GB 全热；
  配 warm-zone 降级热集 10 pods ≈ 1.8GB——**两三台 runner 撑数百 agents 算术成立**
  （进程模型算不出来）。密度档：高流量/高隔离 agent 走 solo，长尾走 pod。
- 生命周期词汇表：**短期=one-shot**（进程内 child 或 headless 独立进程），**常驻=
  continuable**（持久会话+按序消息+可中断）+ 我们 residency 层（rhythm/warm-zone/日滚动）
  叠加。萬星管理层获得一致原语来源。

### 多 harness 的两条正交路径（勿混）

- **serving 面**（对外常驻 agent）：ACP 统一缝（上节）。
- **委派面**（agent↔agent、短期任务）：dsh subagent 外部后端直接可用——dsh agent 把
  子任务丢给 Codex/Claude Code 子代理，M3 场景B 的现成地基；但生命周期归父回合，
  **不能**当 serving 宿主。
- 谦面 pack 物化器（manifest→各 harness 布局落盘）独立成立，与 serving 面在
  「pack 清单→harness 布局」映射处会合。

## 风险与待实证

| # | 项 | 说明 |
|---|---|---|
| 1 | rc 版本节奏 | 矩阵钉 0.2.0-rc.2，DS Bot 已测 0.2.1-alpha.1——上游活跃；dsh-contracts 需为 agents/subagent/preset-registry/ACP 四块**扩合同**，否则跳版盲跳 |
| 2 | ACP 计量边界 | usage/token 事件流在 ACP 面的形状待实证（影响 adapter 基线设计） |
| 3 | 活体三测量 | 并发回合叠加曲线 / pod 内存峰值 / sidecar 分摊实证——可在 0.2.0 树上测，宜随合同扩展一 change 做掉 |
| 4 | 升级粒度 | pod 模式下升级单个 pack=整 pod 排水重建；contextId→session 连续性要跨 pod 重建存活 |
| 5 | 凭据面 | sidecar 进程级共享=pod 内共享 MCP 凭据；单 pack pod 语义成立，跨 owner/pack 硬禁共宿 |

### 2026-10-14 补记：跨会话回合收尾串行化实测（后台续跑挡路石定量）

`scripts/probe-concurrent-turn-close.mjs`（`--tree` 可测任意候选树）对
「A 会话请求挂起（dummy LLM 扣住）→ B 会话发回合并等其收尾」的直接实测：

| 候选 | 判决 |
|---|---|
| dsh-matrix 0.2.0-rc.2（现役） | ✗ B 派发并 running，但收尾被 A 饿死（15s 窗口不收敛；A 释放后双双干净收敛，无楔死无崩溃） |
| 0.2.1-alpha.1（全家族树） | ✗ 同上 |
| 0.2.1-alpha.2（全家族树） | 判据未触发：0 请求到达 dummy、回合空转即关——llm 适配层形状漂移，需跟随性适配后方可测，不构成反证 |

三点定读：

1. **限制是结构性的**：单 agent 驱动内跨会话的回合**收尾**串行（派发/驱动
   本身并发）。dsh 的并发单位是 **agent 上下文（ctx.agents.create）而非
   会话**——DS Bot 的多 bot 并发回合走的是每 bot 一个 agent 上下文，不是
   单 agent 多会话。会话级后台续跑（切走不取消）因此跨三代（0.1.1-rc.2
   →0.2.0-rc.2→0.2.1-alpha.1）均被挡，等上游改会话驱动不现实。
2. **宿主侧地基已备**：per-session turn 状态/turn buffer（2000 事件）/
   `session_loaded{running,turnEvents}` 重放/per-viewer 投递全在产；唯一
   杀后台回合的是 `stopStreamingForSessionNavigation`（切走即取消的刻意
   设计，合同⑨当时如实收窄）。
3. **解锁路径**：结构性解 = 每会话（或每后台会话）一个 agent 上下文，
   即 DshPodAdapter 方向（本底稿切片 2）——后台续跑是 pod 模型的第一个
   消费者。0.2.0 时代的部分解可选：后台续跑+全局单活回合（在别会话发
   prompt 时带提示取消后台回合），碰撞策略是产品决策，未立项。

0.2.1 线的代际差异（未来跟随必读）：**peerDependencies 回来了**
（0.2.0 是零 peer 锁步）。`--legacy-peer-deps` 会欠装全家族 peer 导致
64 插件导入失败假象；全家族树（plain `npm install`，peers 自动装）+
本仓 0.2.0 era profile 模板可握手跑通 alpha.1——迁移面比想象小，但矩阵
manifest/安装流程必须为 peer 时代重写。

## 与 unify-dsh-generation 收口的衔接（2026-10-14 已归档）

- **阻塞已解除**：统一代 0.2.0-rc.2 全链完结（0643901 主落地，出片 sha-f7d7c39 四门
  全绿滚产；spec 三件套：dsh-version-matrix 重塑/dsh-contracts 合同③家族化/
  **dsh-adapter-boundary 新立**）。
- **adapter-boundary 纪律管住本线实施**：适配层名单（dsh-bridge.js、
  dsh-profile-template/ 桥、agent-runner/index.js、scripts/）是唯一可直接 import
  `@deepseek-ai/*` 的集合，CI lint 强制——HarnessAdapter/pod 新代码要么进名单同评审
  轨迹，要么经平台模块中转。
- persona 现状：0.2.0 适配走了声明式组合（standard.agent.cordis.yml + persona prefix
  + 预设 defs 化），桥仅 4 行浅 rebase，`agentPresetId` 仍进程级单值——per-session
  接线是 pod 切片的一部分。

## 建议切片序列（未立项，按序）

1. **0.2.0 能力面合同扩展**（dsh-contracts 增 agents/subagent/preset-registry/ACP
   四族合同）+ 活体三测量顺路做掉——版本跟随的护栏先行。
2. **DshPodAdapter**（桥接 per-session preset + runner pod 粒度管理 + 端口按 pod +
   warm-zone 按 pod；共宿键=pack；验证=生产一个双 agent pack 共宿部署）。
3. **HarnessAdapter 接口抽象 + 第二 harness**（ACP 基线实证后定接口；claude-code
   runner 镜像进机群表）。
4. **谦面物化器**（pack 清单→各 harness 布局映射，与 3 在映射处会合）。
5. **萬星管理面统一**（短期/常驻统一舰队视图；先解「甲/乙读法」未决问题）。

## 未决问题（立项前必答）

| # | 问题 | 影响 |
|---|---|---|
| 1 | 萬星管理层边界：只管 runner 舰队（甲），还是全壹座统一管理面含 cell 内 worker（乙，需 cell 自报控制协议）？ | 切片 5 的形状；乙侵入面大得多 |
| 2 | ACP 与平台 JSON-RPC 的分工：ACP 只驾驶、计量走平台插件？还是计量也上 ACP？ | 切片 3 接口基线 |
| 3 | 短期 agents 执行宿：留在 cell worker-pool，还是搬上 runner 舰队（ephemeral slot 用完即收）？ | 与切片 5 联动；涉及任务引擎归属 |
| 4 | pod 密度档策略：默认 pod 还是默认 solo、按流量晋级？ | 切片 2 的部署语义 |
