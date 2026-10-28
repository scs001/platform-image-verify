## 1. Schema 与策略模型

- [ ] 1.1 decision_items 增列：`route`（owner|deputy）、`resolved_by`（owner|deputy|system）、`resolved_by_model`、`ruling_evidence`、`executed_at`、`executed_session_id`（迁移 + 既有行回填 route=owner）
- [ ] 1.2 委托策略模型：cell 级默认 + 舰队覆写（enabled / routes 类别映射 / maxSeverity / dailyBudget / model / digest 频率）；`config-change`/人事/花费硬编码不可委托
- [ ] 1.3 escalate 入参增可选 `category` 与 `topicKey`（提交方声明的去重主题）；payload 校验扩展
- [ ] 1.4 escalate 同步层：按策略计算 route；归并检查（同 member + 近 7 天相似 → 关联既有项，escalations+1，返回既有引用）
- [ ] 1.5 策略设置面 API（读/写 cell 默认与舰队覆写，高风险类别拒改）

## 2. 常务岗（决策代理）

- [ ] 2.1 常务岗模板（persona 岗位 + 巡逻节奏 + 工具面声明），支持加岗与 opt-in
- [ ] 2.2 deputy MCP 工具：`decision_queue.read`（route=deputy + 来源岗位上下文 + 判例）、`decision_queue.resolve`（approve/reject/escalate-to-owner，服务端强制授权校验）、记忆读写
- [ ] 2.3 服务端强制授权：类别白名单 / maxSeverity / dailyBudget 逐项校验，越权结构化 403 + 条目转 route=owner
- [ ] 2.4 判例读取：主人过往裁决（resolved_by=owner）+ 主人记忆 D7 读缝，作为裁决依据来源；deputy 裁决 SHALL NOT 自身为判例
- [ ] 2.5 巡逻回合产出走报数管线（管理面可见其轮次与产出）

## 3. 去重与问题单分流

- [ ] 3.1 同步归并实现（相似度或 topicKey 匹配；关联计数；不跨岗位）
- [ ] 3.2 常务岗巡逻含存量归并 triage 与问题单跟踪视图（归并后的唯一事项集、最老未决、升级历史）

## 4. 执行追踪与记忆

- [ ] 4.1 送达回合完成钩子回填 executed_at / executed_session_id；outcome 从回合报数/会话派生
- [ ] 4.2 队列与管理面区分「批了没执行」与「已执行」
- [ ] 4.3 裁决镜像扩展到 deputy（resolved_by=deputy 的 reference 镜像）+ 按策略频率的 digest 进主人记忆
- [ ] 4.4 角标口径：等你 N 件 = route=owner 的 open 数；发布时一次性 triage 重路由存量

## 5. 前端

- [ ] 5.1 拍板管理面双视图（等你 / 常务岗）+ 裁决者身份与依据展示 + 收回动作
- [ ] 5.2 设置面：委托策略配置（类别路由/预算/模型/digest）
- [ ] 5.3 常务岗在舰队页的岗位呈现（报告与轮次继承既有面）

## 6. 测试与验收

- [ ] 6.1 决策车道既有合同回归（首裁定局/过期/送达/分段注入/队列防洪）
- [ ] 6.2 新增：策略路由（类别/严重度/预算）、强制授权越权 403、归并（含不误并）、收回、执行回填、判例引用、角标口径
- [ ] 6.3 deputy 提示注入防线：拍板项文本不可驱动 deputy 越权（工具白名单 + 输出 schema 校验）
- [ ] 6.4 真机走查：委托策略生效、常务岗首轮消化存量（66→唯一事项集）、角标下降、记忆可查证
- [ ] 6.5 出片 + GitOps bump + 生产验证