# 上游 PR 候选提交计划（词元 fork → Wei-Shaw/sub2api）

> 谱系纪律（ADR-0024 / spec「上游回馈优先」）：普适能力以独立可 cherry-pick 提交
> 推上游 PR，签署上游 CLA.md；上游合入后下一个月度窗退役本地对应补丁
> （fork diff 只许缩小方向的变更无需额外决策）。状态同步登记台账§五。

## 候选① 按 key 自助用量查询端点（对应上游 issue #6421）

**上游现状（2026-10-14 核实）**：issue #6421「[Feature] 提供按 API Key 维度的
用量/费用查询接口(接入方自助对账)」**open**（2026-08-31 最后更新），无关联 PR。
上游已有近邻端点 `GET /v1/sub2api/billing`（`gateway_key_billing.go` KeyBillingInfo，
返回该 key 的倍率/峰谷信息）——本候选=同端点族的用量维度扩展，形状应与之对齐
（`object: sub2api.*` + `schema_version` + `Cache-Control: no-store`）。

**平台侧动机**：ADR-0011 明确「day one 用量面板走 admin API」的欠账；有了自助
端点，平台/部署者/外部调用者可直接对账，不必给 admin key。

**提议形状（PR 时以 issue 讨论为准）**：

```
GET /v1/sub2api/usage?start=<RFC3339>&end=<RFC3339>&group_by=day|model|key
→ 200 {object:"sub2api.key_usage", schema_version:1,
        key:{id, name}, window:{start, end},
        totals:{requests, input_tokens, output_tokens, cost, actual_cost},
        buckets:[{bucket:"2026-10-14", requests, cost, ...}]}
```

- 数据源=既有 `usage_logs` 表按 `api_key_id` 聚合（上游内部已有 admin 用量查询
  可复用其聚合口径，见 `handler/admin/usage*`）；
- 鉴权=同 `/v1/sub2api/billing`（apiKeyAuth 链上、只读自身 key 数据）；
- 分页/窗口上限：与 admin 用量查询同口径（默认近 7 天、上限 31 天，对齐
  `UsageCleanupService` 的 max_range_days）。

**实施计划**：
1. 在 fork 仓从 `upstream/v0.2.16` 拉独立分支 `feat/key-usage-endpoint`（干净
   单提交，不夹带任何 lanes 代码）；
2. 实现+测试（复用 admin usage 聚合函数；契约测试镜像 `gateway_key_billing_test.go`）；
3. 本地/CI 全绿后推 **scs001 fork**（上游非真 fork 关系，PR 走 scs001 前例），
   `gh pr create -R Wei-Shaw/sub2api`，正文引用 issue #6421；
4. **先签 CLA**（上游 CLA.md，首次 PR 前）；PR 保持单提交、描述含动机/形状/兼容性；
5. 合入后：下一个月度窗删除 fork 内任何临时实现、台账§五状态改「已合入退役」。

**状态**：未启动（计划就绪）。**触发时机**：车道 v1 部署窗后（优先让生产先吃到
三车道，PR 是持续动作非门）。

## 候选② 虚拟用量端点（ADR-0014 backlog）

**语义**：让持有 admin 权限的调用方**代调用键写入**一笔用量/费用（「虚拟用量」），
用于外部结算通道（萬星门面 v1 的 adjustBalance 结算）切换为「sub2api 账本为
权威」——门面按（调用者, agent, 请求, 时长）计量后，不再调 adjustBalance 直改
余额，而是记一笔归属调用键的虚拟用量行，让 sub2api 原生账本/面板/窗口/硬顶
全部生效（ADR-0014 ③ 的切换前置）。

**提议形状（草案）**：

```
POST /api/v1/admin/usage/virtual   （admin 鉴权）
{api_key_id, model:"<虚拟模型名>", units:{...}, cost, actual_cost,
 idempotency_key, metadata:{caller, agent, turn_id}}
→ 201 {object:"sub2api.virtual_usage", id, applied:true}
```

- 幂等=必填 `idempotency_key`（门面重试不重复记账）；
- 计入 key 消费窗/余额硬顶/面板（走既有 RecordUsage 落账路径，`request_type`
  标 `virtual` 以与真实上游调用区分）；
- 单位面：v1 用金额（cost）+自由 `units` 描述（供面板标注），不引入新计量单位。

**实施计划**：同候选①流程；**前置**=候选①先合（两者共用 usage 落账口径与
面板展示语义），或至少与上游维护者先对齐语义（issue 先行）。

**状态**：未启动（计划就绪，等候选①）。**平台侧依赖**：ADR-0014 结算切账本
权威、ADR-0022 分成通道对账。

## 通用纪律（两候选共用）

- **单提交、cherry-pickable**：分支从 `upstream/v0.2.16` 起，不含 lanes/平台清单
  等 fork 专属内容；
- **CLA 先行**：上游 CLA.md 签署一次，覆盖后续 PR；
- **不夹带**：PR 内不引用词元内部文档；动机用普适语言（上游视角的用户价值）；
- **退役登记**：合入→月度窗删除本地对应实现→台账§五+§一备注；
- **候选新增**：fork 内发现普适能力（如三车道沉淀的通用错误面/多上游池形态）
  随时追加到本文件与台账§五。
