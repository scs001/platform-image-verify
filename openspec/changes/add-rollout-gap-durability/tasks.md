# Tasks: add-rollout-gap-durability

## 1. 受理队列与幂等（social-bot-channels）

- [x] 1.1 盘上受理队列：`server/bot-acceptance.js`（原子写 tmp+rename、pending→dispatched→done 单向
  状态机、认领竞态守卫、24h 保留清理、盘上限 BOTS_ACCEPTANCE_FULL），bootBuffer 合流进队列
- [x] 1.2 webhook 路由改写：验签+解析后落盘先行应答（重复键 ack 不二跑），处理异步化，boot 窗
  落盘排队不再内存丢弃
- [x] 1.3 幂等键：五适配器 platformMessageId（wecom/wecom-bot/wechat-oa/telegram/feishu）+ 契约
  注释；无标识不造键（null 键永不去重）
- [x] 1.4 重启接管：构造即装载；dispatched→done(interrupted) 如实结算（不重跑防双回）；pending
  boot 重放/pending message 直派（注册时武装，与 boot drain 认领互斥）

## 2. 打断回合补拍（agent-fleet-runs）

- [x] 2.1 sweepOpenRuns 挂钩：cron 源孤儿 run 结算后 → `onInterruptedRun`（factory 注入）→
  `cron.makeUpInterruptedBeat`（单点导出：查任务→paused/无任务→no-task）
- [x] 2.2 容差窗内 catchUpPending+fireTask（与 boot 补拍同 marker 同路径=无双发）；窗外
  outside-tolerance / 杀开关 kill-switch 如实留痕（warn+已结算 run 行）

## 3. 测试与验证

- [x] 3.1 test-bot-acceptance 7/7（落盘先行/重放不二跑/无标识不造键/状态机认领/跨重启恢复/
  保留清理/超限满）+ test-bot-webhook-durability 5/5（盘在 ack 前/同 id 不二跑/异 id 照常/
  pending 接管直派/dispatched 接管不重跑）
- [x] 3.2 test-fleet-runs 补拍四件（窗内 makeup 双发防线/窗外不补/no-task+paused+杀开关/
  非 cron 源不挂钩）
- [ ] 3.3 全量回归 + lint（显式核退出码）+ 公开门

## 4. 上产与真机验收

- [ ] 4.1 出片线：池出片 → relay/ccr → GitOps bump（gitee 真源，核祖先）→ imageID 实证
- [ ] 4.2 真机：滚版期间 bot 回调→重启接管补处理眼见；打断回合 makeup/missed 两面取证；验收即清
