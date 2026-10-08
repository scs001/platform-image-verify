## Context

See proposal.md - Why. 设计受三件已存在的事实约束：

1. **`credentialRef` 机制已成熟**（`registry-credentials` 能力 + `dsh-profile.js` 的 `writeMcpPatch`）：安装时打标、profile 写入时解析、解析失败省略服务。它当前把 ref 名硬编码为 `"registry"` 单一值，解析循环也只认这一个。
2. **凭据按用户键控**：hosted 模式键=登录邮箱，auth off 键=machine-owner；表在 cell 的 SQLite（`db.js` 迁移序列管理 schema）。
3. **connector 已上线**：`https://connector.finddatatech.cloud/mcp`，认证是 `Authorization: Bearer oct_…`（user_pat），无过期时间（PAT 由用户主动撤销）。

## Goals / Non-Goals

**Goals:**

- connector PAT 复用 `credentialRef` 全链路：存储、注入、解析失败省略、热生效，零新增注入路径。
- ref 解析按名分派，使第三种 ref（未来）只需注册一个解析器。
- 用户能在设置面自助完成粘贴/查看/断开。

**Non-Goals:**

- 不引入 PAT 过期语义（connector PAT 无 exp；staleness 只由 401 驱动，v1 不做自动标记）。
- 不做 OAuth 自动换取 PAT（connector 的登录是浏览器重定向 + 铸造，自动化留待后续 change）。
- 不改 connector 侧任何代码。

## Decisions

### D1: 泛化 `credentialRef` 为注册表分派，而不是并列第二个专用分支

`registry-credentials.js` 现在把 ref 名当常量导出。方案：新增 `credential-refs.js`（或就地扩展）维护 `refName → { isRef(config), liveToken(email), status(email), store/disconnect }` 的注册表，`dsh-profile.js` 的解析循环按 `config.credentialRef` 查表。

**理由**：注入路径只有一条（profile 写入），如果按 ref 名复制分支，第三个 ref 会再复制一次；查表让新增 ref 只注册不改编排。**替代方案**：在 `dsh-profile.js` 里写 `if ref === "connector"` 的并列分支——最小改动，但把 ref 名清单散进编排代码，且"解析失败省略"的逻辑会分叉。

### D2: connector 凭据单独建表，不并入 registry 凭据表

新表 `user_connector_credentials`（email/owner key + token + updated_at），与 `user_registry_credentials` 同形但独立。

**理由**：两凭据生命周期完全独立（一个可同时连接两边，断开一边不影响另一边）；并表会把"两个可选 token"塞进一行，状态投影和断开语义都要加参数。**替代方案**：`user_credentials(email, kind, token, …)` 通用表——更"干净"，但需要迁移现有 registry 行（数据迁移风险）且让 registry 路径的既有测试全部改写，收益不抵风险。

### D3: 服务行进 `mcp.json`（部署基线），不自动播种到 DB

connector MCP 服务行作为 `mcp.json` 的一个条目随镜像走：`{ url: "https://connector.finddatatech.cloud/mcp", credentialRef: "connector" }`。

**理由**：与既有"operator config 基线 + DB 覆盖"分层一致；未连接 PAT 的用户因解析失败而看不到它，无需按用户播种 DB 行。**替代方案**：启动时 seed 进 DB（像 bundled 服务）——会让它出现在扩展管理列表里可被用户误删，且需要处理"已有旧行"的幂等。

### D4: 状态投影只给 connected/updatedAt，无 expiresAt

registry 凭据有 JWT exp 可解析；connector PAT 是 `oct_` 不透明串，无 exp。投影字段因此只有 `connected` / `updatedAt`，UI 不显示过期倒计时。

**理由**：不编造不存在的语义；PAT 失效由 401 自然暴露（v1 只把它呈现为 MCP 工具报错，不做自动标记——Non-Goal）。

### D5: 面板入口放扩展/MCP 市场附近，复用 `RegistryConnectPanel` 的交互形状

新 `ConnectorConnectPanel`：未连接时给粘贴框 + "PAT 从 connector 的「我的连接」页面获取"指引；已连接显示状态与断开按钮。挂载点与 `RegistryConnectPanel` 相同（`McpServerForm` / `McpMarketView`）。

**理由**：用户的同一心智模型（"我要给 MCP 服务配凭据"），放一起最省解释成本。**替代方案**：独立设置页——更"产品化"，但把同一件事拆到两处，且需要新的导航项与 i18n 面。

## Risks / Trade-offs

- **[注册表引入间接层，registry 路径有回归风险]** → registry 的解析结果必须逐字节不变；实现时保留 `registry-credentials.js` 的导出面，注册表只是转发，并用既有 e2e（`registry-connect.spec.js`）作回归门。
- **[PAT 明文入 SQLite]** → 与 registry 凭据同级风险（本机/集群内可信存储），且响应面只写不读；如未来要求加密，两表一起加（`llm-providers` 已有加密先例可循）。
- **[mcp.json 的 connector 行对所有部署可见]** → 自托管用户没有 connector 实例时，该行因无凭据而恒被省略（多一条 warning）；可通过 `credentialRef` 行只在有对应凭据时解析来接受这个噪声。
- **[401 不自动标记 stale]** → 用户断开/撤销 PAT 后，服务在下次 profile 写入前仍连着，工具调用报 401；缓解：UI 文案提示"撤销后请断开并重连"，后续 change 再加自动标记。

## Migration Plan

1. 迁移新增 `user_connector_credentials` 表（纯新增，无既有数据改动；回滚=删表，无数据损失）。
2. `mcp.json` 新增 connector 服务行；若解析器未就绪，该行会被既有逻辑忽略（`credentialRef` 无人认领时服务被省略）——部署顺序安全。
3. 上线后验证：未连接用户 profile 无 connector 服务；粘贴 PAT 后 dsh 会话出现 `mcp__connector__*` 工具并能列出用户在 connector 里的连接。
4. 回滚：撤镜像 tag；表留着无副作用。

## Open Questions

- connector MCP 在 dsh 会话里的服务名（`mcp.json` key）定什么？倾向 `connector`（工具名即 `mcp__connector__list_connections`），实现时确认与既有名字无冲突。
