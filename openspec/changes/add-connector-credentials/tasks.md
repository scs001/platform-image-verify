## 1. 存储与迁移

- [ ] 1.1 在 `db.js` 迁移序列新增 `user_connector_credentials` 表（email/owner key + token + updated_at），跑既有迁移测试确认新版本号与双方言一致（本地 `node --test` 或 e2e 起服即迁移通过）
- [ ] 1.2 新增 `connector-credentials.js`：`status/liveToken/store/disconnect/ownerKey` 与 `registry-credentials.js` 同形（复用 `ownerKey`、写只读投影），写单测覆盖 store→status→disconnect 往返与 auth off 的 machine-owner 退化

## 2. credentialRef 分派

- [ ] 2.1 新增 ref 注册表（`credential-refs.js`）：`isRef(config)`、`liveToken(refName, email)`、`knownRef(name)`；`registry-credentials` 作为第一个注册项转发（导出面不变），写单测断言 registry 解析结果与注册前逐字节一致
- [ ] 2.2 `connector-credentials` 注册为 `"connector"` ref；单测断言两个 ref 互不串扰（只配 registry 时 connector 不解析，反之亦然）
- [ ] 2.3 改写 `dsh-profile.js` 的 `writeMcpPatch` 解析循环为按 `credentialRef` 查表分派，保留"解析失败即省略全部 ref 行 + warning"的兜底；跑既有 e2e（`registry-connect.spec.js`、`resources-binding.spec.js`、`packs.spec.js`）确认 registry 行为零回归

## 3. 服务行与注入验证

- [ ] 3.1 `mcp.json` 新增 connector 服务行（`url: https://connector.finddatatech.cloud/mcp`、`credentialRef: "connector"`、服务名 `connector`），确认与既有服务名无冲突
- [ ] 3.2 端到端：无凭据用户的有效 profile 不含 connector 服务且有 warning；写入凭据后同一用户 profile 含该服务且头为 `Bearer <PAT>`；断开后再次消失（e2e 或探针脚本，记录输出）
- [ ] 3.3 真回合验证：给一个测试用户粘贴真实 PAT，dsh 会话出现 `mcp__connector__*` 工具并能 `list_connections` 返回该用户在 connector 里的连接（记录工具名与返回摘要）

## 4. API 与面板

- [ ] 4.1 新增凭据路由（读状态/写入/清除），hosted 模式拒绝匿名（401）、auth off 落 machine-owner；写 API 测试覆盖三条路径与"响应不含 token"
- [ ] 4.2 新增 `ConnectorConnectPanel` 并挂到 `McpServerForm` / `McpMarketView`（与 `RegistryConnectPanel` 同挂载点）：未连接给粘贴+获取指引，已连接给状态+断开
- [ ] 4.3 六语言 i18n 键补齐（键一致性测试通过），中文文案说明 PAT 从 connector「我的连接」页面获取

## 5. 收尾

- [ ] 5.1 凭据变更后触发 profile 热更新（复用 `reapplyProfile` 形状），e2e 断言粘贴后无需重装即生效
- [ ] 5.2 更新 `openspec/specs/registry-credentials` 的 Purpose 中"单一 ref"表述为分派模型（若其文字与新实现冲突）；`openspec validate --strict` 通过
- [ ] 5.3 全量本地门：lint + format + typecheck + 单测 + 相关 e2e 全绿；记录命令与结果
