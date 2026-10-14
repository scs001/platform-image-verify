# Tasks: add-harness-adapter

## 1. 接口与 dsh 实现（零行为变化）

- [x] 1.1 `agent-runner/harness/adapter.js`：契约定义（JSDoc + `assertAdapter()` 运行时
  形状检查；能力枚举与结构化「unsupported capability」错误）
- [x] 1.2 `agent-runner/harness/dsh.js`：`DshHarnessAdapter`——把 `AgentChild` 的协议面
  （事件泵/prompt/request/wire 命名空间/泊靠/idle 结算/platform-stream/错误族）原样
  搬入；`AgentChild` 变薄壳并把 `turn` 委派给 adapter
- [x] 1.3 契约一致性单测：同一组 spawn/turn/stop/pid/capabilities 断言跑 dsh 实现
  （fake HarnessClient 复用现有夹具）
- [x] 1.4 回归硬门：`scripts/test-agent-runner.mjs` 57 项 + 合同①-⑯ 全绿零改动

## 2. ACP adapter

- [x] 2.1 `agent-runner/harness/acp.js`：`AcpHarnessAdapter` 按 design D4 映射表实现
  （initialize/session-new/set_config_option/prompt/update 流/cancel/usage_update/stop 阶梯）
- [x] 2.2 `scripts/lib/dsh-contracts/fake-acp-agent.mjs`：stdio fake ACP agent（正常 +
  起不来 + 空回合三模式），单测与合同⑰共用夹具
- [x] 2.3 ACP 映射单测：正常回合（文本+usage+delta）、取消收敛、空回合错误族、
  起不来错误族、绝对 cwd 校验、会话续跑（支持/不支持两态）
- [x] 2.4 契约一致性单测：ACP 实现跑 1.3 同组断言（`agentKey` 忽略、能力面如实）

## 3. 第二 harness 落地（claude-code-acp）

- [x] 3.1 凭证面侦察：claude-code-acp 读 `ANTHROPIC_API_KEY` 的通道（env vs 文件）；
  结论落 design 增补；不通则 deployment-secrets 注入 env
- [x] 3.2 runner 配置：`AGENT_RUNNER_ACP_COMMANDS`（JSON 白名单映射 harness 名→命令）；
  descriptor 只声明 harness 名，命令永远 runner 侧
- [x] 3.3 镜像：claude-code-acp 装进 `/opt/harness-acp` 独立前缀（Dockerfile）；
  实测体积/依赖冲突，超限回退独立镜像线（记录实测数据）
- [x] 3.4 `agent-runner/harness/registry.js`：harness 名→adapter 工厂注册表 +
  `capabilities()` 聚合（心跳与冷启动分派共用）

## 4. 选择、路由与部署门

- [x] 4.1 `composeDescriptor` 增 `harness` 透传（缺省不写字段）；manager 冷启动按
  descriptor.harness 分派 adapter；未支持 harness 的结构化冷启动错误
- [x] 4.2 心跳：`createFleetSampler` 增 `harnessProvider`，`runner_stats.payload.harness`
- [x] 4.3 部署门（gateway/packs.js）：harness 维度与 model roster gate 同形
  （有字段且不含→拒绝指名；缺失/未知→降级开放）
- [x] 4.4 单测：分派（dsh 缺省零变化/声明 ACP 走 ACP 工厂/未知 harness 结构化失败）、
  心跳字段、部署门三态（拒/过/降级开放）

## 5. 合同⑰

- [x] 5.1 `contracts.mjs` 合同⑰：ACP adapter 映射面（fake agent）——握手/会话/回合/
  文本/usage_update/取消/两错误族
- [x] 5.2 全量两轮绿（①-⑰；真矩阵树 + fake agent）；`dsh-adapter-files.json` 名单核对

## 6. docs 与收尾

- [x] 6.1 `docs/wanxing-multi-harness-runtime-explore.md`：切片③立项+实施标记；
  未决问题 2 记切片级答案（ACP=驾驶面，深控不进 ACP）
- [x] 6.2 台账：harness 维度写入 runner 机群说明（docs/registry-maintenance.md 或
  GitOps 注释按既有惯例）

## 7. 生产验证

- [ ] 7.1 出片+滚 runner（含 ACP 前缀镜像）；心跳 harness 字段 in-pod 眼见
- [ ] 7.2 同 pack 双 agent 部署（一 `harness: dsh`、一 `harness: acp-claude-code`），
  各自 A2A 回合成功眼见（真 claude 凭证）
- [ ] 7.3 harness 错配部署被拒眼见（指名 harness 与 runner）
