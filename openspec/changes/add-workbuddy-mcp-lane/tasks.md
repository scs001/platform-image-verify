## 1. 真机走查定案（先证后落，D2）

> 结论注记（2026-10-30，真机）：**文档推断被真机推翻**。按官方「项目」页推断的 `.codebuddy/skills`
> 是仓库内代码开发配置（worktree 里的 `.codebuddy/`），不是客户端用户级技能列表。真机探针定案：
> `~/.workbuddy/skills` 放 SKILL.md → 进客户端 `.skill-list-cache.json`（`source: "userSettings"`）；
> 同探针放 `~/.codebuddy/skills` → **零识别**。客户端代码同证（`createSkillsService` =
> `join(resolveWorkbuddyConfigDir(), "skills")`；`getMcpConfigPath()` = `<configDir>/mcp.json`）。
> 实现已按真机改正（`.workbuddy`），docs / cliFacts / 测试同步。

- [x] 1.1 在真实 WorkBuddy 客户端上装一个技能，记录**实际被识别**的目录；
  验证：`facet install 50Tp176hW0HYTTWXZbarKA --target workbuddy` 写入 8 个技能后，客户端
  `.skill-list-cache.json` **8/8 全部出现**且 `source=userSettings`；对照组 `.codebuddy/skills` 零识别
- [x] 1.2 在 `~/.workbuddy/mcp.json` 配一条远端 MCP（`type: "http"` + `url` + `headers.Authorization`），
  验证：路径经客户端代码 `getMcpConfigPath()` 确认为 `<configDir>/mcp.json`，`--write-mcp` 实际写入该路径
  且条目形状正确。**真连通未验**（用非真键，工具列表未刷新，属预期）
- [ ] 1.3 ~~让该客户端走我们的 OAuth 发现连接同一个网关端点（不贴 key）~~ **本单做不了，阻塞点已定位到身份侧**：
  客户端内嵌官方 MCP SDK 的 `registerClient`，硬要授权服务器元数据带 `registration_endpoint`
  （RFC 7591）；实测我们 Logto 没有它，也没有 SEP-991 的 `client_id_metadata_document_supported`
  兜底（且客户端 `clientMetadataUrl` 未赋值），故必抛 `Incompatible auth server: does not support
  dynamic client registration`。资源侧链路我们是通的（挑战头带 `resource_metadata`、
  `/.well-known/oauth-protected-resource` 200、指向 `auth.finddatatech.cloud/oidc`）。
  **需另开身份/网关侧单子**：Logto 开 DCR，或网关前置注册代理，或元数据补 SEP-991 开关。
  本单已把结论写进 `docs/ecosystem/workbuddy.md` §1a 与 design D4，主路径改为贴键。

## 2. CLI 目标面（两张表，D1/D3）—— 已完成

- [x] 2.1 `facet/cli/facet.js` 的 `SKILLS_SUBDIR` 与 `MCP_TARGETS` 增加 `workbuddy`（路径取真机实证，见 1.1/1.2）；验证：`test-facet-cli-mcp.mjs` 断言 `targetDir({target:"workbuddy"})` 的路径与
  `MCP_TARGETS.workbuddy.entry()` 的键形状（`type: "http"` / `url` / `headers.Authorization`）
- [x] 2.2 `writeMcpConfig` 支持写 `~/.workbuddy/mcp.json` 与 `<project>/.workbuddy/mcp.json`；
  验证：单测在 `FACET_HOME` 沙箱内断言用户级/项目级各写一处、内容为合法 JSON、且 `.claude.json` 与
  `~/.claude.json` 零改动（另一客户端的文件不被波及）
- [x] 2.3 帮助文本（用法行、目标布局块、`--target`/`--project` 说明）与「不支持的目标」错误文案更新；
  验证：`facet help` 输出含 `workbuddy` 与两处 MCP 路径；错误文案列出六个目标
- [x] 2.4 装上后的提示语：告知该目标技能目录是 `.workbuddy/skills`（真机实证）、MCP 在同目录，并指出可走 OAuth 不贴键；
  验证：单测断言 `install --target workbuddy` 输出含该提示
  （注：原任务的「缺表项时拒绝」分支因技能目录已定案而不适用，改为本项提示语）

## 3. 文档与单源门 —— 已完成

- [x] 3.1 新增 `docs/ecosystem/workbuddy.md`：安装、连接（OAuth 与贴键两条）、单一 `.workbuddy` 根及真机证据、
  故障排查（含「装了但客户端不识别」）、实证记录节明确标注「未真机」；验证：`client-matrix.md` 出向链接可点通
- [x] 3.2 `docs/ecosystem/client-matrix.md` 增加 workbuddy 列（六家）；验证：
  `node --test scripts/test-facet-docs-facts.mjs` 7/7 绿（该测试按 `Object.keys(SKILLS_SUBDIR)` 自动覆盖新目标，
  断言文档事实 == CLI 两张表，含项目级 MCP 存在性镜像）
- [x] 3.3 `facet/web/src/cliFacts.ts` 两处真值表同步（`FACET_TARGETS` + `FACET_CAPABILITIES`）；验证：同上 docs-facts 门

## 4. 冒烟

- [x] 4.1 `scripts/smoke-facet-clients.mjs` 覆盖 workbuddy 的写入形状（`.workbuddy` 技能目录 +
  `.workbuddy/mcp.json` 条目键名）；验证：脚本结构就位、语法通过、失败时非零退出
- [x] 4.2 在能连生产的位置跑一次 `node scripts/smoke-facet-clients.mjs`，六个目标全绿；
  验证：输出 `PASS — matrix cells hold`
  （2026-10-30 本机对 `https://facet.finddatatech.cloud` 实跑：六目标 skills=8 全命中；
  MCP 六个落点形状全对——CC `.claude.json` / cursor `mcp.json` / zcode `config.json` /
  codex `config.toml` / gemini-cli `settings.json` / workbuddy `mcp.json`；尾部 PASS）

## 5. 收尾与发版

- [x] 5.1 相关测试全绿：`test-facet-cli-mcp` 7/7、`test-facet-docs-facts` 7/7、`test-facet-marketplace-json` 5/5、
  `test-facet-platform` 9/9、`test-facet-cli` 2/2；`biome check` 零告警
  （`test-pack-install-fetch` 3 项红为 **HEAD 既有**，已在干净 HEAD worktree 复现，非本变更引入）
- [x] 5.2 发布说明写入 changelog（facet CLI 版本号 + 新 target 用法一行）；验证：包内 `README`/help 与发布说明一致
  （本包无独立 CHANGELOG 文件，随包载体就是 `facet/cli/README.md`——`package.json` 的
  `files: [facet.js, README.md]` 决定发布内容。已在 README 增「版本说明 0.3.0」节并更新
  `--target` 行为六家、示例路径补 `~/.workbuddy/skills/…`；`facet help` 与 README 逐项核对一致）
