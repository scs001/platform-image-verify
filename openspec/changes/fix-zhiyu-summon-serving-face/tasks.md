# Tasks: fix-zhiyu-summon-serving-face

## 1. cell 侧：formation.members 补 serving 面

- [ ] 1.1 `server/routes/fleets.js` overview：formation.members 对 a2a 岗补 `targetId` 与 `servingPath`（从 entry.url 解析 `${REGISTRY_URL}/agent<path>/` 形态取 path；非该形态 → null）；非 a2a 岗两字段为 null，键仍输出（消费方免判存在性）
- [ ] 1.2 解析为纯函数并单测：url 形态命中/未命中/非字符串三分支（若有既有 fleets 路由测试文件则并入，否则独立小测试）

## 2. gateway 侧：桥的 summon plan 换真源

- [ ] 2.1 `gateway/index.js`：`registerFleetRoomBridge` 装配新增 `servingDeployments` 窄缝（packs internal deployments 拉取，凭据与超时纪律同 agent-lane；失败返 null）
- [ ] 2.2 `gateway/fleet-room-bridge.js`：删除 `.servingMembers?.()` 寻址；按 D2 重写 serving 候选→对齐→summonable（ref/onBehalfOf）；rows null → 诚实降级空；执行段（invite 循环/订阅随行/部分失败）零改动
- [ ] 2.3 biome/typecheck 过（触碰文件单独跑）

## 3. 测试补正路径

- [ ] 3.1 `scripts/test-fleet-room-bridge.mjs`：summon 用例扩为正路径（dryRun plan.summonable 非空逐成员带 ref+title+onBehalfOf；非 dryRun 走 store.inviteCreate 断言）+ 排除态（无对齐行/servingPath null）+ 降级态（null rows，保留现断言）
- [ ] 3.2 `scripts/test-zhiyu-route-assembly.mjs`：生产序装配 + servingDeployments stub 正路径一条（dryRun 200 且 summonable 非空）
- [ ] 3.3 全量 zhiyu 套件回归（13 套件）绿

## 4. 出片与真机

- [ ] 4.1 提交（只 add 本单文件）+ 双推 + 公开免费线快照闸出片（force-push 后恢复镜像 workflows）
- [ ] 4.2 relay → ccr skopeo 硬门 → GitOps 双清单 bump → ArgoCD 滚版 → 双 pod imageID 核对
- [ ] 4.3 真机复验：对含现役 a2a 岗的团队（如万星机群席）dryRun → plan.summonable 非空且 ref=`packId:agentId`；外部地址/无对齐行岗如实排除；persona 岗 cockpitOnly 不变
- [ ] 4.4 执行级召唤一次（至多一队）：invites 按策略发起、逐成员结果如实、订阅随行；复验后清理测试房间

## 5. 收口

- [ ] 5.1 走查单 O8 记录解除 + `optimize-zhiyu-behavior-walkthrough` 2.6 执行半边注记刷新
- [ ] 5.2 `openspec validate --strict` → 归档入 specs
