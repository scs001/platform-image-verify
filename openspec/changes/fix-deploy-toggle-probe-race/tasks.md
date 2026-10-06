## 1. 诊断

- [x] 1.1 诊断（比预案更强：直接读本地 fork 源码 `~/code/mcp-gateway-registry`，零副作用）：registry 侧 toggle 路由**每次调用**都跑 `_refresh_agent_health`（探针=抓后端卡片期望 200，持久化 health_status）+ `mark_dirty` 刷 nginx；`enable_agent` 已在启用态早退但**不影响探针执行**；周期健康循环只覆盖 MCP servers（源码 docstring 明说）——故「重发即自愈」。**早退判据不需要**（重发无副作用），盲重发梯即为正解。原诊断任务：按 `docs/registry-maintenance.md` §6 写通道实锤 toggle 探针语义——POST `/api/agents/<path>/toggle?enabled=true` 的响应形状、GET 条目的健康字段名、重发幂等性；产出：design.md D1/D3 参数注记（早退判据字段名 + 是否需降级为条件重发）

## 2. 实现

- [x] 2.1 `lib/agent-serving.js`：新增 `scheduleDeployReassurance`（+90s/+210s/+330s 三档**无条件重发** toggle?enabled=true，timer unref、失败只记日志）+ deployToRegistry 尾部接线（含 `reassuranceDelays` 测试缝）。验证：伪 fetch 单测 2 条——三档时序（1 即时+2 梯）、失败不抛不阻塞 ✓
- [x] 2.2 回归：`node --test scripts/test-agent-serving.mjs` 34/34（32 既有 + 2 新）✓

## 3. 上线与验收

- [ ] 3.1 随任一平台镜像构建滚动上线（可与 Change A 同滚）；验证：镜像内 `lib/agent-serving.js` 含重探梯
- [ ] 3.2 活链验收：全新部署一个测试 agent（不手动干预），≤5min 窗口内经门面 a2a 调用直接成功、-32033 不复现；记录时间线
- [ ] 3.3 finddata `MCP-REGISTRY.md` §3 销「toggle 探针竞态」挂账行 + closeout 追记；归档（validate → sync 门 → archive）
