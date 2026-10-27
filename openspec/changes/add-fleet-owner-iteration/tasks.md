# add-fleet-owner-iteration · tasks

## 1. 配置改动提议型拍板项（agent-fleet-decision-lane delta）

- [ ] 1.1 `decision_items` 类型扩展：config-change 类型+diff 附件（detail JSON）+批准回调注册表；既有拍板项回归全绿
- [ ] 1.2 提议入口：经营面对配置改动生成 dry-run diff（复用 `fleet-architect.js`）并入队；「批准前零生效」断言测试
- [ ] 1.3 批准回调触发与失败记录（结论不翻盘、原因呈现、可重试）；注入管线与报数管线互不干扰（既有纪律回归）

## 2. 铸版发版链

- [ ] 2.1 迭代链表（proposed→approved→casting→publishing→published|failed(axis)）与状态读面
- [ ] 2.2 编排器：现役集群 export（白名单字段）→pack-draft→gateway 发布；链首环 validate-only 预检
- [ ] 2.3 失败轴透传与从失败环重试（不整链重跑）；发布门拒绝/校验失败如实分类测试
- [ ] 2.4 vN+1 上架与署名/价格规则同轨（依赖 `add-vendor-supply-open` 署名、`add-market-revenue-share` 价格时取同轨参数，任务标依赖）

## 3. 跟新提示（pack-marketplace delta）

- [ ] 3.1 发版钩子→订阅者账内 unread 提示（版本号+变更摘要），复用 scheduled-task-notifications 语义
- [ ] 3.2 订阅条目「有新版」状态与显式升级动作（既有语义不变）；「提示不升装」断言测试
- [ ] 3.3 现役集群 templateNotice 强化：变更摘要进 banner；不自动迁移断言

## 4. 报数 digest 订阅

- [ ] 4.1 订阅关系小表+REST（fleet×owner×cadence，退订即效）
- [ ] 4.2 jobs 周期产出 digest（KPI 摘要+未决拍板计数+未报名单），复用 `fleet-decisions.js` 渲染；停机补跑走 cron 既有 catchUp
- [ ] 4.3 账内 unread 投递+去抖合并（每集群每档一条）；退订后不再产出测试

## 5. 收尾

- [ ] 5.1 `openspec validate add-fleet-owner-iteration --strict` 全绿
- [ ] 5.2 商业口验收走查：提议配置改动→拍板批准→vN+1 上架→订阅者得账内提示→现役集群零触动→日报 digest 按档送达可退订；每步失败路径如实分类
