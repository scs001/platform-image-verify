# Tasks — slim-unit-suite-runtime

## 1. 量（本单的唯一动作）

- [x] 1.1 测出 unit 步骤的绝对耗时与停摆形态
  - 实证：run 42630983629 的 Unit 一步 **63 分钟**；`--test-timeout=180000` 已生效
    （核过该 ref 的 package.json），故非单条悬挂而是累加
- [x] 1.2 定位成本分布
  - 实证：489 个 `scripts/test-*.mjs` 里 **58 个**含 `spawnTestServer` /
    `initTaskEngine` / `attachAgentSession`
- [x] 1.3 排除错误解法：`--test-shard`
  - 实证：四文件 TAP 复测，shard 1/2 同时含 browser-lane-artifacts 与 queue-health 的用例
    → 切的是用例列表不是文件列表；已入闸 `test-unit-shard-safety.mjs`
- [x] 1.4 备好量尺 `scripts/profile-unit.mjs`（白名单自动挑 spawn 重的文件；拒绝在无依赖/
      软链依赖的树上跑，因为那会把 sqlite 锁问题伪装成产品红）

- [x] 1.5 实测「慢」已经变成**队列积压**（本单因此从"优化"升为"门禁吞吐上限"）
  - 实证：镜像仓快照 `6f963a019` 的 CI 于 14:46:55Z 起跑、>60 分钟未完成；更新的
    `ffc8168b0` 已 queue 在其后。concurrency=QUEUED + 推送间隔 10–30 分钟 ⇒ 队列只增不减

## 2. 止损（已完成，不属本单）

- [x] 2.1 作业上限 90 → 120 分钟（`a4f162950`）
- [x] 2.2 每用例 180 秒上限（`153631f3e`）

## 3. 后续（未做，等有榜单后再定）

- [ ] 3.1 在真实依赖的主树跑 `profile-unit.mjs`，落一份 per-file 耗时榜单
- [ ] 3.2 按榜单处理最慢的几个：简化 boot / 共享 server fixture / 独立车道
- [ ] 3.3 若最终要分片：按文件列表切 + 「已执行文件并集 == 全集」断言
