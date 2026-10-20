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
