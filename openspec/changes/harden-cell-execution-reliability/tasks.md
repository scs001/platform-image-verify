# harden-cell-execution-reliability — tasks

## 1. 任务级重试策略

- [ ] 1.1 `task-engine.js`：失败终态前应用可配置重试策略——env 开关（默认关=现网行为零变化）+指数退避+尝试上限+每任务类覆盖；重试参数校验 fail-closed 回落默认
- [ ] 1.2 每次尝试落任务记录（attempt 序号/结果/时长）
- [ ] 1.3 单测：默认关=立即终态；开=退避重试后 done；耗尽=failed 终态不再自动执行
- [ ] 1.4 cron 补跑窗外丢轮：`cron.js`/`server/cron-runner.js` 记账路径追加显式告警事件（复用 metering explicit-alerting 通道先例）；单测覆盖窗外场景

## 2. fetch 超时纪律

- [ ] 2.1 新增共享 fetch 包装（lib/，默认超时+每调用点可覆盖；超时错误结构化、可重试类可判）
- [ ] 2.2 登录路径接入：`gateway/mp-auth.js:114`（code2Session）+其余 gateway 登录面
- [ ] 2.3 MCP bridge 家族接入（`server/fleet-mcp.js` 等约 10 处）
- [ ] 2.4 其余 gateway/server 裸 fetch 全量接入（摸底实证 41 处，逐处核对可覆盖性；确属永不挂起的本地原子操作可豁免并注明）
- [ ] 2.5 单测：包装器超时/可重试分类；mp-auth 与 fleet-mcp 至少各一条超时路径用例

## 3. 核心模块测试补齐

- [ ] 3.1 `server/cron-runner.js`：把补跑/重试判定抽成纯函数+契约测试（容差窗边界用例：窗内补/窗外跳+告警）
- [ ] 3.2 `gateway/index.js`：装配冒烟测试（openapi paths 形态断言）
- [ ] 3.3 `gateway/cell-report.js`：报告载荷形状测试
- [ ] 3.4 `agent-runner/harness/acp.js`：与 dsh adapter 同缝的契约测试至少一条
- [ ] 3.5 全量 `npm run test:unit` 绿+CI 门不回退

## 4. 运维账本回填

- [ ] 4.1 CONTEXT.md/INFRA-NOTES 补 cheap-7 迁机磁盘事故记录（判据/修法/预防：PV 钉死→Pending 死锁→三跳 SSH 清镜像）
- [ ] 4.2 补 cheap-3 DiskPressure 复发记录（2026-11-06：facet 钉住节点驱逐→502 一刻钟；陈旧镜像清理 25G→19G；复发根因调查另立，不在本单）

## 5. 收尾

- [ ] 5.1 出片上产（净化快照线：make-public-snapshot → scs001/platform-image-verify → fd-infra-deploy bump → gitee 推送 → ArgoCD）
- [ ] 5.2 生产探针：人为制造一次窗外丢轮验证告警事件可见（测试 cell 上）
- [ ] 5.3 openspec validate --strict + 归档
