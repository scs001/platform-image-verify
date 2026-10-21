# fleet-memory Specification

## Purpose

舰队级工作记忆服务：为萬星 runner 上的部署 agent（及后续壹座 cell 与本地节点）提供跨会话的任务状态、交接与沉淀事实存取——namespace 隔离、令牌鉴权、OKF 兼容存储、零 LLM。

## Requirements

### Requirement: 人令牌经 /hook 写入其 namespace，platform 族边界如联邦契约

fleet-memory 服务的人令牌（u/ 族）SHALL 同时被 `/hook` 兼容端点与 MCP 面接受，两者写入同一 namespace 语义（互见）；新增 `platform` 族令牌为纯铸造面（铸造 person 令牌；capture//hook/MCP 全拒），权限矩阵为：deployment=d/ 单 namespace 读写；person=u/ root 读写（MCP+/hook）；runner=任意 d/ capture-only + 代铸 deployment；platform=代铸 person only；local collector 令牌族（fsc_）仅 stats 面，与记忆令牌族互不相通。

#### Scenario: 令牌族权限矩阵全覆盖

- **WHEN** 以四种令牌族分别请求 capture、/hook、MCP、铸造面
- **THEN** 每格结果与矩阵一致（拒绝均 403 结构化），无越界写入
