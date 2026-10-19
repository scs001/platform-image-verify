## 1. 基线与 spike（先行，可与 2 并行）

- [x] 1.1 量 e2e 基线：对 `e2e/composer-stop.spec.js`、`session-navigation-streaming.spec.js`、`reconnect-resync.spec.js`、`session-ownership.spec.js`、`session-delete.spec.js` 各跑 5 轮 `npx playwright test --project=fast <spec>`，把红绿率记入 `openspec/changes/concurrent-chat-sessions/notes/e2e-baseline.md`（composer-stop 已知 main 固有 flaky，先量再比）。
- [x] 1.2 合同 ⑨b advisory：在 `scripts/lib/dsh-contracts/contracts.mjs` 新增 `multi-session-close-interleave`（复用 ⑨ 布置→释放 dummy LLM→不发 cancel→断言 A、B 20s 内均 idle），`CONTRACTS` 行带 `advisory: true`；`scripts/dsh-contracts.mjs` 行循环识别 advisory（打印 PASS/FAIL 与 detail，不计入 failures，摘要末尾单列）。验证：`npm run dsh:contracts` 在冻结矩阵上 ⑨b 行 FAIL 且总判定 / exit code 不变。
- [x] 1.3 spike（改用冻结矩阵实测，见备注）：在临时目录安装 `@deepseek-ai/dsh@0.2.1-rc.2` 全家族，`npm run dsh:contracts -- --tree <scratch>`，读 ⑨b 行；结论（PASS/FAIL + detail 原文）写入 `notes/dsh-0.2.1-rc.2-spike.md` 与 dsh-version-matrix 台账；PASS 则在 notes 里记「待立 dsh 升级 change（矩阵升级 + 翻 `TURN_DISPATCH` 默认 + ⑨b 升门禁）」，FAIL 则记「queue 策略即终态」。

## 2. 服务端——派发器核心

- [x] 2.1 新建 `server/turn-dispatch.js` `attachTurnDispatch(ctx)`：`Map<sid, entry>` + FIFO 顺序、`dispatchTurn({sessionId, text, run, ws})`、`drainTurnQueue()`（同步置 `isStreaming` 后执行 `run`）、`cancelQueued(sid)`、`isQueuedFor` / `queuedSessions`、`TURN_QUEUE_MAX`（默认 8）、队非空时 `TURN_QUEUE_POLL_MS`（默认 2000）安全轮询、`TURN_DISPATCH=legacy|queue|concurrent` 解析。验证：新建 `scripts/test-turn-dispatch.mjs`（用 `attachTurnStateModule` 手搭 ctx）覆盖：空闲即派发、忙则入队、FIFO、每会话一条、队满 `queue_full`、取消、同 tick 两条只派一条、三策略行为。
- [x] 2.2 「忙」的定义：`ctx.runtimeBusy()` = `isStreaming || sessionCollectors.size || runtimeReservations.size`；新增 `ctx.runtimeReservations: Set`；`server/cron-runner.js` `collectTurn` 的 finally 调 `ctx.onRuntimeIdle?.()`，`switchPresetForJob` 在 `waitForIdle` 通过后放预约 token、collector 注册或失败时释放。验证：`test-turn-dispatch.mjs` 增用例——模拟 collector 在场时排队项不派发、注销后派发；预约在场时 `bridge.ready` 不派发、释放后派发。
- [x] 2.3 drain 触发接线：`server/dsh-events.js` `finishTurn` 尾部与 `bridge.ready` 分支调 `ctx.drainTurnQueue()`；`bridge.exit` 不清队。验证：单测——finishTurn 后队首派发；子进程重启（exit→ready）后排队项仍在并派发。
- [x] 2.4 显式 sid：`server.js` session shim 改 `prompt(text, sid)`（`sid ?? currentSessionId()`），`server/ws.js` 两个调用点与派发器闭包显式传 `target`；`server/dsh-events.js:402,416` `llm/retry` 改用事件自身 `sid`。验证：单测——接受后、派发前切换全局指针，回合仍落在原会话；retry 事件只投给原会话 viewers。

## 3. 服务端——ws / agent-session 接线

- [x] 3.1 `server/ws.js` `prompt` 两分支（普通 / skill）改经 `dispatchTurn`，`run` 闭包内含 user 回显、**派发时**才 `recordMessage`、`expandDocRefs`、`session.prompt(text, sid)` 或 remote fork；同会话守卫 `isStreamingFor || isQueuedFor`（排队态文案区分）；接受时扣 demo 配额；入队时向 viewers 发 `queued{sessionId, text, position, waitingOn}`（`waitingOn` 取当前开着的 web 会话 `{id, title}`，collector 车道为 null）。验证：`scripts/test-session-ownership.mjs` 同款 fake-ws 单测——A 流中 B 提交收到 `queued`，A 收尾后 B 收到 `dequeued{dispatched}`→`user`→`agent_start`；取消的排队项 SQLite 无 user 行。
- [x] 3.2 `server/agent-session.js`：`switchToSession` / `createNewSession` 删去 `stopStreamingForSessionNavigation()` 调用（`legacy` 策略下保留旧路径），删除该函数与 `remoteAbort.switchedAway`。验证：单测——A 流中 switch 到 B 不发 `cancelSession`、A 的 `isStreamingFor` 仍 true；`TURN_DISPATCH=legacy` 时行为同旧。
- [x] 3.3 `server/ws.js` `stop_turn`：新增排队态分支（`cancelQueued` + `dequeued{cancelled}`，不触碰 dsh）；吸收 remote-abort 分支（`activeRemoteTurnAbort.sessionId === stopSid` → `finishTurn("aborted")` + `abort()`）。验证：单测——排队态 stop 不调 `cancelSession`；remote 回合 stop 后收到 `done`。
- [x] 3.4 状态播报：`sessions` 条目增 `turnStatus`（`running` / `queued` / null，`listSessions` 之后按 ctx 标注）；`broadcastSessions` 在入队 / 出队 / 派发时触发；`switch_session`（含 resync 分支）、连接时、`syncReadyClient` 的 `session_loaded` 增 `queued: {text, position, waitingOn} | null`。验证：单测——排队期间 `sessions` 中 A=running、B=queued；切到 B 的 `session_loaded.queued.text` 等于提交文本。
- [x] 3.5 删除守卫：`chat-history.js` 新增 `setActivityProbe(fn)`，`deleteSession` 的 `active` 判定并入 `streaming || queued`；`server.js` 注入探针。验证：单测——对后台流中会话与排队会话 `DELETE` 均 409 且无删除；REST 与 WS 路径同判。
- [x] 3.6 策略门：启动时 `TURN_DISPATCH=concurrent` 且未设 `DSH_MATRIX_CLOSE_INTERLEAVE=1`（⑨b 通过标记，由 dsh 升级 change 设置）→ 降级 `queue` 并 `console.warn` 指名原因。验证：单测——三种 env 组合的生效策略与告警文本。

## 4. 客户端

- [x] 4.1 `packages/core/src/types/ws.ts`：新增服务端消息 `queued` / `dequeued`，`sessions[]` 条目 `turnStatus`，`session_loaded.queued`。验证：`npm run typecheck` 绿。
- [x] 4.2 `packages/core/src/store/chat-store.ts`：新增 `queuedTurn: {text, position, waitingOn} | null`（当前视图）；`queued`（sid 等于当前视图）与 `session_loaded.queued` 置位，`dequeued` / `agent_start` / 无 queued 的 `session_loaded` 清除；排队态 `canSend=false`；`dequeued{cancelled}` 把文本回填到 composer draft；沿用 sid 过滤。验证：`npm run typecheck` 绿 + 5.2 e2e 覆盖状态流转。
- [x] 4.3 `web/src/components/Chat.tsx` 排队气泡：文本 + 「排队中 · 等待《{title}》完成」（`waitingOn` null → 「等待运行时空闲」）+ 「取消」（`stop_turn{id: current}`）+ `waitingOn` 非 null 时「停止它并立即执行」（`stop_turn{id: waitingOn.id}`）；停止控件在排队态可见（语义=取消排队）；zh/en 词条。验证：`npm run check:locales` 绿 + 5.2 e2e。
- [x] 4.4 `web/src/components/Sidebar.tsx`：会话行按 `turnStatus` 渲染 running（既有 loader 样式）/ queued（时钟图标），带 i18n 可访问标签；删除菜单禁用条件 `isCurrent || turnStatus !== null`，三种 tooltip 文案。验证：`npm run check:locales` 绿 + 5.2 e2e 断言指示与禁用态。
- [x] 4.5 `npm run web:build:e2e` 成功（e2e 吃预构建 dist，前端改动不先 build 会测旧代码）。

## 5. e2e 与回归

- [x] 5.1 重写 `e2e/session-navigation-streaming.spec.js`：两个用例反转为「new chat / 切换均不停活流」——probe 的回合以 `done`（非 aborted）收尾、期间无 busy 拒绝、切走后侧栏 A 行显示 running、切回 A 收到 `session_loaded{running:true}`。验证：`npx playwright test --project=fast e2e/session-navigation-streaming.spec.js` 连跑 3 轮绿。
- [x] 5.2 新建 `e2e/turn-queue.spec.js`：A 流中在 B 提交→排队气泡（文本、等待《A》）+ 侧栏 A running / B queued + 发送禁用；A 收尾后 B 自动开始（`dequeued`→`user`→`agent_start`）；「取消」→气泡消失、文本回到输入框、SQLite 无该 user 行（经 `/api/chat-history/sessions/:id` 断言）；「停止它并立即执行」→A 中止、B 开始；排队中刷新页面→气泡还原；排队 / 后台流中会话右键删除项禁用。验证：连跑 3 轮绿。
- [x] 5.3 多 Tab 用例（并入 5.2 或独立 `multi-tab-streaming.spec.js`）：两个 page，tab1 在 A 流中，tab2 切会话 / 新建不影响 tab1 的流；tab2 在 C 提交进排队且 tab1 的 A 不受影响。验证：3 轮绿。
- [x] 5.4 回归（5 轮红绿率）：新 spec `turn-queue` + `session-navigation-streaming` **30/30 全绿零 flake**；回归四件套 `reconnect-resync`/`session-ownership`/`session-delete`/`chat-history` **55/55 全绿零 flake**；`composer-stop` **3/50 红（6%）**，并在改动前代码上（git stash）复测得**同样 3/50、同样两个用例**——该 flaky 为 main 固有，本次无劣化。
- [x] 5.5 全量门：`npm run test:unit` 1618/1618 绿；`npm run typecheck` 绿；改动文件 biome 绿；**`npm run test:e2e` 全量 503 通过 / 5 失败**——其中 `composer-stop`（2 个）是 main 固有 flaky，`focus-overlay` / `projects-automation` / `registry-connect` 单独复跑全绿（6/6、9/9、5/5），全部为套件顺序/负载 flaky，与本次改动无关。仓库级 `npm run lint` 有 2 处 main 固有红（`cell-memory.js` / `test-agent-serving.mjs`），非本次文件。

## 6. 出片与真机验收

- [ ] 6.1 按 AGENTS.md 出片：先 `fd-build-channel` 判路，`fd-build-snapshot` 走 GHA → hkccr → cheap-3 relay → ccr；验证：relay 日志对本 sha tag 的抓取行 + 镜像 digest。
- [ ] 6.2 真机端到端（真实账号，module-vs-e2e 纪律）：两个会话交替提问、切走切回看活流、排队气泡与自动派发、「停止它并立即执行」、刷新还原排队、多 Tab 互不影响、cron 任务期间提问进排队且任务结束后自动派发；每项留截图或 WS 事件日志；验证 pod imageID digest 与出片 digest 一致。
- [ ] 6.3 回滚演练：对一个测试 cell 设 `TURN_DISPATCH=legacy` 重启，确认切换即停的旧行为恢复；撤掉 env 恢复 `queue`。验证：两种行为各一次真机观察记录。
- [ ] 6.4 台账：发布记录（paas 发布台账 §9）+ dsh-version-matrix 台账补 ⑨b 结论 + 本 change `notes/` 收口；若 1.3 为 PASS，开 dsh 升级 change 的提案并链接到本 change。
