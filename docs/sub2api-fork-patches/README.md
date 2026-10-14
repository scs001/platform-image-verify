# 词元 fork 谱系账本（FindDataTechnology/sub2api）

> 自 2026-10-14 起，萬星·词元以 **sub2api 增量谱系 fork** 形态运行（ADR-0024）：
> 月度合并窗跟上游 + 安全快车道 + 只增不改缝点纪律，与 registry 冻谱系（ADR-0017）
> 成对。本文件 = ①基线与发布记录 ②缝点登记表 ③月度窗台账（含 merge 用时记分）
> ④CI/出片挂账。操作手册：出片走 `tcr-image-pipeline` skill（law-ai-official 线）。

## 一、基线与发布记录

| 版本/tag | 基线 | 内容 | 验收 |
|---|---|---|---|
| `ciyuan-v0.2.16-1`（2026-10-14，**已上生产**） | 上游 **v0.2.16**（01842576b），字节等同零本地补丁 | 谱系首发；顺手还清生产 0.2.7 落后 9 版+安全修复欠账（0.2.14 默认管理员可爆破/EasyPay 回调伪造、0.2.12 验证码爆破） | 出片=law-ai 快照 `sha-8f0d0f5`（构建配方两修：go 钉 1.27.0、VERSION 参数自报语义版）；**继承绿证（完整）**：上游该 commit 四套 workflow 全绿（CI/Security Scan/Release/CLA，API 按 head_sha 直查）+ 自线 test job unit 全绿；生产验收：rollout ready、/health 200、`/api/v1/admin/system/version` 自报 `ciyuan-v0.2.16-1`、公网门面 200、admin 用户面 5 用户在册余额面可达、零 panic；真 chat 回合回执已收（10-14 晨 05:47 自然流量 200/1866ms）。**10-14 晨补记**：昨夜挂 websocket 的 sync 未持久落地（夜间实跑语义 tag RS），晨间 ArgoCD 自愈收敛 sha-8f0d0f5，复验 image/health/version 三件套 + gitee main=747808f 与 live 收敛 |

**版本语义**：`ciyuan-vX.Y.Z-N` = 已并入上游 vX.Y.Z + fork 补丁级 N（ADR-0024）。
**首窗即还欠账**：生产 sub2api 自 0.2.7 直升本基线。

## 二、缝点登记表（只增不改纪律）

fork 自有代码全在 `backend/internal/lanes/` 等新增包；上游文件仅允许触碰下列
登记缝点。缝点集合变更须显式登记。**基线仍零补丁**（`git diff upstream/v0.2.16` 为空）；
下表=2.1 摸定集合（2026-10-14，全部 file:line 实证），实际触碰自 §2.2 车道骨架起。

| 缝点 | 位置（v0.2.16 实证） | 用途 |
|---|---|---|
| 路由注册 | `backend/internal/server/routes/gateway.go:184-187`（`/v1` 组挂 apiKeyAuth） | 车道路由 `/v1/audio/*`、`/v1/rerank`、`/v1/search` 挂 `KeyBillingInfo` 同位（组门 groupModelAllowlist **之前**——车道不绑 chat 分组语义）。非 chat 同位先例：`/v1/sub2api/billing`、`/v1/live`、`/v1/custom-voices/:id/audio`、GrokRealtime WS。**注意：该文件有 400 字符源码级断言窗口**（gateway_model_allowlist_test.go 校验 auth→allowlist 挂载间距）——缝点插入窗口内只留一行，Meter 构造挪组创建之前 |
| handler 服务访问器 | `backend/internal/handler/openai_gateway_handler.go` 文件尾（+10 行只读 getter） | `LanesBillingCacheService()`/`LanesGatewayService()`——车道计量取计费准入与原生账本写入服务；不走 wire 重排装配（BatchImage 式注入先例） |
| 计量-账本写入钩子 | `backend/internal/handler/openai_alpha_search.go:275`（recordAlphaSearchUsage→`submitMandatoryUsageRecordTask` 池提交+池满同步兜底→`GatewayService.RecordUsage`） | 车道按次/按量计费落原生用量行的**完整参考实现**（扣费不丢） |
| 媒体价目面（分组） | `backend/internal/service/media_price_config.go` + Group 字段（admin 后台 admin_group.go 可配） | 上游已有：WebSearchPricePerCall、SearchPricePer1k、Image 1K/2K/4K、Video 480/720/1080、**AudioRealtimePerMin/TTS每百万字符/STT每小时**——websearch+audio 车道直接复用；**rerank 唯一需新增价目字段**。按次计算先例 `CalculateWebSearchCost`（openai_gateway_usage.go:594-599=单价×组倍率） |
| 音频计量机器 | `service.AudioUsage{Mode,DurationOrUnits}` + `reserveInflightBalance(Kind=InflightEstimateAudio)`（handler/grok_audio.go:47） | audio 车道 ASR/TTS 计量复用 Mode 形状，零新机器 |
| 余额/窗口前置检查 | `billingCacheService.CheckBillingEligibility`（grok_audio.go:36 同款） | 车道请求前置：窗口耗尽拒付不触上游 |
| 平台清单（**已触碰**） | `backend/internal/domain/platforms.go`（+Gateway=lane 枚举+siliconflow/serpapi 两行）+ `platforms_test.go`（期望清单同步，上游既定「按位补入」模式） | 车道上游=真 Account 行（2.4）：admin 账号管理面下拉即达；登记副作用=平台进「所有平台」类列表（含分组下拉——误建 chat 分组属可恢复误配，单管理员风险受控）；Gateway=lane 使 UsesOpenAIGateway 等谓词恒 false |
| service 账号仓储访问器 | `backend/internal/service/openai_gateway_service.go` 文件尾（+1 只读 getter） | `LanesAccountRepo()`——车道池取数（ListSchedulableByPlatform）；与 handler 访问器同注入模式 |
| 车道平台谓词排除 | `backend/internal/service/scheduler_snapshot_service.go`（schedulerSnapshotPlatforms）+ `upstream_billing_probe.go`（IsUpstreamBillingProbeIdentity） | Gateway=lane 平台**不进** chat 调度快照（空桶白耗内存，inflight 8MB 界 CI 实证越线）**不进**上游计费探测（非 chat 上游，不外发 key） |
| 分组价目（rerank） | `ent/schema/group.go`+迁移 246+repo/auth 缓存/admin DTO·输入·克隆/`billing_service.go`（CalculateRerankCost）/`openai_gateway_usage.go`（成本分支） | `rerank_price_per_request`（USD/请求，nil=0 计费告警）——镜像 web_search_price_per_call 全链模式；本 change 唯一 schema 变更 |
| 测试阈值 | `billing_inflight_reservation_test.go`（8MB→9MB） | 车道平台+价目字段合法增重（CI 1.27.0 实测 8587240）；防失控守护本意不变 |
| 前端路由+导航 | `frontend/src/router/index.ts` + `components/layout/AppSidebar.vue` | 车道页路由（/lanes）+侧边导航入口「模型车道」（5.2） |
| i18n 词条 | `frontend/src/i18n/locales/lanes.ts` + zh/en index 装配 | 车道页/导航词条（zh/en 对称；扁平化命名空间避免与 common.nav 顶层冲突） |

**首笔缝点触碰（2026-10-14，未发版）**：车道骨架+计量通道+上游账号池+**§3 三车道
v1 全落地+故障口径统一**+**§5.2 车道入口页**（rerank 3.1 / audio 3.2 / websearch 3.3 /
统一错误面 3.4 / 前端 /lanes）落 `internal/lanes/` + 前端登记缝点（fork commits
9225e8baf→ee7f32bcf 已推 main）；**CI 全绿实证**（law-ai 线：rerank 三跑收口
38492374586→dev1/sha-a5e6c87；websearch 一次过 38516176793→sha-872b5d3；audio
一次过 38519899822→sha-e3a88ea；3.4 一次过 38523922129→sha-6e809d3；前端页
38530888676→sha-7a1f7c7（含 check:i18n+vue-tsc+vite build），均未部署）；缝点实插
累计=路由注册/handler 服务访问器/平台清单/service 账号仓储访问器/车道平台谓词排除/
分组价目 rerank/测试阈值/**前端路由+导航+i18n 词条**（§二表）。
车道 v1 平台定案：audio+rerank=siliconflow、websearch=serpapi。
**品牌面=上游配置驱动**（admin site_name）。**§3/§5.2/§5.3 真回执+面板入账+浏览器
眼见=部署窗项目**（websearch key 现成；rerank+audio 待硅基 key；按 runbook §7
车道窗附加探针照单执行）。车道 v1 形状：rerank=按请求（新价目字段）/websearch=
按次（复用 WebSearchCalls）/audio=stt 小时+tts 百万字符（复用 Group 音频三价）；
统一错误面=400/422→400、其余→502、池空 503、无凭据 502，全部含 lane+engine 标识、
不外泄、不计费。

**侦察期三项关键结论**（决定 §2 实施形状）：
1. 上游**无 HTTP `/v1/audio/*` 端点**（Grok 音频是 WS realtime）——audio 车道端点全新，无路由冲突；
2. passthrough 是 codex/responses 专用**非通配 `/v1/*` 兜底**——车道路由不撞透传面；
3. audio+websearch 的价目与计量机器**上游全有**，车道=适配器+路由+接线；真正新增量只剩 rerank 价目字段与三车道上游池。

## 三、月度窗台账（含三月检查点记分）

规则：月度常规 + 安全快车道（notes 见安全字样天级单独滚）。每窗登记：

| 窗 | 上游 tag | 产出 tag | 缝点冲突 | merge 用时 | 探针 | 备注 |
|---|---|---|---|---|---|---|

**三月检查点**（ADR-0024/spec）：单窗 merge 用时 >1 天 → 触发显式降级决策
（继续/冻结/外提），记入下表：

| 触发日 | 事实 | 决策 | 理由 |
|---|---|---|---|

## 四、CI / 出片挂账

- **org GHA 账单阻断（持续）**：FDT 私有仓 Actions 不可用（2026-10-14 复验：私有额度
  2011/2000 仍耗尽）。**CI 归宿已定（§1 口径）：law-ai-official/sub2api-images 快照线**
  ——每次代码窗快照推该仓，test job（unit，go 钉 1.27.0）+ image 出片同线；本地先跑
  全量测试再推快照省额度。**额度护栏（10-14 fd-build-channel）**：law-ai 本月余
  ~320 min，月内多窗开发若耗尽 → 备胎 testaction001-005/build-pool 通用池
  （fd-build-snapshot 直接可用）或等 11-01 月初重置；仓转公开（免费无限）留作
  用户级决策不入自动路径。
- **出片线 = law-ai-official/sub2api-images**（快照法，同 platform-images 模式）；
  manifest 引用镜像 tag，注释写明对应真 tag/commit。relay 已登记 finddata/sub2api
  （首见 tag 自动携带，无需手动补单）。
- **Go 版本坑（首跑实证）**：自线 CI 必须钉 **go 1.27.0** 对齐上游 CI（上游三处
  硬断言 1.27.0）；按 go.mod toolchain 解析到 1.27.2 时分配器行为差异会让
  `billing_inflight_reservation_test` 的 8MB 内存上界断言越线（8599272 ≥ 8388608）。
- **版本戳坑（首跑实证）**：Dockerfile 版本优先级 = 构建参数 VERSION > git tag >
  `cmd/server/VERSION` 兜底；快照仓无 git tag，上游兜底文件=0.2.15 致版本端点
  报错版。image.yml 已传 `VERSION=<ciyuan-tag>`，版本端点从此自报语义版（对齐
  registry fork `/api/version=fd-x` 探针惯例）。
- **TCR 同 tag 覆写坑（首跑实证）**：relay seen 账本挡同 tag 重灌（手动补单也
  不覆写 ccr 侧 manifest）→ **部署永远引用 sha tag**（IfNotPresent 同 tag 不
  重拉 + relay 语义 tag 停旧，双重理由）；语义 tag 只作命名锚点。
- **快照旗标语反转坑（10-14 实锤）**：`fd-build-snapshot --keep-workflows` 语义=
  「同步**源仓自带** .github」（供要带 workflows 的仓用），**不是**「保留目标仓
  workflows」——sub2api 快照线误传该旗标会把上游四套 workflow 同步进镜像仓、
  **删掉 image.yml** 并触发上游 CI/CLA/Security/Release 烧额度。**正确用法=
  不传旗标**（默认排除 /.github=保护目标仓 workflows+免 macOS×10 误触）。
  事故修复配方：`gh run cancel` 两个误触 run → clone 镜像仓 `git checkout
  <上一好提交> -- .github/workflows/image.yml` + 删上游 workflows → push
  （image.yml 随修复提交自动重触发）。本次损耗 ~3 分钟额度。
- **ciyuan-tag 文件进 fork 仓**（10-14 起）：下一版语义 tag 声明从镜像仓专属文件
  改为 fork 仓 tracked 文件（rsync --delete 镜像模式下仓库根额外文件会被删）；
  快照自动携带，release 时改此文件+快照即出正确 VERSION。
- TCR：hkccr `finddata/sub2api` 首推自建成功；ccr 侧同库 0.2.7 在用历史。

**升级配方（照单执行）**：快照推 law-ai 仓（先改 `ciyuan-tag`，workflow 自动
双 tag 出片）→ 等 relay ≤5 分钟带 sha tag → fd-infra-deploy 滚 sha tag →
push gitee → `kubectl --context cheap -n argocd exec deploy/argocd-server --
argocd app sync sub2api --server localhost:8080 --plaintext`（in-pod 必带
--server，命令会挂 websocket 但 sync 已执行，直接看 rollout）→ 探针四件套
（/health、admin version=x-api-key 头走 auth-server 容器 env 的
SUB2API_ADMIN_KEY、公网门面、panic 扫零）。admin key 头=**x-api-key** 非 Bearer。

## 五、上游回馈登记（能上游则上游）

> 操作手册与提交计划：`docs/sub2api-fork-patches/upstream-pr-candidates.md`
> （形状草案/实施步骤/CLA/退役流程）；谱系纪律见 spec「上游回馈优先」。

| 候选 | 上游凭据 | 状态 |
|---|---|---|
| 按 key 自助用量查询端点 | issue #6421（ADR-0011 等此）**仍 open**（2026-08-14 立、08-31 更新，无关联 PR；近邻端点 `/v1/sub2api/billing` 已在上游=形状对齐锚点） | **计划就绪**（计划文档§候选①：形状草案/数据源复用/单提交流程；触发时机=车道部署窗后） |
| 虚拟用量端点 | ADR-0014 backlog（門面结算切账本权威的前置） | **计划就绪**（计划文档§候选②：形状草案+幂等要求；前置=候选①先合或先对齐语义） |

CLA：上游有 CLA.md，首次 PR 前签署（覆盖后续 PR）。补丁保持 cherry-pickable 单提交。

## 六、治理手册索引

- **月度合并窗 runbook**：`docs/sub2api-fork-patches/merge-window-runbook.md`
  （十节照单执行：窗型触发/notes 预判/merge 纪律/缝点解冲突+ent 迁移/本地轻测+
  CI 重测+金样七面/安全快车道判据/出片/部署探针/台账登记/三月检查点/上游回馈）
- **上游 PR 候选计划**：`docs/sub2api-fork-patches/upstream-pr-candidates.md`
- **三月检查点**：§三检查点表（单窗 merge 用时 >1 天触发继续/冻结/外提三选一）
