# 萬星桌面舰队插件 调研底稿（桌面版=客户主要执行平台线）

> 2026-10-15 用户拍板立项。**状态：调研完成、切片待排**——本文是后续 change 的单一
> 事实源。伞文档关系：产品计划归 `facet-wanxing-roadmap.md`，运行底座机制层归
> `wanxing-multi-harness-runtime-explore.md`，本文只管**萬星能力落到桌面版**这一片。
> 调研基线：本仓生产代码实证（supervisor/ electron/ agent-runner/ gateway/）+
> fd-wanxing fleet-observer 源码 + 桌面发行树（dist-opensource）逐目录核对。

## 命题（用户原话拆解）

1. **桌面版必须能指挥上百个 agents**——桌面是相当多客户的主要执行平台，萬星核心
   能力不能只在云端。
2. **萬星=桌面可选插件**——客户选择安装，就获得「网上的能力」（市场拉包、部署、
   舰队管理）。
3. **能与外部部署的萬星 agents 交流**——「只要建立好协议」。
4. 用户定调：**这是萬星必须要做的一个事情**（非可选）。

## 核心调研结论（一句话版）

**万事俱备，只差一个开关。** agent-runner（萬星执行宿主）的全量代码 + dsh 安装矩阵
已经随桌面发行版分发（`dist-opensource/platform/agent-runner/` 完整、predist 链含
`install-dsh-matrix.mjs`），桌面 Supervisor 的服务描述符机制原生支持多后端管理
（历史上管过 LiteLLM/Postgres/OpenConnector，现为 `enabled/optional/start/dependsOn`
+ 健康探针 + 自动重启退避 + 优雅降级）。缺的只是：一个 `agent-runner-js` 描述符、
一个 Preferences 开关、一个舰队 UI 页、以及外部互通的入站通道决策。

## 现状事实（逐项代码实证）

### 桌面版底座：描述符机制就是插件挂点

- `electron/main.js` 零业务逻辑：构造 `Supervisor` → 等 server-js 健康 → 开窗。子服务
  环境经 `agentEnv`（resolveEnv + settings.json + first-run bootstrap）注入。
- `supervisor/descriptors.js`：`getDescriptors()` 返回描述符数组，每项
  `{ id, kind: node|http-external, transport: http-port|stdio-rpc|none, enabled,
  optional, start: {cmd,args,cwd,env}, url/healthPath, dependsOn }`。
  `optional: false` 失败阻断启动，`optional: true` 优雅降级（`unhealthy` 不致命）——
  **插件「装了才启、坏了不拖垮主应用」的语义是现成的**。
- `supervisor/lifecycle.js`：依赖序启动、退出退避重启（1s→15s）、`restart(id)` 单服务
  重启（Preferences UI 已在用）、反向序停机。

### agent-runner：萬星执行宿主，单机原生

- 单入口 `agent-runner/index.js`：boots inert → 轮询 registry（`poll()` →
  `manager.reconcile()`）→ **deploy/pause/resume/destroy 全由 registry 条目驱动**
  （reconcile 收敛），本地无需编排器。
- 每 agent 一个 dsh child（私有 DSH_HOME、runner 级模型）+ A2A 独立端口
  （`agentPortFor` base 8791 span 32）。
- 驻留面（上百 agents 的资源答案）：warm-zone budget（RSS 采样逐出）、rhythm 自
  回合、day rollover、external-context reap、workspace quota——**「上百 agents」=
  注册上百、节奏化驻留，不是全量常驻**。
- pod 密度档（`AGENT_RUNNER_POD_MODE`，默认 solo）：单进程双成员 RSS 216MB 生产
  实证（dsh-pod-adapter）；共宿键=pack，跨 owner/pack 硬禁共宿。
- fleet 上报：`AGENT_RUNNER_FLEET_URL/TOKEN` → observer `POST /ingest`
  （Bearer ingestToken，单端点，EVENT_KINDS 白名单）+ pod 密度自报。
- dsh matrix boot gate：无 install root 时 skip——桌面 bundled dsh 需以
  `DSH_MATRIX_INSTALL_ROOT` 指向发行树内矩阵（predist 已装）。

### 协议面：三条现成，一条要定

| 通道 | 协议 | 状态 |
|---|---|---|
| 桌面 runner ↔ 公网 registry | `GET /api/agents`（Bearer registryToken）+ `/api/skills/{path}/content`；部署=reconcile | ✅ 现成（纯 HTTP 出站） |
| 桌面 runner → 远程 observer | `POST /ingest`（Bearer ingestToken）+ spool 重试 | ✅ 现成 |
| 本地 agents → 外部 agents | A2A 出站委托（delegation-a2a，深度上限环断 ADR-0013） | ✅ 现成 |
| 外部 agents → 本地 agents | 需入站可达；家庭 NAT 后不可直连 | ❌ **要定**（见未决 #1） |

- A2A 面形状（`agent-runner/a2a.js`）：每 agent `GET /.well-known/agent-card.json` +
  `POST /`（JSON-RPC `message/send|message/stream`）；paused 显式应答 `-32010`
  （永不超时永不冷启）；`AGENT_RUNNER_BACKEND_TOKEN` 门。
- 设备身份先例（`gateway/app-auth.js`，add-device-pairing-auth）：bind-code + app
  token → `resolveUser` → cell 路由。「桌面 ↔ 云端」的身份协议形状可直接复用到
  「桌面 runner ↔ 远程萬星实例」。

### 桌面 UI 现状

`web/src/pages/`：Agents/Packs/Tasks/Models/… 无舰队页。舰队视图目前在良机 console
（fd-wanxing wanxing-web OpsView，切片⑤ 刚上 cells 区）与 paas-admin——**桌面版要
新造一页**，数据源用本地 runner（不依赖远程 console）。

## 与云端萬星的职责切分（沿用 ADR-0008 进程边界）

桌面插件启的是 **agent-runner**（萬星执行宿主），不是 gateway（用户 cell 宿主）——
桌面已有自己的 cell（server-js）。管理动作走 registry（部署面），监控走 observer
ingest（只读上行），**桌面 runner 永不向本地之外的平面开入站控制口**。

## 切片序列（提案）

| # | 切片 | 内容 | 验收 |
|---|---|---|---|
| ① | 本地舰队宿主 | descriptors 加 `agent-runner-js`（optional、默认 disabled）+ Preferences「萬星舰队」面板（开关+registry/fleet/模型 env）+ `DSH_MATRIX_INSTALL_ROOT` 指发行树矩阵 | 桌面开插件 → 本地 runner 健康 → 从公网 registry 部署一个 pack → A2A localhost 真回合 |
| ② | 桌面舰队 UI | web 加舰队页：runner /health + fleet 采样（本地直读）；部署/暂停/销毁按钮走 registry API | 浏览器级眼见：本地 agents 列表+状态+费用（sub2api per-agent key） |
| ③ | 远程互通·监控上行 | fleet 上报指客户萬星实例 observer；设备配对流（bind-code）发 runner 凭据 | 远程良机 console board 眼见桌面 runner 的 agents/pod 徽标 |
| ④ | 远程互通·入站交流 | 定入站通道（未决 #1）+ agent-card 注册公网 | 外部萬星 agent 真回合调通桌面 agent |

①② 是「插件」本体，③④ 是「和外部萬星交流」的协议层。

## 资源诚实账（上百 agents 的物理边界）

- solo 每 agent 141-200MB 常驻——百级 solo 常驻在桌面不可行，**必须 pod 档 +
  驻留节奏**（温态为主、热态少数；与云端 runner 同一套 residency 机制，无新发明）。
- 端口天花板：每 runner 32 agents（`agentPortFor` span）——pod 模式下端口按 pod，
  天花板随密度解锁（底稿《多 harness》37 行同判）。
- 模型费用：runner 级 provider/model + pack descriptor 覆写 + 白名单门（roster
  gate）已支持；桌面场景建议默认接 sub2api per-agent key（费用可见性七问之一）。

## 未决问题

1. **入站通道**（切片④ 前必须定）：(a) 异步信箱——外部经公网中继给本地 agent 留
   任务，本地轮询取回（turn 语义异步化，配 NAT 现实）；(b) 反向隧道（cloudflared/
   frp 类，或自建 cheap-1 tunnel 同款）；(c) v1 只出不进——桌面 agents 主动委托
   外部（delegation 已支持），外部到桌面先以「远程可查询产出」满足。倾向：④ 选
   (a)，隧道作为 (a) 的传输层候选。
2. **registry 归属**：桌面 runner 连公网壹座 registry（市场同源，天然成立），还是
   允许客户指自建 registry？倾向：v1 锁公网 registry（凭据/计费/白名单都在那），
   自建 registry 留 env 逃生口不宣传。
3. **远程 observer 的多租户边界**：客户萬星实例收桌面 runner 遥测，ingest token 的
   发放/吊销流程挂在哪（良机 console 的设备管理面？）——切片③ 设计时答。
4. **桌面 runner 的调度分片**：桌面 runner 应带独占 `runner_id`（不落云端默认分片），
   避免云端调度器把条目派到不存在的机位——切片① 的 env 定死。
