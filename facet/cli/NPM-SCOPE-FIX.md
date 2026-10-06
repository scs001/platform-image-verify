# npm scope 修正 — 完成记录与收尾清单

**状态：已完成（2026-10-06）**。CLI 现发布为 **`@finddatatechnology/facet`**（org `finddatatechnology`）。
老包 `@finddatatechonology/facet` 保留可装；唯一遗留见文末。

## 根因（当时核实）

- 个人 scope 继承 npm 账号名，而账号名本身拼错（`finddatatechonology`，少一个 n）。
- npm 官方：**用户名不能改名**，只能新建账号手工迁移；org 名则可以与账号名不同。

## 实际执行（全部完成）

1. **建 org** `finddatatechnology`（owner 账号 `finddatatechonology`）。
2. **bootstrap 发布 `@finddatatechnology/facet@0.1.0`**：
   - npm 直发需要 OTP（账号 2FA 是安全密钥、无 TOTP），bypass-2FA token 的新建已被 npm 收紧（勾选不落库，实证）；
   - 走通的是 npm 官方推荐的 **staged publish**：`npx npm@11 stage publish --access public` → 网页
     Settings → Staged Packages → Approve（一次安全密钥触控）。
3. **OIDC Trusted Publisher**：在包设置页登记 `FindDataTechnology/fd-craw-private` · `facet-cli-publish.yml`
   （权限 npm publish + stage publish）。**注意**：早期登记指向 `platform` 仓是错的（该仓没有这个工作流），已建正确连接并删除错配。
4. **tag 实测（两个坑，均已修）**：
   - runner 自带 npm 10 无法完成 OIDC 交换 → 工作流加 `npm install -g npm@^11`；
   - registry 拒收**私有源仓**的 provenance 包（E422）→ 工作流去掉 `--provenance`（TP 认证保留）。
   - 修完 `facet-cli-v0.1.1` 发布成功（19s，无 token 无 2FA），registry 实测：`versions [0.0.0-stage, 0.1.0, 0.1.1]`，`latest=0.1.1`，
     `npx @finddatatechnology/facet@0.1.1` 全新缓存可用。
5. **引用清扫（全部切新 scope）**：`facet/cli/package.json`（含 0.1.1）、`facet/cli/README.md`、`facet/cli/facet.js` 注释、
   `facet/web/src/cliFacts.ts`（网页命令的唯一来源）、`docs/pack-marketplace.md`、工作流注释与步骤名；
   临时 bootstrap token 已删，本机 `~/.npmrc` 已清理。

## 遗留（各一行）

1. **老包 deprecate**：`npm deprecate @finddatatechonology/facet "..."` 需要 OTP；账号只有安全密钥（无 TOTP），
   网页也没有 deprecate 控件 → **解法**：给 npm 账号追加一个 TOTP 认证器（Account → 2FA），即可本地执行一条命令完成；
   在此之前老包仍可安装、不阻塞任何事，官方文档已全部指向新包。
2. **provenance 恢复**：把 `facet/cli` 镜像到公开仓并重指 trusted publisher，当前发布无签名（认证正常）。
3. **facet 网页生效**：`cliFacts.ts` 已改，随下一次平台镜像发布（image.yml → 滚 `all-services/prod/facet.yaml`）显示新命令。
4. `openspec/specs/{facet-editor-cli,facet-platform}` 内的旧 scope 字面量待随规格更新（走 OpenSpec change）。