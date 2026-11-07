# fleet-room-bridge Specification

## Purpose
团队与智语空间的桥：空间的成员形态之外新增「团队订阅」——把一支团队的关键动态（报数摘要、等你拍板、
健康状态迁移）以事件消息行流入空间供成员阅读讨论；召唤面提供一键把团队的部署成员批量邀入。
桥是**读面 + 邀请面**：不向团队写任何指令，不绕拍板，不改 cell 上行白名单。

## Requirements

### Requirement: 空间可订阅自有团队并以事件行流入

空间（主办或获授权成员）SHALL 可订阅一支**订阅者自己拥有**的现役团队；订阅后团队三类关键事件 SHALL
以 `kind=system|event` 消息行流入空间：报数摘要（岗位名+槽位要点+截断的摘要行）、待拍板产生（问题+严重度，
带驾驶舱深链）、健康状态迁移（连败/失联/恢复，带判定依据）。每事件行 SHALL 带来源标注（团队名+岗位）
与时间；事件行 SHALL NOT 携带会话内容、工具结果或任何上行白名单外的内容。订阅 SHALL 可随时解除，
解除即断流且已流入行保留。未拥有该团队的订阅请求 SHALL 被拒（不泄漏存在性）。

#### Scenario: 报数流入空间

- **WHEN** 一支被订阅团队的岗位完成节奏回合并报数
- **THEN** 空间消息流出现一条 system 事件行（岗位+槽位要点+摘要），点击深链进该团队驾驶舱

#### Scenario: 待拍板产生即通知

- **WHEN** 该团队某岗位产生一项等你拍板的决策
- **THEN** 空间出现事件行（问题+严重度+深链），主人可在空间里讨论后再去驾驶舱裁决

#### Scenario: 非自有团队拒订阅

- **WHEN** 用户试图订阅一支不属于自己的团队
- **THEN** 请求被拒且响应不区分「不存在」与「非自有」

### Requirement: 事件流入有频控且如实降级

事件流入 SHALL 受频控（沿报数防洪语义）：同团队同类事件的密集窗口 SHALL 合并为一条摘要行
（计数+样例），MUST NOT 刷屏；空间消息流配额/熔断（既有回合协议纪律）适用于事件行——熔断期间
事件 SHALL 丢弃并计数，恢复后 SHALL 不补发（如实标注丢失量于下一条事件行）。桥故障 SHALL 只降级
本桥（事件停止流入），MUST NOT 影响空间正常消息或团队回合。

#### Scenario: 密集报数合并

- **WHEN** 一小时内同团队产生 10 条报数
- **THEN** 空间按频控合并呈现（如「近 1 小时 10 条报数，最新：…」），不逐条刷屏

#### Scenario: 桥故障只哑桥

- **WHEN** 桥模块异常
- **THEN** 空间消息与团队回合照常；事件流暂停并在恢复后于下一条事件行标注丢失计数

### Requirement: 一键带队召唤批量邀入部署成员

空间召唤面 SHALL 提供从自己团队清单的一键召唤：将该团队当前可召唤的部署成员（`packId:agentId`，
既有 agent 成员形态）批量发起邀请（沿既有邀请握手与策略应答），并默认建立该团队的事件订阅；
召唤 SHALL 如实呈现哪些成员可召唤（有 serving 部署）、哪些不可（persona 岗无 serving 面——
SHALL NOT 假装其在空间可对话，呈现为「在驾驶舱可见/行动」的指引）。邀请结果逐成员如实
（接受/拒绝/待答），部分失败不掩盖。

「可召唤面」的判定语义 SHALL 为：团队编队上报中 `targetKind` 为 a2a 的岗位，且其 serving 部署
路径能在部署台账中对齐到一行现役部署——此时该岗以该部署的 `packId:agentId` 为席位引用、
该部署的部署者为代表（onBehalfOf）成为可召唤成员。部署台账中无对齐行的 a2a 岗（含外部
serving 地址不属于部署台账的）SHALL 如实排除在可召唤之外，不虚构席位引用。部署台账面
不可达时 SHALL 诚实降级为空可召唤面（如「面暂不可用」，与事件采样同款纪律），MUST NOT
报错打断空间。

#### Scenario: 一键召唤部署成员

- **WHEN** 主人对自己拥有的一支含两个部署成员的团队执行一键召唤
- **THEN** 两个部署成员的邀请按其策略发起，事件订阅建立；persona 岗呈现为「去驾驶舱」指引而非假邀请

#### Scenario: 部分失败不掩盖

- **WHEN** 两个部署成员一个接受一个按策略拒绝
- **THEN** 空间如实呈现一进一拒，订阅照常建立

#### Scenario: 召唤计划对现役部署岗位非空

- **WHEN** 一支团队含 a2a 部署岗且其 serving 部署路径与部署台账对齐，主人执行召唤计划（dryRun）
- **THEN** 计划的 summonable 逐成员携带 `packId:agentId` 席位引用与其岗位名，persona 岗仍呈现在 cockpitOnly

#### Scenario: 外部 serving 地址与无对齐行如实排除

- **WHEN** 某岗的 serving 部署地址不属于部署台账（外部服务），或台账中该路径无现役行
- **THEN** 该岗不出现在 summonable，也不假装可召唤（按计划语义归入不可召唤侧）

#### Scenario: 部署台账面不可达时诚实降级

- **WHEN** 部署台账面不可达（网络/配置缺失）
- **THEN** 召唤计划仍 200 返回，summonable 为空、cockpitOnly 照常如实，不返回错误

### Requirement: 团队订阅与召唤端点在平台网关完整装配下可达

平台网关 SHALL 保证 `fleet-room-bridge` 的四条端点在**生产装配序列**下可达：`GET /api/zhiyu/rooms/:id/fleet-subscriptions`、`POST /api/zhiyu/rooms/:id/fleet-subscriptions`、`DELETE /api/zhiyu/rooms/:id/fleet-subscriptions/:subId`、`POST /api/zhiyu/rooms/:id/fleet-summon`。这些端点 SHALL NOT 被任何更早注册的 `/api/zhiyu/*` 前缀级兜底路由拦截；对合法主办/成员与自有团队的请求 SHALL 进入桥的既有所有权与成员闸逻辑，而不是返回 404。同时，未被任何 zhiyu 路由匹配的 `/api/zhiyu/*` 请求 SHALL 仍以同形 `404 {"error":"not found"}` 收口，MUST NOT 落到 cell 代理而由同名路由以不同语义应答。

#### Scenario: 按生产顺序装配后订阅端点不再 404

- **WHEN** 网关按「房间内核 → IM 桥 → 团队订阅桥 → 前缀兜底」的顺序完成装配，且一位空间主办对自有现役团队发起订阅
- **THEN** `POST /api/zhiyu/rooms/:id/fleet-subscriptions` 不返回 404，而是按既有所有权闸返回订阅成功（201）或可读的拒绝原因

#### Scenario: 按生产顺序装配后召唤计划可读

- **WHEN** 同一装配下主办对自有现役团队发起 `POST /api/zhiyu/rooms/:id/fleet-summon`（含 dryRun 计划请求）
- **THEN** 响应不返回 404，返回含 `summonable` 与 `cockpitOnly` 的计划或执行结果

#### Scenario: 兜底仍挡住未匹配路径

- **WHEN** 任意客户端请求一个未被任何 zhiyu 路由匹配的 `/api/zhiyu/*` 路径
- **THEN** 响应为 `404 {"error":"not found"}`，且不转发到用户 cell

#### Scenario: 装配顺序回归被测试捕获

- **WHEN** 有人把前缀兜底重新移到团队订阅桥之前注册
- **THEN** 按生产装配顺序编写的集成测试失败，提示桥端点不可达
