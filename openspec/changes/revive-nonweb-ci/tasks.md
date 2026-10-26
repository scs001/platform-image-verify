# revive-nonweb-ci — 实施任务

> 实施前提：退出 explore 模式后按其 apply。提交纪律：只 add 本 change 文件（树上有并行在途）。台账=docs/registry-maintenance.md。

## 1 · 私仓 workflow 手术（ubuntu 经济门）

- [x] 1.1 `app-e2e.yml` 去定时档：已删 `schedule: cron "0 3 * * *"`；Maestro iOS 档保留 job 定义但仅 `workflow_dispatch` 可触（名改 manual dispatch）；**Maestro android 档维持 ubuntu 私仓 paths 触发**（×1 计费且限 `app/**|packages/core/**`，实测分钟数收口见 2.3 Open Question）。验证：yaml.safe_load 过、schedule 段已从文件消失（推送后 gh api 眼见归档）
- [x] 1.2 app 门禁三棒齐备：原 app-e2e `gates` job 有名无实（缺 lint 步）——已补 `npx biome check app/ packages/core/` 步于 typecheck 前；三棒本机全绿（biome 41 件净 / typecheck 绿 / unit 14/14）。路径过滤 `app/**|packages/core/**` 原有。验证：本机命令全绿 + yaml 合法
- [x] 1.3 miniapp 门禁接入：新建 `.github/workflows/miniapp-ci.yml`（ubuntu 小门：biome→typecheck→markdown，paths=`miniapp/**|packages/core/**`；不挂 weapp build，design D6）。本机三棒全绿（biome 71 件净 / typecheck 绿 / markdown 10/10）+ yaml 合法
- [x] 1.4 `release.yml`/`win-install-smoke.yml` 头注运行位置=公开池侧分支通道已写（行为与触发模型不动）。验证：两文件头注含池通道指路 + yaml 合法（台账「非 web 端通道」一节随 2.4 落地后指针即通）

## 2 · 池通道建制化（三件套）

- [ ] 2.1 快照脚本落地：干净树导出 → gitleaks 扫（非零报即中止）→ 修剪 `.github/workflows` 只留当次所需 → 推 `testaction003/build-pool` 侧分支（命名 `desktop-release/<ver>` / `nonweb-e2e/<date>`）。验证：干跑（dry-run，不真推）输出修剪后文件清单人工过目；gitleaks 对本仓现前树零报
- [ ] 2.2 泄漏清单成文：`.env*`、`cell-data/`、`data/`、`uploads/`、`agents.json`、`mcp.json`、`trace.db*`、本地凭据文件列入永不入快照名单（脚本内置 + docs 可查）。验证：dry-run 清单与名单逐条对得上
- [ ] 2.3 池通道实跑一次：用 2.1 快照（留 app-e2e 双腿）推 `nonweb-e2e/` 侧分支，dispatch 起 Maestro iOS + android 双腿；记录实测分钟数。验证：双腿 run 结论进台账 + 实测分钟数写回 design.md Open Questions 收口（APK/android 档留私仓还是迁池的最终裁定）
- [ ] 2.4 台账立「非 web 端通道」一节：分工模型（私仓 ubuntu 经济门 / 池重腿）、快照三件套用法、登记格式（run URL + sha256 + 分钟）。验证：台账该节存在且与 §12.3 recipe 互相指针

## 3 · 护栏与收口

- [ ] 3.1 护栏登记：本 change 全程私仓无非 ubuntu runs-on 新增——自查 workflows diff 一遍，结果记台账。验证：`git diff main -- .github/workflows` 输出附台账条目
- [ ] 3.2 AGENTS.md 补一句非 web 端判路（fd-build-channel 之后：重腿走池侧分支通道）。验证：AGENTS.md 该句存在且与台账 §通道 一节一致
- [ ] 3.3 `openspec validate revive-nonweb-ci --strict` 零 error、零 warning；`openspec validate --specs` 不掉数。验证：两命令输出贴日志
- [ ] 3.4 归档预备确认：spec 三需求在私仓 workflow + 台账中可指认（场景→落点对照一遍）。验证：对照表写入 PR/提交说明或台账，随后走 archive 流程
