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
