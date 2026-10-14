# unify-wanxing-management-plane — 任务清单

## 1. cell 侧：stats 快照 + HTTP 车道

- [ ] 1.1 `task-engine.js`：`stats({now})` 派生——`{jobs, executions:{running,queued},
       workers, recent:{done,failed,interrupted}, agentBusy}`；纯计数、无 prompt；
       worker 池占用经注入的 provider 取（不硬连 server 层）
- [ ] 1.2 `server/worker-slots.js`：只读 `poolStats()` → `{cap, busy, idle}`（不带 persona）
- [ ] 1.3 `server/routes/tasks.js`（或既有任务路由挂点）：`GET /api/tasks/stats`——
       标准 cell 鉴权（**非** loopback 豁免），答 stats JSON
- [ ] 1.4 单测：stats 形状（在跑/排队/worker 占用）；**无用户内容**（prompt 子串不得出现
       于序列化）；stats() 无副作用（重复调用结果一致、不打断队列）

## 2. gateway 侧：代采上报器

- [ ] 2.1 `gateway/fleet-cells.js`：`createCellFleetReporter({cells, fetchImpl, env, log})`——
       env 缺任一（URL/TOKEN）不启动；tick 串行遍历 cells、2s 采样超时、批量 POST ingest
       （ULID id、source `cell-sampler`、agent `cell:<userId>`、kind `cell_stats`）；失败
       log-only 丢批；timer unref
- [ ] 2.2 `gateway/index.js` 接线：spawner cells Map + env 装配（默认全关=零变化）
- [ ] 2.3 单测：未配置不跑不发包；两 cell 各得上报一条（身份/形状断言）；一 cell 采样
       失败不影响其余；ingest 500 丢批不抛

## 3. runner 侧：心跳密度自报

- [ ] 3.1 `agent-runner/fleet.js`：runner_stats payload 增 `pod`（config.podMode）；
       harness-adapter 既有测试同步
- [ ] 3.2 单测：payload 含 pod 布尔；旧形状（无 pod）消费侧读作 solo 的降级断言
       （在既有 board/门测试上补）

## 4. 姊妹仓 fd-wanxing（独立 change `add-fleet-cell-views`，本节只交叉引用）

- [ ] 4.1 fd-wanxing change 立项+实施：observer EVENT_KINDS 收 `cell_stats`、board 增
       `cells` 段 + `cells_total`；console 统一视图（cells 表与 runners 并排）
- [ ] 4.2 发布线滚产（该仓自有管线）

## 5. 出片与生产实证

- [ ] 5.1 `fd-build-channel` 判路 → 快照出片（GHA→hkccr→relay→ccr 链路纪律）→
       fd-prod 平台容器 + agent-runner-serving 两滚动位滚产
- [ ] 5.2 生产眼见：board `runners[].pod` 字段出现（serving runner=false）；fd-prod 配
       FLEET_INGEST_URL/TOKEN 后 board `cells` 段有真 cell 遥测（jobs/executions/workers
       计数对得上 cell 内 /api/tasks/stats）；console 统一视图渲染
- [ ] 5.3 零回归：cell 流量、runner 部署/回合、既有 board 段全部不伤
- [ ] 5.4 台账（docs/registry-maintenance.md §9）+ 底稿切片⑤完结注记 + 记忆落盘

## 追记

（实施中回填）
