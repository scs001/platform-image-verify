# Tasks: add-agent-notifications

## 1. 绑定与描述符

- [ ] 1.1 `gateway/packs.js` + `lib/agent-serving.js`：deploy 请求 `notifyChannel`（per agent，string|null）录入与描述符 `notify_channel`（省略=保留、null=解绑，同 rhythms 语义）。验证：单测三态落描述符

## 2. bridge 能力与转发

- [ ] 2.1 `agent-runner/compose.js` bridge 行增 `bot_notify` 面（event/text/channel?）；handler 以宿主身份转发 `POST {relayUrl}`（`AGENT_RUNNER_RELAY_URL/TOKEN` env，token 不进 child）；未配置 token/未绑通道/显式通道≠绑定 → 结构化拒绝。验证：单测——绑定投递/三拒绝形状/token 不出现在 spawn spec
- [ ] 2.2 per-agent 限流（默认 6/min，env 可调）+ runner 侧审计行（agent/channel/outcome/textLen）。验证：单测——第 7 次/分钟被拒且无外发

## 3. 端到端与文档

- [ ] 3.1 staging e2e：绑 `test-channel` 部署 → 回合内 bot_notify → relay 审计行 + child 成功回执；未绑定与超限两路径。验证：探针脚本留档 scripts/
- [ ] 3.2 文档：DEPLOY.md 通知段（绑定形状/relay env/四类事件为 pack 作者示例）。验证：文段与 spec 一致
