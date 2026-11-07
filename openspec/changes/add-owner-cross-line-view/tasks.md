# add-owner-cross-line-view Tasks

> 章程 C1（4.1-4.2 实施；4.3 `/` 发现面=Q1 单独待裁不夹带；4.4 SSO/401 实证随走查补证）。
> 红线：不并账（六账独立真源）、不新建 capability、只读铁律、缺数据如实降级不填 0。

## 1. 服务端聚合面

- [x] 1.1 共享读法提炼：`lib/board-adapters.js` 把 lex（console/usage 读法+401 翻面）与 wire（客户面 quota 读法）提炼为导出 helper，adapter 与 helper 单一真源——验证：现有四线 board 单测/e2e 回归钉绿（读法行为零变化）
- [x] 1.2 聚合端点：`server/routes/fleets.js` `GET /api/fleets/owner/cross-line-spend`（owner 鉴权组内），六分组各独立 try/catch（fleet=spendProjection 复用/market=purchasesForBuyer/wanxing=facade ops usage 代读（按主人 email 过滤 caller 行）/lex/wire=共享 helper 按凭据态/balance=billing_snapshots 最新快照），每线带 status/calibre/reconciledAt/metrics——验证：单测六分组各自 ok/degraded/unconnected 三态（mock 上游失败只降级该线）；响应无任何跨线总额字段（schema 层无槽）（2026-11-07 实施：scripts/test-owner-cross-line-spend.mjs 7/7 绿=六分组齐+口径键/无 total 槽三断言/lex-wire unconnected 零上游/401 翻面+500 单线降级/萬星 email 过滤+无行字段缺席+facade 不可达单线降级/market 缺失独立降级/只读铁律源码 grep 断言；ctx 注入走 localPackMarket（server.js 464 增 billingSnapshots 委托一腿））
- [x] 1.3 萬星代读口径落码：facade 不可达→wanxing 分组 degraded+分类错误；主人 email 无 caller 行→metrics 如实空（不填 0 指标）——验证：单测两分支（test 1.5：无行=turns/minutes 字段缺席非 0；不可达=degraded 且其余线 ok）；口径文案 key owner.wanxing 与 spec「服务凭据代读」场景对应（前端 i18n 落 2.3）
- [x] 1.4 只读铁律 grep 核证：聚合端点全链无跨线写入/扣费/结算路径——验证：核证记录=scripts/test-owner-cross-line-spend.mjs test 1.7（机器化断言：处理器源码无 .post/.patch/.delete/INSERT INTO/UPDATE/DELETE FROM/deduct/settle/charge）+人工 grep 复核（6 分组全部只读调用：spendProjection/purchasesForBuyer/fetch/ops/usage/fetchLexUsageFor/fetchWireUsageFor/billingSnapshots）

## 2. 前端成本区

- [x] 2.1 API client：`fleet-owner-api.ts` 增 fetchCrossLineSpend+六分组类型（无总额字段）——验证：类型编译过（tsc 5.9.3 exit=0）
- [x] 2.2 TeamsOverviewBoard 第四路：跨线花费区（六格：线名/读数/口径角标/对账时间/深链 /boards/<line>），独立 fetch 不阻塞既有三路；degraded=单线错误+重试；unconnected=未连接+去连接入口——验证：组件单测三态渲染；任一路失败不进整屏错误态（含既有三路回归）（2026-11-07 实施：fleet-hub e2e 9/9 绿=六格渲染+萬星 $1.23+lex 未连接+Connect 入口+fleet 12 runs+区内无 total 行；第一轮失败=web bundle 未重建（playwright fast 用旧 dist），web:build:e2e 后过）
- [x] 2.3 i18n 五语词条：跨线花费区全部文案（线名/口径/未连接/重试）zh-CN/en/ja/fr/es——验证：五语键齐无缺（check:locales all 5 OK；xlineReason 子键本地化 expired/not_connected）

## 3. 平台接线

- [ ] 3.1 platform env 补 `WANXING_FACADE_URL`（fd-infra-deploy，ClusterIP 字面量+justification 注记照 wanxing-contract-hardening 4.2）——验证：GitOps 提交+滚版后 in-pod env 实证
- [ ] 3.2 出片滚版+线上实证：主人会话打开综合看板跨线花费区——六分组真实渲染（至少 fleet/market/balance 三账有真数；lex/wire 按当前连接态如实；wanxing 走服务凭据真读 facade）——验证：端点响应留档+截图/走查记录

## 4. 章程联动收尾

- [ ] 4.1 章程 4.1 勾选（本单 1.x/2.x/3.x 全勾+3.2 实证后）；4.2 章程勾选注记（Capabilities=仅 Modified 两个既有 capability，无新 capability——本单 proposal 已按红线落）——验证：charter tasks 对应行勾选并引用本单
- [ ] 4.2 章程 4.4 实证补证（不改代码）：lex/wire 各一条端到端记录（连接→注入→401→翻面→恢复），与 A0 2.5 SSO 补证共用证据不重复劳动——验证：两条记录落档并引用 charter 4.4
- [ ] 4.3 `openspec validate add-owner-cross-line-view --strict` 通过 + 提交自查（点名文件、无并行会话卷入）——验证：exit=0；提交清单核对
