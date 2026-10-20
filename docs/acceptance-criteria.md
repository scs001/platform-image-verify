# 真机验收与回滚演练（add-line-boards-and-action-gate）

## 验收环境

- 部署：`cheap-3` 或测试 cell
- 账号：普通用户（非 admin，有 `creators` 组权限）
- 凭据：已连接「谦面市场」凭据（设备配对）

## 验收场景

### A. 看板页面

1. **打开看板**
   - 访问 `/boards/facet`
   - 预期：显示「概览」「我的包」「发布记录」三个 tab
   - 预期：顶部显示「壹座 · facet 看板」和「打开原站」按钮

2. **tab 切换**
   - 点击「我的包」tab
   - 预期：URL hash 变为 `#my-packs`，列表块显示
   - 点击「发布记录」tab
   - 预期：时间线块显示

3. **未连接状态**
   - 断开「谦面市场」连接
   - 刷新页面
   - 预期：显示「该线尚未接入」错误提示 + 「打开原站」链接

4. **已连接状态**
   - 重新连接「谦面市场」
   - 刷新页面
   - 预期：显示空列表（无数据）+ 动作按钮「发布新包」「管理可见性」

### B. 动作闸流程

1. **提议写操作**
   - 在「我的包」tab 中点击「发布新包」
   - 预期：弹出确认卡，显示影响面摘要（如「发布新包到市场」）和风险等级（publish → 异步审批）
   - 预期：按钮显示「提议中...」→ 成功后显示「已提议」+ Proposal ID

2. **批准流程**
   - 等待 5 秒后，查看审计台账（如有 UI）或检查数据库
   - 预期：proposal 状态为 `approved`（自动批准）或 `pending`（需人工批准）

3. **拒绝流程**
   - 对另一个提议，点击「取消」
   - 预期：proposal 状态为 `rejected`

4. **过期流程**
   - 手动修改 DB 中一个 proposal 的 `created_at` 为 25 小时前
   - 等待 60 秒（expiry sweeper 周期）
   - 预期：proposal 状态变为 `expired`，WS 广播 `action_expired`

### C. board_changed 事件

1. **执行动作后刷新**
   - 在「我的包」tab 中点击「发布新包」并批准
   - 预期：收到 `board_changed` 事件（可通过浏览器 DevTools Network 面板观察）
   - 预期：列表块自动刷新，显示新发布的包

2. **手动验证**
   - 打开浏览器 DevTools → Application → Local Storage
   - 预期：能看到 `board_changed` 事件的 dispatch

### D. 副驾 dock

1. **打开副驾**
   - 从任意页面点击右下角 FAB（机器人图标）
   - 预期：右侧出现 dock，内含 iframe 加载 `/chat?embed=copilot&board=facet`

2. **上下文条**
   - 预期：dock 顶部显示「正在看：facet」和「清除」按钮
   - 点击「清除」
   - 预期：URL 中的 `board=facet` 参数消失，上下文条消失

3. **Tab 切换**
   - 在主页面切换到 `/boards/wanxing`
   - 再次打开副驾
   - 预期：dock 内的 iframe URL 变为 `/chat?embed=copilot&board=wanxing`
   - 预期：上下文条显示「正在看：wanxing」

4. **独立会话**
   - 在副驾中输入消息并发送
   - 预期：主对话不受影响，继续原有会话
   - 关闭副驾后再次打开
   - 预期：恢复之前的会话历史

### E. 应用中心卡片

1. **已连接状态**
   - 访问 `/apps`
   - 找到「谦面」卡片
   - 预期：主行动按钮显示「看板」（蓝色高亮），次要按钮「打开原站」

2. **未连接状态**
   - 断开「谦面市场」连接
   - 刷新页面
   - 预期：主行动按钮变为「打开原站」

3. **万星卡片**
   - 找到「萬星」卡片
   - 预期：主行动按钮显示「看板」（当 connected 时）或「打开原站」（当 disconnected 时）

### F. i18n 校验

1. **语言切换**
   - 在设置中切换语言至 English
   - 访问 `/boards/facet`
   - 预期：所有文案变为英文（Overview / My Packs / Publish History）

2. **五语一致性**
   - 切换至 fr/es/ja
   - 预期：所有新增的 key（appCenter.board, board.tab.*, copilot.*）都有对应翻译

## 回滚演练

### 1. 功能开关回滚

```bash
# 临时关闭 action gate
kubectl patch deployment paas-cell --patch '{"spec":{"template":{"spec":{"containers":[{"name":"paas","env":[{"name":"ACTION_GATES_ENABLED","value":"false"}]}]}}}}'

# 验证
# - /api/actions/* 路由返回 404
# - 看板页面仍可访问（仅 actions 不可用）
```

### 2. 配置回滚

```bash
# 恢复默认 env
kubectl patch deployment paas-cell --patch '{"spec":{"template":{"spec":{"containers":[{"name":"paas","env":[{"name":"ACTION_GATES_ENABLED","value":"true"}]}]}}}}'
```

### 3. 数据清理

```bash
# 清空测试数据
sqlite3 data/app.db "DELETE FROM action_proposals; DELETE FROM action_audit;"

# 重启 cell
kubectl rollout restart deployment paas-cell
```

## 验收标准

- [ ] 所有场景按预期工作
- [ ] 无 console 错误（浏览器 + 服务端）
- [ ] 性能达标（看板加载 < 2s，动作提交 < 5s）
- [ ] 无障碍检查（键盘导航、ARIA 标签）
- [ ] 五语翻译完整且准确

## 通过标准

全部场景通过验收 → change 可 merge → 滚动发布到生产。

---

**备注**：如果某些场景在当前环境无法完全验证（如需要真实凭据），可以标记为「跳过」并在后续版本补测。

---

# 柏讯线接入（add-wire-line-board）——真机验收十场景

## 验收环境

- 部署：验收 cell，`LINE_BOARDS_ENABLED=1`（默认关；关门即回滚）
- 账号：`wire-customers` 组成员，已在「设置 → 连接 → 柏讯（操作）」完成授权（浏览器 PKCE 铸 ID token）
- pack：「柏讯助手」已 private 发布并安装到该 cell
- 前置：fd-wire 已出片（或本地 / 预发可用）；先用读工具跑一次 `callTool` 探针确认 wire-ops-mcp / wire-build-mcp 的 gateway endpoint 可达且 Bearer 透传

## 场景

1. **打开柏讯看板（零 token）**：访问 `/boards/wire` → 概览 / 我的数据 / 产物 / 需求单四块渲染该账户真实数字；对话 token 用量不变。
2. **未连接态**：断开柏讯连接后刷新 → 「尚未连接」卡 + 「去连接」入口（落 `/settings/connections?panel=line-wire-customer`），页面无任何私有数据。
3. **读回合**：副驾（柏讯助手 preset）问「我有哪些数据集」→ 调 `wire_datasets_list` 返回与看板一致的列表。
4. **写提议行内确认**：让副驾提交需求单 → 确认卡含「公开源 URL」「公开数据声明」两个空字段，未填齐确认钮不可点；填齐确认后 `wire_demand_submit` 执行，`action_audit` 新增一行（含提议者 / 批准者 / digest，无 token）。
5. **合规不代填**：让模型在提议参数里带 `source_urls` → 确认卡字段仍为空，落账的 `args_json` 不含模型值。
6. **花钱二次确认**：订阅市场数据集 → 卡片档位「二次确认」并显示费用影响面；确认后执行。
7. **未注册动作拒绝**：让副驾「删除数据集」→ 闸拒（action not registered），wire 侧零调用。
8. **风险对拍**：本地把任一 MCP 仓 `tool-surface.json` 的 `tool_risk` 改一条并跑 `node scripts/refresh-wire-tool-surface.mjs --check` → 非零退出并打印差异；改 `lib/action-registry.js` 一条风险 → `scripts/test-wire-tool-risk.mjs` 测试 A 红并点名条目。
9. **应用中心**：`line-wire-customer` 已连接、`paper-trading` 未连接 → `wire` 卡徽章 `partial` 但主行动为「看板」，「打开原站」为次要，无「建设早期」徽章；关 `LINE_BOARDS_ENABLED` 后三张看板线卡都回到「打开」。
10. **工具面纯净**：柏讯助手会话可见工具 = 7 ops 读 + 4 build 读 + `propose_action`，不含任何 `tool_risk` 写工具（探针读 tool-filter / registry tool_list）。

## 回滚演练

- 关 `LINE_BOARDS_ENABLED` → `GET /api/boards/wire` 返回 404 `line_boards_disabled`、`/boards/wire` 显示未开启、应用中心无看板主行动；主对话与既有页面零变化。
- 注册表柏讯条目、`lib/wire-tool-risk.js` 快照、执行器、身份注入、`userFilledArgs` 留存无副作用（无 wire 提案即无调用）。

## 本地已覆盖（无需真机重复）

- 单测：`scripts/test-wire-tool-risk.mjs`（对拍 A/B + 突变验证）、`scripts/test-wire-line-board.mjs`（执行器真 HTTP MCP / 闸三态 / 身份豁免 / profile 注入 / 适配器四态 / env 门）、`scripts/test-official-packs-lint.mjs`（写工具 lint + 校验器）、`scripts/test-app-center.mjs`（看板 CTA 条件）。
- e2e（fast）：`e2e/wire-board.spec.js` 十条（门默认关 / 四块深链 / 未连接 / 过期 / 单块失败 / 行内归档确认前零执行 / 补填字段门控与提交体 / 422 逐字段 / 应用中心两态）。

---

# 柏讯线真机验收实录（2026-10-21，platform-demo 验收 cell）

环境：`platform-demo`（fd-prod，AUTH_MODE=none 机器主人、emptyDir 沙箱）滚动至
`sha-29d5c89`（= paas `4dfa7104`，digest `24dc4c4e` ccr 实证），`LINE_BOARDS_ENABLED=1`、
`MARKET_REGISTRY_URL/TOKEN` 就位；镜像含 actions-mcp tools-capability 修复（首版 `sha-9b7417a`
的 actions 子进程在 dsh connect 断言即死——真机 stdio 握手当场抓获，本地假服务端单测测不出）。

## 已在真机跑过并绿的场景

| # | 场景 | 证据 |
|---|---|---|
| 2 | 未连接态 | `GET /api/boards/wire` → 200 `{connected:false, reason:not_connected, connectPath:/settings/connections?panel=line-wire-customer}`，零上游请求 |
| — | 诚实降级 | `GET /api/boards/nope` → 404 `line_not_found` + availableLines |
| — | 部署开关 | `/api/config` → `lineBoardsEnabled:true`；关 env → 立即 404 `line_boards_disabled`（回滚演练双向实走） |
| — | MCP 端点链路 | probe-pack-scope 全量档真握手：wire-ops-mcp **10 工具**、wire-build-mcp **15 工具**、actions **1（propose_action）**——registry 端点 + Bearer 透传全通 |
| — | propose_action | pod 内 stdio 握手 `tools/list → ["propose_action"]`（修复后） |
| — | pack 发布 | facet 市场实发：validate `valid:true`（发布门过）→ publish **`ALuUIiL23WP5OqLIgSRX1g` v1（private）**，经 aloadtree 设备凭据直调 facet-market-mcp（网关剥 Authorization，走 NodePort 31893 直连） |
| — | pack 安装 | demo 真安装链 `POST /api/mypacks/install` → skills/mcpServers/agents 全 installed（前置：registry 两条目 tool_list 回填 10/15 对象数组 + 机器主人 registry 凭据） |

## 待补（阻塞原因如实记录）

- **场景 1/3/4/5/6（需 wire 客户数据与写动作）**：wire 控制面 REST **只认 Logto ID token**
  （`console/auth.py` JWKS 验签+aud；`wdk_` key 仅数据面，`X-Customer-Id` 占位登录已退位），
  无人持有 wire 测试账号的浏览器会话 → 本轮无法铸 token。需要一个 wire 客户身份在壹座
  完成「设置→连接→柏讯」浏览器授权（或提供 Logto 测试凭据由 browser 工具走 PKCE）。
- **场景 10 聚焦面实测**：预设定义/allowTools 已物化（presets.patch.yml 含 柏讯助手），
  但合成探针无法在真实宿主进程外判焦（deriveScope 在探针上下文解析不到 persona）——
  聚焦面正确性目前由本地 e2e（wire-board 十条）+ 仓库 lint 钉死；待真实会话 tools/list 实测。
- **上产 go-live**：prod `platform` 仍 `sha-352d662`（刻意不动，按迁移计划验收后 go-live）。
  **硬前置**：prod 的 `platform-mcp-config` ConfigMap 尚无 `actions` 条目——不补则上产后
  副驾没有 propose_action（本 change 遗留 follow-up）。

## 过程缺陷（真机抓获并已修）

1. actions-mcp `capabilities:{}` → dsh connect 断言死（`4dfa7104` 修复）。
2. registry 两条目 `tool_list=[]` 卡发布门（AuthGate 匿名 401 是既定接受态）→ 照萬星配方
   Mongo 直写回填对象数组（wire-ops 10 / wire-build 15），公网 API 回读一致。
3. demo 无 operator MCP 基线（mcp.json 是 .dockerignore 的，经 GitOps ConfigMap 挂载）→
   增设 `platform-demo-mcp-config`（仅 actions）。

---

# 柏讯线真机验收第三轮（2026-10-21 深夜，会话层闭环）

环境：`platform-demo` → `sha-eec250d`（paas `9d87ae1d`）。本轮把第二轮遗留的
场景 3/10 会话层打完，并再修两个真缺陷。

## 新发现并修复

| # | 缺陷（真机抓到） | 修法 | 落点 |
|---|---|---|---|
| 5 | pack 注入的 wire-ops/build MCP 带的是 **registry 凭据（wgk-，仅数据面）**——会话内任何控制面读工具 401 `invalid console token` | `credentialRefForEntry`：`tool_risk` 快照里两个宿主 server 的注册表条目一律解析为 `wire-customer`（注册表公开 API 不透出 metadata.credential_ref，只能在分发处按工具宿主判定） | paas `9d87ae1d`（镜像 `sha-eec250d`） |
| 6 | demo cell 无 registry 凭据来源：AUTH_MODE=none 禁用设备配对，用户级凭据无处产生 | 以部署环境 token（`MARKET_REGISTRY_TOKEN`）写入 machine-owner 的 registry 凭据（`POST /api/registry/credential`，写-only 通道） | 运维动作（demo cell 内） |

> 顺带把注册表 Mongo 里两条 wire 条目补了 `metadata.credential_ref=wire-customer`
>（`mcp_servers_default`）——公开 API 暂不透出，留作 API 侧 future-proof。

## 场景收口

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 3 | 读回合（副驾） | **通过（会话层真跑）** | chat 会话问「我有哪些数据集？请用工具查一下」→ 副驾调 wire 工具，返回 客户表冒烟（6 行）/E2E 宏观样例（9 行），与看板/`wire_datasets_list` 完全一致；回合 trace：in 568 / out 218，1 step |
| 10 | 工具面纯净（聚焦面） | **通过（物化层实证）** | `tool-filter.json` 聚焦图 = wire-ops-mcp 7 读 + wire-build-mcp 4 读（共 11），**零写工具**；`actions` server 不在过滤图（不收窄）且 `tools/list` 仅 `propose_action`（前轮 stdio 已验）——合成面恰为 11 读 + propose_action；注入头已从 `wgk-` 变为用户 `eyJ` JWT（mcp.patch.yml 实测） |

## 组合与运维口径（本轮实证）

- pack 安装后 `dshUpdateMcp` 触发 profile 重写；聚焦过滤由 `tool-filter.json`
  表达（只收窄图中列出的 server，未列出的 actions 不受影响）。
- demo 每次滚版 emptyDir 清空 → 重铸序：mint wire 凭据 → 写 registry 凭据 →
  `refreshRegistry()` → 重装 pack。已全部脚本化（`/tmp/wire-accept/*`）。
- demo 当前活跃 profile 已切到 `agent.preset=assistant`（聚焦）——验收 cell 无碍。

# prod go-live（2026-10-21 深夜，第四轮）

`platform` 生产 `sha-e4e8e1f` → **`sha-eec250d`**（paas `9d87ae1d`），fd-infra-deploy
`4763b80`。此前 `LINE_BOARDS_ENABLED=1`、`platform-mcp-config`（connector/facet-market/
paper-trading/**wire-ops(wire-customer)**/lex-ops/wanxing-ops/**actions**）与
`PAAS_BASE_URL` 均已在位——go-live 只差镜像。

**生产真会话 E2E（aloadtree，Logto 会话直登）**：

| 步骤 | 结果 |
|---|---|
| 连接柏讯（静默 mint） | ✓（prod 回调已在 Logto 注册；`PAAS_BASE_URL` 在位） |
| `/boards/wire` | ✓ 四块真实数据（2 数据集 / 7 产物 / 4 需求单 / 配额 2/3） |
| 看板行内动作（归档 #18 test） | ✓ propose → inline 确认卡 → executed → 徽章自动变 archived（board_changed 生效）；wire 侧 operator 留痕 `console:aloadtree@gmail.com` |
| 现场还原 | ✓ #18 已 restore 回 draft |

已知边界（如实）：多用户生产中，若 dsh 运行时 profile 的 owner 与发起者不同，
行内动作提议可能瞬时报「未连接」——刷新/重进即恢复（per-user profile 按活跃
owner 重写）；单租户场景不受影响。另：**源包订阅不在 v1 闸名单**（fd-wire 十一条
无 pack.subscribe），用户所见「源包」页与数据集市场是两个面。

## 剩余（不阻塞本 change 归档判断）

- ~~场景 6 执行段~~ 已补（第三轮深夜）：挂市场→订阅执行→撤回复原；注意 wire 的
  拥有者自订是幂等空转（`created:false`），跨客户订阅才是有订阅行的正路径（属
  fd-wire marketplace 既有验收范围）。
- ~~prod go-live~~ 已完成（第四轮）：prod `sha-eec250d` + 真会话 E2E 全过；
  `PACK_BASELINE_MCP=actions` 的显式口径仍建议后续补上（当前靠「过滤图不收窄
  未列 server」的语义达成）。

# 柏讯线真机验收第二轮（2026-10-21 晚，wire 客户凭据打通后）

环境：`platform-demo` → `sha-9dba0ff`（paas `fad9d71c`），`LINE_BOARDS_ENABLED=1`；
wire 生产 `sha-22da877`。连接凭据 = 浏览器 Logto 会话（本轮为 `aloadtree@gmail.com`，
即 demo 机器主人的 SSO 身份；`AUTH_MODE=none` 下凭据按 `machine-owner` 键存取）。

## 本轮新打通 / 新发现并修复

| # | 缺陷（真机抓到） | 修法 | 落点 |
|---|---|---|---|
| 1 | demo 未设 `PAAS_BASE_URL`，mint 回调被拼成 `http://`，Logto 以 `invalid_redirect_uri` 拒绝 | GitOps 加 `PAAS_BASE_URL=https://demo.finddatatech.cloud` | fd-infra-deploy `daedfd2` |
| 2 | wire 的 Logto SPA 客户端只注册了控制台回调与 **prod** mint 回调，缺 demo 回调 | Admin Console 补 `https://demo.finddatatech.cloud/api/lines/wire-customer/mint/callback` | Logto 控制台（已保存） |
| 3 | demo 镜像 `sha-29d5c89`（paas `4dfa7104`）早于执行器形状修复：`getMarketEntries()` 返回快照对象被当数组，`list.find is not a function`，**一切执行必失败** | 从 HEAD 现出 `sha-97086a8`（paas `35617efe`，含 `5b13288d` 的 `safeMarketEntries`） | fd-infra-deploy `5a9dbc4` |
| 4 | 模型给 `wire.demand.submit` 带 `title`，工具 pydantic 严格签名 → 上游 422；注册表八条柏讯动作无参数白名单 | 注册表 `argKeys` + propose 过滤未知键 + camelCase 归一；需求单影响面改 `description` | paas `fad9d71c`（镜像 `sha-9dba0ff`） |

> 缺陷 3/4 只有真机执行才会暴露：单测用假 executor/假 MCP，测不到「快照形状」和「上游严格签名」。

## 十场景结果

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | 打开看板零 token | **通过** | `/api/boards/wire` 与 `/boards/wire`：概览 2 数据集 / 6 产物 / 4 需求单 / 配额 2/3；四块真实数据；页面无对话请求 |
| 2 | 未连接态 | **通过**（前轮） | `{connected:false,reason:not_connected,connectPath:/settings/connections?panel=line-wire-customer}`，零上游 |
| 3 | 读回合 → `wire_datasets_list` | **工具层通过，会话层未跑** | 持 cell 凭据直连 wire-ops MCP：`wire_datasets_list` 返回「客户表冒烟（6 行）」等，与看板一致；会话层见「待补」 |
| 4 | 写提议行内确认 + 合规两空字段 + 审计 | **通过** | 提议返回 `userFilledArgs=[source_urls, public_data_asserted]`；未填 → 400 `missing required user arg: source_urls`；补填后 `executed`，wire 侧生成需求单 `DE-20261020-01`（id 12）；`action_audit` 一行，line=wire，仅 digest，无 Bearer/token |
| 5 | 模型合规值不采纳 | **通过** | 模型传 `source_urls/public_data_asserted` → `args_json` 只剩 `description/contact_email`（落库实证） |
| 6 | 花钱二次确认 | **通过（第三轮含执行段）** | `risk=cost`、`tier=second`、影响面含「产生费用」；把一个数据集挂市场后全链执行：approve → `executed`，上游如实返回 `{subscribed:true, created:false}`（**拥有者自订语义**：自己的数据集无订阅行，幂等空转——闸不遮掩），审计 206ms 无错误；验后数据集已撤回市场（盘点复原 0） |
| 7 | 未注册动作拒绝 | **通过** | `wire.dataset.delete` → 400 `action not registered`，wire 零调用 |
| 8 | 风险对拍 | **通过（本地）** | `test-wire-tool-risk.mjs` 6/6；`test-action-executor-refs.mjs` 16/16；`test-wire-line-board.mjs` 23/23 |
| 9 | 应用中心 | **通过** | Wire 卡主行动 `Board`、次要 `Open origin site`、**无 Early stage** 徽章、聚合态 `Partly connected` |
| 10 | 工具面纯净 | **清单/服务端通过，聚焦会话未跑** | wire-ops 10 工具（7 读 + 3 写）、wire-build 15 工具（10 读 + 5 写）；pack `allowTools` = ops 7 读 + build 4 读，与 12 写工具交集为空（lint 绿）；`propose_action` 由 actions MCP 提供（前轮 stdio 已验） |

## 待补（本轮仍无法闭环，原因如实）

- **场景 3 会话层 / 场景 10 聚焦面**：pack「柏讯助手」重装后 MCP 两条目报
  `credential-required`——demo cell 没有 registry 凭据（`platform-demo-registry-token`
  缺失/为空），dsh 无法把 wire MCP 注入会话。补 registry 凭据后跑一次真实问句
  「我有哪些数据集」，同时用宿主会话 `tools/list` 验聚焦面 = 11 读 + `propose_action`。
- **场景 6 执行段**：wire 市场当前盘点为 0，无可订阅数据集；补市场货后做一次
  `wire.market.subscribe` → 二次确认 → 执行 → 退订回收。
- **身份字段口径**：`AUTH_MODE=none` 下 proposer/approver 落 `null`（凭证键为
  `machine-owner`）；prod 启用认证后同一路径写入真实邮箱，本轮不构成缺陷。
- **上产 go-live 前置不变**：prod `platform` 仍 `sha-352d662`；`platform-mcp-config`
  ConfigMap 仍缺 `actions` 条目。
