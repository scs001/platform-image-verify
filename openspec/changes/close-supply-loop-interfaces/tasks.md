# close-supply-loop-interfaces Tasks

> 单仓单（架构勘验纠正：写闸真源=paas `gateway/supply-store.js`，非 fd-wanxing——实例状态读源在壹座本地 fleet 库，fd-wanxing 全仓零触碰）。单向铁律贯穿全单。
> 落盘纪律：paas 与 fd-wanxing 分仓提交、点名文件；章程 3.1-3.3 双账在 §4。

## 1. facade 侧（paas/facet gateway/supply-store.js，开关缺省关）

- [ ] 1.1 脊柱 schema：`spine_instances` 表（instance_id 主键 / status / runner_id / source_pack_id / source_pack_version / provenance JSON / expires_at）+ 写闸 `POST /api/supply-store/instances/{upsert|patch|delete}` 路由族（actor/source 审计照 mcp-servers 族同构走既有 writeRoute 闸；`SPINE_INSTANCES_ENABLED` 缺省关）——验证：路由族单测（upsert 幂等/patch 字段级/delete 404 语义）；开关关闭时路由 404
- [ ] 1.2 投影：`GET /api/supply-store/projection` 增 instances 段（含 as_of）——验证：投影单测含 instances 行；无任何读面驱动代码（grep 全 facade 无 instances→运行态调用）

## 2. 壹座侧（paas）

- [ ] 2.1 `lib/supply-instance-report.js`：回报器（读 `localFleetSnapshot`→upsert 载荷组装：instance_id/status/runner/source_pack/provenance/reported_at；fire-and-forget try/catch 全包+失败计数；TTL=24h 随事件续期）——验证：单测（载荷形状/失败不抛/计数递增）
- [ ] 2.2 部署写路径后置 hook：`wanxing-fleet.js` 的 deployments POST/stop/start/remove 成功分支追加回报调用（零行为变更，登记失败不影响响应）——验证：hook 单测（部署成功+写闸 500 → 响应仍 201/200）；grep 部署路径无同步等待登记
- [ ] 2.3 单向铁律全链核证：grep paas+facade 两仓——脊柱登记内容无任何驱动实例运行态的读路径——验证：核证记录落本单（grep 输出引用）

## 3. 收尾

- [ ] 3.1 `openspec validate close-supply-loop-interfaces --strict` 通过（含 spec delta）——验证：exit=0
- [ ] 3.2 提交自查：paas 单仓（gateway+lib+routes+openspec）点名文件提交——验证：无 git add -A、无并行会话文件卷入
- [ ] 3.3 上产与投影实证：facade 开关开启后真实部署一轮 → 脊柱投影 instances 段读到带 provenance 条目——验证：投影 curl 输出留档（实施期做，立单不勾）

## 4. 章程双账（§3.1-3.3）

- [ ] 4.1 章程 3.1 勾选（本单 1.x/2.x 全勾+3.3 实证后）；4.2 章程 3.2 勾选（Q2 裁决记录=D3，W2 `agent-promotion-channel`「v1 fork 范围如实划定」条文为成文基准，promote 回归钉绿）；4.3 章程 3.3 勾选（微信模板挂账=design Q-C，措辞「依赖用户行动」）——验证：charter tasks 对应行勾选并引用本单
