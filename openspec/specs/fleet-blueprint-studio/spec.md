# fleet-blueprint-studio

## Purpose

垂直蓝图（vertical blueprint）从内部手艺变客户面产品的契约面：蓝图是与活集群独立的资产对象，
经「编辑→校验→批准→铸造→上架→试跑」六段走完一条可审计的产线。本规格钉三件事——
① 校验链复用（不立第二套校验器/第二上架通道/第二调度器）；
② 批准分两段（对话级显式批准 + apply 重校验兜底），未经批准零落地；
③ 试跑断言全绿是「可售态」的唯一真源。

边界：本能力治「包」（蓝图→集群模板→上架），活集群的现场编排归 `agent-fleet-core` /
architect 面——两处共享 fleet 段校验函数与起草批准纪律，但互不引写路径。

## Requirements

### Requirement: 蓝图是独立资产对象，fleet 段过既有模板校验

平台 SHALL 提供蓝图（blueprint）实体作为与活舰队独立的资产对象，承载垂直包的自描述内容：板块边界（名称/一句话用途/不做什么）、数据来源引用（仅 registry 在册 server 名或内部库逻辑名，**不得含端点/token/secret 任何凭据**）、岗位编制（岗位名、职责一句话、纪律 pack 引用、KPI 槽位、节奏声明、编导边）、看板与产物骨架、监控判据与 escalate 阈值、验收断言清单。蓝图的 fleet 段字段形状 SHALL 与既有舰队模板逐字段同源，SHALL 能直接通过既有 `parseFleetTemplate` 校验——**零翻译层**。

#### Scenario: fleet 段零翻译过校验

- **WHEN** 取任一蓝图 fleet 段提交既有 parseFleetTemplate
- **THEN** 校验通过且无格式改写；失败报错来自既有校验器原文

#### Scenario: 蓝图不含凭据

- **WHEN** 审阅任一新存储的蓝图
- **THEN** 数据来源引用行只出现在册 server 名或内部库逻辑名，无端点与凭据键

### Requirement: 工作室提供编辑→校验→diff 的工作面，草稿不落库

平台 SHALL 在 owner 面提供「蓝图构造间」：蓝图创建与编辑（表单与 JSON 双轨，互相只读同步，不绕校验）、以自然语言生成蓝图草稿（**承袭构造师 pack 的编译能力**，仅作为草拟输入渠道，不引入第二个编译源）、草稿先经完整校验链与归一化 diff 再呈现给主人。**未经主人明确批准前，经面不得将草稿落地为任何实体**：市场上不出现新包、市场与铸造仓不出现新 manifest、实例化路径不出现新集群。

#### Scenario: 草稿先行、批准未至零落地

- **WHEN** 主人提交 NL 场景并产出的蓝图草稿尚未批准
- **THEN** 市场条目、铸造仓与集群库无任何新增；工作台只显示草稿与 diff

#### Scenario: 双轨编辑不绕校验

- **WHEN** 主人以 JSON 轨直接改岗位编制
- **THEN** 提交前该剧字段仍跑全套既有校验；直写不得绕过校验闸

### Requirement: 校验链复用，禁新立第二套

蓝图草稿与铸造前的全部校验 SHALL 复用既有校验链：`parseFleetTemplate`（fleet 段）→ 既有 `validatePackManifest`（manifest 段）→ 发布门 `allowTools ⊆ 商业集`（可携依赖声明复核）。错误回报 SHALL 逐字段指名并使用既有校验器原文语义——SHALL NOT 在该面另起第二套校验器或改写错误格式。

#### Scenario: 非法蓝图逐字段拒绝

- **WHEN** 草稿含成环 handoff 边或含未备案 MCP 引用
- **THEN** 回报指名违规字段与所在行，错误文本与既有校验器生成件同源

#### Scenario: 校验不过的批准短路

- **WHEN** 主人对一份校验未通过的草稿点批准
- **THEN** 批准动作被拒并指名未过项；铸造/上架一律不发生

### Requirement: 主人批准闸分两段纪律

批准 SHALL 按两段纪律执行：① 对话级纪律——主人对校验结果与 diff 的显式批准动作才可推进铸造；② apply 重校验兜底——铸造/上架动作在服务端对**批准时的同一草稿**重跑全套校验，且草稿与库状态漂移（如依赖 pack 已下架、蓝图草案被并发改写）时如实报错并拒绝执行。批准凭据（批准人、批准时间、diff 摘要）SHALL 记录为铸造追溯件。

#### Scenario: 批准走同一草稿再校验

- **WHEN** 批准后到铸造间隔中依赖 pack 被下架
- **THEN** apply 重校验发现漂移、报错拒绝，且不产生新的铸造或上架动作

### Requirement: 铸造与上架走既有发行通道，产物带追溯

铸造 SHALL 按既有形态产出集群模板 manifest：依赖占位 `{{PACK_ID:*}}` 补齐、`_casting` 段记录来源蓝图路径/草案版本/主取凭据与批准时间；上架 SHALL 只经既有市场发行通道（pack 发行门），市场条目标注模板归位（「集群模板」专辑/类目）。上架 SHALL NOT 引入与既有 pack 发行不同的第二上架路径；铸造产物在人工后续改写时按既有「用—养—传」纪律与构造链不冲突共存。

#### Scenario: 铸造产物的 `_casting` 完整

- **WHEN** 检查新上架模板的 manifest
- **THEN** `_casting` 段含来源蓝图路径、批准凭据与批准时间，依赖占位已逐项落实 packId

#### Scenario: 走市场同一门道

- **WHEN** 上架一封集群模板 pack
- **THEN** 该条目过既有发布门（工具面声明闭包与商业集闸），在集群模板专辑可见；未发现走另一通道的条目

### Requirement: 试跑验收为可售态的真源

模板首跑 SHALL 以蓝图验收段的断言清单执行「装一台跑一轮」试跑：报告逐断言记录证据（首回合标识、读数快照、产物 source_ref），全量落盘可查。试跑不绿的模板 SHALL NOT 进入可对外呈现/可售态；vendor（第三方）上架的模板 SHALL 强制带有可验收的试跑报告位（与供给开放单的 vendor 统计/分成字段对账）。

#### Scenario: 试跑断言全绿才可售

- **WHEN** 试跑中任一断言失败或证据缺位
- **THEN** 报告如实标出不绿，模板条目不进入可售态，市场不在「集群模板」专辑呈现对外购买路径

#### Scenario: vendor 模板带试跑位

- **WHEN** 某第三方提交一则模板欲上架
- **THEN** 上架前该模板携带可验收的经营报告位；缺位的上架在结构性闸被拒

### Requirement: v1 方言如实拒绝，不归一化兼容

平台 SHALL 只接受蓝图格式 v2（`boundary` / `dataSources` / `board` / `acceptance` 结构化条目）。收到 v1 方言（出现 `vertical` / `sources` / `boards` 独有键，而对应 v2 键 `boundary` / `dataSources` / `board` 缺位）时，平台 SHALL 落一条指名 v1→v2 的错误并拒绝，SHALL NOT 归一化改写成 v2 形状后接受。

该拒绝 SHALL 分两处生效：
- **写入层**：v1 形状的 content 在任何写路径（创建/编辑，及未来写入方）上结构性不可存储，与「蓝图不含凭据」同级处理——拒绝且不落库。
- **校验链**：校验/批准/铸造入口同样拒绝；且该拒绝 SHALL **短路**后续校验链，只报这一条根因错误，SHALL NOT 叠加由方言错位派生的形状错（如逐条 acceptance 形状错与无字段归属的包级错）。

错误文案 SHALL 指名：本平台只接受 v2、v2 各段字段形状、格式真源位置、以及 v1→v2 的逐项迁移指引（`vertical{name,tagline,non_goals[]}` → `boundary{name,oneLine,outOfScope}`、`sources[].registryName` → `dataSources[].ref`、`boards` → `board`、自由文本断言 → 结构化断言条目）。

这与「未知断言 kind 拒绝而非猜测」同族：错方言必须被如实指名，不得静默猜测或静默转换。

#### Scenario: v1 蓝图写入被指名拒绝

- **WHEN** 主人把一份按 v1 字段名写的蓝图（`vertical` / `sources` / `boards` / 自由文本 `acceptance`）粘贴提交创建或编辑
- **THEN** 请求被拒（422），返回**一条**指名「蓝图格式为 v1，本平台只接受 v2」的错误，含 v2 字段清单与逐项迁移指引；库中不新增/不改写该蓝图

#### Scenario: 校验链只报根因，不报派生散错

- **WHEN** 对一份 v1 形状的蓝图执行校验、批准或铸造
- **THEN** 回报中只有这一条 v1→v2 错误；不出现逐条 `acceptance[N]` 形状错，也不出现无字段归属的包级错误

#### Scenario: v2 蓝图不受影响

- **WHEN** 提交一份按 v2 字段名写的蓝图（含 `boundary` / `dataSources` / `board` / 结构化 `acceptance`）
- **THEN** 创建、校验、批准、铸造全链行为与本变更前一致；即便该文档另带一个无害的旧键也不触发 v1 拒绝（判别要求 v1 独有键存在**且**对应 v2 键缺位）
