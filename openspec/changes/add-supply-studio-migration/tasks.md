# Tasks: add-supply-studio-migration

## 1. 谦面侧 Studio 骨架（facet/ + gateway/）

- [x] 1.1 studio-docs SQLite（与 packs 同宿主同纪律：WAL/ensureSchema/dump 备份；owner=谦面身份；文档 id 语义与壹座 blueprints.db 对齐）
- [x] 1.2 凭据禁带闸随迁：写路径落笔前 blueprint-validate 扫描（凭据/v1 方言结构性不可存），错误带状态码
- [x] 1.3 生命周期状态机服务端迁移（draft/approved/cast、批准人闸、agent 文档 approve/cast/trial/signoff 显式 409、铸后编辑回 draft 重封注记）
- [x] 1.4 校验错误稳定 code + 五语摘要表（未知 code 回落原文）+ entry/data-anchor 双路径定位（blueprint-validate 既有 code 体系随路由整迁——1.x 未新增 code 面，validateBlueprint/deriveCode 同模块复用；web 面 ValidationPanel 单源）
- [x] 1.5 深链端点：`?new=agent` / `?doc=` / `?fork=`（谦面域解析）
- [x] 1.6 Studio web 三栏面（文档库/画布/检查器组件随迁，壹座侧组件删除窗口与本单步骤 4 同 release）

## 2. 发布与跨域闭环

- [x] 2.1 Studio 发布接谦面既有发布闸（manifest 校验+注释层强制+身份落戳+版本不可变）；产物入 W1 统一目录（对账钉）（进程内 publisher 复刻闸序 verdict shortCircuit+同名闸 twin+限速；对账钉测试=registry 读回 pack row+版本 immutable+manifest._casting.blueprintId）
- [x] 2.2 铸→部署跨域：部署动作深链进壹座 → install（reused 幂等）→ from-template（born paused）→ 团队页；无壹座会话如实引导（deployTeam runOrigin 分支→壹座 /packs?deployCastPack= 预填 detail dialog（install surface→from-template wizard 既有链）；无壹座会话=壹座登录流既有承接）
- [x] 2.3 壹座舰队详情「来源蓝图」芯片改链供给域 Studio 文档 URL（`_casting.blueprintId` 保留）（FleetsPage STUDIO_ORIGIN/VITE_STUDIO_ORIGIN，缺省回落域内链接=release 窗序安全）
- [x] 2.4 AI 起草迁谦面：判官桥逻辑随迁、模型走谦面网关配置（sub2api 内网）、逐字段采用写门（未产字段逐字节不动）（studio-draft.js 同模块随 createStudioDraftRoutes 挂 /api/studio/draft；env 车道 LLM_* 生效、per-user 名册空→env-route 同 cell 进程已实证形态；逐字段采用写门在 AiDraftOverlay 单源组件）

## 3. 预览沙箱与晋升通道

- [x] 3.1 预览沙箱 v1：静态校验+manifest 组装+起草干跑；零持久化（回归钉：预览后存储无新增记录）（facet/preview-sandbox.js；回归钉=blueprints 清单零新增）
- [x] 3.2 配额三闸：每身份每日配额+单次时长/token 帽+匿名不给预览；超限显式语义码（preview_auth_required/preview_quota_exhausted/AbortSignal.timeout；语义码测试过）
- [x] 3.3 诚实降级：上游失败显式失败态+重试入口，不产占位草稿（注入 failing fetchImpl 驱动 502 preview_lane_failed；静态+形状两腿如实返回）
- [x] 3.4 晋升通道（壹座侧）：实例→草稿 fork（preset/配置/skills），provenance 带来源实例与时间；确认界面列「未包含：记忆/会话历史」（POST /api/fleets/:id/promote：installed manifest 反向组蓝图+content._promotion+excluded 显式；确认界面=_promotion 段在 studio doc 内如实呈现，web 确认浮层随 4.x sidebar release 一并）
- [x] 3.5 单向闸回归：编辑晋升草稿不动实例运行态（回归钉）（结构性=蓝图 API 无 fleet 回写面；测试=studio 编辑前后 fleet snapshot deepEqual）

## 4. 壹座侧解体与退役（单 release）

- [x] 4.1 `/studio` 路由退役为供给域重定向（query 原样透传，`?doc=` id 稳定性回归钉）（App.tsx StudioRouteRedirect→facet/#/studio，?doc/?new/?fork 原样透传；回归钉在 5.3 e2e）
- [x] 4.2 `/agents` 四区解体：构建/供给/我的创作区移除，旧区深链 query 重定向表（MUST NOT 404）（AgentMarketPage 替换四区门面；旧 query 经 SURFACE_SLUG_ALIASES 保持可解析，layout 44 测绿）
- [x] 4.3 sidebar 一级入口改「智能体市场」深链+装机动作面板（slug/testid 身份不变；词表 v4 增「智能体市场」五语言行）（nav.agents 五语改词条；AgentMarketPage 装机面板=MyPacksView 既有件）
- [x] 4.4 原生调优面 `/tuning`（候选评审+persona 占位，契约=skill-self-evolution 不变；路由名归档前复核词表）（TuningPage 原样挂两视图；路由名待 5.5 词表复核）
- [x] 4.5 legacy 重定向改靶：`/settings/packs`、`/settings/presets`（Settings 原生面或市场深链）；Settings MCP/技能管理别名入口保留不分叉（presets→settings/general、packs→/agents；别名入口未动）
- [x] 4.6 蓝图相关壹座端点退役或转晋升通道专用（blueprints 路由、AI 起草端点、hub 构建区读端点）；blueprints.db 转只读归档（server.js 卸 createBlueprintRoutes/createStudioDraftRoutes/registerBlueprintAuthorRoutes；模块保留供 facet 装配与迁移读；blueprints.db 只读归档在 5.1 迁移段执行）

## 5. 数据迁移与验收

- [x] 5.1 静窗迁移：blueprints.db → studio-docs（文档数+逐文档 content_json 相等对账；owner email 映射表落档；无谦面身份 owner 首访按邮箱认领）（scripts/studio-store-migrate.mjs 程序化对账件；生产实况=壹座库 0 行【特性上线数日无人存盘】→空搬 0/0 AGREE；owner 映射=同域 Logto 同邮箱同人，零映射表条目；壹座 blueprints.db 转只读归档随 4.6 端点退役生效——存储层结构性不可写已由卸载达成）
- [ ] 5.2 漏斗验收：新谦面身份完成「注册→创作→预览→发布」全程零壹座依赖（端到端走查）——**API/行为层已覆盖**（test-facet-studio 13/13：身份/创建/预览/发布全链 facet 域 mock 跑通）；真机走查随镜像上产执行（挂账见 roadmap 注记）
- [ ] 5.3 六客户端装包链路回归 + e2e（三栏/自动保存冲突/ribbon/深链/结构图环拒绝/跨域部署闭环/晋升）——**行为层已覆盖**（workspace 系 35 测：画布环拒绝/生命周期/校验；studio 系：深链/晋升/跨域）；浏览器级 e2e 随镜像上产执行；**trial 真执行通道接通为本项前置**
- [ ] 5.4 机器面对账：studio 发布产物在 generated/catalog.json 出现且注释层形状合规——发布闸对账钉已测（cast→registry row+_casting 蓝图链）；catalog.json 投影对账随上产后跑
- [ ] 5.5 文档收尾：词表登记、supply-domain-roadmap W2 状态注记、registry-maintenance.md 发布记录、validate --strict——词表五语已落（nav.agents+agents.market+tuning 三组）；roadmap 注记+maintenance §9.2 已落；strict 当前绿；**归档前终验=5.2/5.3/5.4 上产项清账**
