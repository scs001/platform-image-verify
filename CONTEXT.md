# PAAS Platform Domain Context

## Language

**功能集（Pack）**:
运营者发布到市场、订阅者一键装进 cell 的技能+MCP+角色的版本化捆绑包。
_Avoid_: 扩展包、bundle、插件包

**角色（Persona）**:
Pack 中声明的对话入口，在订阅者运行时以本地人设运行——当前选中模型+包人设文本，无独立端点或凭证。
_Avoid_: 智能体、agent（除非指 dsh 内部概念）、机器人、bot

**资源集（Resource Set）**:
一个角色关联的技能与 MCP server 清单。推导视图：从已装包版本快照与覆盖偏好推导，不是被存储的声明。
_Avoid_: 裁剪集、focus set、关联集

**聚焦模式（Focused Mode）**:
运行时组合状态——只装载基线与所选角色资源集的技能与 MCP server。
_Avoid_: 裁剪模式、trim mode、瘦身模式

**基线（Baseline）**:
Deployment 级常量集合：MCP = mcp.json 运维层 ∪ PACK_BASELINE_MCP env；技能 = 仓库 skills/ 目录。
_Avoid_: 默认集、default set、基础集

**覆盖偏好（Overlay）**:
用户对某预设有效资源集的增删偏好：加只能选已启用的资源，减总是合法。是偏好差异而非快照，包升级后对新集合重新解析。
_Avoid_: 自定义资源集、scope 状态、快照

**自建预设（Custom Preset）**:
用户在 cell 本地拼装的对话入口：自选人设文本与本地可用资源，聚焦运行，不经市场发布。
_Avoid_: 用户包、自定义智能体、local pack
