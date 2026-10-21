## 1. 服务端：按线解析聚焦助手（design D1 / D5）

- [x] 1.1 新建 `lib/copilot-presets.js`：`resolveCopilotPreset(line, installedPacks, deps)` 纯函数（四条形状规则：全引用声明非空 `allowTools` 且无 `fullSurface`；`allowTools` 并集不含注册表任一 `tool`；服务器集合 ⊆ 线服务器且非空；至少一个 `report.agents[].status === "installed"`），多候选按 `installedAt` 降序取首个并 warn；`lineServersFromRegistry()` 从 `lib/action-registry.js` 的 `server` 字段推导 facet / wanxing，柏讯补 `wire-ops-mcp` / `wire-build-mcp` 常量；`copilotPresetForLine(line)` 包装 DB 读取（DB 未就绪 → null）。返回 `{ agentId, agentName, packId, packName }`。
- [x] 1.2 单测 `scripts/test-copilot-presets.mjs`：三个官方 manifest 各自解析到自己的线且不串线；含写工具（`facet_market_pack_visibility`）的 pack 被拒；某引用未声明 `allowTools` 被拒；agent 在报告里 skipped 被拒；两候选取最近安装；柏讯常量与 `lib/wire-tool-risk.js` 的 server 集合一致；未知线 → null。
- [x] 1.3 `server/routes/boards.js` 新增 `GET /api/boards/:line/copilot`：`LINE_BOARDS_ENABLED` 未开 → 404 `line_boards_disabled`；未知线 → 404 `line_not_found`；否则 `{ line, copilot }`，不调用适配器。单测：门关 404、未知线 404、已装谦面助手时返回其 agent、未装时 `copilot: null`，且 `fetchBlocks` 零调用。

## 2. dock：注入与恢复（design D2 / D3）

- [x] 2.1 `web/src/components/CopilotDock.tsx` 接收 `send`（`App.tsx` 传入）；`boardLine` 变化时 `GET /api/boards/:line/copilot`，结果存 `copilot` state；iframe src 在有 `copilot.agentId` 时追加 `&preset=<agentId>`；postMessage 的 `copilot_context` 同步携带 `preset`。
- [x] 2.2 打开时记录 `agentBeforeOpen = useChatStore.getState().currentAgent`；关闭时若 `currentAgent === copilot.agentId` 则 `send({ type: "set_agent", id: agentBeforeOpen ?? "local" })`，否则不恢复；无 `copilot` 时关闭不发任何消息。

## 3. embed：应用预设与上下文条（design D2 / D4 / D5）

- [x] 3.1 `web/src/pages/ChatPage.tsx` embed 模式读取 `preset`；`status === "connected"` 后一次性（ref 守卫）在 `currentAgent !== preset` 时 `send({ type: "set_agent", id: preset })`；监听 `agent_changed` 对齐即视为已聚焦。
- [x] 3.2 上下文条增加聚焦段：已聚焦显示「聚焦预设：<agent 名>」（名字来自 store `agents` 列表，找不到则显示 id）；`set_agent` 返回 error 时显示「主对话正在回答，暂未聚焦」+ 重试按钮（重试即重发一次）；URL 无 `preset` 时显示「未聚焦：该线助手 pack 未安装」。「清除」按钮只清 `board`，不动 `preset`。五语 locale 补 `copilot.focused` / `copilot.focusPending` / `copilot.focusRetry` / `copilot.unfocused`。
- [x] 3.3 e2e（`e2e/wire-board.spec.js` 追加或新 `e2e/copilot-dock.spec.js`，mock `/api/boards/:line/copilot`）：有助手时 iframe src 含 `preset=`、上下文条显示聚焦段；无助手时 src 不含 `preset` 且显示未聚焦；关闭 dock 后 WS 收到 `set_agent` 恢复消息（或断言主对话 agent 回到打开前）。

## 4. 官方 pack v2（design D6）

- [x] 4.1 `docs/official-packs/{facet-assistant,wanxing-fleet-assistant,wire-assistant}-manifest.json` 的 `agents[0].id` 改为 `facet-assistant` / `wanxing-fleet-assistant` / `wire-assistant`，`notes` 标 v2 原因；`release-instructions.md` 增「v2 发布记录」位与 agent id 去撞说明。
- [ ] 4.2 市场发布三包 v2（cell 设备凭据直调 validate → publish），验收 cell 升级后 `GET /api/boards/{facet,wanxing,wire}/copilot` 三线各自非 null。（市场侧动作，发布前经用户确认。）

## 5. 验证与上产

- [x] 5.1 `npm run test:unit`（含新测试）、`biome check`、`tsc --noEmit`（web）、`web:build`，e2e fast 项目相关 spec 绿。
- [ ] 5.2 出片：`fd-build-channel` 判路 → `fd-build-snapshot` → relay → ccr → ArgoCD（`argocd.argoproj.io/refresh` 注解，image 字段翻转 ~60s 为准）；digest ↔ pod imageID 比对。
- [ ] 5.3 真机验收（aloadtree）：`/boards/facet` 开 dock → src 带 `preset` → 上下文条「聚焦预设：谦面助手」→ 主对话选择器同步显示 → 让模型「把包 X 改成私有」→ 只出 `propose_action` 确认卡、无 `facet_market_pack_visibility` 直调 → 关 dock → 主对话 agent 恢复。记录到 `docs/registry-maintenance.md` 发布记录。

## 6. 收口

- [ ] 6.1 同步主 spec（`line-boards` MODIFIED、`web-chat-ui` ADDED），`openspec validate --all` 绿。
- [ ] 6.2 归档 change；更新持久记忆（发现③收口、cell 级预设副作用与恢复策略）。
