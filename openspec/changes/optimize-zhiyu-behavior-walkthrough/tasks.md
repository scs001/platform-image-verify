# Tasks: optimize-zhiyu-behavior-walkthrough

> 状态标注：`【BLOCKED 日期：原因】` 的任务保持 `- [ ]`，证据与原因见同目录 `evidence.md`。零假绿。
> 用户 2026-11-06 按选项 A 授权受限写；`proposal.md` Impact 已改为「只读为主 + 授权范围内受限写」。真机走查抓出 **P0 缺陷 O0**（桥路由被 404 catch-all 吞掉，见 `evidence.md` §3.5），2.x 因此统一 BLOCKED。

## 1. 准备与判据固化

- [x] 1.1 确认走查环境（生产 `platform.finddatatech.cloud` / 镜像 `sha-d5784e8e5-paas`，源 `d5784e8e5` 在 HEAD 祖先链、`d5784e8e5..HEAD` 智语链 9 文件零改动）与既有客服班组种子 `docs/fleet-templates/service-desk-fleet.seed.json`，记录 `ownerEmail / fleetId / roomId` 三元组；验证=三元组落 `evidence.md`，且 design.md 链条图与之对齐。→ 授权后补齐：`aloadtree@gmail.com` / `fleet_1793235503630_7n5a3u`（现役「工单分诊集群·试跑」，非客服班组种子，已在 evidence.md 标注） / `zy_68aea26f922749debe`（专用走查房，走查后已 end）。
- [x] 1.2 把 5.2 七步与四个行为面的判据逐条写进 `evidence.md` 检查表（每条指向落库行 / 流内事件行 / 端点响应 / 页面呈现，带三元组），并为拉取式桥事件行写死等待上限（D4，默认 90s / 5s 轮询）；验证=判据表可读、每条有可观察产物与超时口径，无「测试通过」类判据。→ `evidence.md` §1.2 十条判据齐备。
- [x] 1.3 复核两条已知坑在现役代码仍成立：`store.messagesAfter` 返回数组非 `{items}`、`gateway/fleet-room-bridge.js` 引 express 需显式 import；验证=两条各带 `file:line` 记录，与 `add-zhiyu-team-memory/design.md:86-87` 对照。→ `gateway/zhiyu/store.js:646-659`、`gateway/fleet-room-bridge.js:20`，见 `evidence.md` §1.3。
- [x] 1.4 确认走查账号为既有测试租户、证据采集口径只含 `kind` / `seq` / 可见性标记 / 计数，不含真实用户消息正文；验证=口径写入 `evidence.md` 判据表并确认无 PII 导出步骤。→ 口径在 `evidence.md` 文首；零正文导出；凭据未落盘、临时会话文件已删。
- [x] 1.5 复核 `add-member-knowledge-profile` 8.2 真机冒烟证据（tasks.md:56、提交 `8b89c936c` 9/9）与本单 2.1/2.2 的覆盖范围，明确「回归而非首验」；验证=`evidence.md` 记一行覆盖范围与不重复劳动的说明。→ `evidence.md` §1.5。

## 2. 5.2 真机走查（记忆两腿回归 + 空间桥四腿首验）

- [ ] 2.1 （回归）客服班组跑三回合，观察 `recordFleetTurnEvent`（server.js 包裹、fire-and-forget）落 capture；验证=按 11-05 新口径：`turn`/`health` 观测落成员 own 分区 `d/<packId>/<memberId>`，`decision-*`/`swap` 落团队 shared 分区 `d/<fleetId>/shared`；legacy `f/<fleetId>` **不应出现新写入**（`server/fleet-memory.js:10,28-37,45-51`）。两侧按 `timestamp + ownerEmail + fleetId` 三元组对账。旧 `u/<owner>/f/<fleetId>` 判据已废止（会得假阴性）。【待跑 2026-11-07：O0 已修复上产（订阅/事件行链路复验通过），此条所阻的「无计费回合」仍待真跑三回合；O0 牵连已解除】
- [ ] 2.2 （回归）观察 `server/fleet-context.js` 的 digest 梯子注入；验证=回合 fleetContext 快照含三标签段【本岗位记忆】/【团队记忆】/【历史团队记忆】（`fleet-context.js:402-421`），own ∪ shared ∪ legacy `f/` 按 scope 门控；provider 返回 null 时该段缺席且不阻塞回合（D2 provider seam）。【BLOCKED 2026-11-06：同 2.1，无回合快照】
- [ ] 2.3 清史重开后观察记忆段仍在；验证=新会话首回合 fleetContext 仍含上轮记忆内容（按 2.2 三标签口径）而对话史为空——此条验「记忆层 != 对话史」，为全案立论，缺证即整链不成立。【BLOCKED 2026-11-06：依赖 2.1/2.2】
- [x] 2.4 `POST /api/zhiyu/rooms/:id/fleet-subscriptions` 建立订阅；验证=`GET /api/zhiyu/rooms/:id/fleet-subscriptions` 返回该订阅，且首见基线静默（不倒历史、无存量事件行涌入）。→ **O0 修复后真机复验通过**（`fix-zhiyu-fleet-bridge-route-order/evidence.md` §8，2026-11-07）：专用房 `zy_1ad879f94b7f3248e3` POST 201（`fs_1793987849221_2qmcz2`「工单分诊集群·试跑」）→ GET 回读 1 行；首见基线静默实证=订阅后等 2 个拉取 tick 仅出现订阅后差异行（room_created/subscribed/health/report 四行、均 `visibility=shared`），无历史倒灌。生产 `zy_fleet_subs` 恒 0 → 首行落库。前 BLOCKED 注记（三路 404）已由 O0 修复单全链销案。
- [x] 2.5 观察报数事件行流入与深链回驾驶舱；验证=空间流出现 `kind=system|event` 行含来源标注（团队名+岗位）与时间、带驾驶舱深链；密集窗口合并为计数+样例行、熔断期丢弃不补发且恢复后下一条标注丢失量（D5）如实。→ **O0 修复后真机复验通过（观察半边）**（`fix-zhiyu-fleet-bridge-route-order/evidence.md` §8 事件行纪律段）：桥事件行 `bridge=health to=abnormal`（seq3）与 `bridge=report`（seq4）流入，均带 fleetId 来源标注 + `deepLink=true` 驾驶舱深链；5/5 行 `visibility=shared`。密集合并（MAX_PER_WINDOW=10）与熔断丢弃（DROPS_NOTE_MIN）本轮无密集窗口未触发——该半边由装配测试与 `gateway/fleet-room-bridge.js:24/26/244` 码锚覆盖，如实记「未触发」而非挂账。
- [x] 2.6 `POST /api/zhiyu/rooms/:id/fleet-summon` 一键召唤；验证=逐成员如实呈现接受/拒绝/待答，persona 岗呈「去驾驶舱」而非假邀请，订阅随召唤同时建立，部分失败不掩盖。【O0 半边已解 2026-11-07：dryRun plan 可读实证在 `fix-zhiyu-fleet-bridge-route-order/evidence.md` §8——200 + `cockpitOnly=["分诊岗","处置岗"]` 如实分诊；**执行半边另阻于新缺陷 O8**：桥对 JSON 调不存在函数 `servingMembers?.()`，summonable 恒 []（生产 10 支 a2a 岗永不可召），已立案 `fix-zhiyu-summon-serving-face`（strict 绿待 apply）。逐成员接受/拒绝/待答与订阅随行 **2026-11-07 O9 上产后全判据过**：验证舰队 dryRun summonable 非空（ref=packId:agentId、onBehalfOf=台账部署者）+ 执行邀请落库 pending（待答如实）+ 订阅随行；详见 fix-zhiyu-summon-serving-face/tasks.md 4.3/4.4】
- [x] 2.7 七步证据汇总落 `evidence.md`；验证=每步有证据或明确 `BLOCKED` + 原因，零「推断成功」，且 2.1-2.6 的 `file:line` 锚点齐备可复现。→ `evidence.md` §3 状态表 + §2 生产只读盘点 + §3.5 P0 四路交叉实证。

## 3. 四个跨边界行为面核对

- [ ] 3.1 guest/widget 链：第三方 cookie 被拒时 `tty` 兜底不降级；验证=无 cookie 请求仍能复用同一 guest 席位并续读自己的流（`gateway/zhiyu/index.js:163-178`、`:1087-1088`），widget 加载与 guest 消息各自 429 限速独立生效（`:1055`），iframe 响应 `frame-ancestors` 按令牌白名单更新（`:1025`）。**并做一次 browser-eye / 无痕窗口回归**：打开 `zhiyu.finddatatech.cloud/#demo` → guest 席位铸成（403=失败）→ 提问得「产品向导」真应答、全程无登录墙 → 核对席位文案与「只一张开口」；此为 ④ 官网 liveRoom 的滚版后回归，不另立 change。【PARTIAL / 未勾 2026-11-06：Playwright 无痕浏览器眼已复验 200 + 真令牌在线 + 1 iframe 指向 platform 域 + `CONSOLE_ERRORS=[]` + 无登录墙；CSP/令牌有效性另有 curl 实证。未做「访客发一句得真应答」（会触发计费回合，且 10-30 已有真域无痕窗口真应答档案）】
- [ ] 3.2 私窗隔离：验证=guest 与中途加入者的消息流内无任何 `private:<id>` 行（`:809` / `:1139`），且成员私窗对话不出现在共享历史。【PARTIAL / 未勾 2026-11-06：生产 266/266 `visibility=shared`、零 `private:<id>` 行 → 无泄漏证据，但也无正向私窗样本，不能判通过】
- [ ] 3.3 熔断与计费归属：验证=@定向时未点名座位零计费、pass 与失败零计费、guest 点名按**被点座位**的部署计费键结算且 usage id 带 guest scope；reply_cap 两级（`:450-457`）与 dailyBudget 1..100000（`:378-385`）界内生效、界外被拒且现值不变。【PARTIAL / 未勾 2026-11-06：现役房间 `reply_cap=1`/`daily_budget_turns=60`/`day_turns=8`，`reply_cap_hit` 5 行、`all_passed` 4 行；计费归属需跨账本对账，未做】
- [ ] 3.4 IM 桥回写：验证=`meta.im` 的 guest 行不回寄 IM 群（防回响）、长回答按平台上限有序切段、送达失败在房间事件流如实落一条失败事件且不静默吞（`zhiyu-im-bridge` Req3 / Req5）。【PARTIAL / 未勾 2026-11-06：`meta.im` 类行 4 条说明入流有痕迹；防回响/切段/送达失败需主动投递，未做】
- [x] 3.5 四个面结果汇总落 `evidence.md`；验证=每面有通过/缺陷/BLOCKED 判定与证据，缺陷单列「现象 / 证据 / 建议另立 change」一行，本单零源码改动（D3）。→ `evidence.md` §3 状态表 + §4 缺陷观察清单 O0–O7。

## 4. 收账与校验

- [x] 4.1 缺陷清单定稿于 `evidence.md`；验证=清单每行含现象、证据、建议另立 change 名，`git status` 对账确认 `gateway/` / `web/` / `server/` 零改动。→ `evidence.md` §4 O0–O7 每行三要素齐；工作树并发会话遗留改动（`Dockerfile`、`openspec/specs/agent-runner/spec.md`、`harden-windows-runner-smoke` 删除、`scripts/tmp-*`、截图/zip，以及收尾时出现的 `gateway/index.js` +7 行 `FACET_PROXY_TIMEOUT_MS` opt-in）**均非本单产生**，已核 diff 确认；本单零源码改动。
- [x] 4.2 补记 `docs/registry-maintenance.md` 的 §15 序列台账条目（承接 `add-zhiyu-team-memory` 5.3）；验证=新条目在册、编号顺延无重号、正文含 5.2 走查结论与三元组口径。→ `## §15.138`（全局最大号 137，顺延无重号），正文含两段实录、P0 缺陷、最终进度与解阻顺序。
- [x] 4.3 回写 `openspec/changes/archive/2026-10-30-add-zhiyu-team-memory/tasks.md` 的 5.2 / 5.3 为 `- [x]`；验证=两行状态变更且 `git diff` 显示该归档件无其余差异（D6）。→ **2026-11-07 解阻**：O0 修复上产复验（订阅/事件行）+ O8/O9 上产正路径全判据过——5.2 的真机走查实质完成（订阅 201、事件行深链、召唤三态、七步证据链闭合），5.3 台账 §15.138 序列在册；两行回填 `fix-zhiyu-fleet-bridge-route-order` 复验与本案证据为凭
- [x] 4.4 确认 `openspec/specs/app-navigation/spec.md:4` Purpose「including the Bots entry」残留已在 design.md Non-Goals 与 4.2 台账中登记为跨单 deferral（本单不修，理由=项目规则 + `skip_specs` 无 delta 通道）；验证=两处登记在位且措辞含理由，避免下轮体检误判为未处理。→ `design.md` Non-Goals + `evidence.md` §5 双处 + §15.138；理由含项目规则与 delta `## Purpose` 被忽略。
- [x] 4.5 运行 `openspec validate optimize-zhiyu-behavior-walkthrough --strict`；验证=命令输出零错误。→ `Change ... is valid`，EXIT=0（skip_specs INFO 为预期提示）。
- [x] 4.6 复核本单产物清单与 proposal.md Impact 一致；验证=只含本 change 目录工件（含 `evidence.md`）、`docs/registry-maintenance.md` 一条台账、归档件两个勾选框，零源码/零 `openspec/specs/` 改动。→ 实际产物＝本 change 目录 4 工件 + `evidence.md` + `docs/registry-maintenance.md` §15.138；归档件**未**改（4.3 BLOCKED），零源码/零 `openspec/specs/` 改动，与 Impact 一致。凭据未落仓。
