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
   （权限 npm publish + stage publish），tag 实测通过。**注意**：早期登记指向 `platform` 仓是错的（该仓没有这个工作流）——
   正确连接已建成；那条错配是**无害死配置**（该仓无此工作流，无法通过认证），因删除需额外密钥触控暂未清，可随手在包设置页 Delete。
4. **tag 实测（两个坑，均已修）**：
   - runner 自带 npm 10 无法完成 OIDC 交换 → 工作流加 `npm install -g npm@^11`；
   - registry 拒收**私有源仓**的 provenance 包（E422）→ 工作流去掉 `--provenance`（TP 认证保留）。
   - 修完 `facet-cli-v0.1.1` 发布成功（19s，无 token 无 2FA），registry 实测：`versions [0.0.0-stage, 0.1.0, 0.1.1]`，`latest=0.1.1`，
     `npx @finddatatechnology/facet@0.1.1` 全新缓存可用。
5. **引用清扫（全部切新 scope）**：`facet/cli/package.json`（含 0.1.1）、`facet/cli/README.md`、`facet/cli/facet.js` 注释、
   `facet/web/src/cliFacts.ts`（网页命令的唯一来源）、`docs/pack-marketplace.md`、工作流注释与步骤名；
   临时 bootstrap token 已删，本机 `~/.npmrc` 已清理。

## 遗留（各一行）

1. **老包 deprecate**：`npm deprecate @finddatatechonology/facet "..."` 需要 OTP；账号只有安全密钥（无 TOTP）、npm 也没有
   staged-deprecate（`npm stage` 只有 publish/list/view/approve/reject/download）→ **解法**：给 npm 账号追加一个 TOTP
   认证器（Account → 2FA），即可一条命令完成。老包仍可安装，官方文档已全部指向新包。

## 已结清（同日）

- **provenance ✅**：把 `facet/cli` 增量放入公开仓 `FindDataTechnology/platform`（与快照管线本会产出的内容一致），
  以该仓打 tag 发布——`0.1.2` 起带 **SLSA v1 provenance**（`dist.attestations.provenance`）。工作流已单源化：
  按仓可见性条件签名（公开=签名 / 私有=不签名，规避 E422）。
- **两条 TP 连接都成了正解**：公开仓 `platform` = 主发布路径（带签名）；私有仓 `fd-craw-private` = 无签名回退路径。
  无需删除（此前误判为"错配"）。
- **`--version` 写死 bug**：CLI 三个版本一直输出 `0.1.0`（实测 0.1.2 时发现）→ 改为读 package.json，`0.1.3` 起正确。
- **官网文档**：`/products/facet-market` 中英已切新 scope 并上线（roll `sha-fb19c23`，公网已验）。

## 快照管线发现（交给平台会话）

`node scripts/make-public-snapshot.mjs --init` 当前**被 12 个历史遗留文件挡住**（tailnet IP、内网 CI 词、个人邮箱等
未清洗项，早于本次的漂移）——完整快照重发前需维护 EXCLUDE/SCRUB 表。本次公开仓的 facet/cli 为**增量 API 推送**，
与快照产物一致，不与管线冲突。
