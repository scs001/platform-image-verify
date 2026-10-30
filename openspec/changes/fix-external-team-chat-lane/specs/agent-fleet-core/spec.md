## ADDED Requirements

### Requirement: 对外岗位的对话车道注入本队上下文

用户在对话车道与某个 preset 对话时，若该 preset 归因到某支智能体团队的 persona 岗位，
则起轮前 SHALL 为该轮注入本队上下文：本队成员清单（ref、title、目标）与可派发目标集合。
未归属任何团队的 preset SHALL NOT 注入，行为与现状一致。注入 SHALL 复用任务车道的上下文渲染器
（同一格式），且 SHALL NOT 包含节点、凭据、成本等内部运营信息。

#### Scenario: 前台拿到本队名单

- **WHEN** 访客在对话车道向前台岗位提问，且该 preset 归因到某队的 persona 岗位
- **THEN** 该轮 prompt 包含该队的成员清单与可派发目标，前台无需猜测队友标识

#### Scenario: 普通 preset 不受影响

- **WHEN** 用户与一个未归属任何团队的 preset 对话
- **THEN** 该轮 prompt 不含任何团队上下文段，行为与变更前一致

### Requirement: 派发按岗位引用寻址

派发请求的 `to` SHALL 接受本队成员的岗位引用（ref）或岗位标题（大小写不敏感），
member id 继续支持；解析 SHALL 限本队内。同名歧义 SHALL 以 400 拒绝并列出候选；
跨队引用 SHALL 以 400 拒绝。

#### Scenario: 按 ref 派发命中

- **WHEN** 岗位以 ref 指向本队某个成员发起派发
- **THEN** 派发命中该成员并按既有同集群闸、限流与回执语义执行

#### Scenario: 同名歧义被拒

- **WHEN** 本队存在两个同名成员，派发按标题寻址
- **THEN** 请求以 400 拒绝并列出两个候选，不任选其一
