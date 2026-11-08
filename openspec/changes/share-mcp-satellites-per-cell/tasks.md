# Tasks — share-mcp-satellites-per-cell

## 1. 可行性收口（设计期先答，不写代码）

- [x] 1.1 确认 dsh 的 MCP 客户端在 `streamable-http` 下**不会**自动重连/重试导致宿主被反复打爆
      （`@modelcontextprotocol/client` 的 StreamableHTTPClientTransport 行为）；验证 = 读装的那个
      版本的源码 + 一个最小连通实验（宿主停 30s 再起，观察客户端是否自恢复）
- [x] 1.2 确认 13 个卫星里哪些**真的与成员无关**（本期只共享这一档）：逐个核对它启动时读的 env
      是否只含 cell 级值；已知 fd-memory（成员 token）/ library（成员集合）必须排除；
      验证 = 产出「可共享 / 必须保留 per-worker」两栏表，落 design.md
- [x] 1.3 确认 `sessionGatedMcp: ["websearch"]` 的闸在哪一侧：若闸在 dsh 侧（tools/set），
      共享宿主可保留 websearch；若在卫星进程内，则 websearch 需留在 per-worker 档；
      验证 = 代码定位 + 结论写进 design.md

## 2. 宿主（cell 内一份）

- [x] 2.0 范围按可行性结论钉死：只共享 **8 个「只读 cell env」卫星**（fleet/cron/delegation/
      fleet-architect/blueprint-author/pack-author/persona-evolution/skill-evolution）+ bench-proposal；
      `actions` 本期不做（需 `DSH_SESSION_ID` 按请求注入）；library/websearch/fd-memory 留 per-worker。
      收益按此重算 = ≈560Mi 标称 / **≈270Mi 实扣**（不是 proposal 初稿的 450Mi）
- [x] 2.1 cell server 起一份卫星宿主，仅承接该 cell 的 dsh 世代；`TASK_WORKER_MAX=0` 时**不启动**
      （单 dsh 走原路径，形态不变）；验证 = 单测：cap=0 不启动、cap>0 启动一次
- [x] 2.2 宿主以 streamable-http 暴露，dsh 侧以 `url` 条目接入（`toMcpClientEntry` 已支持）；
      验证 = 单测断言生成的 patch 里该条目 `transport: streamable-http` 且无 `command`
- [x] 2.3 宿主生命周期与 cell 同生共死（cell 退出即收），并对自身子进程做退出清理（不留孤儿）；
      验证 = 单测：`stop()` 后 ps 里无残留（已实证）；与 cell 同生共死待 2.1 接线后验证
- [x] 2.4 失败域：宿主挂 → 该 cell MCP 工具降级、其它 cell 不受影响、恢复后自动可用；
      验证 = 故障注入单测（停宿主 → 工具报错且原因明确；重启宿主 → 恢复）
      - 实证：SIGKILL 一个卫星后邻居仍正常出工具；该端点按**声明集**回答
        `satellite "<name>" is not running`（POST 走 200+SSE JSON-RPC error，与真传输失败同形），
        `/healthz` 同步 `up:false`；重启宿主后客户端自恢复（1.1 实测 ~4ms 恢复）

## 3. 成员级覆盖保持原样

- [x] 3.0 **白名单校验**（D4 风险）：断言共享集里的每个卫星其启动 env 不含成员级键
      （TOKEN/SECRET/COLLECTIONS/PROJECT_ID/EMAIL），新增卫星若不遵守会在这里红；
      验证 = 单测遍历共享集合 + `server/*-mcp.js` 的 env 读取，出现成员级键即失败

- [x] 3.1 fd-memory / library 仍走 worker 私有 patch（`writeMemberMcpPatch` 未改）；
      验证 = 既有成员补丁单测全绿 + 新增「共享宿主下成员视图不变」用例
      - 用例断言 `library` 仍 `transport: stdio` 且带 `LIBRARY_COLLECTIONS`，
        `fd-memory` 仍带 `headers.Authorization: Bearer <member token>`
- [x] 3.2 断言共享**没有**把成员视图放宽为账号级；验证 = 两成员跑同一宿主，各自只看到自己的集合
      - 两个 persona（`mo-inventory` / `ops-wx-chief`）在同一宿主下各写一份补丁：
        集合 `col-a,col-b` vs `col-z`、token 各自一份，互不继承

## 4. 观测与验证

- [ ] 4.1 内存面 cell 行暴露卫星进程数与总量；验证 = 单测 + 真机：单 dsh cell 与多 worker cell 可直接对比
- [ ] 4.2 真机收益对照：同一 cell 在 cap=0 / cap=1 两种形态下的 pod 实扣与卫星数；验证 = `kubectl top`
      + /proc 扫描，数字进台账
      - **阻塞（2026-11-08）**：线上 `TASK_WORKER_MAX=0`（被并发会话从 2 改回 0），池关 → 每 cell
        只有一个 dsh → 无重复卫星可省 → 本变更正确地未生效（日志 `worker pool off`）。验证需
        worker-pool 线同意把 cap 设 1 滚一次（方案与观察项已记入台账 §15.138 续廿三（渠））
- [ ] 4.3 出片 + 灰度（先一个开 worker 的 cell）；验证 = `tools/verify-rollout.sh` + 该 cell 回合/工具面走查
- [ ] 4.4 回滚面：`TASK_WORKER_MAX=0` 即回到单 dsh 原形态，无需回滚镜像；验证 = 演练一次
