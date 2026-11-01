# Design: add-rollout-gap-durability

## Context

滚版窗口治丢的两条缝（提案 Why）。已核事实：webhook 入口 `server/routes/bots.js`
（POST /api/bots/webhook/:botId/:secret）现用**内存 bootBuffer**（BOOT_BUFFER_MAX 满则 503，
SIGKILL 即丢）；各平台适配器已解析消息标识（企微 MsgId 等）；cron 停机补拍在 `cron.js`
（`countMissedOccurrences` + `withinToleranceWindow`，2× 周期地板 6h，杀开关
`PLATFORM_CRON_CATCHUP=0`）；回合孤儿清扫在 `server/fleet-runs.js` `sweepOpenRuns`
（30 分钟宽限）。

## D1 受理队列（write-ahead，盘上）

- 落盘位置走既有 data 目录约定（`PLATFORM_DATA_DIR` 下），每受理项一个 JSON 文件或追加日志
  （实现择一，append-only 单文件 + 处理游标更贴合重启接管：读游标之后未处理项即补处理面）。
- 顺序：验签 → 落盘（fsync 语义，见 D4）→ 200/平台应答 → 异步处理 → 处理完成打标。
- bootBuffer 合流：启动窗未加载完 registry 时同样落盘受理（不再内存排队、不再 503 丢），
  registry 就绪后按队列补处理——BOOT_BUFFER_MAX 语义从「丢」变「盘上限」。
- 重启接管：启动时扫描队列游标，未完成项依序补处理（与首处理同一路径，幂等层兜底重叠）。

## D2 幂等键

- 键 = `botId + 平台消息标识`（适配器已有解析面取名：企微 MsgId、飞书 messageId 等）。
- 存放：受理队列记录自带其键与处理状态；去重查询在受理时（新到项 vs 队列/近期已完成记录）。
- 保留窗：与受理队列同生命周期（D3 的清理策略），不另设 TTL 配置面。
- 解析不出标识的载荷：不造键，按原行为处理（宁重复不假重）。

## D3 队列清理

- 处理完成 + 保留期（≥ 容差补处理窗口，建议常量与 cron 容差同数量级）后删除盘上记录；
  启动时一并清扫已完成且过保留期的残留。上限（盘字节数/条数）超限时显式 503 + 留痕。

## D4 fsync 与丢失窗口的诚实边界

- 落盘用「写临时文件 + rename」原子替换；fsync 目录一步在 v1 可省（进程崩溃不丢已 rename 文件，
  掉电窗口接受）——如实记录该边界，死窗（无监听）回调仍依赖平台重试，本变更保证重放安全。

## D5 打断回合补拍（与 cron 补拍合流）

- `sweepOpenRuns` 判孤儿处挂钩：孤儿 run 有 sourceTag（fleetId/memberId）→ 查该成员 cadence
  节拍偏移，`withinToleranceWindow` 同源复用（不复制规则）→ 窗内补一拍（复用既有 catch-up
  enqueue 路径，带 makeup 来源标记），窗外 missed 记账。
- 双发防线：补拍走队列幂等（同一节拍 catch-up 只入队一次——cron 引擎已有 catchUp 去重集合，
  合流而非并列）。

## D6 测试

- 受理队列：落盘先行（应答前文件在）、重启接管补处理、上限落盘、超限 503。
- 幂等：同键重放不二跑（回合数断言）、无标识不造键、跨重启幂等保留。
- 补拍：孤儿+窗内→makeup 一拍且不与 cron catch-up 双发；窗外→missed。
