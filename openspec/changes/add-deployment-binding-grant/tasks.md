# Tasks — add-deployment-binding-grant

## 1. 提案（本次已做）

- [x] 1.1 查实铸造链只认用户账号（`connector-grants.js` 的 `liveToken(email)` + 连接器侧 403）
- [x] 1.2 查实可复用的地基：`deployment_secrets`（值留平台侧、只下发引用、带 `deployer` 列）
      ／ `descriptor.mcpServers = roleMcp(manifest, agent)`／ runner 只接收 `secret_refs`
- [x] 1.3 立项本 change，写 proposal + spec delta，`openspec validate --strict`

## 2. 实施（待批）

- [x] 2.1 新模块 `deployment-bindings.js`：`mintableBindings`（只取 satisfied 且非 optional）、
      `deploymentBindingSecretName`（折成 `[a-z0-9_]{1,32}`，前缀 `connector_binding_`）、
      `mintDeploymentBinding` / `mintDeploymentBindings`（用**部署者**账号调 `mintBindingToken`；失败只登记不上抛）
- [x] 2.2 部署路径接线 `gateway/packs.js` 的 deployHandler：部署成功后对每个已部署 agent 铸绑定，
      经 `registry.recordDeploymentSecret` 落库（`name = connector_binding_<key>`，`deployer = 部署者`）；
      响应只回 `deploymentBindings.{granted,failed}` 的**名字与键**，令牌值永不进响应
- [ ] 2.3 撤销/卸载：删除对应部署密钥，并吊销连接器侧令牌（`revokeOnConnector`）——**未做**
- [x] 2.4 单测 `scripts/test-deployment-bindings.mjs` 5/5：四态判定表（satisfied+非optional 唯一可铸）、
      密钥名合法性（含冒号/超长/空键）、一次铸一枚并存值/记部署者、铸造失败只登记不上抛且不落库、
      无父凭证时**连连接器都不调用**（`no_account` 反证）
- [ ] 2.5 全量 `npm run test:unit`，增量不新增红——**未跑**

## 3. runner 侧接线（待批，单独验收）

- [x] 3.1 served agent 的 profile 写出 `connector:<packId>:<bindingKey>` 行：descriptor 增 `connector_bindings`
      （`serverName`/`url`/`secretName`），runner 的 `connectorBindingEntries()` 用它 + 已取到的密钥值组装 mcp 行；
      密钥名同时并入 `descriptor.secret_refs`（runner 只按那张表取值，否则永远取不到）
- [x] 3.2 值只经既有内部路由取用：runner 先按 `secret_refs` 取全部值（提前到 mcp 组装之前），
      再 pin 进 `.credentials.yaml`；注册表只承载 `secretName`，令牌不落注册表。
      **注**：mcp 行的 Authorization 仍是组装期写入（与既有 `config.mcpToken` 同一姿态）
- [ ] 3.3 端到端：真机部署一个声明绑定的包为常驻岗位，工具调用打通；撤销后下一轮失败
      ——**未做**：需要重建 agent-runner 镜像（现存 runner pod 跑 `yizuo/platform:sha-1c17030`，
      未含本改动），且本机无 runner 端到端环境（session-resume 用例因 dsh bundle 解析失败全红）。
      **注意滚 agent-runner 会重启所有岗位、掐断在飞回合**，属停机窗，须单独安排
- [x] 3.4 边界记录：ACP harness 路径（`#spawnAcpChild` → `acpMcpServers`）只认 `descriptor.mcpServers`
      且统一用平台 token，**吃不到部署绑定**；本改动只覆盖 dsh 路径（`materializeAgentHome`）。
      ACP 若要支持，需把 `connector_bindings` 按同样规则映射成 ACP 的 http 行（另一个改动）

## 4. 明确不做

- [ ] 4.1 不放宽 `service_pat` 铸 PAT（须连接器侧共同评审“服务身份代表谁”）
- [ ] 4.2 不做运行期自动续铸（令牌寿命与续期属 ③）
