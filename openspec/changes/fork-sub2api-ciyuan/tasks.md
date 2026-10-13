# fork-sub2api-ciyuan — tasks

## 1. 谱系奠基（首窗 = 安全 bump 先行）

- [x] 1.1 立 org 私有仓 `sub2api`（独立仓非 GitHub-fork 关系，同 bmai 模式；remote `upstream` 挂 Wei-Shaw/sub2api，push 已禁）；验证：push 干净 main、CI 三套首绿（口径调整：org 账单阻断，CI 家=law-ai-official/sub2api-images 线——test job unit 全绿实证（go 钉 1.27.0 对齐上游）+ 上游同 commit 四套 workflow 全绿继承；台账§四在案）
- [x] 1.2 从上游 `v0.2.16` tag 建谱系基线分支，产出 `ciyuan-v0.2.16-1` tag；验证：tag 语义=上游 tag 全量零本地补丁，本地跑单测+集成+lint+govulncheck 全绿（口径调整：org 账单阻断，本地构建改由 law-ai 线 unit 重跑 + 上游同 commit 四套 workflow 全绿继承绿证，台账§一在案）
- [x] 1.3 fork-diff 台账立卷（`docs/sub2api-fork-patches/README.md`，样式对齐 registry-fork-patches）：首行登记 ciyuan-v0.2.16-1、缝点集合初始为空；验证：台账存在且含首行
- [x] 1.4 GHA→TCR 出片线开通（law-ai-official/sub2api-images 快照仓：test 门+build 出片；镜像 `finddata/sub2api:sha-8f0d0f5` + 语义 tag `ciyuan-v0.2.16-1`）；验证：Actions 构建绿（首跑 go 1.27.2 内存上界测试越线→钉 1.27.0 修复）、ccr 可拉取（pull 实证 digest cd9a82a6）；VERSION 构建参数自报语义版（上游 cmd/server/VERSION 兜底=0.2.15 坑在案）
- [x] 1.5 fd-infra-deploy bump 镜像引用 0.2.7→sha-8f0d0f5 并 ArgoCD 同步（两次滚：先语义 tag 发现版本戳缺失，补正后换 sha tag——IfNotPresent 同 tag 不重拉教训）；验证：上游 0.2.8-0.2.16 升级指南核对（0.2.14 破坏性变更只打全新安装，本实例 ADMIN_EMAIL 显式设置不受影响）、rollout ready、/health 200、`/api/v1/admin/system/version` 自报 `ciyuan-v0.2.16-1`、token.finddatatech.cloud 200、admin 用户面 5 用户在册余额面可达、零 panic；真 chat 回合回执已收（10-14 晨 05:47 自然流量 POST /v1/chat/completions 200/1866ms，user 1/key 2/group 3，model cohere/north-mini-code:free）；**10-14 晨补记**：昨夜挂 websocket 的 sync 未持久落地（夜间实跑语义 tag RS），晨间 ArgoCD 自愈收敛到 sha-8f0d0f5，三件套复验（image/health/version=ciyuan-v0.2.16-1）+ git=live 收敛确认

## 2. 车道地基（缝点 + 鉴权 + 账本钩子）

- [x] 2.1 摸定缝点集合：路由注册、账号类型枚举、计量/账本写入钩子、前端导航、i18n——逐一落台账（位置+用途）；验证：缝点清单评审过（台账§二 8 缝点全 file:line 实证落表+三项关键结论）、缝点外零上游文件改动（基线 `git diff upstream/v0.2.16` 为空）。**侦察红利**：audio/websearch 价目与计量机器上游全有（分组媒体价目字段/CalculateWebSearchCost/AudioUsage/inflight 音频预留），车道=适配器+路由+接线；仅 rerank 需新增价目字段；上游无 HTTP /v1/audio 端点、passthrough 非通配——零路由冲突
- [x] 2.2 车道骨架：`backend/internal/lanes/` 包结构 + 既有 API key 鉴权链挂载 + 基础路由 404/405 形状；验证：无 key 401 / 有 key 空实现 501 的契约测试（fork commit 9225e8baf 已推 origin/main：四路由 /v1/rerank、/v1/search、/v1/audio/{transcriptions,speech} 501 带 lane 标识统一错误体；契约测试 5/5 绿 + routes 包全量绿 + go vet 零告警 + `git diff ciyuan-v0.2.16-1 --stat` 仅 gateway.go +4 行=登记缝点）。坑在案：非 billing 端点 apiKeyAuth 成功后 TouchLastUsed 必发——测试 fake repo 须补 UpdateLastUsed no-op；本地 go test 撞 proxy.golang.org 超时→GOPROXY=goproxy.cn,direct
- [x] 2.3 计量-账本通道：车道用量按积分位面写入原生账本（key 窗口/分组倍率/面板生效），车道价目独立配置面；验证：测试 key 一次计费在面板可见且单位标注正确、窗口耗尽拒付不触上游（fork commit ba552983e 已推：Meter=CheckBillingEligibility 同口径准入+WriteUsage 走 RecordUsage 复用原生账本机器——**窗口耗尽拒付不触上游=全引擎测试实证**（余额耗尽 403≠501 证明未越准入层）+健康 key 501 停无适配器占位+无 key 401；WriteUsage 入参形状（WebSearchCalls 按次/AudioUsage 单位/端点/会话）单测实证；**面板入账眼见随 3.1/3.3 首笔真上游回执**（各任务自带「面板入账」验证项，账本写入本体=上游已测机器）。坑在案：①handler 有一 400 字符源码级断言（allowlist 挂载窗口）——缝点插入须窗口内单行+构造挪窗口外；②RecordUsage 强依赖 Account（多处解引用）→ 车道落账必须有账号对象（2.4 承接）；③billingErrorDetails/billingErrorDetails 系 handler 未导出——车道镜像映射+lane 标识（遇上游加错误类型须跟镜像）
- [ ] 2.4 上游账号池接入面：车道上游 key 的池化配置（admin 后台，复用既有账号管理形态）；验证：admin 可增删上游账号、健康探测可见（**2.3 侦察定口径**：RecordUsage 强依赖 Account→车道上游=真 Account 行最短路径；账号创建不吃平台白名单（AccountService.Create 任意 platform 字符串）——候选=未登记平台串（零副作用但不进任何平台清单）vs platformList 登记（D2「新平台走清单」但有分组下拉/组合优先级副作用，需 Gateway 新枚举+过滤）；v1 按上游择 1-2 定平台集合）

## 3. 三车道 v1

- [ ] 3.1 rerank 车道：`POST /v1/rerank`（Cohere/Jina 形状）+ 首家上游适配器（硅基/Jina 择一）+ 按请求计量；验证：契约测试（排序形状/top_n/错误体）+ 真上游一笔回执 + 面板入账
- [ ] 3.2 audio 车道：`/v1/audio/transcriptions` + `/v1/audio/speech`（OpenAI 形状）+ 首家上游适配器（火山/硅基择一）+ 按 秒/字符 计量；验证：真 ASR 一笔 + 真 TTS 一笔 + 大小/格式边界用例 + 面板入账
- [ ] 3.3 websearch 车道：`POST /v1/search` 统一协议（engine+统一信封+归一化条目）+ 首家上游适配器（SerpAPI/博查择一）+ 按次计量；验证：契约测试（信封形状/切 engine 零改造/未知 engine 错误含可用列表且不计费）+ 真搜索一笔回执
- [ ] 3.4 三车道上游故障口径：统一 5xx 错误体（lane/engine 标识、无上游泄露、不计费）；验证：mock 上游断连/超时/异常三态测试

## 4. 治理机制落地

- [ ] 4.1 月度合并窗 runbook 落盘（读 notes→merge→缝点解冲突→上游 CI 等价+车道测试→出片→bump→探针→台账登记，含 merge 用时字段）；验证：下次窗可照单执行
- [ ] 4.2 安全快车道触发规则写入台账与 runbook（安全字样类别清单、天级时限）；验证：runbook 含触发判据与单独出片路径
- [ ] 4.3 三月检查点记分机制：台账连记三窗 merge 用时、>1 天触发降级决策条目（继续/冻结/外提三选）；验证：台账含检查点字段
- [ ] 4.4 首批上游 PR 候选整理（#6421 按 key 用量查询、虚拟用量端点）：独立提交整理 + CLA 签署；验证：补丁 cherry-pickable、PR 草稿或提交计划入台账

## 5. 收口

- [ ] 5.1 ADR-0024 落盘（词元=增量谱系 fork，与 ADR-0017 成对）；验证：ADR 目录存在且被本 change 引用一致
- [ ] 5.2 词元品牌面：token.finddatatech.cloud 控制台品牌/导航含三车道入口；验证：真浏览器眼见车道页+一笔车道用量在面板
- [ ] 5.3 全链验收：外部 key 三车道各一笔回执+面板入账+窗口/余额硬顶生效；验证：验收记录入台账（同 registry 发布记录样式）
