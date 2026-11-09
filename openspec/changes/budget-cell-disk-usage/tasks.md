# Tasks — budget-cell-disk-usage

## 1. 实证（已完成）

- [x] 1.1 定位节点 `liuliangjkiimypbdzxa`：30 GiB，长期 74%–90% 振荡，触发过 facet 驱逐停摆约 15 分钟
- [x] 1.2 取到真实驱动：`evictionHard nodefs.available=5%` / `evictionMinimumReclaim=10%` /
      `imageGCHighThresholdPercent=85`
- [x] 1.3 拆出占用构成：containerd 6.1 GiB、cells 5.6 GiB（workspace 1.1 GiB 中单 cell 1051 MiB、
      sessions 1.4 GiB）——**镜像不是主因**
- [x] 1.4 确认 workspace 里是用户真产出（长篇小说全文/导出/读者版），不是垃圾，不可删

## 2. 实施（待批）

- [ ] 2.1 用量采集：每 cell 的 workspace / sessions 字节数，进状态面与 ops 看板
- [ ] 2.2 软阈值提示 + 硬阈值拒绝写入（错误信息带处置建议，优先引导用户导出/清理）
- [ ] 2.3 会话历史归档/滚动：冷会话移出 pod 的临时盘（目录可配置，默认保留近 N 天）
- [ ] 2.4 单测：阈值判定、拒绝路径不误伤其他 cell、用量采集在 cell 缺失时不报错

## 3. 基础设施（另一仓，需与运维确认）

- [ ] 3.1 `fd-infra-deploy`：给该节点加 `systemReserved`/`kubeReserved` 的 ephemeral-storage 预留
- [ ] 3.2 把 `evictionHard` 的 nodefs 阈值抬到与真实余量匹配（消除振荡式驱逐）
