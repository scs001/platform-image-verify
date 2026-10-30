## Context

见 `proposal.md`「Why」。设计相关的现状：

- 谦面 CLI 的目标面由**两张常量表**单一驱动：`SKILLS_SUBDIR`（技能落盘目录后缀）与 `MCP_TARGETS`
  （各客户端原生 MCP 配置位置与条目形状），`facet/cli/facet.js`。两张表同时被
  `scripts/test-facet-docs-facts.mjs` 读取，断言「文档矩阵 == 出厂 CLI」——文档无法与实现漂移。
- WorkBuddy 的客户端事实（初版取自其官方文档，2026-10-30 **已用真机逐项复核**）：MCP 用户级
  `~/.workbuddy/mcp.json`、项目级 `<项目>/.workbuddy/mcp.json`；`type: "http"` + `url` + `headers`。
  文档的「项目级技能写 `.codebuddy/skills/`」指的是**仓库内代码开发配置**，不是用户级技能列表——
  真机探针定案用户级技能根为 `~/.workbuddy/skills`（详见 D2）。
- 我们已有的 OAuth 连接能力在 `ecosystem-access`（RFC 9728 保护资源文档 + 授权服务器元数据），
  今天没有被任何真实桌面工作台客户端验收过——本单查明了原因：**授权服务器缺动态客户端注册端点**，
  而 WorkBuddy 内嵌的官方 MCP SDK 硬要它（详见 D4）。

## Goals / Non-Goals

**Goals**

- 新增 target 之后，`facet install <pack> --target workbuddy --write-mcp` 一条命令完成技能落盘 +
  MCP 配置写入，用户不手抄 JSON。
- 文档矩阵、CLI 事实、冒烟脚本三者继续单源咬合，新 target 不能靠手工同步。
- 把「OAuth 在真实客户端上是否可用」从推论变成一次逐环实测记录（结论：**当前不可用，卡在
  授权服务器缺 `registration_endpoint`**，见 D4）。

**Non-Goals**

- 不做插件市场分发（兄弟单）。
- 不新增网关/MCP 契约，不改注册处行为。
- 不实现 WorkBuddy 的快捷指令 / Hooks / 智能体组件的打包（那是插件形态，属兄弟单）。

## Decisions

### D1：扩两张表，不引入 target 适配层

现有实现已经把「目标差异」压缩成数据（目录后缀 + 配置文件位置 + 条目形状），加一个目标的
机械成本是两行常量加一个 `entry()`。引入第三层抽象（target interface）会让单源测试失去意义
（它读的正是这两张表）。

**Alternatives**：为每个 target 建模块目录——被否，五个目标都不需要行为注入，只有数据。

### D2：技能落盘路径先证后落，不照抄

文档只明确了项目级技能目录（`.codebuddy/skills/`）与 MCP 文件（`~/.workbuddy/`），用户级技能
目录未在同页给出。实现顺序定为：**先在真机装一个技能、观察客户端是否识别，再定表值**；
在定案前 `SKILLS_SUBDIR.workbuddy` 不写入代码（宁可先只做 MCP 写入，也不写一个错的目录）。

**Alternatives**：照抄 `.codebuddy`（WorkBuddy 与 CodeBuddy 同族，可能直接读它）——作为候选，
但必须有真机证据才采纳。

### D3：MCP 条目形状按客户端文档逐键落

`{ type: "http", url, headers: { Authorization } }`，写进 `MCP_TARGETS.workbuddy.entry()`。
不写 `command`（这是远程 MCP，不是 stdio），也不复用 `zcode` 的嵌套结构（那是另一个客户端的形状）。

### D4：当前只能贴键；OAuth 免键被授权服务器阻塞（原「OAuth 优先」已被实测推翻）

本单原把「客户端自己走 OAuth 发现」作为优先连接方式（贴键对非技术用户是漏斗杀手，
且我们的发现文档已在产）。**2026-10-30 对生产端点逐环实测推翻了这个判断**：

- 客户端确实内嵌了官方 MCP SDK 的标准 OAuth 流程（授权码 + PKCE-S256 + `registerClient`），
  它的资源侧也正确消费了我们的挑战头（`WWW-Authenticate: Bearer realm="mcp", resource_metadata="…"`）。
- 但 `registerClient` 硬要求授权服务器元数据带 `registration_endpoint`（RFC 7591 动态客户端注册），
  缺则直接抛 `Incompatible auth server: does not support dynamic client registration`。
- 我们的 Logto 元数据**没有** `registration_endpoint`，也**没有**免注册的兜底开关
  `client_id_metadata_document_supported`（SEP-991 URL 型 client_id；且该兜底在客户端需要
  `clientMetadataUrl` 被赋值，它未赋值）。两条兜底全数不通。

所以指南与 CLI 提示的**主路径改为贴键**，OAuth 作为「当前不可用、原因定位清楚」写明。
打通它需要动身份/网关侧（Logto 开 DCR，或网关前置注册代理，或元数据补 SEP-991 开关），
不在本单范围内——本单技术上只涉及 CLI 两张表 + 文档。

### D5：文档事实表只扩不复制

`docs/ecosystem/client-matrix.md` 加一列即可，`test-facet-docs-facts.mjs` 不用改断言逻辑——
它按 `Object.keys(SKILLS_SUBDIR)` 自动覆盖新目标。若需要新断言（如"每个 target 的 MCP 条目必须
带 Authorization"），加在同一个测试里而不是新开一份。

## Risks / Trade-offs

- **技能目录猜错 → 装了但客户端不读**（静默失败）→ D2 的真机定案 + 冒烟脚本锁路径 + 指南写明
  "若客户端未识别，见 X 节"。这是本单最大的真风险，因为失败是静默的。
- **WorkBuddy 对远端 MCP 的鉴权行为与我们假设不同**（例如要求 SSE、或 OAuth 与 header 二选一）
  → 走查先做 MCP 连通（`type: http` + header），再做 OAuth 走查；两者独立记结果。
- **同族客户端路径漂移**：WorkBuddy 与 CodeBuddy 共享约定但可能不同步 → 表里只写已证实的一项，
  未证实的留空并让 CLI 在缺表项时报"该目标暂不支持 X"，不猜。
- **文档矩阵改动触发 docs-facts 测试红**（并行会话在改同一份文档）→ 提交只 add 本变更文件
  （工作区常有其他车道在途）。

## Migration Plan

1. 无数据迁移：纯 CLI 常量 + 文档 + 测试；发版即生效。
2. 回滚：目标从两张表移除即可，不留下服务端状态；已写入用户机器的配置文件由用户自行删除
   （指南给出路径），CLI 不做破坏性清理。
3. 发布节奏：与兄弟单 `add-pack-marketplace-git-channel` 可分开发版，无相互依赖。

## Open Questions

原列两问，本单已各自有结论，留此以免复犯：

- ~~WorkBuddy 用户级技能目录的真实路径~~ → **已定案 `~/.workbuddy/skills`**（真机探针 8/8 识别 +
  缓存 `watch.dirs` 首项 + 客户端代码 `createSkillsService` 三证一致；文档推断的 `.codebuddy/skills`
  是仓库内代码开发配置，属不同面）。
- ~~该客户端 OAuth 授权后是否把 token 写回 `mcp.json`~~ → **当前走不到授权那步**，卡在授权服务器缺
  `registration_endpoint`（D4）。若日后打通，这个观察点仍要重做。
