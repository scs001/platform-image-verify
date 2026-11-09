# Tasks — budget-cell-disk-usage

## 1. 实证（已完成）

- [x] 1.1 定位节点 `liuliangjkiimypbdzxa`：30 GiB，长期 74%–90% 振荡，触发过 facet 驱逐停摆约 15 分钟
- [x] 1.2 取到真实驱动：`evictionHard nodefs.available=5%` / `evictionMinimumReclaim=10%` /
      `imageGCHighThresholdPercent=85`
- [x] 1.3 拆出占用构成：containerd 6.1 GiB、cells 5.6 GiB（workspace 1.1 GiB 中单 cell 1051 MiB、
      sessions 1.4 GiB）——**镜像不是主因**
- [x] 1.4 确认 workspace 里是用户真产出（长篇小说全文/导出/读者版），不是垃圾，不可删

## 2. 实施

- [x] 2.1 用量采集：`gateway/cell-disk.js` 量每 cell 的 workspace / `dsh/sessions`（`lstat` 走查，
      **符号链接不计**——否则一个 cell 会报出另一个 cell 的字节）；TTL 缓存（默认 5 分钟）避免
      每次状态请求遍历 48 个根；`spawner.statusWithDisk()` 把读数并进 `GET /api/gateway/status`，
      软/硬阈值经 `CELL_DISK_SOFT_MB` / `CELL_DISK_HARD_MB` 配置（默认 512 MiB / 2 GiB，按实测单 cell 1051 MiB 定档）
- [x] 2.1b 三态判定 `ok/near/over`（软、硬阈值均含边界；负数读数不当 over）；单测
      `scripts/test-cell-disk-budget.mjs` 5/5，其中符号链接那条当场抓到我自己写错 `stat` 的实现
- [ ] 2.2 硬阈值拒绝写入——**未做**：写入点分散在 agent 运行时与文件路由，先要定"在哪一层拒"
      （工具调用前 / 文件写入路由 / 只拦上传）。当前只到"如实显示 over 状态"，不做平台代删：
      workspace 里是用户真产出，任何静默清理都是事故
- [ ] 2.3 会话历史归档/滚动：冷会话移出 pod 的临时盘（目录可配置，默认保留近 N 天）
- [x] 2.4 单测：阈值判定（含边界/负数）、采集在目录缺失时为 0 不抛、符号链接不计、
      TTL 命中与过期刷新、`snapshot()/invalidate()` 行为

## 3. 基础设施（另一仓，需与运维确认）

- [ ] 3.1 `fd-infra-deploy`：给该节点加 `systemReserved`/`kubeReserved` 的 ephemeral-storage 预留
- [ ] 3.2 把 `evictionHard` 的 nodefs 阈值抬到与真实余量匹配（消除振荡式驱逐）
