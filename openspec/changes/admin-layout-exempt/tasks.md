# Tasks — admin-layout-exempt

## 1. 实现

- [ ] 1.1 `server/layout.js resolveForUser`：`facts.isAdmin === true` 时不解析 role 预设、`layers.role` 留空（其余层不动）。验证：`node --test scripts/test-layout-resolution.mjs` 新增用例绿
- [ ] 1.2 单测 `scripts/test-layout-resolution.mjs`：① admin + `stock`（simple）→ 三容器全等于部署默认；② 同输入非 admin → simple 收窄（既有行为）；③ admin + 部署隐藏 `fleet` → 结果缺 `fleet` 其余全集；④ auth off（facts.authOn=false）+ 角色 → 不收窄。验证：四用例绿、既有用例不变
- [ ] 1.3 e2e `e2e/layout.spec.js`：hermetic（auth off=机器所有者）下 PUT 本机身份 `primary:"stock"` 后 `/api/config.resolvedLayout.settings` 仍含 `models`、`roles`、`layout`，nav 含 `apps`、`tasks`；恢复 `standard`。验证：`npx playwright test e2e/layout.spec.js --project=fast` 绿

## 2. 本地门与发布

- [ ] 2.1 `npm run test:unit` / `typecheck` / `lint` 绿；`web:build:e2e` 后 layout.spec 全绿。验证：退出码 0
- [ ] 2.2 提交只 add 本变更文件，双推；公开快照线出片（**快照 `.github` 先手动修剪到只剩 image.yml**）→ relay OK → ccr digest → 双清单 → ArgoCD → 双 rollout 绿 → pod imageID 全等。验证：台账证据链
- [ ] 2.3 生产验收：真 admin 账号临时 `PUT /api/roles/assignments/<admin> {primary:"stock"}` → `/api/config.resolvedLayout` nav 7 项、settings 13 节（含 models/roles/layout/channels/diagnostics/status/branding）→ 侧边栏眼见 → 恢复 `standard`。验证：脚本 ALL PASS 且角色已恢复
- [ ] 2.4 台账 §12.17（含 10-18 管理界面消失事故：根因两层、数据已清、规格变更）；核销；`openspec validate admin-layout-exempt --strict` 绿后归档 + 两份 spec 同步。验证：归档目录存在；主 spec role-system 场景改为「not narrowed」
