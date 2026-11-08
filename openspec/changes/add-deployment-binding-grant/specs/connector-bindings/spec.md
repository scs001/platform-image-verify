## ADDED Requirements

### Requirement: 无人值守部署的绑定由部署者预铸

一个包被部署为常驻服务（served agent / 定时岗位）时，其声明的绑定 SHALL 在**部署时**由
部署者本人的身份铸出，并存储为部署密钥供该部署使用；运行期 SHALL NOT 依赖服务身份铸造
绑定，因为服务身份不拥有被铸造的凭证。

只有同时满足以下两条的绑定键 SHALL 被铸造：该包 `connector_bindings` 声明中 `optional`
不为真；解析态为 `satisfied`。`unwired`、`undetermined`、`missing` 的键 SHALL NOT 被铸造
（与状态面同语义：目录不覆盖、无法询问、尚未连接都不是可铸状态）。

铸造出的令牌 SHALL 记录其归属部署者与所属部署；该部署者撤销账号或撤销该绑定时，对应
部署密钥 SHALL 一并失效或被删除，重新部署 SHALL 以重新部署者的身份重铸，旧密钥 SHALL NOT
与新密钥并存。

#### Scenario: 无人值守岗位拿到绑定

- **WHEN** 部署者部署一个声明了绑定（`optional` 非真、解析态 `satisfied`）的包为常驻岗位
- **THEN** 部署完成时已存在对应的部署密钥，其值是一枚由部署者账号衰减而来的绑定令牌
- **AND** 运行中的岗位无需任何用户交互即可使用该绑定

#### Scenario: 不可铸状态不静默变通

- **WHEN** 某绑定的解析态为 `missing`、`unwired` 或 `undetermined`
- **THEN** 部署 SHALL NOT 为其铸造令牌
- **AND** 该键在状态面上呈现其原本状态，而不是显示为已授权

#### Scenario: 部署者撤销即失效

- **WHEN** 部署者撤销其账号或删除该绑定
- **THEN** 该部署对应的部署密钥失效/被删除，岗位下一次调用被拒
- **AND** 重新部署需要由重新部署者重铸，不与旧密钥并存
