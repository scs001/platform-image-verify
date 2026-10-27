# add-fleet-owner-surface · tasks

## 1. 模板参数槽契约（agent-fleet-templates delta）

- [ ] 1.1 `manifest.fleet.params` 可选段 schema（槽名/类型/默认值/必填）+ 校验器（`server/fleet-template.js`）；非法槽如实拒的单测
- [ ] 1.2 实例化器按槽消费入参（`server/fleet-provisioner.js`），未填槽走默认、必填缺失 422 分类；单测覆盖
- [ ] 1.3 官方种子模板补参数槽（守恒纪律：只加槽不改岗位语义）；种子回归脚本全绿

## 2. 装作路径

- [ ] 2.1 参数向导组件（按槽 schema 生成表单，必填拦挡）+ 市场模板卡「装作」入口（复用详情 action bar 模式）
- [ ] 2.2 `from-template` 接参接线 + 点燃（生而不在跑→start）链路；e2e：市场卡→向导→实化→点燃→总览坞可见
- [ ] 2.3 装作链失败分类（实化冲突/权限/配额）如实呈现；负面 e2e 断言无静默吞错

## 3. 总览坞与经营读数

- [ ] 3.1 owner 聚合端点（集群行+状态聚合+未决拍板/failing 计数），仅自有组织可见；与单集群 cockpit 读数一致性测试
- [ ] 3.2 坞面视图（FleetsPage 族内）：清单+状态+告警入口直达；口径遵循叙事层诚实文案（无绝对化承诺词）
- [ ] 3.3 经营读数面：KPI 槽位行（复用 `buildLatestView`）+ 拍板队列与动作（复用决策车道）整合进坞；missing 如实呈现

## 4. 跨机占位

- [ ] 4.1 注册名录×采样差集占位投影（gateway `fleet-cells.js` 扩展）：休眠 cell 显式「休眠中」+最近应答时间
- [ ] 4.2 占位不计异常、不影响聚合状态的断言测试；cell-lifecycle 名录落地后切源平移（任务挂外部依赖标记）

## 5. 花销视图

- [ ] 5.1 token 事实投影聚合（`fleet_runs`/`member_turn_events` usage，缺失如实）
- [ ] 5.2 金额对账周期任务：部署 key 余额快照差按集群归属；口径标注+最近对账时间呈现；fake sub2api 测试
- [ ] 5.3 市场行并入：消费侧成交记读面（依赖 `add-market-revenue-share` 落表，任务标依赖）；三类读数同屏不混加

## 6. 收尾

- [ ] 6.1 `openspec validate add-fleet-owner-surface --strict` 全绿
- [ ] 6.2 PCA 全真旅程验收（普通客户试驾账）：市场选模板→向导→点燃→坞见在跑→次日 KPI 行→拍板动作留审计→花销三读数，步步无死链、失败如实分类
