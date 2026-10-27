## 1. 列表面：加载态与客户端缓存（web-list-surfaces）

- [x] 1.1 新增 `web/src/lib/listCache.ts`（进程级 `Map` + `useListCache(key, fetcher)`，返回 `{data, status, refresh}`，`status ∈ idle|loading|loaded|error`），并写单测覆盖：冷启动为 loading、命中缓存即时为 loaded 且后台 revalidate、失败落到 error。验证：`scripts/test-list-cache.mjs` 8/8 通过。
- [x] 1.2 应用中心接入：目录产品区在冷启动渲染占位骨架（不再「5 张品牌卡 → 突增」），缓存命中时即时全量渲染。验证：e2e `app-center.spec.js`「a revisit paints the catalog in full from cache」通过（切走再返回无骨架帧）。
- [x] 1.3 智能体页接入（`/api/catalog` + `/api/clusters/mine`），空态文案只在 `loaded && empty` 出现。验证：e2e `agents-smoke.spec.js`「a delayed cluster read shows no empty copy until it lands」通过。
- [x] 1.4 集群页接入（`/api/fleets`）：新增 loading 态，列表空文案仅在 `loaded && empty` 出现。验证：e2e `fleets.spec.js`「cold load shows placeholders, never the empty copy」通过。
- [x] 1.5 缓存失效接线：`catalog_changed` 广播使 catalog 缓存失效并重取；窗口 focus 触发重取；身份/角色变化或登出清空缓存。验证：`test-list-cache.mjs` 覆盖 invalidate（精确/前缀）、订阅通知、clear 全清；接线在 `App.tsx`（identityKey → clear，catalogVersion → invalidate「catalog」）。
- [x] 1.6 集群页记住上次选中（`localStorage` 键 `fleets.lastSelectedId`），深链 `/fleets/:fleetId` 优先、记忆的集群不存在时忽略。验证：实现 + `fleets.spec.js` 全组通过（列表/详情/深链不回归）。
- [x] 1.7 更新既有断言「空态文案立即出现」的用例为「加载完成后出现」，并补一条空态时序用例。验证：`app-center.spec.js` 加骨架归零等待；新增集群页/智能体页两条时序用例，均通过。

## 2. 智语未读归零（zhiyu-room 通知与触达）

- [x] 2.1 服务端新增 `POST /api/zhiyu/notifications/read-all`（一条 `UPDATE ... WHERE email = ? AND read_at IS NULL`，返回最新 `unread`）。验证：`scripts/test-zhiyu-notify.mjs` 8.3（read-all 归零、幂等、不动他人）通过。
- [x] 2.2 接受/拒绝邀请时置读其对应通知（`resolveInviteAction`）。验证：`test-zhiyu-notify.mjs` 8.1（accept 后该用户 unread 归零）通过。
- [x] 2.3 未读计数与通知面板口径一致（面板不再过滤 `invite`，与计数同集合）。验证：e2e `zhiyu-unread-badge.spec.js`「an invite-only unread badge ... has a matching panel row」通过。
- [x] 2.4 前端进 `/zhiyu` 调用 `read-all` 并以返回的 `unread` 即时清零导航角标（不等 Sidebar 轮询）。验证：同上 e2e（`readAllCalls > 0` 且角标消失）。

## 3. 长会话打开载荷（web-chat-server / web-chat-ui）

- [ ] 3.1 插测量：`switchToSession` 记录耗时与 `messages` 序列化字节数（一行日志）。代码已落（`server/agent-session.js` `logSwitchCost`），**真机读取待 4.4**（本地无 dsh 常驻会话，无法产生真实读数）。
- [x] 3.2 服务端首帧窗口化：`session_loaded`（`running: false`）只携带最近 N 轮 + `totalTurns` + `hasMore`；N 与客户端渲染开窗共用同一常量（`TRANSCRIPT_WINDOW = 50`）。验证：`test-transcript-window.mjs` 6/6 + e2e `session-open.spec.js`「a long session loaded from the server opens windowed」通过。
- [x] 3.3 服务端按需分页：新增 `load_earlier`（游标 = 最早已载 `seq`，返回上一批升序 + `hasMore`），复用 `switch_session` 的所有权校验。验证：`test-transcript-window.mjs` 逐页回溯/最老页终止/空页如实/未知输入降级 全通过。
- [x] 3.4 客户端接入：store 持有已载窗口；顶部「加载更早」改为向服务端取上一页并前插；已含首轮时隐藏入口；outline/export 不报错。验证：`test-chat-store-session-open.mjs` 3.4（前插 + 游标推进 + 异会话丢弃）4 例通过；e2e `session-open.spec.js` 渲染开窗/outline 跳转全通过。
- [x] 3.5 老客户端兼容回归：未知字段（`hasMore`/`totalTurns`）到来不报错、按窗口替换。验证：`test-chat-store-session-open.mjs` 3.5（无计数字段的旧负载读作完整）通过；session/store/history 相关 42 例全通过。

## 4. 收口与出片

- [ ] 4.1 新增文案（加载中/骨架等）补齐五语言，复用既有「加载更早」。**本变更零新增 key**（骨架无文案、`chat.loadEarlier` 复用），因此无需补译；locale 闸当前红是并行会话在途的 `packs.detail.*`/`packs.earnings.*` 只补了 en+zh-CN，与本案无关。
- [ ] 4.2 全量门：`npm run test:unit` 与相关 e2e 全绿。**我方全绿**（4 个测试文件 + session/store/history + zhiyu 家族）；全量门 31 例红全部来自并行会话在途（`server/fleet-digest.js` 曾缺失、pack/extension 契约）与 HEAD 既有（app-center `GRID_ORDER` 未含已入仓的 `crm-desk`），非本案文件。
- [x] 4.3 `openspec validate --specs` 全量为 0 失败。验证：`190 passed, 0 failed`。
- [ ] 4.4 出片并真机眼见五项（集群空态不闪、应用中心即时全量、智能体不空刷、智语角标可归零、长会话打开变快）。**待部署**（需用户出片到生产后走查；与 3.1 的真机读数同批）。
