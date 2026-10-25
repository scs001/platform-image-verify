# fix-fleet-round-discipline Tasks

## 1. 缺陷 A — 交付控制器忙谓词与硬顶

- [x] 1.1 `server/dsh-mcp-delivery.js`：单测先行——`scripts/test-dsh-mcp-delivery.mjs` 增忙矩阵用例：收集器注册期间 `onCredentialChange` 返回 deferred、settle 后 poller 排空、`drainIfIdle` 忙重查不抢跑、硬顶不打断未逾自身预算的合法回合且楔死（逾预算仍未终止）仍照既有语义强推释放（`node --test scripts/test-dsh-mcp-delivery.mjs` 绿）
- [x] 1.2 `server.js:735`：`isStreaming` 扩为 `ctx.isStreaming || taskTurnRegistry.size > 0 || sessionCollectors.size > 0`（design D1），`maxDeferredMs` 传 15min（design D2）；验证：1.1 的注入形态单测绿 + `[mcp-delivery]` 日志分支与注释一致
- [x] 1.3 `server.js` `dshUpdateMcp` 末端「hot-swap 关闭 / 空 patch」兜底裸 restart 改经控制器（design D3）；验证：单测覆盖「兜底 restart 遇注册表非空 → deferred」，grep 确认 `dshBridge.restart` 裸调仅剩 preset 切换链路
- [ ] 1.4 真机口径（上产后走查）：巡逻回合流式中触发 token 重铸 → 回合完整跑完、日志留 deferred、restart 落回合边界；记入台账 §15 发布记录

## 2. 缺陷 B — 舰队回合子进程对话轮换

- [x] 2.1 `server/cron-runner.js`：`collectTurn` 增可选 `mirrorSessionId` 参数（收集键=子进程 id、镜像落稳定 id，design D4），既有调用方默认行为逐字节不变；验证：cron-runner 既有单测全绿 + 新单测断言镜像行 id 与收集键解耦
- [x] 2.2 `runPersonaTurn`：`sourceTag?.fleetId` 任务以 `#r<startedAt>` 子进程 id prompt 与收集（design D4/D7）；验证：单测——第 N+1 回合子进程 id ≠ 第 N 回合、bridge 无 `session/delete` 支持时亦然、镜像行持续落稳定 id
- [x] 2.3 回合收尾 dispose：settle 后对子进程 id best-effort `deleteSession`，失败仅警告（design D5）；验证：单测——delete 被拒时下一回合仍以全新 id 正常执行
- [x] 2.4 cluster 成员子会话 `memberSessionId` 前缀改挂本回合子进程 id（design D4）；验证：cluster 既有单测核对后按新形状增断言
- [x] 2.5 普通定时任务回归：无 fleetId sourceTag 的任务走既有路径逐字节不变；验证：既有 cron 单测全绿 + 新增「普通任务 id 不带 `#r`」断言

## 3. 缺陷 C — swap 清史可验证语义

- [x] 3.1 `server/routes/fleets.js` swap `freshSession` 分支：保留镜像清空，注释与行为对齐「下一回合必不回放靠轮换原语保证」（design D6）；验证：单测——2.3MB 级会话上 swap + bridge `session/delete` 拒绝 → 下一回合子进程 id 全新
- [x] 3.2 单测钉住 spec 场景「换防默认继承可选清史」：清史重开后镜像行重建、报数史与槽位连续性不受影响；验证：`node --test scripts/test-*.mjs` 相关文件绿

## 4. 收口

- [x] 4.1 `openspec validate fix-fleet-round-discipline` 通过；全量单测 2040/2049——9 红全在 extension/manifest 族（test-pack-registry、test-role-gated-extensions，import 链与本变更零交集，main 既有红），本变更新增两测试文件与全部受影响套件（fleet-core/cluster/turn-events/bots/tool-posts/token-renewal/dsh-mcp-delivery）全绿
- [ ] 4.2 出片上产（先 `fd-build-channel`，照 `deploy-registry-image` 证据链），真机走查三口径：A=巡逻回合中凭据变更不打断；B=连跑 5 回合子进程文件单回合量级、回合墙钟不逐回合劣化；C=2.3MB 会话 swap 后首 token 延迟正常
- [ ] 4.3 台账 `docs/registry-maintenance.md` §1 运行表 + §15 发布记录更新；tasks 勾销与归档按 openspec 流程
