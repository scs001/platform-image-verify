# Tasks: add-runner-fleet-sharding

## 1. runner 过滤

- [x] 1.1 `agent-runner/config.js`：`defaultRunnerId`（env `AGENT_RUNNER_DEFAULT_ID`，缺省=`fleetRunnerId`）。验证：单测三档（显式/回退自身/字面缺省）。
- [x] 1.2 `agent-runner/registry.js`：`createRegistryClient` 增 `runnerId/defaultRunnerId`，`listServedAgents` 过滤 `(metadata.runner_id ?? defaultRunnerId) === runnerId`。验证：单测——未标注归默认 runner、标注 runner-b 归 runner-b、其余互不侵。
- [x] 1.3 `agent-runner/index.js`：把两个 id 接进 registry client。验证：既有 runner 套件全绿（fake 条目无 runner_id=归自身，行为不变）。

## 2. 部署侧

- [x] 2.1 `lib/agent-serving.js` `deployToRegistry`：opts 增 `runnerId/runnerPortBase/runnerPortSpan`；descriptor 打 `runner_id`、URL 用 `agentPortFor(path, {base, span})`；未传=现状逐字节不变。验证：既有 serving 测试全绿+新增分片端口/打标断言。
- [x] 2.2 `gateway/packs.js`：`agent_runners` 表+访问器+boot 种子（表空且 env 在→插 cheap-1 行）；deploy 路由 body 可选 `runnerId`（命中行→新 URL/打标；表空回退 env）。验证：路由测试——默认字节等价、指定 runner-b、未知 runnerId 400。
- [x] 2.3 `gateway/packs.js`：`GET /api/packs/internal/runners`（registry token 门）。验证：路由测试——凭据门+行形状。

## 3. 第二台 runner

- [ ] 3.1 节点余量核查（≥2.5G），fd-infra-deploy 新 `agent-runner-b`（hostNetwork、8851/32、FLEET_ID=runner-b、mem 2G、env Secret 平移 cheap-1 runner env）。
- [ ] 3.2 上线后 board `runners` 出现 `runner-b`（心跳/预算字段真实）。

## 4. 实证与收口

- [x] 4.1 全量测试门：runner+serving+packs 相关套件绿。
- [ ] 4.2 跨机协同实证：一个 agent 部署到 runner-b（board 双 runner）；经 facade 真回合调通 runner-b 的 agent；cheap-1 的 planner 可发现/调用它（协同跨机不变式）。**PROBE PASS**。
- [ ] 4.3 归档+路线图「已定决策」表补记（2026-10-11 用户拍板：多机部署+协同=蓝图硬前提）。
