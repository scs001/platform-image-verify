# Tasks: add-desktop-residency-hardening

## 1. 注册可断言与幂等

- [x] 1.1 `electron/steward-install.js` 导出 `registrationArtifacts()`（win: schtasks argv〔entry 名/ONLOGON/LIMITED//F 幂等替换/稳定路径〕；mac: plist 字段〔RunAtLoad/KeepAlive/SuccessfulExit/ThrottleInterval/参数〕），单测直接断言产物（不驱动 launchctl/schtasks）
- [x] 1.2 幂等重注册：重复 install 走 replace 语义（win 先删后建、mac 覆盖 plist），单测断言"唯一一条"
- [ ] 1.3 win 真机（win-smoke 轨）实跑一次 schtasks 注册/查询/删除，断言实际系统状态与产物一致

## 2. 崩溃环保护

- [x] 2.1 新 `supervisor/steward-health.js`：崩溃环计数状态机（失败计数/阈值开冷却窗/冷却期不起栈/健康启动清零/显式动作清零/状态落 `steward-health.json` 跨重启），`supervisor/steward-main.js` 接入（冷却期只驻留不拉栈、窗口结束以 EX_TEMPFAIL 交还注册重试）；单测覆盖全部状态转移
- [x] 2.2 落 `steward-health.json`（dataDir，读取失败=首启语义）；阈值/冷却窗/清零窗口经 `STEWARD_CRASH_*` 可配
- [ ] 2.3 真机校准：win/mac 各测一次冷启动时长（含 dsh 载入），落默认阈值并写明实测依据（进任务注释与 design 补记）

## 3. 状态面与修复动作

- [x] 3.1 Preferences「后台管家」区三态渲染：已注册且健康 / 已注册未健康（带最后失败原因与冷却剩余）/ 未注册；状态由 `attachSteward` 探测 + 崩溃历史派生，禁止以注册文件存在代替健康
- [x] 3.2 修复动作 IPC `steward:repair`：重新注册自启（mac 覆盖 plist / win `/F` 替换 = 幂等，不重复条目）+ 清零崩溃计数；preload 暴露 + 偏好页按钮与状态面随行刷新
- [ ] 3.3 i18n 五语言 key 同批（en/zh-CN/es/fr/ja），过 locale 门

## 4. 恢复即收敛

- [x] 4.1 收敛落在 cell 启动（cell 正是管家拉起的进程）：`server/local-agent-feed.js` 的 `convergeLocalCluster()` 在 `server.js` 启动时跑——以部署表为期望集、剔除孤儿（pack 已卸载）、报告计数；可重入幂等、纯本地不触网
- [x] 4.2 收敛结果进状态面：`GET /api/wanxing/fleet/convergence` 暴露「上次收敛报告 + 当前期望」；空部署呈现健康 `0` 而非未健康
- [x] 4.3 单测：`scripts/test-steward-residency.mjs` 8 测试全绿（注册产物断言 ×2、崩溃环状态机 ×4、收敛 ×2）

## 5. 见证

- [x] 5.1 注册断言已改为可断言数据（win schtasks argv / mac plist 字段，含 KeepAlive/SuccessfulExit/ThrottleInterval），mac 腿既有的 plan 断言即覆盖；收敛计数并入平台中立探针（`electron/local-cluster-probe.mjs` 的 convergence 腿）并接入 release.yml 两腿。**双平台 CI 腿待跑** —— **待 CI 腿（本地无法跑双平台）**
- [ ] 5.2 手动一幕（真机睡眠/唤醒 + 重启后收敛与计数）：**待出片后在 mac/win 真机各做一次**
- [x] 5.3 `openspec validate add-desktop-residency-hardening --strict` 绿；`scripts/test-steward-residency.mjs` 8 例全绿（注册产物 ×2、崩溃环状态机 ×4、收敛 ×2）；biome/tsc 绿。**台账与真机截图待出片**
