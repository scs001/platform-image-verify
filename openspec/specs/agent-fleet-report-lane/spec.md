# agent-fleet-report-lane Specification

## Purpose

舰队的业务状态面：成员岗位在自治回合内以结构化工具上报状态（按岗位声明的 KPI 槽位对齐），系统保留 append-only 报数史并以岗位级最新值视图服务读面；带下级的岗位触发回合时，系统把下级最新报数与舰队概况注入其 prompt（巡视上下文注入），使组织层级具备真实的信息流。

## Requirements

### Requirement: 成员岗位可通过报数工具上报结构化状态

系统 SHALL 向舰队成员的回合提供 `report_status` 工具：入参为按槽 key 对齐的指标值、受管资源清单、阻塞项与人读摘要；一次调用 SHALL 落一条 append-only 报数记录并更新该岗位的 latest 视图，记录 SHALL 携带来源会话标识与时间戳。非舰队成员调用 SHALL 以结构化错误拒绝；报数频次与单条体积 SHALL 有上限，超限以结构化错误拒绝且不落库。

#### Scenario: 岗位按槽上报

- **WHEN** 「电商部」岗位（声明槽 sales_week）的回合调用 report_status 提交 {metrics:{sales_week:{value:"$309",delta:"+12%"}}, resources:[…], blockers:[], summary:"…"}
- **THEN** 报数落库，该岗位 latest 视图的 sales_week 槽更新为本次值，来源会话可追溯

#### Scenario: 非成员拒绝

- **WHEN** 未加入任何舰队的 persona 回合调用 report_status
- **THEN** 工具返回结构化错误说明仅舰队成员可用，无记录落库

#### Scenario: 超频拒绝

- **WHEN** 同一岗位在频控窗口内超过上限次数调用 report_status
- **THEN** 超限调用以结构化错误拒绝且不落库，latest 视图不受影响

### Requirement: 槽位制决定指标呈现层级

岗位卡片 SHALL 只呈现该岗位 kpiSlots 声明过的槽 key 的最新值；报数中未声明的指标 key SHALL 保留在报数详情中但不进入卡片视图。槽位声明变更 SHALL 只影响此后读取的呈现分组，不改动既有报数史。

指标趋势 SHALL 由系统计算：latest 视图的每个槽值 SHALL 携带与该岗位上一条报数同槽值的比对结果（方向与差值）；报数提交时随指标附带的 delta 备注 SHALL 仅作展示标注，不参与趋势计算。无前值可比时趋势 SHALL 呈现为无趋势而非伪造。

#### Scenario: 未声明槽进详情不进卡

- **WHEN** 岗位仅声明槽 A，而报数同时提交了 A 与 B 两个指标
- **THEN** 卡片 latest 视图只显示 A，报数详情可见 A 与 B

#### Scenario: 趋势系统算

- **WHEN** 岗位 sales_week 槽上一条报数为 280、本条为 309
- **THEN** latest 视图该槽携带上行趋势与差值 +29（系统比对），即便本条报数自报的 delta 备注与此不符

#### Scenario: 无前值不伪造

- **WHEN** 岗位某槽首次报数
- **THEN** 该槽趋势呈现为无趋势

### Requirement: 报数归属按岗位解析且 a2a 岗位诚实降级

报数归属 SHALL 由服务端从回合执行上下文解析（persona 岗位按当前 preset、cluster 岗位按 clusterId 定位唯一岗位），调用方 SHALL 不能指定任意岗位 id 代报。a2a 岗位因无法调用本 cell 工具，其 latest 视图 SHALL 由最近一次执行结果生成执行摘要并明确标注为非自报。

#### Scenario: 服务端归属解析

- **WHEN** persona E 以「电商部」岗位身份执行回合并调用 report_status
- **THEN** 报数归属「电商部」岗位，即使请求未携带任何岗位标识

#### Scenario: a2a 执行摘要降级

- **WHEN** a2a 岗位完成一次回合
- **THEN** 其 latest 视图呈现由该回合结果生成的执行摘要，且视图标注「非自报」

### Requirement: 巡视上下文注入

岗位节奏规格的 prompt 模板 SHALL 支持 `{{fleetContext}}` 占位符；触发时系统 SHALL 把舰队上下文渲染注入该占位符，内容至少包含：直接下级岗位的最新报数摘要（槽值+blockers）、舰队在岗概况。模板不含占位符时 SHALL 原样执行（与既有静态 prompt 行为一致）。渲染失败 SHALL 使该次触发以结构化错误落史，不静默降级为无上下文执行。

#### Scenario: CEO 岗位巡视拿到下级报数

- **WHEN** 带 {{fleetContext}} 的 CEO 岗位节奏触发，其下级「电商部」latest 报数为 sales_week=$309
- **THEN** 本次回合的 prompt 中 fleetContext 部分包含该槽值与岗位名

#### Scenario: 无占位符零变化

- **WHEN** 岗位模板不含 {{fleetContext}}
- **THEN** 触发行为与注入能力引入前完全一致

#### Scenario: 渲染失败显性化

- **WHEN** 注入渲染过程抛错
- **THEN** 本次触发记录为失败并携带结构化错误，不静默按空上下文执行

### Requirement: 报数时间线读面

舰队详情读面 SHALL 为每个岗位提供报数时间线（时间、槽值快照、blockers、来源会话链接），并 SHALL 把岗位失联判定升级为「执行超窗或（曾报数后）报数超窗」二者的或，判定依据随响应携带。

#### Scenario: 时间线可读

- **WHEN** 岗位累计三条报数后读取舰队详情
- **THEN** 该岗位时间线按时间倒序呈现三条记录，每条可跳转来源会话

#### Scenario: 报数腐化计入失联

- **WHEN** 岗位执行正常但其报数超过两倍周期未更新
- **THEN** 派生状态呈现失联并携带「报数超窗」依据

### Requirement: 舰队成员回合注入岗位身份

舰队成员在**其岗位回合**内 SHALL 能读到自己的岗位身份，至少包含所属舰队标识、岗位标识、岗位名与在岗目标引用。身份 SHALL 以一行系统文本前缀在该回合的 prompt 首部，格式稳定到可被模型直接复述为外部系统的生产来源标记（`fleet=<id>; post=<memberId>; ref=<targetRef>; title=<title>`）。

该注入 SHALL 覆盖**两条成员唤醒路径**：有节奏岗的定时回合与被动岗的受委托回合（delegation）。身份 SHALL 不含任何凭据，SHALL NOT 写入对外可见的 AgentCard 或公开目录。

非成员回合 SHALL 不注入：persona 未在岗任何岗位、或一个 persona 同时占据多个岗位（归属歧义）时，回合 prompt SHALL 与现状逐字一致。归属判定 SHALL 复用报数面既有的归属解析，不引入第二套判定。

#### Scenario: 有节奏岗回合带身份

- **WHEN** 一个绑定 persona 的有节奏岗位到点触发回合
- **THEN** 该回合的 prompt 首部含一行岗位身份，四个字段（fleetId / memberId / 目标引用 / 岗位名）与实际岗位一致
- **AND** 该回合的会话史首条用户消息含同一行

#### Scenario: 被动岗受委托回合带身份

- **WHEN** 一个无节奏的被动岗被另一个 agent 通过 delegation 唤醒
- **THEN** 该回合的 prompt 首部同样含岗位身份行

#### Scenario: 非成员回合不注入

- **WHEN** 普通对话由一个未在岗任何舰队岗位的 persona 执行
- **THEN** 回合 prompt 与现状逐字一致，不含身份行

#### Scenario: 归属歧义不注入

- **WHEN** 执行回合的 persona 同时占据两个岗位
- **THEN** 不注入身份行（与报数面对歧义的诚实拒绝一致）

#### Scenario: 身份不含凭据

- **WHEN** 检查注入的身份行内容
- **THEN** 其中只含舰队标识、岗位标识、岗位名与目标引用，不含任何 token、密钥或凭据
