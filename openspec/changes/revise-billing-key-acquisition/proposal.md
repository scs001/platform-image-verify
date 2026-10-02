# Proposal: revise-billing-key-acquisition

## Why

③ 上线后的首次真链路测试（2026-10-02，以真实用户 aloadtree）暴露了计费铸 key 的身份死角：部署者的 sub2api 账户若**早于平台存在**（同邮箱预存账户——网关老用户全都如此），平台不持有其密码，而 sub2api **没有 admin 侧代建 key、也没有 admin 改密路由**（上游 v0.2.13 main 已核对，2026-10-02 发版）→ 部署静默走无 key 降级（实测 `keyRef: null`）。已提交未部署的「派生专属账户」补丁（cf6c311）是带密码托管的绕路，与真实能力不符：**sub2api 的 Logto OIDC 登录已在 DB settings 启用**（`oidc_connect_enabled=true`，issuer=`auth.finddatatech.cloud/oidc`，回调经 URL fragment 交付 JWT）——用户本人一键 SSO 即可进入自己的 sub2api 面板建 key。正确的形状是：**key 由用户在自己会话下铸造、经部署请求交给平台；平台零密码托管**。

## What Changes

- **真实账户解析取代一切代建**：部署时以 admin API 按**邮箱**解析部署者的真实 sub2api 账户；无账户 → 402 结构化指引（「先 Logto 一键登录 token.finddatatech.cloud 建立账户」）；余额门照旧读真实账户。删除 ensureDeployerUser/mintAgentKey 的账户代建与密码托管路径（**取代已提交未部署的 cf6c311 派生账户方案**）。
- **粘贴式 key 交付**：部署请求体增 `billingKeys: { <agentId>: { key } }`——用户在 sub2api 面板（Logto SSO）自建 key 复制粘贴。服务端校验形状（`sk-` 前缀、长度上限）、以平台侧随机引用（`pk_…`）入库、descriptor 带引用、runner 注入与计量链路**不变**（全部已上线）。
- **部署弹窗 UX**：检测无在册 key 时显示「连接 sub2api」按钮（弹窗打开面板根路径，SSO 一键登录）+ key 粘贴框；余额读出/欠费横幅沿用。无 key 部署仍可进行，但 UI 明示「该部署走平台共享配额」。
- **上游自动化留档**：端到端免粘贴需要 sub2api 代码改动（按次 frontend_redirect 覆盖 ~5 行，或 admin 代建 key ~30 行，二者都会弄坏或绕过面板自身 OIDC 登录的全局设置不可用）——立为后续独立 proposal/上游 PR，本片不含。

## Capabilities

### New Capabilities

（无——本片是对 platform-billing 既有两条要求的修订）

### Modified Capabilities

- `platform-billing`:
  - 「Every deployer maps to one sub2api account」→ 重塑为**真实账户按邮箱解析**：无代建、无密码托管、无账户时的一次登录指引；
  - 「Deployment mints one metered key per agent」→ 重塑（REMOVED+ADDED 改名）为「**Deployment binds a deployer-provided metered key per agent**」：key 来自部署者自有会话（面板/SSO），经请求交付、校验、引用、分发——描述符与 runner 侧契约不变。

## Impact

- **Code**: `lib/sub2api-admin.js`（删 ensureDeployerUser/mintAgentKey，增 findUserByEmail；保留 selfCheck/readUser/adjustBalance）、`gateway/packs.js` 部署联动块（真实账户门 + billingKeys 入参校验与入库；sub2api_accounts 表去密码语义）、web 部署详情（连接弹窗 + 粘贴框 + 无 key 明示，五语）、tests。**实现草稿已stash 在案**（`git stash: billing paste-flow rework draft`），随本片落地。
- **撤销项**: cf6c311（派生账户）未部署、被本片取代，随实现一并清理。
- **部署面**: 平台镜像一轮滚动；sub2api 侧**零改动零重启**（OIDC 已启用是前提事实）。
- **实测基线（2026-10-02 已验）**: 余额门 402/充值后放行、两级发现、billing board degraded:false——本片只换 key 来源，其余链路照旧。

## Non-goals

- sub2api 代码/镜像/全局设置任何改动（含 frontend_redirect_url——会弄坏面板自身 OIDC 登录）。
- 端到端免粘贴自动化（上游 PR：按次 redirect 覆盖或 admin 代建 key——独立后续 proposal）。
- key 的过期/轮换提醒（粘贴的 key 失效 → 回合 401/402 自然暴露，运营侧可见后再做提醒面）。
