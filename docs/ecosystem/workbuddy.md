# 在 WorkBuddy 中使用谦面功能集

从发现到可用三步：连接 → 安装 → 验证。全程不需要壹座账号。

WorkBuddy 是腾讯的 AI 办公工作台（CodeBuddy Agent CLI 之上的桌面 Product）。它对谦面的意义有两层：
一是**技能与 MCP 可以直接装进去**（本文），二是**它自己带插件市场，可以按地址添加外部市场**
（见 `docs/ecosystem/workbuddy-marketplace.md`）。

## 0. 前置

- Node 18+（`npx` 可用）。
- 一次性的注册处身份：Logto 注册（免费）。

## 1. 连接

**只有一条路现在能用：贴调用键（1b）。** OAuth 免键那条（1a）我们这边还差一环，见下。

### 1a. OAuth 授权（不贴键）—— 当前不可用，原因已定位

这条路的链路我们查到底了，**不是客户端不支持，是我们的授权服务器缺一个端点**。

客户端做 MCP OAuth 用的是官方 SDK 的 `registerClient`，它要求授权服务器元数据里有
`registration_endpoint`（动态客户端注册，RFC 7591）；缺了就直接抛错：

```
Incompatible auth server: does not support dynamic client registration
```

实测我们的链路逐环：

| 环 | 状态 |
|---|---|
| `POST /<pack>/mcp` 未授权 → `WWW-Authenticate: Bearer … resource_metadata="…"` | ✅ 正确 |
| `GET /.well-known/oauth-protected-resource` | ✅ 200，指向 `https://auth.finddatatech.cloud/oidc` |
| `GET <auth>/.well-known/openid-configuration` | ✅ 200 |
| 该元数据里的 `registration_endpoint` | ❌ **缺失**（Logto 不提供 DCR） |
| 该元数据里的 `client_id_metadata_document_supported`（SEP-991 免注册替代） | ❌ **缺失** |

两条替代路都不通：客户端只有在拿到 `clientMetadataUrl` 时才走 SEP-991 的 URL 型 client_id，
而它这个值没有被赋值（不是内置常量）。所以**当前 OAuth 只能在客户端抛错**。

要打通需要动授权侧（Logto 开 DCR 或前置一个注册代理，或让网关在授权服务器元数据里补上
`client_id_metadata_document_supported` 并支持 URL 型 client_id）——这是**网关/身份侧的活**，
不在本次 CLI 改动范围内。在那之前，**用 1b**。

### 1b. 贴调用键（现在唯一可用的路，与其它编辑器一致）

```bash
npx @finddatatechnology/facet connect
```

浏览器打开注册处 → Logto 登录 → 生成个人 wgk- 键 → 粘贴回 CLI。CLI 验活后存
`~/.facet/credentials.json`（0600）。之后 `install --write-mcp` 会把键写进下面第 2 节的文件。

## 2. 安装

```bash
npx @finddatatechnology/facet install <packRef> --target workbuddy --write-mcp
```

技能与 MCP 都落在 `.workbuddy`：

| 内容 | 用户级 | 项目级 |
|---|---|---|
| 技能 | `~/.workbuddy/skills/<skill>/SKILL.md` | `<dir>/.workbuddy/skills/<skill>/SKILL.md` |
| MCP 配置 | `~/.workbuddy/mcp.json` | `<dir>/.workbuddy/mcp.json` |

> **这里曾经写错，记录在此以免复犯。** 早期版本按该客户端「项目」文档页写 `.codebuddy/skills`，
> 属**文档面误读**：那句话讲的是仓库内的代码开发配置（worktree 里的 `.codebuddy/`），不是客户端的
> 用户级技能列表。2026-10-30 真机探针定案：往 `~/.workbuddy/skills` 放一个 SKILL.md，它进了客户端
> 自己的 `.skill-list-cache.json`（`source: "userSettings"`）；同一份探针放到 `~/.codebuddy/skills`
> **完全没有被识别**。客户端代码同证：`createSkillsService` 用
> `join(resolveWorkbuddyConfigDir(), "skills")`，而 `resolveWorkbuddyConfigDir()` 默认
> `~/.workbuddy`。MCP 侧由 `getMcpConfigPath() = join(<configDir>, "mcp.json")` 决定。

MCP 条目形状（客户端读这个）：

```json
{
  "mcpServers": {
    "<server>": {
      "type": "http",
      "url": "https://mcp.finddatatech.cloud/<server>/mcp",
      "headers": { "Authorization": "Bearer wgk-…" }
    }
  }
}
```

`<packRef>` = 谦面市场（https://facet.finddatatech.cloud）详情页的功能集 id。

## 3. 验证

新开 WorkBuddy 会话：技能出现在「已安装」列表且对话里能被调用；MCP 服务的状态灯为绿、工具可被调用。
让它查一个真实数据点（如最新 CPI），返回真实数据即全链通。

## 故障排查

**装了但客户端不识别技能。** 先看「已安装」列表确认它在不在——该客户端的技能开关是**关闭≠未安装**：
关闭只是暂停模型调用，文件与配置都还在。其次确认技能目录用的是 `.codebuddy`（不是 `.claude` 或
`.cursor`）。仍不识别时，把 `SKILL.md` 内容贴进项目规则文件是可行的降级路径（同 Cursor 的 Rules 做法）。

**MCP 状态灯红。** 检查三件：`type` 是否写成 `http`（漏写时客户端会按有无 `url` 推断，但显式更稳）、
`url` 是否指到 `<registry>/<server>/mcp`、`Authorization` 头是否带 `Bearer` 前缀。

**调用被拒 401/405。** 401 = 键无效或组不可见；405 = 该 server 在你注册处的组里已停用。这属注册处侧
的端到端判定，不是本地配置问题。

## 备注

- 免费月度额度内调用免费；超额 402，次月重置。law-bench 属付费档。
- 键随时可在注册处吊销；本地清除 `facet connect --clear`。

## 实证记录（2026-10-30，macOS 真机）

WorkBuddy 5.9.3 桌面版（`/Applications/WorkBuddy.app`），配置根 `~/.workbuddy`。

1. **技能目录 ✅ 真机往返**：`facet install 50Tp176hW0HYTTWXZbarKA --target workbuddy` 把 8 个技能写进
   `~/.workbuddy/skills/`，稍后客户端 `.skill-list-cache.json` **8/8 全部出现**，`source` 均为
   `userSettings`。对照组：同一份探针放到 `~/.codebuddy/skills/` **零识别**（该项由文档推断而来，
   已被推翻）。
2. **目录监听面 ✅**：客户端缓存里的 `watch.dirs` 首项即 `~/.workbuddy/skills`，
   第二项 `~/.workbuddy/connectors/skills` —— 即它主动监听的用户级技能根。
3. **MCP 文件路径 ✅ 代码级确认**：`getMcpConfigPath()` = `join(resolveWorkbuddyConfigDir(), "mcp.json")`；
   `--write-mcp` 写入 `~/.workbuddy/mcp.json`，条目为 `type:"http"` + `url` + `headers.Authorization`。
   **未做**：真实连通（探针键非真键，工具列表未刷新，属预期）。
4. **市场仓结构 ✅ 与客户端自带市场同形**：本机已装市场
   `wecom-unified` / `codebuddy-plugins-official`（206 条）均为
   `<root>/.codebuddy-plugin/marketplace.json` + `plugins/<name>/.codebuddy-plugin/plugin.json`，
   与 `facet/marketplace-repo.js` 的产物逐字段一致（`name`/`owner`/`plugins[].{name,source,version,description}`；
   plugin.json 的 name+version 必须与条目一致——客户端加载器直接 reject 不一致者）。
   **未做**：真机「添加地址」走查（需要一个可访问的远端仓）。
5. **OAuth 连接 ❌ 查到底：被授权服务器阻塞（非客户端能力问题）**。客户端确有能力——它内嵌官方
   MCP SDK 的标准 OAuth 流程（`registerClient` + PKCE-S256 + 授权码），但**要求授权服务器元数据里有
   `registration_endpoint`**，缺了就抛 `Incompatible auth server: does not support dynamic client
   registration`。实测我们的链路：资源侧挑战头正确（`resource_metadata` 指到位）、
   `/.well-known/oauth-protected-resource` 200、Logto 的 `openid-configuration` 200，
   但**没有 `registration_endpoint`，也没有 SEP-991 的 `client_id_metadata_document_supported`**；
   客户端侧 `clientMetadataUrl` 未被赋值，所以 SEP-991 兜底也走不了。**结论：键路径是当前唯一可用的连接方式**，
   打通 OAuth 属网关/身份侧改动。

CLI 侧写入形状由 `scripts/smoke-facet-clients.mjs` 与 `scripts/test-facet-cli-mcp.mjs` 持续咬合。
