# Tasks: desktop-catch-up-release

## 0. 前置纪律

- [ ] 0.1 `fd-build-channel` 查私有仓额度余额；本刀预算两次 release 矩阵（2×mac ×10 + 1×win ×2），余额不足则干跑延后并在此注记

## 1. 打包缺口修复 + 建制化断言

- [ ] 1.1 `electron-builder.js` files 清单补 `agent-runner/**`
- [ ] 1.2 `scripts/verify-bundle.js` 增 RUNTIME_DIRS 显式清单断言 + `supervisor/descriptors.js` 静态扫描门（descriptor args 相对路径解析出的目录必须在清单且在打包树在位；缺即 fail 并点名路径）
- [ ] 1.3 断言负例单测：模拟清单缺目录 → 构建红（防断言自身失效）

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
