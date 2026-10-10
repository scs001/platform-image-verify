## 1. 共享核心落地（scripts/lib/test-server.mjs）

- [x] 1.1 从 e2e/helpers.js 逐行抽出 spawnTestServer 核心（detached 自成组 + kill(-pid) 组杀 + 20s 挂梯 + 250ms 收尾宽限）为 scripts/lib/test-server.mjs，导出 spawnTestServer/GRACE_MS
- [x] 1.2 实现所有权登记：spawn 前落盘 `$TMPDIR/paas-test-servers/<pgid>.json`（属主 PID + store 根可选字段），stop() 成功后删登记
- [x] 1.3 实现自愈扫除：模块导入时扫登记目录，属主 `kill(pid,0)` ESRCH 的登记 → 组 SIGKILL + rm store 根 + 删文件；属主存活跳过
- [x] 1.4 实现属主钩子：首次使用时安装 exit/SIGINT/SIGTERM 钩子，退出时对全部在册组直接组 SIGKILL（无 Playwright 门控）
- [x] 1.5 helper 自测脚本（scripts/test-test-server.mjs）：spawn 哑 server + 假子进程 → stop() 全灭；SIGKILL 属主 → 重新导入 → 尸体+store 根被清；活属主登记不被碰

## 2. e2e 同源

- [x] 2.1 e2e/helpers.js 改为 import scripts/lib/test-server.mjs，本地保留 Playwright 专属（per-worker store、worker 钩子环境门控、页面助手），行为零变化
- [ ] 2.2 CI fast e2e 全绿（推送后看步骤级结论，本地只 lint/unit/build） <!-- 待 push 后看 CI 步骤级结论（本地已单跑 worker-pool fast spec 绿） -->

## 3. 14 个脚本机械换装

- [x] 3.1 换装 cell 系六脚本：test-cell-bindings / test-cell-gateway / test-cell-containment / test-cell-isolation / test-migrate-single-to-cell / test-gateway-sessionless
- [x] 3.2 换装 app/mp 系四脚本：test-app-pairing / test-mp-auth / test-mp-demo / test-mp-single-auth
- [x] 3.3 换装其余四脚本：test-pack-marketplace / test-session-share / test-facet-cli / test-facet-cli-connect <!-- facet 两脚本只有 execFile 短命 CLI + 进程内 stub，无 server spawn，无可换装面（规格空满足） -->
- [x] 3.4 每组换装后本地跑对应脚本，确认行为不变（断言结果同换装前）

## 4. 全链验收

- [x] 4.1 全量 `npm run test:unit` 跑完，ps 断言零 dsh/server/gateway 残留、`$TMPDIR/paas-test-servers/` 登记清空
- [x] 4.2 自愈演练：人为 `kill -9` 一个正在跑的测试脚本 → 跑任一其他测试 → 断言尸体组与 store 根被自动清走
- [x] 4.3 lint + 本地单测绿；openspec validate --specs 通过（归档前必验）
- [x] 4.4 冒烟一轮 Ctrl-C：test:unit 中途 ^C，钩子收车后 ps 零残留
