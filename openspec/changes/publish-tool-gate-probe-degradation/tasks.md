# Tasks: publish-tool-gate-probe-degradation

## 1. 门的探测失败语义

- [x] 1.1 `lib/publish-tool-gate.js`：探测不可达时输出 unresolved 文案（拒绝 + 「刷新条目快照后再发布」指引），不再断言工具不存在；错误分类（BILLING_UNAVAILABLE / 401-403 未授权 / 网络）留在 lastError 供运维用，不进用户可见校验错误
- [x] 1.2 `probeMcpToolNames` 失败分类：解析 `detail.error` 与状态码，区分计费门与凭据问题
- [x] 1.3 单测：`scripts/test-publish-tool-gate.mjs` 覆盖「探测不可达 → 拒绝 + unresolved 文案 + 不含 does not expose」（10/10 绿）

## 2. 快照刷新运营动作

- [x] 2.1 `scripts/refresh-registry-tool-list.mjs`：读（运行时 tools/list 或 --from-json）→ 写（控制台会话 PATCH tool_list/num_tools，支持 --dry-run）
- [x] 2.2 配方登记进 `docs/registry-maintenance.md`（含「上游要自己的凭据，registry token 不通」与 503 判据）

## 3. 验收

- [ ] 3.1 在能连通上游的主机上跑一次真实刷新（law-bench 或 business-mcp），验证条目 tool_list 与运行时真值一致后，发布门对应名字不再报 unresolved——需具备上游凭据/主机访问，待用户提供或另开会话执行
