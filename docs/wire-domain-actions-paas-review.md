# 壹座侧评审回复：客户域动作的舰队消费（wire-domain-actions 跨线件）

> 对象：fd-wire《壹座/萬星侧需求：客户域动作的舰队消费》（2026-10-29，待评审稿）
> 评审方：paas（壹座/萬星） 日期：2026-10-29 状态：**评审完成，结论如下**
> 本文与原文同构：先总裁决，再逐项给证据与条件；文末列对柏讯侧的具体请求。

## 一、总裁决

| 项 | 裁决 |
|---|---|
| R1 岗位身份注入 | **前提已过时**：身份注入已在产（2026-10-23）。唯一真实缺口 = 回合腿，paas 已立 `add-fleet-identity-turn` 补齐（见 §三） |
| R2 拍板面唯一在柏讯 | **不反对**，且结构上可验证壹座不会长出第二确认面（见 §四） |
| R3 提议不阻塞回合 | **同意**，附一条对偶义务（见 §五） |
| R4 计量与凭据轨 | 知会收讫，零改动 |
| 原文「已核实：不需要 paas 改动」表 | **补两项批次内 paas 侧工作**（见 §六）——不补，柏讯的 pack 发布会撞门 |

## 二、R1：身份注入已于 2026-10-23 在产——原文「至今未落地」请更正

证据链（全部可复核）：

1. **注入点**：`server/cron-runner.js` `runPersonaTurn` 内（现约 :462-468，注释标 `enable-wire-content-fleet D1`）——每个成员回合的 prompt 首部前缀一行
   `【集群岗位身份】fleet=<id>; post=<memberId>; title=<title>; target=<kind>:<id>`。
   注入点选在 cron 节奏回合与 delegation 唤醒回合**共用**的 seam，被动岗同批覆盖；非成员回合（未在岗/归属歧义）逐字不注入，带 ghost-post 守卫。
2. **渲染与归属**：`server/fleet-reports.js:138-170`（`renderFleetIdentity` / `fleetIdentityFor`，复用报数面归属解析，无第二套判定）。
3. **主 spec 已收编**：`openspec/specs/agent-fleet-report-lane/spec.md:96`「舰队成员回合注入岗位身份」，含两条唤醒路径与不注入场景。
4. **生产记录**：台账 `docs/registry-maintenance.md` §15.16（2026-10-23 同车发布+真机验收）。

因此原文 R1 的验收（真实成员回合提议域动作、台账可读岗位三元组）**部署+岗位两腿今天即可兑现**：模型可从 prompt 首行逐字复述。两个澄清：

- **key 名以在产格式为准**：spec 的示例写 `ref=<targetRef>`，实际在产是 `target=<targetKind>:<targetId>`。柏讯侧解析/技能稿请按在产 key 名（`fleet=`/`post=`/`title=`/`target=`），paas 会在本批 change 里把 spec 示例校正成与实现逐字一致。
- **回合腿是真缺口**：`roundChildSessionId`（逐轮轮换、稳定可读）就在注入点同函数内，但身份行没带它——agent 无法自证回合，三元组的第三腿只能编造。paas 已立案：

> **paas change `add-fleet-identity-turn`**（已 scaffold、validate 绿、待实施）：身份行追加 `turn=<该回合实际落地标识>`，两条唤醒路径同批；`renderFleetIdentity` 增可选参数，非成员路径零变化。约两行改动，随下一班列车上产后，`source_ref` 三元组（部署/岗位/回合）可由身份行逐字复述。

原文 R1 验收里「memberId」已有（`post=` 即成员 id）；若柏讯还想要模板岗位 ref，`target=persona:<presetId>` 中的 presetId 即 pack 层稳定岗位名，无需另注。

## 三、R2：不反对「唯一拍板面在柏讯」，且壹座侧可给结构性保证

代码实证（非口头承诺）：壹座动作闸（`lib/action-registry.js`）**只包已注册动作**（现役 10 条 wire 动作 id）；`wire_action_*` 不注册进壹座动作注册表，就不会进壹座确认卡——与现产先例同形（`wire_artifact_dashboard_create` 为 write 风险、未注册、由舰队岗直调，从未触发壹座确认面）。所以「两闸分层、互不越界」核实成立，壹座**不建第二确认面**。

观测面兑现路径（零 paas 代码起步）：

- 驾驶舱回合 trace 的工具块天然呈现 `wire_action_propose` 调用与其 pending 结果（含提议 id）；技能稿让 agent 在报数里回显提议 id 与柏讯控制台深链（新标签页、无会话凭据参数，与 console-ai-entry「去壹座」反向同款纪律）。
- 「已提议 → 待柏讯确认」的**持久徽标**（壹座轮询 `wire_action_status` 刷状态）本期**不做**：下轮巡检读状态即可达意，徽标需要壹座解析工具结果+新增读循环，成本大于收益；柏讯侧若后续有真实需求再单独立案。

一条护栏请柏讯与本仓共同遵守：**wire_action 提议永不镜像进壹座拍板 lane（decision items）**——否则单一拍板面会从后门重新反转成双确认。

## 四、R3：同意，附对偶义务

壹座侧回合收尾机制与「提议即返回 pending」天然相容：工具调用返回即收尾，无任何等待确认的挂点可误触。对偶义务落在柏讯侧：`wire_action_propose` SHALL 即时返回 pending——若未来实现变成阻塞等确认，壹座侧会如实把该回合归因为 stalled/超时（既有归因面，无需新代码），不会静默假绿。这条建议写进 wire-domain-actions 的 spec 场景。

## 五、R4：知会收讫

overlay 写不进行数计量、提议/状态查询走调用方凭据（舰队线池凭据、双凭据归属不变）——壹座计量零改动，同意原文口径。

## 六、原文「已核实」表漏掉的两项 paas 侧工作（须排进同批）

**① registry 工具面快照必须重烘焙，否则新 pack 发不出去。**
`/wire-ops-mcp` 条目的 tool_list 快照现停 13 工具；因该服务 AuthGate 匿名 401，发布门的 live probe 探不到（「unresolved 而非 absent」，台账 §1151/§1616 有实录与 Mongo 直写配方）。柏讯部署三新工具后、fleet-packs 模板把 `wire_action_*` 写进 allowTools 之前，**壹座侧须先按既有配方重烘焙快照（对象数组 + num_tools 同步）**，否则柏讯 pack 发布被拒。建议：柏讯部署完成即通知壹座，同批排程，别等发布日撞门。

**② wire-tool-risk 快照刷新会触发 CI 归账 + 一条标签契约。**
`lib/wire-tool-risk.js` 是从 fd-wire `tool-surface.json` 的 `tool_risk` 生成的 vendored 快照，两处 CI 硬断言写工具全集恰为 16（`scripts/test-wire-tool-risk.mjs`、`scripts/test-official-packs-lint.mjs`）。新工具入快照后：计数断言归账（16→N）；`wire_action_propose` 进入 gated write 全集的连带效果是**声明它的 pack 不再够格当 copilot 聚焦面**（gatedWriteTools 并集），这是期望行为，柏讯勿惊。同时一条契约请求：

> **柏讯三个新工具的 `tool_risk` 标签请复用既有值（write/read/cost），勿单方新增 risk 值**——壹座的 risk→tier 映射测试与 fd-wire 的 RISK_TO_TIER 逐字节对齐，新值会打破对齐并需要跨仓协同改表。预期：`wire_action_list`/`wire_action_status` = read（不入写全集），`wire_action_propose` = write（入全集、不注册壹座动作）。请柏讯在实施前把拟定标签知会壹座。

## 七、对柏讯侧的具体请求（随本回复回执）

1. R1 验收以**在产身份行格式**为准（§二），回合腿等 `add-fleet-identity-turn` 上产后兑现——柏讯侧技能稿/台账解析留好 `turn=` 字段位。
2. `tool_risk` 标签（§六②）实施前知会壹座，避免 CI 归账返工。
3. `wire_action_propose` 即时返回 pending 写进 spec 场景（§四对偶义务）。
4. 部署三新工具后通知壹座重烘焙 registry 快照（§六①），再走 pack 发布。

## 附：壹座侧证据路径

```
server/cron-runner.js                          # runPersonaTurn 身份行装配（enable-wire-content-fleet D1 注释）
server/fleet-reports.js:138-170                # renderFleetIdentity / fleetIdentityFor（ghost-post 守卫）
openspec/specs/agent-fleet-report-lane/spec.md # :96 岗位身份需求（在产主 spec）
docs/registry-maintenance.md §15.16            # 2026-10-23 发布记录+真机验收
openspec/changes/add-fleet-identity-turn/      # 本批复合段 change（validate 绿，待实施）
lib/action-registry.js                         # 壹座动作闸=仅注册动作（R2 结构实证）
lib/publish-tool-gate.js                       # 发布门名字存在性检查（§六①依据）
lib/wire-tool-risk.js + scripts/test-wire-tool-risk.mjs  # vendored 快照与 16 计数断言（§六②依据）
```
