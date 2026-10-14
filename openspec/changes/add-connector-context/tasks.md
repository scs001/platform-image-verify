# Tasks

- [x] 1. `ConnectorConnectPanel` 标题下加产品说明（连接器是什么、令牌给谁用）与
  「了解产品」链接（design D1）：链接新标签打开官网产品介绍页，按界面语言选页（i18n 当前语言 zh 前缀 → `/zh/products/wanxing-connector/`，否则 `/products/wanxing-connector/`）；说明与链接常显（卡片在 `connectorConnection` 未知时不渲染的既有规则不变）
  - 实现：`ConnectorConnectPanel.tsx` 标题行后加 `data-testid="connector-context-line"`（`contextLine` + 链接 `connector-learn-more`）；`connectorLearnMoreUrl(lang)` 落 `web/src/lib/connector-mint.ts`（node 测试可 import）
- [x] 2. 五语 locale 键（en / zh-CN / ja / fr / es）全配（design D2：`contextLine` + `learnMore`），`check:locales` 绿
  - 证据：`check:locales` 1292 键 × 5 语全等绿
- [x] 3. `agents.json` 的 `wanxing-connector.description` 纠偏为实际口径（design D3：SaaS 连接网关 / 统一凭据 / 为 agent 铸令牌，与官网页基线一致）
  - 实现：`数据连接器——连接企业数据库与外部数据源，铸造个人访问令牌` → `SaaS 连接网关——统一托管外部服务凭据，为 agent 铸造访问令牌`（url 不变）
- [x] 4. 测试：组件测试断言说明文案与链接（含按语言选页）；既有套件全绿（web 单测 + 相关 e2e 哨兵）
  - 新增 `scripts/test-app-center-connector.mjs` 4 断言全绿（语言选页 zh 家族→中文页 / en/es/fr/ja→英文页；五语键非空且 en≠zh；agents.json 口径与旧文案缺失断言）
  - 全套 `test:unit` 1361/1362：唯一红 `test-worker-pool.mjs` 单独复跑 4/4 绿（并发态存量 flake，非本变更回归）
  - `web typecheck` 绿（tsc 无输出）；`biome check` 本变更 9 文件全绿
  - oxfmt 格式门：本变更 2 个 md 文件格式绿；仓内 10 个存量文件格式债为基线守卫（`git stash` 复证同红，非本变更引入，未动）
- [x] 5. 目检：本地/预览实机看卡片两态（已连接/未连接）与链接可达
  - en 态：`lineText: "Connect your SaaS accounts once and mint access tokens for agent platforms. Learn more"`、`linkHref=https://www.finddatatech.cloud/products/wanxing-connector/`、`target=_blank`
  - zh-CN 态（`localStorage["platform.locale"]="zh-CN"` 后重载）：`连一次 SaaS 账户，为 agent 平台铸造访问令牌。 了解产品`、`linkHref=https://www.finddatatech.cloud/zh/products/wanxing-connector/`、`target=_blank`；截图存证
- [ ] 6. 出片上线：commit → 平台镜像 → GitOps roll → 线上验收（MCP 市场卡片说明与链接在产；应用中心卡片描述纠偏在产；「了解产品」链接可达官网页）
- [ ] 7. 归档
