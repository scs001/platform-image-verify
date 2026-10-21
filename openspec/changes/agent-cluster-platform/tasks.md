# Agent Cluster Platform - Implementation Tasks

> ## 对账记录（2026-10-21）
>
> 本 tasks.md 长期显示 0/70，与实际严重脱节：实现早已发生并**已上产**。
> 本日逐条对代码与台账取证后重写勾选状态。33/70 完成，其余为真实欠账或已作废项。
>
> **生产链**（docs/registry-maintenance.md）：
> - 集群功能首产 `sha-b7e825b`/digest `7e7ea998`（≙ paas `5bc21c05`，§11，2026-10-20），探针 11/11；
> - 三波真机修复：§11.1 `/agents` 白屏四根因（`27e0991`）、§11.2 订阅→建集群全链走查（`4a5959a`）、
>   §11.3「我的集群」详情+解散（`512f7a4`）；
> - 当前生产 `sha-848d733`（§14.1，2026-10-21 滚动）**包含全部集群代码**。
>
> **对账中发现的三处「虚假面」——已于 2026-10-21 处理（删除/接真，见下方 ③ 记录）**：
> 1. `server/routes/cluster-templates.js` 的「集群模板市场」是**三个硬编码虚构模板**——
>    agent id（finance-bot/contract-analyzer/content-writer 等）不存在于任何真实 pack，
>    订阅数（127/89/245）与作者（FindData Technology 等）全系编造；**已整文件删除**；
> 2. `server/routes/monitoring.js` `/api/monitoring/providers` 返回**硬编码假健康数据**
>    （Volces 98.5% 成功率 / 15234 req/h 等全为虚构）；**已删除该端点**，`/tasks` 改接
>    真任务引擎、`/health` 删捏造的 api 块；
> 3. `server/routes/model-binding.js` 的 `PROVIDER_ROUTES` provider 路由层**无任何消费者=死代码**，
>    且硬编码 ark/hunyuan 直连端点+独立 key（VOLCES_API_KEY 等），与生产模型真源
>    （词元车道 LLM_API_KEY@NodePort 32080，见 ciyuan-account-lane 发布记录）相悖；
>    bindings 存 `global.modelBindings` 内存 Map（重启即失、执行时无人读）；**已整文件删除**。
>    同批 `optimization.js`（假 cacheHitRate 95.2/avgResponseTime 1200）一并删除。
>
> **2026-10-21 实施轮（本轮）**：补齐集群任务执行链全链——cron-mcp 透传的 clusterId
> 此前从 REST 路由就被丢弃，engine 只认 persona/a2a。现在：REST/WS 两路创建均解析并
> 校验集群引用与 executionPolicy 形状；task-engine 新增 `cluster` target；
> cron-runner 抽出 persona/a2a 两个成员执行器并新增集群编排（成员解析→扇出→聚合
> all/first/summary→统计回写→preset 还原）；worker pool dispatcher 拒绝误认领集群任务。
> 顺带修复：auth-off 本地/测试模式下集群路由必 401（未遵循仓内 owner 回落约定）；
> 回环内部身份的 preset 兜底与 clusterId 冲突。测试：`scripts/test-cluster-tasks.mjs`
> 16 用例（含并行时序断言、summary 汇总回合、部分失败归因、诚实降级注记）全绿；
> 本地真实服务器集成验证：装带 cluster 元数据的 pack→catalog 打标→建集群→建任务→
> 触发执行→三个成员子会话+绑定会话逐成员归因摘要全部落盘（成员回合止于本地 LLM
> 凭据 401=环境问题；成功路径由单测覆盖，真机成功路径待走查）。

## 1. Phase 1: MVP - Pack as Cluster Template

### 1.1 Backend: Pack manifest schema extension

- [x] 1.1 Update `lib/pack-manifest.js` to accept optional `cluster` field with validation for name, description, defaultAgents, optionalAgents, schedulingPolicy
  （`lib/pack-manifest.js:85,167,817-905`：unknown-key/重复声明/引用未声明 agent/超额并发全有校验）
- [x] 1.2 Add validation tests for cluster metadata (valid cases, invalid agent refs, oversized fields, excessive concurrency)
  （`scripts/test-cluster-platform.mjs` 8 用例：合法/缺必填/坏引用/超额并发/无 cluster 通过/重复 agent/空 defaultAgents/optional 校验）
- [x] 1.3 Verify: Run `node scripts/test-pack-validate.mjs` on a pack with cluster metadata and confirm it passes; run on malformed cluster and confirm rejection
  （由 test-cluster-platform.mjs + 生产探针 `scripts/probe-cluster-platform-live.mjs` 11/11 覆盖，强于本地单跑）

### 1.2 Backend: Catalog marking

- [x] 1.4 Update `gateway/packs.js` to add `clusterId`, `clusterName`, `isDefaultAgent` fields to pack-sourced agents in catalog response
  （实际落在仓库根 `catalog.js:221-227,301-318`，非 gateway/packs.js——任务里写的文件位置是错的）
- [x] 1.5 Add integration test: subscribe to a cluster pack, fetch `/api/catalog`, verify cluster fields present on agents
  （test-cluster-platform.mjs 覆盖 catalog marking；生产探针 11/11 亦含）
- [x] 1.6 Verify: Call `curl http://localhost:3000/api/catalog` after subscribing to a cluster pack and inspect JSON for `clusterId` field
  （被生产探针取代）

### 1.3 Frontend: Marketplace cluster views

- [x] 1.7 Update `web/src/components/packs/PackDetailDialog.tsx` to show "Cluster Info" section when pack has cluster metadata (name, description, agent count, agent list)
  （`PackDetailDialog.tsx:523-537`）
- [x] 1.8 Add expandable/collapsible agent list UI with "Show optional agents" toggle
  （`PackDetailDialog.tsx:111`）
- [x] 1.9 Update marketplace listing page to add cluster size filter (`?size=3`) and category filter
  （2026-10-21：`?agents=1|2-3|4+` URL 状态化筛选（`pack-agent-size-filter`）；agent 数由市场 list SQL 侧 `json_array_length` 计算（零 schema 变更，老服务端无数值时直通不过滤）；category 筛选既有。**spec 的"Cluster type"分类筛选未做**——货架空则死 UI，待有 cluster pack 再上）
- [x] 1.10 Verify: Open a cluster pack detail, confirm cluster info section renders; apply size filter and confirm only matching packs shown
  （前半真机走查在案（§11.x 轮）；后半随 1.9 上产，等首批 cluster pack 上架后可视复核）

## 2. Phase 2: Core - Dynamic Cluster Composer

### 2.1 Backend: Dynamic cluster API

- [x] 2.1 Create `server/routes/clusters.js` with endpoints: POST /api/clusters/dynamic, GET /api/clusters/:id, DELETE /api/clusters/:id, PATCH /api/clusters/:id
  （8 端点：POST /dynamic、GET /mine、GET/PATCH/DELETE /:id、POST /:id/agents、DELETE /:id/agents/:agentId、GET /user/:email；SQLite 持久化 clusters-db.js，per-cell 落盘 `/data/cells/<id>/data/data/clusters.db`。计划外另有 cluster-templates(6)/model-binding(4)/monitoring(4)/optimization(4)/admin(1) 端点——其中 templates/monitoring 为虚假面，见对账记录）
- [x] 2.2 Implement cluster creation logic: validate pack references, trigger install flow if needed, return status
  （§11.2 真机实证：订阅 2 柏讯 pack → UI 创建 2 集群 ready）
- [x] 2.3 Implement cluster termination logic: deactivate agents, release session bindings, trigger cleanup
  （§11.3 真机实证 Manage→解散集群）
- [x] 2.4 Add auto-termination job: cron task that checks clusters unused for 24h with <5 executions and deletes them
  （`startAutoTerminationJob` clusters.js:374，server.js:394 调用；注意 24h/<5 次的具体阈值未验，回归测试缺——见 4.7）
- [x] 2.5 Add rate limiting: 10 cluster creations per hour per user (use existing rate limiter middleware)
  （clusters.js:42-51）
- [x] 2.6 Verify: Create a dynamic cluster via API, confirm clusterId returned; terminate it, confirm GET returns 404
  （探针 11/11 含写链路实弹：模板部署→GET→监控可见→terminate）

### 2.2 Frontend: Cluster composer UI

- [x] 2.7 Create `web/src/components/clusters/ClusterComposerModal.tsx` with sections: metadata input, agent selection (searchable multi-select), activation policy, session binding
  （注：曾长期未被任何页面挂载=死代码，`83886b56` 补挂到 AgentsPage）
- [x] 2.8 Add "Add all from pack" shortcut for each pack in agent selection
  （§11.2 真机验可用；顺带修过 InstalledPack.packId 读成 id 的 404）
- [x] 2.9 Wire up form submission to POST /api/clusters/dynamic endpoint
  （§11.2 真机建群成功）
- [x] 2.10 Display loading state with progress indicator during bulk install
  （ComposerModal:47-49,329-333 creating/loading 态；为终态渲染而非 WebSocket 实时事件——规格里的 WS 实时未达，见 2.16）
- [x] 2.11 Verify: Open cluster composer, select 3 agents from 2 packs, create cluster; confirm modal shows progress and completes successfully
  （§11.2 真机走查等价场景）

### 2.3 Frontend: Agent picker cluster grouping

- [x] 2.12 Update `web/src/components/agent/AgentPicker.tsx` to group pack-sourced agents by `clusterId`
  （2026-10-21：实际消费点为 `ControlStrip.tsx` 的 agent 下拉（chat 侧真正的 agent 选择器）——`agentRows` 按 clusterId 分组；AgentInfo 类型补齐 clusterId/clusterName/isDefaultAgent（catalog 打标早已上线、客户端类型一直没接））
- [x] 2.13 Add cluster header showing cluster name and agent count
  （ControlStrip 集群头：名+计数徽标，`strip-cluster-header`）
- [x] 2.14 Add "Load entire cluster" button that triggers bulk install + activation
  （`strip-cluster-load`。**语义按架构事实落定**：共享运行时一次承载一个 persona，"同时激活 N 个"不可达——落为「建绑定当前会话的动态集群（bindToSession+sessionId）+ 切到领街默认 agent」，扇出执行走集群任务面。picker 里的 pack 已安装，安装流在市场侧 Load in chat（见 marketplace-cluster-view spec，仍欠））
- [x] 2.15 Verify: Subscribe to a cluster pack, open agent picker, confirm agents are grouped under cluster header with "Load entire cluster" button
  （2026-10-21 **真机可视收口**：首个 cluster pack「柏讯·投研三镜头」egaYyOaZVTf0FWlLvaGAQA v1 上架（用户授权代选——在架 52 pack 全单 agent，按包上限 agents≤3/mcp≤5/skills≤10 由同作者三套柏讯套件角色合集铸造，成员经 resources.mcpTools 收窄回原工具面）；aloadtree 安装→catalog 打标→真浏览器：picker 集群头「投研三镜头」+载入按钮可见→载入→会话头徽标出现→零 console 错）

### 2.4 Integration: Session binding

- [x] 2.16 Update WebSocket protocol: add `cluster_bound` event when a cluster is bound to a session
  （clusters.js 创建/终止处广播；chat-store 两 case 消费。**顺带修真 bug**：`req.sessionId` 从未被任何中间件赋值，bindToSession 一直空转——改收 body.sessionId；编排器弹窗同样补传真实会话 id）
- [x] 2.17 Update chat session header to display "Running with [Cluster Name]" when cluster-bound
  （ChatHeader `chat-header-cluster` 徽标；冷启动按 /api/clusters/mine 的 sessionId 恢复，live 走 WS 事件）
- [x] 2.18 Handle cluster termination during session: fall back to built-in agent, show notification
  （cluster_terminated → chat-store 清徽标+置 notice → ChatPage 切回内置 agent（set_agent local）+ 横幅 `cluster-terminated-banner`）
- [x] 2.19 Verify: Create a cluster with "Bind to current session", send a message, confirm session header shows cluster name
  （2026-10-21 生产 sha-839f39c API 级验证：带 sessionId 建群→mine 回带 sessionId→terminate 200；徽标渲染链由 typecheck/build+agents-smoke+三页真浏览器零错背书。浏览器级端到端（发消息见徽标）待 cluster pack 上架后一并走查）

## 3. Phase 3: Advanced - Scheduling & Model Binding

### 3.1 Backend: Cluster-aware scheduling tools

- [x] 3.1 Update `lib/scheduling-tools.js` to accept `clusterId`, `executionPolicy`, `targetAgents` fields in create tool
  （schema 在 `server/cron-mcp.js:88-100,145-161`——lib/scheduling-tools.js 不存在，任务里文件位置是错的。**2026-10-21 前只是 schema 透传，服务端从 REST 路由起就丢弃字段；本轮接通**：`server/routes/cron.js` + `server/ws.js` 解析集群引用、`cron.js` 校验策略形状并落 `targetType:"cluster"`、`task-engine.js` 放行该 target）
- [x] 3.2 Implement parallel vs sequential execution: add flag to control whether agents run concurrently or sequentially
  （allowParallel 默认 false；**执行实现在 `server/cron-runner.js` runClusterTurn**：parallel 下远端 a2a 成员与 persona 循环重叠，persona 成员受共享运行时约束始终串行并在摘要注记）
- [x] 3.3 Implement result aggregation: support "first", "all", "summary" policies
  （`buildClusterDigest` + summary 汇总回合，cron-runner.js；三策略各有单测）
- [x] 3.4 Extend list tool response to include `clusterName`, `agentCount` for cluster tasks
  （cron-mcp.js:177-178,203-204 读；`task-engine.js` clientShape 现真带 clusterId/clusterName/agentCount/executionPolicy/targetAgents）
- [x] 3.5 Add cluster-level task management endpoints: POST /api/clusters/:id/tasks/:taskId/pause, resume, delete
  （**作废（superseded）**：任务级 pause/resume/delete 本就 target 无关且已存在——`POST /api/cron/:id/pause|resume`、`DELETE /api/cron/:id`，集群任务天然可用；专设集群子路径端点无增量）
- [x] 3.6 Verify: Create a cluster task with 3 agents and parallel=true; execute it, confirm all 3 agents ran concurrently and results aggregated
  （2026-10-21 实现并验证。**语义修正**：本地 persona 成员共享一个运行时、逐个切换执行，真并行只对远端 a2a 成员成立——`test-cluster-tasks.mjs` 用时序断言证明 parallel 下 a2a 与 persona 循环重叠、sequential 下不重叠，且并行时对 persona 的串行降级在摘要中如实注记。聚合 all/first/summary 三策略均有用例；summary 的汇总回合落在绑定会话、由首个成功 persona 领衔）

### 3.2 Frontend: Task history with cluster view

- [x] 3.7 Update `web/src/pages/TasksPage.tsx` to display cluster tasks with cluster badge and agent avatars
  （2026-10-21：`cron-job-cluster` 徽章（名×计数）；avatars 落为成员 id 徽标——agent 头像无真实图标数据，不虚构）
- [x] 3.8 Add expandable timeline view for cluster task details (show per-agent output)
  （lite 形态：`cron-job-cluster-members` 成员徽标直达各自子会话（id 规则与 runner 落盘一致）——每 agent 输出就在其子会话里；卡片内嵌时间线留待有真实集群任务历史后按需做）
- [ ] 3.9 Visualize parallel execution: use CSS grid to show agents running simultaneously
  （未做）
- [ ] 3.10 Verify: View a completed cluster task, confirm cluster badge shows, click to expand and see per-agent outputs
  （随 3.7-9 未做）

### 3.3 Backend: Per-agent model binding

- [x] 3.11 Update deploy action in `gateway/packs.js` to accept `model` field per agent in deploy request
  （`gateway/packs.js:1803` modelOverrides 进 deployToRegistry）
- [ ] 3.12 Implement three-gate validation: whitelist check, lane check, roster check (degrade open if roster unavailable)
  （未做：model-binding.js 无 whitelist/lane/roster 任何一闸）
- [ ] 3.13 Add serving config PATCH endpoint to update model binding on live deployments
  （未做：model-binding.js 只有集群绑定 CRUD（/api/clusters/:id/bindings），无在线部署 serving PATCH）
- [ ] 3.14 Implement provider routing layer: map model IDs to provider endpoints with fallback
  （曾为**假完成**：PROVIDER_ROUTES+fallback 代码存在且路由挂载，但全仓无回合路径消费=死代码，硬编码 ark/hunyuan 直连+独立 key 与生产词元车道真源相悖。**2026-10-21 整文件删除**（③）。真实现须以词元车道为唯一模型真源重做，本任务保留为欠账）
- [ ] 3.15 Log `providerUsed` in usage metrics for every turn
  （未做）
- [ ] 3.16 Verify: Deploy a pack with model="volces-max"; execute a task, confirm logs show provider used; fail volces intentionally, confirm fallback to tencent works
  （未做）

### 3.4 Frontend: Model binding UI

- [x] 3.17 Update pack detail dialog deploy form to show model input per agent (autocomplete from manifest's modelWhitelist)
  （`PackDetailDialog.tsx:734-739` 真实输入控件+modelDrafts→提交；无 whitelist 自动补全，弱于规格但主体在）
- [ ] 3.18 Add session-level model override: POST /api/sessions/:sessionId/switch-agent with modelOverride field
  （未做：仅 model-binding.js:183 的任务路由有 modelOverride 参数）
- [ ] 3.19 Show model override in session header: "finance-bot (using deepseek-coder)"
  （未做）
- [ ] 3.20 Verify: Open pack detail, deploy with model override; start a session, switch agent with model override, confirm header shows overridden model
  （未做）

## 4. Testing & Validation

### 4.1 Unit tests

- [x] 4.1 Write unit tests for cluster metadata validation (all edge cases)
  （test-cluster-platform.mjs 8 用例，即 1.2 同批）
- [x] 4.2 Write unit tests for dynamic cluster API (creation, termination, auto-termination)
  （2026-10-21：`scripts/test-cluster-tasks.mjs` 以真 clusters.db 覆盖创建→执行→统计回写→解散后执行的诚实报错；auto-termination 阈值行为仍未测，归入 4.7）
- [x] 4.3 Write unit tests for scheduling tools with cluster context (parallel, sequential, aggregation)
  （2026-10-21：16 用例——policy 形状校验、成员解析、三种聚合、并行/串行时序、summary 回合、部分失败、全失败、targetAgents 子集、已删集群）
- [ ] 4.4 Write unit tests for provider routing (fallback logic, error handling)
  （**作废前置**：provider 路由层已因虚假/死代码整体删除（③），真路由待对齐词元车道重建后再测）

### 4.2 Integration tests

- [x] 4.5 End-to-end test: subscribe to cluster pack → create dynamic cluster → execute task → verify results
  （2026-10-21 **生产真机成功路径走通**（sha-3234d2f，台账 §15）：测试号 cell 既有集群「集群测试」（柏讯舆情+投委会主持人）→ 建集群任务 → 38.5s success → 绑定会话聚合摘要 + 两成员子会话真实 LLM 回复 + clusters.db 统计回写，均 in-pod 直读实证。本地全链亦已走（装带 cluster 元数据 pack→打标→建群→建任务→触发），止于本地 LLM 凭据 401）
- [ ] 4.6 End-to-end test: deploy pack with model binding → execute task → verify provider used logged correctly
  （未做）
- [ ] 4.7 Load test: create 100 dynamic clusters, verify auto-termination cleans them up after 24h
  （未做；自动清退阈值行为未验）

### 4.3 Manual testing

- [x] 4.8 Manually test cluster composer UI: create clusters with various configurations
  （§11.2 真机两场景：2-agent 集群 + 1-agent 集群）
- [x] 4.9 Manually test marketplace cluster views: browse, filter, search cluster packs
  （2026-10-21 真机：市场搜索「投研三镜头」→卡片→详情 cluster-info 分节+2 条默认成员行渲染；?agents= 筛选随 1.9 在产）
- [ ] 4.10 Manually test task history: view cluster tasks, expand timelines, verify visualization
  （随 3.7-9 未做）

## 5. Documentation & Release

### 5.1 User documentation

- [x] 5.1 Write user guide: "How to use agent clusters" (marketplace discovery, dynamic assembly, task execution)
  （`docs/CLUSTER_PLATFORM_QUICKSTART.md`，快速上手级；无市场发现/任务执行实操深度——随 1.9/3.6 补）
- [ ] 5.2 Write creator guide: "How to publish cluster packs" (cluster metadata in manifest, examples)
  （未做：现有 agent-cluster-implementation.md 是实现侧记录，非创作者指南）
- [ ] 5.3 Add tooltips to UI elements: cluster composer, model binding, execution policy
  （未做）

### 5.2 API documentation

- [ ] 5.4 Update OpenAPI spec with new cluster endpoints
  （未做）
- [x] 5.5 Document cluster task schema and execution policies
  （cron-mcp 工具 inputSchema 自述 clusterId/executionPolicy/targetAgents 字段与语义）

### 5.3 Release

- [x] 5.6 Add feature flags: `CLUSTER_VIEWS_ENABLED`, `DYNAMIC_CLUSTERS_ENABLED`, `CLUSTER_SCHEDULING_ENABLED`
  （**作废（superseded）**：三个 flag 从未实现，功能以常开直上；实际回滚手段=镜像级 GitOps 回退（§11 回滚段已演练依据），事后补 flag 无收益）
- [x] 5.7 Roll out Phase 1 with feature flag enabled for 10% of users, monitor errors
  （**作废**：未走灰度，直接随 sha-b7e825b 100% 上产+探针+真机走查）
- [x] 5.8 Roll out Phase 2 with feature flag enabled for 50% of users, monitor errors
  （同上作废）
- [x] 5.9 Roll out Phase 3 with feature flag enabled for 100% of users
  （同上作废：Phase 3 已实现部分同镜像直上；未实现部分见欠账）
- [x] 5.10 Remove feature flags after successful rollout
  （作废：无 flag 可删）

## Verification Summary

- [ ] **Verification**: Full end-to-end test: subscribe to Finance Cluster pack → create dynamic cluster with Data Analyst pack → schedule a daily task → verify task executes both agents → check task history shows cluster view → verify billing logs show correct provider used
  （核心段全证：双 agent 扇出+summary 综合 ✓ 真机（投研三镜头集群 112s success，成员子会话各自真实回复且引用收窄后的真实工具名）、任务历史集群视图 ✓（3.7/3.8 已上产）、绑定会话聚合 ✓。**剩余**：计费 providerUsed 归因（3.15——须对齐词元车道真源）。顺带修真机抓到的 summary 重复落盘 bug（synthesis 自落+手动 digest 双写→exactly-once，含回归断言））

> **发布状态**：本 change 实施轮已于 2026-10-21 上产 `sha-3234d2f`（digest `b524b14a`，台账 §15）；
> 生产探针 10/10（新口径）。

---

## 欠账总账（2026-10-21 实施轮后，按优先级）

1. ~~集群任务执行链从未实测~~ → **已接通并单测/本地集成验证**（本轮）；剩余=真机成功路径走查（4.5/Verification）
2. ~~虚假面清理~~ → **已处理**：三文件删除、monitoring 接真（本轮 ③）
3. ~~货架上货~~ → **已上**（2026-10-21 用户授权代选：「柏讯·投研三镜头」egaYyOaZVTf0FWlLvaGAQA v1，三镜头=宏观/估值默认+投委会可选；舆情/风控等更多角色入动态集群叠加——包上限决定了合集包是"小队模板"而非"全明星队"，大团队=编排器动态集群，分工诚实）
4. **会话集成全缺**（2.12-2.19）：picker 分组、Load entire cluster、cluster_bound WS、会话头集群名、终止兜底
5. **市场集群视图半缺**（1.9/1.10/4.9）：size/类型筛选
6. **模型绑定后半程**（3.12-3.16/3.18-3.20）：三闸校验、serving PATCH、真 provider 路由（必须对齐词元车道唯一真源）、providerUsed 计量、会话级覆盖
7. 文档补全（5.2 创作者指南/5.3 tooltips/5.4 OpenAPI）+ 本轮发版后更新台账 §11 与 probe 口径
