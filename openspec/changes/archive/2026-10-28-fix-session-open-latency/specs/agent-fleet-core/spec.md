## ADDED Requirements

### Requirement: 舰队名册读面每请求只合并一次目录

舰队名册类读面（`GET /api/fleets`、`/api/fleets/overview`、`/api/fleets/owner/board`、`/api/fleets/:id`、`/:id/cockpit`，以及编排草稿校验与 apply、catalog 变更后的对账）SHALL 在同一请求（或同一对账轮次）内对合并目录取一次快照，并以该快照解析全部岗位目标；SHALL NOT 逐岗位重新合并目录。cron 任务表 SHALL 每请求列取一次并在各舰队之间复用。

合并目录的成本来自重读注册表快照、已装包清单与用户预设（生产实测单次约 30ms）。逐岗位合并使名册读成为 cell 事件循环上的秒级同步阻塞，而同一进程同时服务聊天 WebSocket，因此该阻塞会推迟会话首帧。

#### Scenario: 六十岗位的名册读只付一次合并

- **WHEN** 某舱主有 21 支舰队、60 个岗位，请求 `GET /api/fleets`
- **THEN** 该请求内的目录合并次数为 1，且不随岗位数增长

#### Scenario: 快照不改变在岗判定

- **WHEN** 同一请求内解析多个岗位的目标
- **THEN** 每个岗位的 `alive`/标签与逐岗位合并时一致（同一份目录快照）

### Requirement: 舰队名册行携带待拍板计数

舰队名册行 SHALL 携带 `openDecisions`（该舰队 `state='open'` 的拍板条数）。侧栏角标以名册行该字段为唯一来源；缺该字段时角标永远不会出现，故服务端 SHALL 在名册读面提供。

#### Scenario: 有待拍板时名册行可见

- **WHEN** 某舰队存在 1 条 open 决策，请求 `GET /api/fleets`
- **THEN** 该舰队行的 `openDecisions` 为 1

#### Scenario: 无待拍板时为 0

- **WHEN** 某舰队没有任何 open 决策
- **THEN** 该舰队行的 `openDecisions` 为 0（不是缺字段）