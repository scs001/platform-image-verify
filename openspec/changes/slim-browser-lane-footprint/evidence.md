# 证据台账 — slim-browser-lane-footprint

本文件记录任务 3.3 / 4.1 / 4.2 / 4.3 的实测证据与 5.x 的发布路径。数字均为实跑，
不是估计。

## 1. 改造前基线（4.3 前半，2026-11-08，fd-prod）

`kubectl -n fd-prod top pod`：`platform-59c57b8575-kqt2p  430m  1776Mi`
（同期 `platform-demo` 548Mi，另一个 pod，未计入）。

pod 内 `/proc` 扫描（同一套归组规则，只读）：

```
TOTAL RSS MiB: 3523 procs: 37
(no-cell)           2317Mi procs=31 browser=2  browser-mcp.js:50Mi,browser-mcp.js:48Mi
1da519d4c1c0bf89     632Mi procs= 3 browser=1  cli.js:127Mi
3fdc7b8e8ac03b68     573Mi procs= 3 browser=1  cli.js:109Mi
```

- **chromium / headless_shell 进程数 = 0**：浏览器车道此刻完全闲置。
- 闲置成本 = `browser-mcp.js` ×2（98Mi）+ `@playwright/mcp/cli.js` ×2（236Mi）= **约 334Mi**。
- RSS 合计 3523Mi 与 cgroup 1776Mi 的差是共享页重复计（既有已知口径，非本次问题）。
- 注：两个 `browser-mcp.js` 因 cwd 无 cell 线索落在 `(no-cell)` 桶（正是本变更要消除的
  「无归属的每 cell 复制品」形态）。

**改造后对照（4.3 后半）尚缺**：需先出片并上产（见 §3），届时用同样的两条命令复测：
预期 platform pod ≤2.5GB（`kubectl top`），cell 进程表内不再出现 `browser-mcp.js` /
`playwright cli.js`，而 `browser-lane` 桶转为 1 份 `browser-lane-service.js` + 1 份
`cli.js`。

## 2. 真机冒烟（3.3 / 4.1 / 4.2）

`node scripts/smoke-browser-lane-shared.mjs`，本机 macOS + 钉版
`@playwright/mcp@0.0.80`（临时装在 `/tmp/browser-mcp-pin`）+ 本机 chromium-1228：

```
smoke-browser-lane-shared: ok — 24 tools, navigated about:blank,
artifact routed into cell 0123456789abcdef (2 file(s)),
sessions 0123456789abcdef / fedcba9876543210 isolated;
navigate reply: ### Ran Playwright code ... Page URL: about:blank
EXIT=0
```

覆盖到的断言：
- 真实 chromium 导航（`about:blank`，不需要外网，但需要可用的 chromium + 系统库）；
- `browser_take_screenshot` 落在 `<CELL_DATA_ROOT>/<cellId>/workspace/browser/`（具名 1 份
  + 未命名 1 份由清扫归位，共 2 份）；
- 第二个 cell 的截图落在自己目录，两边互不出现（4.2）；
- 回环 cookie 页：cell A 登录写入 `lane_cell=AAA`，cell B 在**同一进程**上看不到该 cookie（4.1）；
- cell A 会话关闭后新会话再访问，同样看不到旧 cookie —— 会话结束不残留（4.1）；
- 全程仅 1 个 `cli.js` 进程（1.2 哨兵的另一侧证据）。

## 3. 实测发现的三个部署事实（已写进 DEPLOY.md）

1. 钉版 0.0.80 的 `--port` 同时暴露 `/mcp`（streamable-http）与 `/sse`（legacy SSE）：
   design D2 的「只有 SSE」前提对这支钉版不成立。前端仍必要（身份/产物/守护是我们
   的职责），当前按设计走 SSE；日后可把上游这段换成 `/mcp`，属简化非行为变更。
2. `--host 127.0.0.1` 必须配 `--allowed-hosts 127.0.0.1:<port>`：CLI 的主机头校验按
   `host:port` 精确比对，缺端口条目会对**自己的** SSE 连接返回 403。
3. 必须 `--allow-unrestricted-file-access`：CLI 把写盘沙箱在 cwd，而共享服务没有单一
   workspace（产物要写进各自的 cell 目录）。模型的越权面仍被前端收窄：输出文件名一律
   降为 basename 并锁进调用方 cell 的产物目录。

## 4. 单测矩阵（`npm run test:unit` 自动纳入）

| 文件 | 覆盖 | 结果 |
|---|---|---|
| `scripts/test-browser-lane-service.mjs` | 1.1 / 1.3 / 1.4 / 1.5 / 4.2 | 9/9 |
| `scripts/test-browser-lane-supervisor.mjs` | 1.2 / 2.4（进程表、EADDRINUSE 收尸、argv 哨兵） | 4/4 |
| `scripts/test-browser-lane-gate.mjs` | 2.1 / 2.2 / 2.3 / 2.4（含无共享端点的逐字段 golden） | 11/11 |
| `scripts/test-browser-lane-manifest.mjs` | 3.1 / 3.2 | 7/7 |
| 既有 `test-proc-memory.mjs` / `test-memory-face.mjs` / `test-cell-wake-admission.mjs` / `test/cell-memory.test.mjs` | 回归（新增 `browser-lane` 桶） | 37/37 |
| `web` `tsc --noEmit`、`check:locales` | 前端类型与五语键 | 干净 |

## 5. 待决与发布路径

- **待裁**：tasks 1.2 的 `--isolated` 与 `browser-use` delta 场景「同一 cell 的登录态跨
  会话保持」互斥。当前按任务实现（隔离优先）。两条路：①承认「同一会话内持久」，删该场景；
  ②给每 cell 持久 profile 目录。
- **发布路径（5.1 / 5.2）**：出片（含本变更的镜像）→ 在 `fd-infra-deploy` GitOps 加
  `browser-lane` 容器与两个 env（`BROWSER_SHARED_MCP_URL` /
  `BROWSER_SHARED_OUTPUT_ROOT`）→ 先只给一个测试 cell 的 patch 打开 → 走查工具面 /
  产物 / 降级三项 → 全量 → 复测 §1 的两条命令 → 回滚演练（删 env + 停 sidecar）。
  生产清单不在本仓，本仓 `k8s/deployment.yaml` 只是设计权威版。
