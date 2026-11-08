# Tasks — add-deployment-binding-grant

## 1. 提案（本次已做）

- [x] 1.1 查实铸造链只认用户账号（`connector-grants.js` 的 `liveToken(email)` + 连接器侧 403）
- [x] 1.2 查实可复用的地基：`deployment_secrets`（值留平台侧、只下发引用、带 `deployer` 列）
      ／ `descriptor.mcpServers = roleMcp(manifest, agent)`／ runner 只接收 `secret_refs`
- [x] 1.3 立项本 change，写 proposal + spec delta，`openspec validate --strict`

## 2. 实施（待批）

- [ ] 2.1 部署路径：若角色声明缺省开启绑定需求（`connectorBindings.roles` 或等价声明），部署时
      按 §判定口径挑键，用**部署者**账号调 `mintBindingToken`
- [ ] 2.2 落库：写入 `deployment_secrets`（`name = connector_binding:<bindingKey>`，`deployer = 部署者`），
      同一次部署内重复键幂等
- [ ] 2.3 撤销/卸载：删除对应部署密钥，并吊销连接器侧令牌（`revokeOnConnector`）
- [ ] 2.4 单测：可铸/不可铸四态矩阵、重复部署幂等、部署者撤销后失效、旧新密钥不并存
- [ ] 2.5 全量 `npm run test:unit`，增量不新增红

## 3. runner 侧接线（待批，单独验收）

- [ ] 3.1 served agent 的 profile 写出 `connector:<packId>:<bindingKey>` 行，`credentialRef` 指向部署密钥
- [ ] 3.2 值只经既有内部路由取用，不落 profile、不进注册表
- [ ] 3.3 端到端：真机部署一个声明绑定的包为常驻岗位，工具调用打通；撤销后下一轮失败

## 4. 明确不做

- [ ] 4.1 不放宽 `service_pat` 铸 PAT（须连接器侧共同评审“服务身份代表谁”）
- [ ] 4.2 不做运行期自动续铸（令牌寿命与续期属 ③）
