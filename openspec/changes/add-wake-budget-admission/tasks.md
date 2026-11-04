## 1. 纯函数层（proc-memory）

- [x] 1.1 `lib/proc-memory.js` admission 增加 `inflightBytes` 入参（并入判定用量，纯函数保持纯，缺省 0 时行为逐字节等价现状）；`scripts/test-proc-memory.mjs` 补 inflightBytes 用例（并入后超阈拒、归零等价）。验证：`node scripts/test-proc-memory.mjs` 全绿。

## 2. 账本层（gateway spawner）

- [x] 2.1 `gateway/spawner.js` 引入 `inflightWakes` 账本：ensure() 判定前登记（档案足迹或默认足迹）、finally 释放（覆盖放行/拒绝/异常/fail-open 四路径）；驱逐链复投影读同一账本。验证：单唤醒+有档案的判定式与现状逐字节一致（现有测试全绿不改动断言）。
- [x] 2.2 默认足迹 env `CELL_WAKE_DEFAULT_FOOTPRINT_MB`（缺省内置保守值，闸关闭时账本 inert 零开销）；无档案唤醒按默认值记账且不落档案列。验证：无档案 cell 唤醒的证据带 `defaultFootprintApplied=true`。
- [x] 2.3 证据扩展：`recordGateRefusal` 与 `err.memory` 增加可选 `inflightBytes`/`defaultFootprintApplied`，沿 `last_gate_refusal_json` 落库。验证：拒绝场景读回 registry 行含新字段。

## 3. 测试扩展（test-cell-wake-admission.mjs 新增 5.x 段）

- [x] 3.1 并发记账：同采样窗两唤醒、各自单独达标、合计超限 → 后到者拒于物化前且证据含预约合计。验证：新增 test 全绿。
- [x] 3.2 预约释放：放行后/失败后/拒绝后三路径预约归零，后续唤醒判定不含残留。验证：新增 test 全绿。
- [x] 3.3 默认足迹接管：无档案唤醒按默认值记账 → graceful park 落档 → 再唤醒回归档案值。验证：新增 test 全绿。
- [x] 3.4 驱逐链含他人在途预约：A 唤醒在途时 B 触发驱逐，复投影计入 A 预约。验证：新增 test 全绿。
- [x] 3.5 fail-open 释放：采样故障放行且预约不留残留；闸关闭逐字节等价（无登记开销）。验证：新增 test 全绿。

## 4. 收口

- [x] 4.1 全套件回归：`node scripts/test-cell-wake-admission.mjs`（原 10 测+新 5.x 段）+ `node scripts/test-proc-memory.mjs` 全绿；gateway 既有套件无回归。验证：命令输出全绿。
- [x] 4.2 生产缺省值复核：以 `cells-registry.db` 现役足迹分布复核 `CELL_WAKE_DEFAULT_FOOTPRINT_MB` 缺省档（只读取证，配方见 §15.132 探针），必要时调内置缺省。验证：复核数记录在本文件勾选注记。→ **2026-11-05 复核（cheap-ts platform pod 只读探针）**：29 rows（26 suspended/3 running），已归档足迹 808/769MB（两笔皆 cron 大户），24 个挂起 cell 无档案即默认足迹覆盖面；按 2048MB 容器/1740MB 准入线/956MB 稳态算账，内置缺省 **256→512MB**（512 保住双 800MB 并发最坏情形，误拒一次唤醒顺延、首次 park 后自愈）。
- [ ] 4.3 出片上产：快照仓推送 → 镜像 → GitOps 滚版（避开大 cell resident 窗，11-04 教训）；滚版后观察首个集中唤醒窗（cron 大户回醒）零 OOMKill、无预约残留（`last_gate_refusal_json` 抽查）。验证：GitOps commit + pod imageID 双证 + 观察窗记录。
