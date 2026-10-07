# add-desktop-release — Tasks

## 1. 首发彩排（release.yml 首次真跑）

- [x] 1.1 公开仓 main 上打 `v1.3.0` tag 推送，三矩阵首跑观察；修复暴露的坑（win runner 路径差异 / resources 缓存命中 / artifact 命名）直到三资产挂上 GitHub Release。验证：三矩阵两轮全绿（arm64 3m14s / x64 8m50s / exe 5m25s）；资产挂载步骤被组织级 Releases API 500 阻塞（与私有仓 CI 账单同根，GitHub 状态页无事故，fd-official-web 对照仓同 500）——账单修复后 `gh run rerun --failed` 或重推 tag 即出 Release。
- [x] 1.2 mac 本机安装冒烟：arm64 dmg 安装 → 启动 → 核心面（对话/设置）可用。验证：冒烟留档 2026-10-07——首轮 dmg 抓出两致命缺陷（打包缺 lib/server/gateway 等目录→server 启动即 ERR_MODULE_NOT_FOUND；打包默认 logto 无 endpoint→后端崩溃循环），修复后本地 --dir 构建全链绿（breadcrumb→回落开放→[::1]:47600 LISTEN→/api/ready 200→窗口进程在列）；非破坏式（从 /tmp 副本与 --dir 产物跑，未动 /Applications）。

## 2. release-sync 脚本

- [x] 2.1 `scripts/release-sync.mjs <tag>` 四步链：gh api 读 Release+资产 → 资产映射（design D3：macos=arm64 直链+Release 页、windows=exe 双直链）→ 写 `FD_WEB_DIR` 官网仓 snapshot（同 tag 覆写收敛）+ commit/push gitee → rsync 三产物到 dl；含 prune 子命令（保留 ≥2 版）。验证：对 v1.3.0 真跑 + 重跑幂等（无重复条目、rsync 零传输）。
- [x] 2.2 写前本地校验 snapshot：与官网 build 校验同规则（缺字段/未知平台键/无链接平台项即拒）。验证：构造坏 fixture 三类全拒且不 commit。

## 3. dl 平面

- [ ] 3.1 cheap 机 Caddy 静态站：目录 `/platform/<version>/`、DNS `dl.finddatatech.cloud`、TLS。验证：curl 直链 200 且 sha256 与 GitHub 资产一致。
- [ ] 3.2 保留策略 runbook：prune 步骤、盘余记录。验证：prune 后旧版 404、最近两版双源在。

## 4. 未签名文档 + beta 纪律

- [x] 4.1 公开仓 README 增未签名章：macOS Gatekeeper / Windows SmartScreen 绕过步骤 + 官网下载带脚注链接。验证：README 渲染可见两平台绕过说明。
- [ ] 4.2 v1.3.0 首条目：macos `beta:false`（1.2 冒烟后）、windows `beta:true`；Windows 实机冒烟完成后翻转（spec 场景）。验证：官网下载带 beta 标记与实际冒烟状态一致。

## 5. 官网回写联动

- [ ] 5.1 release-sync 真跑回写 v1.3.0：首条目 GitHub-only 过渡（dl 未就绪）或含 dl 直链（dl 已就绪），官网 roll 后下载带渲染新版本。验证：官网 band 显示 v1.3.0 + 双源/beta 语义正确 + dl 直链下载可完成。
