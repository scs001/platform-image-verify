# tasks — add-erp-supply-chain-gateway-proxy

> 承 finddata 根 `serve-erp-vertical-api` §3。上游服务已上产（ClusterIP，无对外端口），本单只做平台侧同源入口与身份收口。

## 1. 实现

- [x] 1.1 新增 `server/routes/erp-proxy.js`：`createErpProxy`（剥离客户端 `X-ERP-*` → 按会话注入 → 无会话 401 → 原始字节转发 → 统一错误壳）＋ `loadIdentityBindings`（缺失/损坏 → 空表）＋ `resolveIdentityHeaders`（租户常量 / staff=会话账号 / 客户·供应商·承运商只认绑定表）＋ `registerErpProxyRoutes`（`ERP_API_PROXY_ENABLED=0` 可关）
- [x] 1.2 `server.js` 两处接线：①body parser 跳过 `/erp/supply-chain/v1` 前缀（否则代理只能拿到重新序列化的对象，丢字节）；②`registerErpProxyRoutes(ctx)` 挂在 `registerMiscRoutes`（静态 + SPA 深链兜底）**之前**（否则 `GET /erp/...` 被 fallback 抢走返回 index.html）
- [x] 1.3 单测 `scripts/test-erp-proxy.mjs` 九例：无会话 401 / 伪造 `X-ERP-Supplier|Carrier|Customer` 被剥离 / 改名租户头被覆盖 / staff 取会话账号 / 绑定表注入（邮箱大小写不敏感）/ 绑定表缺失与损坏 fail-closed / 未绑定角色不注入 / POST 原始字节 + 全前缀路径不重写 / 鉴权关闭不拦 / 上游不可达 502 / 开关可关 —— `node --test` **9 passed**
- [x] 1.4 `node --check server.js`、`biome check`（三文件）干净

## 2. 部署与上产

- [ ] 2.1 平台镜像出片（新 tag）并换片：`fd-infra-deploy/all-services/prod/platform.yaml`（image tag + 带外 env）
- [ ] 2.2 带外 env：`ERP_API_UPSTREAM`（缺省集群内 Service）、`ERP_TENANT_ID=acme`、（可选）`ERP_IDENTITY_BINDINGS_FILE` / `ERP_DEFAULT_CUSTOMER`；键值不进 git
- [ ] 2.3 上产验收（对应 finddata `serve-erp-vertical-api` 3.2，负向用例是硬门）：①带会话 `GET /erp/supply-chain/v1/pagesets` → 200 且四 key；②伪造 `X-ERP-Supplier` → 上游收到值来自绑定表或不存在；③无 cookie → 401 `AUTH_REQUIRED`；④未授权 grant → 403 `GRANT_REQUIRED`；⑤开票/售后 → 501 `NOT_IMPLEMENTED`

## 3. 归档前门

- [ ] 3.1 `openspec validate add-erp-supply-chain-gateway-proxy --strict` 绿
- [ ] 3.2 归档时把 `erp-gateway-proxy` 能力合入 `openspec/specs/`
