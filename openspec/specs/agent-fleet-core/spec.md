# agent-fleet-core Specification

## Purpose

把「舰队」立为 cell 的一等公民：一组按组织树编排的稳定岗位（Member），每个岗位绑定一个可替换的执行目标（persona/cluster/a2a）与一份节奏规格，节奏物化为既有任务引擎的定时任务并幂等对账。组织结构、岗位身份与历史在人员更替、节奏调整、暂停归档之间保持连续；执行真源始终是既有任务引擎，本能力不引入第二调度器。

## Requirements

### Requirement: 舰队与岗位是一等对象且岗位身份稳定

系统 SHALL 以持久化对象保存舰队(Fleet:名称、所有者、状态 active|paused|archived、创建时间、舰队级默认模型 defaultModel——可空模型声明)与岗位(Member:舰队内稳定标识、岗位名、父岗位引用组成组织树、KPI 槽位声明、节奏规格、在岗者引用 targetRef、模型声明 model 与 fallbackModel——均可空)。模型声明 SHALL 不参与岗位身份:改模型、清模型 SHALL 保持岗位标识、组织位置、KPI 槽位声明与会话史不变。targetRef SHALL 支持 persona、cluster、a2a、tool 四种目标并可在岗位生命周期内原子替换(换防);替换后岗位标识、组织位置、KPI 槽位声明 SHALL 保持不变。tool 目标(targetId 形如 `server::tool`,指向注册 MCP 服上的一个工具)SHALL 持有 JSON 参数节奏(promptTemplate 为合法 JSON 对象串,执行时作为工具参数原样传入);tool 岗的模型声明 SHALL 以结构化错误拒绝(无 LLM 回合,无处归位)。组织树 SHALL 允许多个顶层岗位(森林),并 SHALL 拒绝成环。

唯一在岗规则:一个 persona 或 cluster SHALL 同时只在一个岗位在岗——对已在岗对象的岗位引用(建岗或换防)SHALL 以结构化错误拒绝并指明现有岗位;a2a 与 tool 目标 SHALL 允许多岗(远程执行与无状态调用无归属歧义)。岗位引用 SHALL 不限制目标的日常使用(角色照常对话)。

换防语义:换防 SHALL 默认延续岗位的专属会话史;换防请求可显式选择清史重开(清会话对话史,报数史与槽位连续性不受影响)。

#### Scenario: 建队建岗

- **WHEN** 用户创建舰队并添加一个岗位「电商部」,绑定 persona E、节奏每小时、无父岗位
- **THEN** 舰队与岗位落库,岗位出现在组织树顶层,且物化的定时任务在下一个整点触发该 persona 的回合

#### Scenario: 换防不断史

- **WHEN** 「电商部」岗位的 targetRef 从 persona E 原子替换为 persona F
- **THEN** 岗位标识、父岗位、KPI 槽位声明不变,后续节奏回合以 persona F 执行
- **AND** 岗位的历史(过往回合、既往报数与拍板)仍归属同一岗位可查

#### Scenario: 换防默认继承可选清史

- **WHEN** 主人执行换防且不勾选清史重开
- **THEN** 岗位专属会话的对话史延续,新在岗者接着既有对话执行
- **WHEN** 主人勾选清史重开
- **THEN** 会话对话史清空重开,而该岗位报数史与 KPI 槽位连续性不受影响

#### Scenario: 唯一岗拒绝

- **WHEN** 主人试图把岗位 B 换防给正在岗位 A 在岗的 persona E
- **THEN** 请求以结构化错误拒绝并指明 E 已在 A 岗;岗位 A 与 B 均不变

#### Scenario: 工具岗建岗

- **WHEN** 建岗 targetKind=tool、targetId=websearch::search、节奏每小时、promptTemplate 为 `{"query":"舰队 周报"}`
- **THEN** 岗位落库并物化 targetType=tool 的定时任务;同工具可另设一岗不被唯一岗规则拒绝

#### Scenario: 工具岗非法参数拒绝

- **WHEN** 建工具岗时 promptTemplate 不是合法 JSON 对象,或声明 model
- **THEN** 写面以结构化错误拒绝并指明原因

#### Scenario: 组织树拒绝成环

- **WHEN** 用户把岗位 A 的父岗位设为其后代岗位 B
- **THEN** 请求以结构化错误拒绝,树不变

#### Scenario: 改模型不动岗

- **WHEN** 岗位「电商部」的模型声明从 glm-4.7 改为 deepseek-v4.1-flash
- **THEN** 岗位标识、父岗位、KPI 槽位声明与目标不变;该岗下一回合以新声明执行
### Requirement: 节奏规格物化为任务引擎任务并幂等对账

节奏为岗位的可选属性：每个**有节奏**岗位的节奏规格（cron 表达式、IANA 时区、prompt 模板）SHALL 物化为任务引擎的 recurring 任务，任务记录 SHALL 携带舰队与岗位标识（fleetId/memberId）以区分于普通定时任务。**无节奏岗位（被动岗）** SHALL 不物化任务，仅在受委托或拍板批复唤醒时发起回合。物化 SHALL 幂等：同一节奏规格重复对账不产生重复任务；修改节奏规格后对账 SHALL 更新既有任务而非新建；删除岗位或归档舰队 SHALL 使对应物化任务停止且不再产生新回合。全队暂停 SHALL 批量暂停全部物化任务，恢复 SHALL 逐岗恢复且尊重岗位自身暂停态。

#### Scenario: 重复对账无副作用

- **WHEN** 对同一舰队连续执行两次对账而节奏规格未变
- **THEN** 物化任务数量不变，任务的下一次触发时间不变

#### Scenario: 被动岗不物化

- **WHEN** 用户创建不带节奏的岗位「助理岗」
- **THEN** 无物化任务产生，该岗位仅在受委托或拍板批复唤醒时执行回合

#### Scenario: 改节奏即改任务

- **WHEN** 岗位节奏从每小时改为每天 9 点并完成对账
- **THEN** 既有物化任务的调度被更新为新表达式，历史执行记录保留，不出现孤儿旧任务

#### Scenario: 撤掉节奏变被动岗

- **WHEN** 岗位节奏被清空并完成对账
- **THEN** 其物化任务停止并移除，岗位转为被动岗语义，历史保留

#### Scenario: 全队暂停即刹车

- **WHEN** 用户暂停整支舰队
- **THEN** 全部物化任务停止触发，在岗派生呈现暂停态；恢复后各岗位按自身节奏继续

### Requirement: 在岗与健康状态为派生视图

系统 SHALL 从物化任务状态与执行历史派生每个岗位的状态：在岗（任务存在、未暂停、近期有执行或尚在首跑窗口）、暂停、失联（超过容忍窗口无执行，容忍窗口与节奏周期成正比）、被动（无节奏岗位的常态，失联判定不适用）、待补岗（targetRef 指向已不存在的对象）。派生状态 SHALL 不落库，读取时计算；待补岗岗位 SHALL 在管理面提供补岗（重新绑定 targetRef）动作。

#### Scenario: 悬空诚实降级

- **WHEN** 岗位绑定的 persona 被用户删除
- **THEN** 岗位派生态变为待补岗并停止触发新回合，管理面显示补岗入口
- **AND** 用户为该岗位绑定新的 persona 后，节奏恢复且岗位历史连续

#### Scenario: 失联可判定

- **WHEN** 某按小时节奏的岗位超过两倍周期无任何执行记录
- **THEN** 派生状态呈现失联，并在管理面可见判定依据（上次执行时间与容忍窗口）

#### Scenario: 被动岗不失联

- **WHEN** 被动岗长期无任何执行
- **THEN** 派生状态呈现被动而非失联，仅其最近一次被唤醒的执行可查

### Requirement: 舰队管理面提供全生命周期操作

web 应用 SHALL 提供舰队管理面：舰队列表（名称、状态、成员数、整体在岗概况）、组织树视图（岗位卡：岗位名/在岗者/节奏或被动标记/派生态）、编队器（选择既有 persona/cluster/a2a 目标、命名岗位、设定节奏（可留空建被动岗）与组织关系）、以及暂停/恢复/归档/解散与成员增删改、换防操作。归档 SHALL 停止全部物化任务但保留全部历史可读；对已归档舰队 SHALL 拒绝节奏类写操作并以显式状态说明。过密节奏（触发间隔低于阈值）在创建时 SHALL 要求显式确认。

#### Scenario: 编队器建队

- **WHEN** 用户在编队器中选择两个 persona 与一个市场 a2a agent，命名三个岗位并设定节奏，提交建队
- **THEN** 舰队与三个岗位落库，各岗位物化任务就绪，管理面立即可见组织树

#### Scenario: 过密节奏需确认

- **WHEN** 用户为某岗位设定每分钟级节奏
- **THEN** 界面呈现成本警示并要求显式确认，未确认不落库

#### Scenario: 归档保史

- **WHEN** 用户归档一支舰队
- **THEN** 其全部物化任务停止，舰队态转为 archived，历史回合记录仍可读，且对归档舰队的节奏修改被拒绝并说明原因

### Requirement: 舰队操作经 REST API 暴露且鉴权与既有面一致

舰队与岗位的全生命周期操作 SHALL 以 REST API(/api/fleets 前缀)暴露,鉴权与身份语义 SHALL 与既有集群/定时任务面一致(auth-on 走 forward-auth 用户,auth-off 归机器主人);用户 SHALL 只能读写自己拥有的舰队。非法输入(缺岗位名、非法 cron、未知 targetRef 类别)SHALL 以结构化错误拒绝且不落库。

模型声明的写面:建岗与改岗 SHALL 接受可选 `model` 与 `fallbackModel`(`null` = 清除,回到继承);舰队设置面 SHALL 接受可选 `defaultModel`。校验 SHALL 复用既有三闸——标识符形状、宿主模型 roster、计费车道(已绑计费才校验)——失败 SHALL 以结构化错误如实拒绝并指名违反的是哪一闸。`fallbackModel` 仅在 `model` 非空时可设;清空 `model` 时 `fallbackModel` 仍非空 SHALL 拒绝并提示先清兜底。a2a 岗位与 cluster 岗位设置模型 SHALL 拒绝(a2a 的模型归该服务的部署配置,集群岗归各成员岗位)。所有返回岗位读面的接口 SHALL 带 `model`、`fallbackModel` 原值与 `effectiveModel`——由服务端按解析链与读时 roster 计算,标注 advisory(读时与回合时 roster 可能漂移)。

#### Scenario: 越权拒绝

- **WHEN** 用户 A 请求修改用户 B 的舰队
- **THEN** 请求被拒绝且不产生任何变更

#### Scenario: 非法 cron 拒绝

- **WHEN** 创建岗位时提交非法 cron 表达式
- **THEN** 返回结构化错误,无岗位与物化任务产生

#### Scenario: 建岗带模型回显

- **WHEN** 主人建岗时带 `model: "cheap-model"`,随后 PATCH 改为 `null`
- **THEN** 建岗后岗位读面回显 `model: "cheap-model"`,PATCH 后回显 `null` 且 `fallbackModel` 同样为 null

#### Scenario: 三闸拒绝指名

- **WHEN** 主人建岗时带不在宿主 roster 里的 `model: "ghost-model"`
- **THEN** 返回结构化错误且文案指名「不在宿主模型 roster」,岗位不落库

#### Scenario: 兜底缺首选拒绝

- **WHEN** 主人 PATCH 岗位只设 `fallbackModel` 而 `model` 为空,或置 `model: null` 时 `fallbackModel` 仍非空
- **THEN** 均以结构化错误拒绝并提示兜底依赖首选,岗位模型声明不变

#### Scenario: 非 persona 岗位设模型拒绝

- **WHEN** 主人给 targetRef 为 a2a 或 cluster 的岗位设置 `model`
- **THEN** 以结构化错误拒绝并说明模型归服务部署配置/各成员岗位

#### Scenario: 读面带生效模型

- **WHEN** 岗位未声明模型而舰队设了 `defaultModel`,主人读取舰队详情
- **THEN** 岗位读面 `model` 为 null、`effectiveModel` 为舰队默认(该模型在读时 roster 中命中)
### Requirement: 舰队节奏对外只读契约

系统 SHALL 提供一个只读查询：给定舰队标识，返回该舰队在岗岗位的节奏与目标位，每岗含岗位标识、岗位名、cron 表达式、IANA 时区与在岗目标引用（kind + id）。无节奏的被动岗 SHALL 以空 cron/时区返回，供调用方判定其不参与节奏等价比较。

该查询 SHALL 仅返回节奏与目标位，SHALL NOT 返回 KPI 槽位声明、报数史、拍板记录、会话内容或任何凭据。作用域 SHALL 与舰队其余管理读面一致（仅舰队所有者可读）；未知或非本人舰队 SHALL 以既有语义拒绝。

用途：外部内容系统在**创建刷新调度**时查询岗位节奏，命中「与某岗位节奏等价且目标同一产物」即拒绝并指向该岗位（跨系统冲突单侧无法判定，故由持有节奏的一侧提供事实）。

#### Scenario: 返回在岗岗位的节奏与目标位

- **WHEN** 所有者查询某舰队的节奏契约
- **THEN** 响应含每个在岗岗位的岗位标识、岗位名、cron、时区与目标引用
- **AND** 响应不含 KPI 槽位、报数、拍板或凭据

#### Scenario: 被动岗如实返回空节奏

- **WHEN** 舰队中存在无节奏的被动岗
- **THEN** 该岗在响应中 cron 与时区为空，其余字段照常

#### Scenario: 非本人舰队被拒

- **WHEN** 非所有者查询该舰队的节奏契约
- **THEN** 请求以既有作用域语义拒绝，不泄露任何岗位信息

### Requirement: 岗位模型按解析链归位执行

每个 persona 岗位回合 SHALL 在回合开始时把运行时模型归位到解析链的第一个 roster 命中档——`[岗位 model, 岗位 fallbackModel, 舰队 defaultModel, cell 默认]`,去空去重,与 persona 归位同构、不依赖上一回合残留。解析输入 SHALL 于回合执行时从岗位/舰队表现查,不物化进任务记录。链中某档已声明但 roster 不含(写时校验不保证运行时有效)SHALL 落到下一档继续,并在回合执行记录留痕指名失效档;该回合存在报数行时 SHALL 同步记入报数 blockers。未声明(null)SHALL 安静继承,不记异常。全链无命中或 roster 为空 SHALL 使回合如实失败,不硬造模型。兜底 SHALL 仅发生在选型时;模型已入选但执行中失败(provider 故障、超时)SHALL 维持既有回合失败语义,等下个节奏自然重试,SHALL NOT 执行中换模型重跑。岗位回合用量 SHALL 按实际运行的模型计入既有 turn 记录。集群汇总回合 SHALL 以首个成功成员的解析结果模型运行。a2a 岗位回合不受解析链影响。

#### Scenario: 岗位模型归位执行

- **WHEN** 岗位声明模型 A 且运行时停在其它模型上,节奏回合触发
- **THEN** 该回合以模型 A 运行,该回合的用量记录显示模型 A

#### Scenario: 改模型下一回合生效

- **WHEN** 岗位模型从 A 改为 B,下一个节奏回合触发
- **THEN** 该回合以 B 运行(允许一次重启),不静默沿用 A

#### Scenario: 未声明岗位不被残留污染

- **WHEN** 混编舰队中岗位甲声明模型 X 跑完回合,未声明模型的岗位乙随即触发
- **THEN** 乙的回合归位到舰队默认或 cell 默认,乙的用量记录不出现 X

#### Scenario: 声明失效回落留痕

- **WHEN** 岗位声明的模型已从宿主 roster 移除,舰队设了 defaultModel,回合触发
- **THEN** 回合成功落舰队默认执行,执行记录(及存在的报数行)指名「岗位模型已失效,落舰队默认」

#### Scenario: 全链无命中如实失败

- **WHEN** 岗位与舰队均未声明模型且 cell 无可用模型,或声明档全部失效且无兜底
- **THEN** 回合以结构化错误如实失败,不虚构模型执行

### Requirement: 成员回合产出回合结果事件

每次舰队成员回合结束,系统 SHALL 追加一条回合结果事件并持久化,至少含:舰队标识、岗位标识、触发源 source(cron 节奏回合 / 拍板批复 execute-now / delegation 唤醒三值)、status(ok|failed|interrupted)、errorKind、错误摘要 error、执行模型 model、起止时刻 startedAt/endedAt、来源会话 sessionId。事件 SHALL 只增不改;岗位归属解析 SHALL 复用既有归属判定(resolveAttribution),不引入第二套身份判定;非舰队回合(无舰队归属的普通定时任务与人工会话)SHALL 不产出事件。

errorKind SHALL 在写时从错误文本与形状归类为有限枚举:模型/上游(model_upstream)、工具/权限(tool_permission)、运行时未就绪(runtime_not_ready)、超时(timeout)、业务拒绝(business_refused)、其余(other);归类 SHALL 为纯函数可测,未识别错误 SHALL 落 other 而非丢弃。

事件 SHALL 有界保留:按岗位滚动限量保留最近 N 条(默认 200),裁剪 SHALL 只删最旧事件且不影响报数与拍板历史。同一岗位的连续失败次数 SHALL 可从事件流聚合读取,不要求独立计数存储;一次成功回合后连续计数 SHALL 归零。

#### Scenario: 失败回合产出事件

- **WHEN** 某岗位的 cron 节奏回合因模型上游不可用而失败
- **THEN** 该岗位追加一条 status=failed、source=cron 的事件,errorKind=model_upstream,错误摘要与来源会话可查

#### Scenario: 被动岗唤醒回合产出事件

- **WHEN** 无节奏的被动岗因 delegation 唤醒执行了一回合并成功
- **THEN** 该岗位追加一条 source=delegation、status=ok 的事件,含起止时刻与执行模型

#### Scenario: errorKind 分类纯函数

- **WHEN** 分类函数收到「execution timed out」与一条无法识别的错误文本
- **THEN** 分别归类 timeout 与 other,过程不访问任何外部状态

#### Scenario: 非舰队回合零扰动

- **WHEN** 用户的一个普通定时任务(非舰队物化)执行并失败
- **THEN** 不产生任何回合结果事件

#### Scenario: 有界保留

- **WHEN** 某岗位累计事件超过保留上限
- **THEN** 最旧事件被裁剪,报数与拍板历史不受影响

#### Scenario: 连续失败聚合归零

- **WHEN** 某岗位连续 3 次失败后执行了一次成功回合
- **THEN** 该岗位连续失败计数从 3 归零,事件流保留全部 4 条记录

### Requirement: 回合结果事件可查询

系统 SHALL 提供回合结果事件的读面:成员级时间线(按岗位分页倒序,含 nextBefore 游标,同报数时间线形态)与舰队级过滤查询(按 status 与 source 过滤)。读面 SHALL 仅暴露事件字段,不携带凭据或会话正文;owner 作用域与舰队读面一致。

#### Scenario: 成员时间线分页

- **WHEN** 请求某岗位的回合时间线并传入上一页返回的 nextBefore
- **THEN** 返回更早一页事件,字段完整且无凭据与会话正文

#### Scenario: 舰队级失败过滤

- **WHEN** 请求舰队回合事件并指定 status=failed
- **THEN** 仅返回该舰队失败事件,含岗位标识与 errorKind

### Requirement: 工具岗回合以确定性工具调用执行

工具岗的回合 SHALL 不经 LLM:执行器 SHALL 将节奏 promptTemplate 解析为 JSON 参数、按 targetId 路由到注册 MCP 服、以 MCP 客户端调用该工具一次,并将工具返回(或错误)以 JSON 文本落入该回合会话。回合结果 SHALL 经既有回合收口产出 O1 事件(model 为空如实),失败 SHALL 结构化分类:参数非 JSON(runtime_not_ready)、server 不可路由(runtime_not_ready)、工具执行错误(other 或按文本归类)。工具岗回合 SHALL 可作为 dispatch 与 handoff 的目标(走 manual 任务车道,targetType=tool),护栏与链深规则与 persona/a2a 一致。

#### Scenario: 确定性回合

- **WHEN** 工具岗 websearch::search 的节奏回合触发
- **THEN** 该工具被调用一次、参数为声明的 JSON、结果 JSON 落会话,O1 事件 status 如实且 model 为空

#### Scenario: 派发到达工具岗

- **WHEN** supervisor 模式下主管岗 dispatch_post 到工具岗
- **THEN** manual 任务以 targetType=tool 创建并按同一执行器运行,深度与频次护栏照常生效

### Requirement: 舰队行更新落双审计痕

fleets 表每次 UPDATE SHALL 在 fleet_row_audit 落一行审计记录（时间戳 / fleet_id /
本次变更的字段集 / orchestration 旧值→新值）——以库层 AFTER UPDATE 触发器实现，对任何
写入进程无差别生效，包括平台进程之外的直接 SQL 写入。平台进程内的舰队行更新 SHALL 附
归因（HTTP 请求身份，或进程内调用方首帧），归因随审计可查。orchestration 从非 null 变
为 null 的写，当归因缺失或不是该舰队 owner 的 HTTP 会话时，平台 SHALL 打 warn 日志。
/api/fleets 的非只读请求 SHALL 记访问日志（方法 / 路径 / 请求身份）。审计记录 SHALL NOT
包含凭据或密钥材料。

#### Scenario: 人为 PATCH orchestration 可查 caller 与新旧值

- WHEN owner 通过 PATCH /api/fleets/:id 修改 orchestration
- THEN fleet_row_audit 出现对应审计行（含时间戳、变更字段集、orchestration 旧值→新值、
  归因为该 owner 的 HTTP 会话）

#### Scenario: 进程外直接 SQL 写入仍被捕获

- WHEN 任意进程绕过平台 API 直接 UPDATE fleets 表（如 shell 直写库文件）
- THEN 触发器审计行照常落库（无应用层归因），据此可判读为进程外写入

#### Scenario: orchestration 复位为 null 打 warn

- WHEN 一次写使 orchestration 从非 null 变为 null,且归因缺失或不是该舰队 owner 的
  HTTP 会话
- THEN 平台日志出现 warn(含 fleet_id 与可得归因),审计行同时落库

#### Scenario: 非审计字段的常规更新不改变写语义

- WHEN owner 修改舰队名或状态等常规字段
- THEN 更新行为与审计前完全一致,仅追加审计行,无额外拒绝或延迟语义
