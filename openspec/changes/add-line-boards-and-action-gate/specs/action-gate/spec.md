## Purpose

动作闸把「AI 提议、人确认、系统执行」变成平台原语：让副驾与自主 agent 都能提出动作，但任何重要动作都必须经过明确确认、可追溯执行与事后审计。

## ADDED Requirements

### Requirement: 动作注册表声明风险与影响面

每个受闸动作 SHALL 在注册表中声明：动作 id、底层工具、风险等级（read / write / destructive / cost / publish）、影响面模板与目标类型（cloud / desktop / any）。风险等级 SHALL 决定确认档位。未在注册表声明的动作 MUST NOT 由副驾执行。

#### Scenario: 未注册动作被拒绝

- **WHEN** 副驾提议一个不在注册表中的写动作
- **THEN** 闸拒绝执行并返回动作未注册，不调用底层工具

### Requirement: 写工具不进入副驾可见面

副驾的可见工具面 SHALL 只含读工具与平台提供的 `propose_action`。副驾所使用的 pack 工具白名单 MUST NOT 含任何写类工具；`propose_action` 由平台提供，不计入 pack 声明。副驾 MUST 通过提议通道发起写操作，MUST NOT 直接调用写工具。

#### Scenario: 副驾工具面只含读与提议

- **WHEN** 检查副驾会话的可见工具面
- **THEN** 不含任何写类工具，含读工具与平台提供的 `propose_action`；副驾 pack 的白名单本身不含写工具

### Requirement: 三级确认档位

闸 SHALL 按风险等级选择确认档位：`read` 直接执行并记录；`write` 在执行前呈现行内确认（含动作名、目标与影响面）；`destructive` 与 `cost` SHALL 二次确认并展示影响面摘要（受影响对象数量、可逆性、费用或资源占用）；`publish`（对外发布或可见性变更）SHALL 进入异步审批。任何档位 MUST NOT 在用户未确认时执行。

#### Scenario: 写动作行内确认

- **WHEN** 副驾提议一个 write 动作
- **THEN** 用户看到确认卡，只有点击确认后才调用底层工具

#### Scenario: 破坏性动作展示影响面

- **WHEN** 副驾提议一个 destructive 动作
- **THEN** 确认卡显示将受影响的对象数量与是否可逆，用户确认后才执行

### Requirement: 异步审批仅限 owner 且失败关闭

`publish` 与需要离线处理的动作 SHALL 进入审批队列，审批人 SHALL 仅限资源 owner。审批请求 SHALL 在 24 小时内有效；超时未处理 SHALL 自动拒绝（fail-closed），MUST NOT 自动执行。审批请求 SHALL 通过现有通知通道触达用户。

#### Scenario: 超时自动拒绝

- **WHEN** 一个审批请求 24 小时内未被处理
- **THEN** 该动作被拒绝，底层工具未被调用，审计记录标记为 expired

#### Scenario: 非 owner 不能批准

- **WHEN** 非资源 owner 尝试批准该请求
- **THEN** 闸拒绝并返回 403

### Requirement: 单一执行路径与审计台账

所有受闸动作 SHALL 经同一条执行路径调用底层工具。执行记录 SHALL 至少包含：动作 id、提议者（会话与用户）、批准者、批准时间、参数摘要、执行结果与耗时。审计记录 MUST NOT 含凭据明文。记录 SHALL 可按线、按时间与按动作检索。

#### Scenario: 执行留痕

- **WHEN** 一个动作被批准并执行
- **THEN** 审计台账新增一条记录，含提议者、批准者、参数摘要与结果

#### Scenario: 审计不含密钥

- **WHEN** 查询任意审计记录
- **THEN** 响应不含 token、sk- 或其片段

### Requirement: 部署无关的 preflight

动作的目标 SHALL 在确认前完成 preflight：`target=cloud` SHALL 要求该用户已连接部署者凭据（`wanxing-deployer`）；`target=desktop:<seat>` SHALL 要求该机位已配对且在线，MUST NOT 要求计费键。preflight 失败 SHALL 阻止动作进入确认档位，并给出可操作的修复指引。

#### Scenario: 桌面部署不需要计费键

- **WHEN** 用户提议把 agent 部署到已配对的桌面机位
- **THEN** preflight 通过，确认卡不要求计费键

#### Scenario: 云端部署缺凭据被拦截

- **WHEN** 用户提议云端部署但未连接 wanxing-deployer
- **THEN** preflight 失败，动作不进入确认档位，提示去连接

### Requirement: 回执不冒充结果

闸 SHALL 区分已接受、已执行与执行失败三种状态，并向用户如实呈现。提议被接受但尚未执行时 MUST NOT 显示为成功；执行失败 SHALL 保留原动作与失败原因，允许重试或取消。

#### Scenario: 接受不等于成功

- **WHEN** 异步审批请求刚被创建
- **THEN** 看板与副驾显示等待批准，不显示已执行
