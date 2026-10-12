# Tasks: fix-turn-token-attribution

## 1. 实现

- [ ] 1.1 manager.js tokensOf：总数命名优先 + harness 分列（inputTokens/input_tokens +
  outputTokens/output_tokens）求和回退；两不匹配维持 null
- [ ] 1.2 fakeHarnessClient assistant/message 事件补挂 dsh 真实形状 usage；计量测试
  断言 tokens=150；无 usage 变体断言仍 null
- [ ] 1.3 本地门：test-agent-runner 全绿 + lint（改动文件零新增告警）

## 2. 部署（标准 law-ai 快照线）

- [ ] 2.1 提交 paas → 快照推 law-ai → GHA → relay 回灌 → ccr manifest 实证
- [ ] 2.2 三清单同滚（serving/b/c）→ gitee+github 双推 → ArgoCD → pod 起新镜像
- [ ] 2.3 滚后卫生：/health OK、条目照常、计量流照常

## 3. 生产实证

- [ ] 3.1 上游恢复窗口：任一真实回合计量行 tokens 为数值（+ok:true 正路径回执
  双收）；未恢复则按前例挂自然流量

## 4. 收尾

- [ ] 4.1 openspec 归档（validate --specs 先行）
- [ ] 4.2 记忆落盘 + MEMORY.md 索引
- [ ] 4.3 cheap-1 退役容器 agent-runner-dsh-retired-20261013 + 卷清理（新 runner
  稳定性已确认：接管后三镜像滚、计费/分成链复核、无回滚需求）
