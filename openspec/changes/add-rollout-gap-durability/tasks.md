# Tasks: add-rollout-gap-durability

## 1. 受理队列与幂等（social-bot-channels）

- [ ] 1.1 盘上受理队列：append/游标/清理三件（落盘→应答→异步处理→打标），bootBuffer 合流进队列
- [ ] 1.2 webhook 路由改写：验签后落盘先行应答；处理异步化（现同步处理路径不改其回合语义）
- [ ] 1.3 幂等键：适配器消息标识接入 + 去重面（新到 vs 队列/近期完成），无标识不造键
- [ ] 1.4 重启接管：启动扫描未完成受理补处理（与首处理同路径）

## 2. 打断回合补拍（agent-fleet-runs）

- [ ] 2.1 sweepOpenRuns 挂钩：孤儿 run → 成员 cadence 偏移 → withinToleranceWindow 复用判定
- [ ] 2.2 窗内补拍合流进 cron catch-up enqueue（makeup 来源标记 + 双发防线），窗外 missed 记账

## 3. 测试与验证

- [ ] 3.1 test 套件：受理队列四件（落盘先行/重启接管/上限落盘/超限 503）+ 幂等三件（重放不二跑/
  无标识不造键/跨重启保留）
- [ ] 3.2 test 套件：补拍两件（窗内 makeup 不双发/窗外 missed）
- [ ] 3.3 全量回归 + lint（显式核退出码）+ 公开门

## 4. 上产与真机验收

- [ ] 4.1 出片线：池出片 → relay/ccr → GitOps bump（gitee 真源，核祖先）→ imageID 实证
- [ ] 4.2 真机：滚版期间 bot 回调→重启接管补处理眼见；打断回合 makeup/missed 两面取证；验收即清
