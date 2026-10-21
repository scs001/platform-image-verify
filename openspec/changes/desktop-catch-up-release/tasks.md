# Tasks: desktop-catch-up-release

## 0. 前置纪律

- [x] 0.1 额度判决（2026-10-21 10:56）：私有池合计剩 9360 min（4.7 池），但**本仓 fd-craw-private=PRIVATE，release 矩阵计费走所属账号 FindDataTechnology=2011/2000 已耗尽**→ GHA 干跑当下会被额度闸秒拒。**改道**：打包件确证改走本机 arm64 本地 dist（仓库既有调试先例，零额度）；GHA 矩阵留到月初重置（2026-11-01）随正式 tag 一次跑

## 1. 打包缺口修复 + 建制化断言

- [x] 1.1 落地：files 清单的运行时目录块改为从 RUNTIME_DIRS 生成（`...RUNTIME_DIRS.map(d => \`${d}/**\`)`），agent-runner 随块入列——单源后此缺口类不可再漏
- [x] 1.2 `scripts/lib/runtime-dirs.mjs` 单一真源（RUNTIME_DIRS 9 目录 + PACKED_ELSEWHERE_DIRS 4 目录）+ descriptorSpawnRefs 静态扫描 + verify-bundle 新门；真实 descriptors 三引用（server.js/agent-runner/node_modules dsh bin）全过；开发树全量 verify-bundle exit 0
- [x] 1.3 `scripts/test-runtime-dirs.mjs` 5/5：未知目录红（neither…nor）/ 引用目录缺盘红 / RUNTIME_DIRS 条目缺盘红 / 真实仓布局绿 / files 接线（RUNTIME_DIRS.map）钉死防单源烂掉

## 2. 干跑确证

- [ ] 2.1 `workflow_dispatch` 干跑 release 矩阵（artifact-only 不发 release），取 mac arm64 安装包
- [ ] 2.2 打包件冒烟清单（design D6 八项：升级装/舰队配对真启动/并发切窗/应用中心/连接中心/语音/集群/云目录 last-good），逐项留证据
- [ ] 2.3 坐实/证伪 agent-runner 缺口记录在案；按 design D5 判据决定是否追加 desktop-fleet-runner spec delta（条件性，预期零 delta）

## 3. 补版发布

- [ ] 3.1 bump `package.json` 1.3.18 + 提交（显式路径）+ tag `v1.3.18` → release 矩阵出三平台安装包
- [ ] 3.2 `win-install-smoke` 过门——看日志 `smoke:` 行真证据，不认 run 绿（runner 瞬态红按 main+tag 双跑绿定案先例处理）
- [ ] 3.3 release-sync 链：dl.finddatatech.cloud + 官网下载中心快照；抽验 byte-identical（digest 对 GitHub asset）
- [ ] 3.4 发布记录更新 + 升级文案（无 autoUpdater，明示手动重装路径）
- [ ] 3.5 `openspec validate` 绿 + 归档准备
