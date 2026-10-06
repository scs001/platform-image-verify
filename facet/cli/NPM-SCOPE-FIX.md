# npm scope 修正 runbook（finddatatechonology → finddatatechnology）

## 现状与根因（2026-10-06 核实）

- 已发布：`@finddatatechonology/facet@0.1.0`（个人 scope），装机实测可用，repository 指向本仓
  `platform/facet/cli`——**包是我们自己的，错的是 scope 拼写**。
- 根因：个人 scope 继承自 npm 账号名，而该账号名本身少了一个 n。
- npm 官方立场：**用户名不能改名**，只能「新建账号并手工迁移数据」
  （docs.npmjs.com/changing-your-npm-username）。org 名则可以与账号名不同。

## 结论路径

**不动账号名，建一个名为 `finddatatechnology` 的 org，以 org scope 重新发布。**
个人 scope 的包不能随账号迁移（等于重新发布），所以新账号路径步骤更多、收益相同，见文末备选。

## 执行步骤（需维护者 npm 登录 + 2FA）

1. **建 org**：以 `finddatatechonology` 登录 npmjs.com → Add Organization → 名称 `finddatatechnology`
   （免费计划支持无限公开包；若名称被占，备选 `finddata`，并在本文件记录实际取值）。
2. **bootstrap 首发布**（新 scope 下包尚不存在，Trusted Publisher 只能配在已存在的包页面上）：
   ```bash
   cd facet/cli
   # 把 package.json 的 name 改为 @finddatatechnology/facet
   npm login          # 维护者账号 + 2FA
   npm publish --access public
   ```
   验证：`npx @finddatatechnology/facet help` 在全新缓存下可用。
3. **挂 OIDC**：新包页面 → Settings → Trusted Publisher 登记
   GitHub org `FindDataTechnology` / repo `platform` / workflow `facet-cli-publish.yml`；
   此后打 `facet-cli-v<version>` 标签即走 Actions 发布，无需本地 token。
4. **退役老包**（保留可装、显式引导迁移；不 unpublish——会破坏已装用户的 npx 复现）：
   ```bash
   npm deprecate @finddatatechonology/facet "Renamed to @finddatatechnology/facet — switch with: npx @finddatatechnology/facet install"
   ```

## 修正后需同步的引用（2026-10-06 grep 全集）

| 位置 | 动作 |
|---|---|
| `facet/cli/package.json` | name → `@finddatatechnology/facet`（第 2 步随发布改） |
| `.github/workflows/facet-cli-publish.yml` | 名称与头部注释 |
| `docs/pack-marketplace.md:62` | npx 命令 |
| `openspec/specs/facet-editor-cli/spec.md`、`openspec/specs/facet-platform/spec.md` | 内含 npx 字面量的规格文本，需走 OpenSpec change |
| facet 网页（facet.finddatatech.cloud）intro 与页脚 | 随规格文本重发 |
| 官网 `fd-official-web` 的 `/products/facet-market`（`src/content/apps/{en,zh}/facet-market.md`） | **发布成功后**再改；在此之前保持与线上实际可用命令一致 |

## 备选路径（不推荐）

新建账号 `finddatatechnology` 并重做 2FA / Trusted Publisher：npm 用户名不可改，个人 scope 包又不能随
账号迁移，等于重新发布 + 老包废弃，步骤更多、结果相同。