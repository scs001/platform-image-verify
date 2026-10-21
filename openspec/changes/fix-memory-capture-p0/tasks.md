# fix-memory-capture-p0 — 任务清单

> 两 P0（串投 / 观测空心）+ 两处纪律文案（pod 自相矛盾 / cell 无消费者）。先于
> `add-memory-scopes-and-cluster-sharing` 归档；设计见 design.md D1-D7。
> 纪律：每项代码任务配同号测试；提交只 `git add` 本 change 文件（并行会话在途）；出片走 `fd-build-channel`。

## 1. 分组队列（P0-1，design D1）

- [ ] 1.1 `agent-runner/memory-capture.js`：队列项携带 `namespace`，删 `#namespace` 字段；`#flush()` 取 ≤100 条后按 namespace 分组、每组一次 POST（body `{events, namespace}` 不变）；失败按组回排 + gap 计数 + 退避；`drain()` 冲全部组
- [ ] 1.2 串投突变测试（`agent-runner/test/memory.test.mjs`）：两 namespace 交替 observe → fetch 两次、各 body 只含自己的事件；临时改回单 namespace 实现该测试必红（做一次并在 PR 说明里记录）
- [ ] 1.3 分组失败隔离测试：A 组 500 / B 组 200 → B 不回排，A 回排且 `droppedBatches=1`，退避只影响下一次 flush 时机

## 2. 观测带内容（P0-2，design D2/D3）

- [ ] 2.1 `agent-runner/config.js`：新增 `memoryIntentMax / memoryArgsMax / memoryResultMax`（env `AGENT_RUNNER_MEMORY_INTENT_MAX` 500 / `_ARGS_MAX` 600 / `_RESULT_MAX` 800，非法值回默认）
- [ ] 2.2 `memory-capture.js observe()` 接受 `{namespace, sessionId, event, toolName, summary, at}`，映射 capture 字段 `event / tool_name / summary`；缺 `event` 时回落 `stop`（兼容）；`summary` 仍硬顶 2000
- [ ] 2.3 `manager.js turn()`：过 pause/park 门后、`child.turn` 前投 `user-prompt-submit`（`text` 截 intentMax）；构造 `onEvent` 回调：`tool_call` → `pre-tool-use`（参数单行紧凑 JSON 截 argsMax）、`tool_result` → `post-tool-use`（结果文本截 resultMax，`isError` 加 `error: ` 前缀）；成功 / 失败两处 `stop` 保留；全部 try/catch，永不进回合失败路径
- [ ] 2.4 四形状与截断测试：伪 adapter 回放「意图 + 2 工具（1 成功 1 失败）」→ 队列序 `user-prompt-submit, pre, post, pre, post, stop`，每条摘要 ≤ 对应上限，错误结果带前缀，`tool_name` 正确

## 3. dsh 适配器事件回调（design D2/D4）

- [ ] 3.1 抽 `server/dsh-events.js parseToolResult` 到无依赖 `lib/dsh-tool-result.js`，`server/dsh-events.js` 改 import（行为字节不变，既有 server 测试绿）
- [ ] 3.2 `agent-runner/harness/dsh.js` turn 收集器：`session.event` 的 `tool/call` → `onEvent({type:"tool_call", callId, toolName: ev.data.name, args: ev.data.arguments})` 并登记 callId→name；`tool/result` → 经 `parseToolResult` 出 `{type:"tool_result", callId, toolName(回填), resultText, isError}`
- [ ] 3.3 `agent-runner/harness/adapter.js` 契约注释：`onEvent` 可选能力一行
- [ ] 3.4 真事件夹具：从跑过工具回合的 cell `trace.db` 取 `tool/call` + `tool/result` 各一对（`select payload from trace_events where event_type in ('tool/call','tool/result')`），扁平与包裹两形状都要；收集器单测断言两次 `onEvent` 形状（夹具文件入 `agent-runner/test/fixtures/`）

## 4. ACP 适配器事件回调（design D2）

- [ ] 4.1 用本机 claude-code ACP 真流核对 `tool_call` / `tool_call_update` 字段名（`toolCallId / title / kind / status / content / rawInput / rawOutput`），差异记进 design D2
- [ ] 4.2 `agent-runner/harness/acp.js` 收集器：`tool_call` → `onEvent(tool_call)`（`toolName = title ?? kind`）；`tool_call_update` 且 `status ∈ {completed, failed}` → `onEvent(tool_result)`（`content[]` 文本拼接，缺则 `rawOutput` JSON；`isError = status === "failed"`）
- [ ] 4.3 测试：三条 update（call / completed / failed）→ 三次回调形状正确；无 `onEvent` 时行为字节不变

## 5. 纪律文案与挂载同生同灭（design D5）

- [ ] 5.1 `manager.js`：`#memoryDiscipline()` 改为按本次组合是否实际 push 了挂载行取文案——dsh / ACP spawn 在 `memoryToken` 非空且 mount row 已加入后才取；铸币失败分支为 `null`；`#spawnPod` 恒 `null`，删除「pod 不挂记忆却传文案」那段注释与传参
- [ ] 5.2 测试：pod 组合 persona 无文案；dsh 组合铸币成功含、铸币失败（mint 500）不含；ACP 同

## 6. 文案单源 + cell 消费者（design D6）

- [ ] 6.1 新建根 `memory-discipline.js` 导出唯一 `MEMORY_DISCIPLINE`（取 cell 现行中文文案）；`agent-runner/memory-discipline.js` 改 re-export 并保留 `personaWithMemoryDiscipline`；`cell-memory.js` 删本地常量改 import
- [ ] 6.2 `dsh-profile.js writePresetsPatchSync`：部署单例路径（`dirs` 为空）且 `cellMemoryConfig(env).enabled` 时，对 `preset-standard` 与每个生成预设的 persona 行写 `config.suffix`（既有 suffix 之后追加文案）；`dirs` 非空不动
- [ ] 6.3 cell 测试（新 `test/dsh-profile-memory.test.mjs` 或并入既有 dsh-profile 测试）：开启时每个 persona 行 suffix 含文案；关闭时 presets patch 与现状字节等同；runner 注入文本 === cell 注入文本；台账记录「部署级门 vs 每 owner 铸币失败」的接受边角
- [ ] 6.4 打包三形态核查：Dockerfile 根 `*.js` / `agent-runner` / `lib` 已在册（读码确认）；desktop（electron-builder `files`）与 `dist-opensource` 清单含根 `memory-discipline.js` 与 `lib/dsh-tool-result.js`，缺则补

## 7. 验证与出片

- [ ] 7.1 `node --test agent-runner/test` 与既有 server 测试全绿；`openspec validate fix-memory-capture-p0` 绿
- [ ] 7.2 本地活体：本地 fd-memory + runner 托管一个 dsh 部署跑含工具的回合，`observations` 表见 `user-prompt-submit / pre-tool-use / post-tool-use / stop` 四形状且 namespace 正确；两个部署交替各跑一回合，各 namespace 只含自己的事件
- [ ] 7.3 出片：`fd-build-channel` 判路 → platform 镜像滚 `runner-serving` 与 cell（`deploy-registry-image` / `paas-release` 纪律：先推 origin 再快照、核 pool tree 含新文件、relay 看逐 tag OK 行、digest↔pod imageID 双向比对）
- [ ] 7.4 生产验收：两个部署各跑一个含工具的回合，fd-memory 各自 `d/` namespace 下见四形状且无对方事件；记录每回合观测条数与 PVC 用量基线（一周后复看）
- [ ] 7.5 台账：`docs/registry-maintenance.md` §9 发布记录；记忆台账 `memory-architecture-v2-program.md` 追加 P0 完结

## 8. 归档

- [ ] 8.1 `openspec-sync-specs`：`agent-runner` 与 `memory-federation` 两条 MODIFIED 同步主 spec；`add-memory-scopes-and-cluster-sharing` 的 `agent-runner` delta 以同步后的主 spec 为基线重写（其 proposal 已约定）
- [ ] 8.2 `openspec archive fix-memory-capture-p0`
