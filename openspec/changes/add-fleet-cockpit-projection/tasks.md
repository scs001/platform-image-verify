# Tasks: add-fleet-cockpit-projection

- [ ] 1.1 paas `/api/fleets/overview`：owner/admin 全景 compact（50 fleets 硬界；decisions 按需度+临期排序 top3 题面 ≤80字、stream 各岗 latest（at/source/摘要≤120字/槽≤4）；v:1+sampledAt）；复用 deriveMemberStatus/latestReport/decision 排序 helper；非舱主 403
- [ ] 1.2 paas 单测：龚主多舰一往返界内截断/非舱主 403/启用 cell 旭位样例（启用 decision+report 数据复用既有 fixture）
- [ ] 2.1 paas cell-sampler 二路 tick：`FLEET_CELL_FLEETS_SAMPLE_SECS`(默认60)/ENABLE=0 关断；活 cell 每 tick 按上述端点取 overview 发 `cell_fleets`（agent=cell:<email>）；失败 log-only
- [ ] 2.2 paas test-gateway-fleet-cells.mjs 增覆盖：新增品种被发+频剂按 env+fail 只计日志（style 照既有 tick 测试）
- [ ] 3.1 萬星 store：`cell_fleets` 入 EVENT_KINDS；ingest 对该品种 201；未知 kind 仍 400
- [ ] 3.2 萬星读点 `GET /api/fleet/v1/cell-fleets`：raw kind 窗默认 6h 合成每 agent 最新快照；stale（>3×tick）标识；requireToken
- [ ] 3.3 萬星 tests（test-fleet-observer.mjs 增覆盖）：品种入白名单/读点最新性+stale/token 401
- [ ] 4.1 OpsView 镜像段：fetch /api/fleet/v1/cell-fleets 随既有 30s 周期；每舰一卡（health chips/decisions top3/stream 一行/样龄）+深链 paas /fleets/:id；observer 404 或零数据→段隐去；data-testid=fleet-mirror-*
- [ ] 4.2 e2e/stub：OpsView 镜像段 stub 见舰/拍板/stale 态
- [ ] 5.1 出片上纪律：先 wanxing-observer→后 platform→末 facade/web；GitOps 双端+Argo refresh+滚动+imageID 三面检
- [ ] 5.2 生产眼见（ops token）：OpsView 段含「公司式舰队」卡+样龄 <90s+待拍板数与 paas cockpit 一致；解散后 stale 痕迹眼证
- [ ] 5.3 台账 §15 上线记录 + openspec archive + 记忆更新
