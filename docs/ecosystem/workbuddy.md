# 在 WorkBuddy 中使用谦面功能集

从发现到可用三步：连接 → 安装 → 验证。全程不需要壹座账号。

WorkBuddy 是腾讯的 AI 办公工作台（CodeBuddy Agent CLI 之上的桌面 Product）。它对谦面的意义有两层：
一是**技能与 MCP 可以直接装进去**（本文），二是**它自己带插件市场，可以按地址添加外部市场**
（见 `docs/ecosystem/workbuddy-marketplace.md`）。

## 0. 前置

- Node 18+（`npx` 可用）。
- 一次性的注册处身份：Logto 注册（免费）。

## 1. 连接

**两条路都能用：1a OAuth 免键（桌面日常）与 1b 贴调用键（headless/CI、脚本化）。**

### 1a. OAuth 授权（不贴键）—— 已打通（2026-10-30 端到端实证）

一条命令，`mcp.json` 里不落任何秘密：

```bash
npx @finddatatechnology/facet install <packRef> --target workbuddy --oauth --write-mcp
```

写入的条目带的是**静态 OAuth 客户端**（不是凭据）：

```json
{
  "mcpServers": {
    "<server>": {
      "type": "http",
      "url": "https://mcp.finddatatech.cloud/<server>/mcp",
      "oauth": { "name": "facet", "clientId": "tvmzkpz3ld5kqlmse5se9",
                 "scope": "openid gateway:access offline_access" }
    }
  }
}
```

首次调用该服务器时，WorkBuddy 打开浏览器到 Logto 授权页（PKCE），登录同意后 token 存进
客户端自己的加密库——配置文件里没有凭据，吊销走 Logto 侧。`--oauth-client <id>` 可覆盖
client_id（自建应用时用）。组/角色照常生效：授权账号不持某 server 要求的角色时，调用被拒。

> **这条路曾判过死刑，翻案记录。** 客户端内嵌官方 MCP SDK，在没有现成 client_id 时会调
> `registerClient` 要求动态注册（RFC 7591），而 Logto 无 `registration_endpoint`，于是抛
> `Incompatible auth server: does not support dynamic client registration`。但成熟方案本就不依赖
> DCR：MCP 规范把 DCR 定为 MAY（2026-07-28 版起弃用，转向预注册/CIMD），静态 client_id 是优先
> 路径——SDK 的 provider 一旦拿到 `oauth.clientId` 就短路整个注册环节。打通共动三处：
>
> | 处 | 内容 |
> |---|---|
> | Logto 生产配置 | Native 应用 facet-mcp-keyless（id 即上例 clientId），回调 `http://127.0.0.1/oauth/callback`——native 型走 RFC 8252 端口无关回环匹配，客户端随机端口照样命中 |
> | Logto 生产配置 | 把网关 origin `https://mcp.finddatatech.cloud` 注册为 API 资源（scope `gateway:access`）；租户级 custom-JWT 给网关受众的 token 注入 `roles` 与 `username`（计费/组门与 wgk- 车道同口径） |
> | 网关镜像 sha-c216f47 | auth-server 的 Logto provider 接受网关**自广告的 origin** 为 bearer audience（env `LOGTO_ACCEPTED_AUDIENCES`，RFC 8707 资源指示符原样进 `aud`） |
>
> 已知非阻塞项：Logto provider 对 native 应用未回 refresh_token（`offline_access` 被静默丢弃），
> 令牌过期后客户端会自动再弹一次授权（账号已登录时近乎无感）。

### 1b. 贴调用键（headless/脚本化，与其它编辑器一致）

```bash
npx @finddatatechnology/facet connect
```

浏览器打开注册处 → Logto 登录 → 生成个人 wgk- 键 → 粘贴回 CLI。CLI 验活后存
`~/.facet/credentials.json`（0600）。之后 `install --write-mcp` 会把键写进下面第 2 节的文件。

## 2. 安装

```bash
# 贴键车道：先 facet connect 铸 wgk- 键，再
npx @finddatatechnology/facet install <packRef> --target workbuddy --write-mcp
# 免键车道：跳过 connect，直接
npx @finddatatechnology/facet install <packRef> --target workbuddy --oauth --write-mcp
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
`url` 是否指到 `<registry>/<server>/mcp`、`Authorization` 头是否带 `Bearer` 前缀。免键条目
（`oauth.clientId` 形状）首次连接必须完成一次浏览器授权，授权前灯不绿属预期；回调端口被防火墙
拦时改用其它网络环境重试（回调固定在 `127.0.0.1:<随机端口>/oauth/callback`，不出本机）。

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
5. **OAuth 连接 ✅ 打通（同日翻案：原判「被授权服务器阻塞」只对了一半）**。缺 DCR 属实，但成熟
   解法本就不走 DCR——MCP 规范把 DCR 定为 MAY（2026-07-28 版起弃用），静态 client_id 是优先路径，
   SDK 的 provider 拿到 mcp.json `oauth.clientId` 即短路 `registerClient`。配套三处（Logto native
   应用 facet-mcp-keyless + origin `https://mcp.finddatatech.cloud` 注册为 API 资源 + 租户 custom-JWT
   注入 roles/username；网关 accepted_audiences 补丁 sha-c216f47）后，无头复刻客户端全流程
   （PKCE-S256、PRM 裸 origin resource）实测：授权 → token `aud=https://mcp.finddatatech.cloud`
   含 roles/username → initialize 200 → tools/list 160+ 工具；计费与 wgk- 车道同口径（username=邮箱）。
   CLI 侧 `--oauth` 写入车道由 `scripts/test-facet-cli-mcp.mjs` 持续咬合。已知非阻塞项：native 应用
   未回 refresh_token（offline_access 被 provider 丢弃）→ 令牌过期自动再弹一次授权。

CLI 侧写入形状由 `scripts/smoke-facet-clients.mjs` 与 `scripts/test-facet-cli-mcp.mjs` 持续咬合。
