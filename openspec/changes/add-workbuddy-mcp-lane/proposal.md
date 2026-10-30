## Why

萬星与谦面的供给进不了腾讯 WorkBuddy：团队用户的工作台里没有我们的入口，只能靠人工抄一段 MCP 配置。
WorkBuddy 是 CodeBuddy Agent CLI 之上的桌面 Product，其开放面已支持远程 MCP（用户级
`~/.workbuddy/mcp.json`、项目级 `<项目>/.workbuddy/mcp.json`，`type: http` + `url` + `headers`），
而谦面 CLI 现有的五个 target（Claude Code / Cursor / ZCode / Codex / Gemini CLI）不含它——
一条命令能完成的事，今天要用户手写 JSON、手贴调用键。

同时本单把「我们的 OAuth 发现能力能不能让这个客户端免贴键」从推论变成了逐环实测，
结论是**当前不通，且原因不在客户端**：客户端内嵌官方 MCP SDK 的标准 OAuth 流程，
硬要求授权服务器元数据带 `registration_endpoint`（RFC 7591 动态客户端注册），而我们的
Logto 没有它（也没有 SEP-991 兜底开关）；实测抛错 `Incompatible auth server: does not support
dynamic client registration`。打通它属身份/网关侧改动，不在本单范围；本单把贴键路径
做成可用产品，并把这一阻塞原因写进指南（避免下一个人再推一遍）。

## What Changes

- **facet CLI 新增第六 target `workbuddy`**：技能安装按该客户端的目录约定落盘；`install --write-mcp`
  写它原生的 MCP 配置（用户级与项目级各一），条目形状为 `type: "http"` + `url` + `headers`。
- **连接主路径是贴键**：`facet connect` 铸键 + `install --write-mcp` 写 `headers.Authorization`；
  同时把 OAuth 免键为什么当前不可用写进指南（阻塞点定位到授权服务器缺注册端点，非客户端能力）。
- **文档与单源测试同步**：新增 `docs/ecosystem/workbuddy.md` 指南、`docs/ecosystem/client-matrix.md`
  增列；`scripts/test-facet-docs-facts.mjs` 的「文档事实 == CLI 两张表」断言随新 target 自动咬合。
- **冒烟覆盖**：`scripts/smoke-facet-clients.mjs` 增加新 target 的写入形状断言（路径 + 条目键名）。
- **明确不做**：不碰插件市场分发（兄弟单 `add-pack-marketplace-git-channel`）、不做 Buddy 应用
  （需审核，属对接而非开放能力）、不改网关 MCP 契约与注册处行为。

## Capabilities

### New Capabilities

（无新增 capability：本单是既有安装面与既有连接能力的扩面，行为新增落在既有 requirement 的目标集合上。）

### Modified Capabilities

- `facet-editor-cli`: 「Skills install into editor targets」的目标集合由五个扩到六个并新增 workbuddy
  的技能落盘约定；「MCP references are honest about credentials」的目标表新增 workbuddy 的用户级/项目级
  配置文件与条目形状。

## Impact

- 代码：`facet/cli/facet.js`（`SKILLS_SUBDIR`、`MCP_TARGETS`、`writeMcpConfig`、帮助文本）。
- 测试：`scripts/test-facet-docs-facts.mjs`、`scripts/smoke-facet-clients.mjs`、CLI 单测。
- 文档：`docs/ecosystem/workbuddy.md`（新）、`docs/ecosystem/client-matrix.md`。
- 依赖：无新增依赖；不涉及镜像层变化（纯 CLI + 文档 + 测试）。
- 风险面：WorkBuddy 的技能目录约定在文档中未完全统一（MCP 走 `~/.workbuddy/`，项目级技能文档写作
  `.codebuddy/skills/`），落盘路径必须由真机走查定案，不得照抄猜测。
