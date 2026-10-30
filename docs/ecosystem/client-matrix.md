# 客户端支持矩阵

六家编辑器/CLI 客户端在谦面（facet）上的能力一览。**每一格都有出处**：要么是 CLI 的
代码事实（`facet/cli/facet.js` 的 `SKILLS_SUBDIR`/`MCP_TARGETS`——CLI 写什么），要么是
真环境 walkthrough 的实证（客户端认什么，见各客户端指南的「实证记录」节）——没有
想象格。定期冒烟（`scripts/smoke-facet-clients.mjs`）持续验证 CLI 侧写入形状。

| 能力 | claude-code | cursor | zcode | codex | gemini-cli | workbuddy |
|---|---|---|---|---|---|---|
| 技能安装 · 用户级 | ✅ `~/.claude/skills/` | ✅ `~/.cursor/skills/` | ✅ `~/.zcode/skills/` | ✅ `~/.codex/skills/` | ✅ `~/.gemini/skills/` | ✅ `~/.workbuddy/skills/` |
| 技能安装 · 项目级 | ✅ `<dir>/.claude/skills/` | ✅ `<dir>/.cursor/skills/` | ✅ `<dir>/.zcode/skills/` | ✅ `<dir>/.codex/skills/` | ✅ `<dir>/.gemini/skills/` | ✅ `<dir>/.workbuddy/skills/` |
| MCP 配置写 · 用户级 | ✅ `~/.claude.json`（`type:"http"`） | ✅ `~/.cursor/mcp.json` | ✅ `~/.zcode/cli/config.json`（`mcp.servers`） | ✅ `~/.codex/config.toml`（`[mcp_servers.*]`） | ✅ `~/.gemini/settings.json`（`httpUrl`） | ✅ `~/.workbuddy/mcp.json`（`type:"http"`） |
| MCP 配置写 · 项目级 | ✅ `<dir>/.mcp.json` | ✅ `<dir>/.cursor/mcp.json` | —（无项目级 MCP 约定） | —（同左） | —（同左） | ✅ `<dir>/.workbuddy/mcp.json` |
| 插件市场形态 | ✅ `/plugin marketplace add` | — | — | — | — | ✅ 「插件 → + → 输入市场地址」（可为外部 Git 市场） |
| **MCP 连接道（当前实测）** | **L2** 代持令牌 | **L2** | **L2** | **L2** | **L2** | **L2**（用户文件不消费 `oauth` 块） |
| 更新路径 | `facet update`（快照重取，报 v旧→v新） | 同左 | 同左 | 同左 | 同左 | 同左 |
| 真环境实证（2026-10-12） | ✅ 全链（技能+配置+wire initialize 200） | ◐ 配置面（目标机无 Cursor 二进制） | ✅ 全链 | ✅ 配置面+wire 探针 | ✅ 配置面+wire 探针 | ◐ 目标机有客户端：技能目录真机实证（探针进缓存）；MCP/市场仓待验 |

**连接道这一行不是散文，是能力表的读数。** 唯一权威是
`facet/cli/mcp-auth-capability.js`（`selectLane` 的返回值才是结论）；本行只是 2026-10-31 的一次快照。
矩阵给"当前走哪条"，能力表给"凭什么这么走"——两者不一致时以能力表为准，并修这一行。

三道含义：**L1** 客户端自己消费静态 `clientId` 跑授权（零凭据落盘）；**L2** CLI 跑授权，
把短命 access token 写进客户端静态 `Authorization` 头（今天覆盖全部六家）；
**L3** `wgk-` 调用键（headless/CI）。之所以六家当前全落 L2：各家 `headerStatic` 都已实证为真，
而 L1 除了 WorkBuddy 已知为 `false`（asar 里 `toAuth$2` 只传 `provider:{name}`），其余五家是
`oauthClientId: null`（**未验**）——未验不选 L1，这是纪律不是保守。

## 口径说明

- **「技能安装」**=facet CLI 把 `SKILL.md` 写进该客户端的技能目录；**项目级**用
  `--project <dir>`。客户端是否主动读取该目录随其版本而异（Cursor 的技能目录支持
  已知随版本变化，可将内容接入 `.cursor/rules/`）——CLI 写入形状是稳定承诺，客户端
  读取面见各指南实证节。
- **「MCP 配置写」**=持 wgk- 键后 `install --write-mcp` 代写该客户端的原生连接配置；
  条目形状逐字节见矩阵单元格。连通性另需该 server 在注册处健康/启用且键所属组可见
  （停用=405、组不可见=401，诚实边界详见各指南）。
- **「更新路径」**=`facet update`（v0.2.2+）：按本地安装记录重取最新版快照，无订阅
  副作用。
- **「MCP 连接道」**取自能力表 `selectLane`：L1 需要实证该客户端消费静态 `clientId`；
  L2 只需实证它认静态 `Authorization` 头；L3 为无浏览器/headless 兜底。换客户端版本时
  `probe-mcp-auth-lanes.mjs static --app <产物目录>` 重跑，版本不符即 `stale`，自动降 L2。
- **真环境实证**三档：✅ 全链（含 wire initialize）/ ◐ 配置面 / —（未实证）。

出处：[claude-code](claude-code.md) · [cursor](cursor.md) · [zcode](zcode.md) ·
[codex](codex.md) · [gemini-cli](gemini-cli.md) · [workbuddy](workbuddy.md) 各指南的「实证记录」节；
CLI 代码事实由冒烟脚本持续咬合。
