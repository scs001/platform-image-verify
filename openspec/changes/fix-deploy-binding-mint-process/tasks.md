# Tasks — fix-deploy-binding-mint-process

## 1. 实证（已完成）

- [x] 1.1 证实 `/api/packs` 前缀在 `FACET_BASE_URL` 下被代理到 facet，deploy 路由在 facet 进程执行
- [x] 1.2 证实 facet 无 `mcp.json`（`connector_not_configured`），挂 `platform-mcp-config` 后转为 `no_account`
- [x] 1.3 证实 facet 无 `/data/data`（数据根 `/data/facet`），即无 cell 库、无用户连接器账号
- [x] 1.4 真机演练产物已清理（注册处 DELETE 204 → 404、卸包、台账 deprecated、部署/密钥/包行归零）

## 2. 实施（待批）

- [ ] 2.1 platform 增内部代铸路由：`POST /api/packs/internal/binding-mint`（`x-facet-user` + 内部令牌），
      按 (pack, agent, bindingKey) 幂等，只回 `{name, secretRef, secretValue}`，不落 facet 之外的日志
- [ ] 2.2 platform 增内部撤销路由：按 `deploy:<pack>:` 命名空间吊销（复用 `revokeBindingTokenById`）
- [ ] 2.3 facet 侧：本地无凭据且 `mintableBindings` 非空时走内部通道；失败仍不阻断部署
- [ ] 2.4 `no_account` 分档：进程无凭据 vs 用户未连接，文案分开
- [ ] 2.5 单测：跨进程代铸路径、幂等、失败降级、撤销越界保护

## 3. 明确不做

- [ ] 3.1 不放宽父凭证（不接受服务身份代铸）
- [ ] 3.2 不把 cell 数据目录暴露给 facet
