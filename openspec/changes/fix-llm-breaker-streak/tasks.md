# fix-llm-breaker-streak — 实施任务

## 1. streak 状态机（llm-lane.js）

- [x] 1.1 熔断计数从挂钟滑窗 `failures[]`/`sweep`/`windowMs` 改为连续计数 `streak`：`recordUpstreamFailure` 计数 +1、`streak ≥ threshold` 即 `openUntil = now + openMs`（已开窗时探针再败前滚 openUntil）；`recordUpstreamSuccess` 清零 streak + openUntil；`breakerState` 去掉 sweep、返回字段 `failures` → `streak`；`breakerConfig` 移除 `windowMs`、`DEFAULT_OPEN_MS` 10min→2h；模块头注释「restart 后窗口一个 span 重填满」改写为 streak 语义下的等价表述（D5）。验证 = `node --test scripts/test-fleet-turn-attribution.mjs` 熔断组全绿。

## 2. 消费点同步（cron-runner.js）

- [x] 2.1 skip 文案 `${br.failures}/${br.threshold} upstream failures in window` → `${br.streak}/${br.threshold} consecutive upstream failures`；seam 记账调用点不变（函数签名未改）。验证 = 同上 + `node --test scripts/test-fleet-core.mjs`。

## 3. 测试改 streak（test-fleet-turn-attribution.mjs）

- [x] 3.1 熔断组：移除 `PLATFORM_LLM_BREAKER_WINDOW_MS` 设置/清理；`.failures` 断言（112/295/299 行）改 `.streak`；头注释「sweeps the window」改 streak 语义。验证 = 全套件绿。
- [x] 3.2 **新增间隔不敏感场景**（红→绿靶心）：同 lane 连击 5 次、每次间隔 3 小时（无任何成功）→ 第 5 次必须开窗——旧滑窗实现下此断言必红；探针再败前滚 openUntil 一条。验证 = 摘本补丁该断言红、还原后绿。

## 4. 治理

- [x] 4.1 `openspec validate fix-llm-breaker-streak --strict` 绿。验证 = 命令退出码 0。

## 5. 出片与验收

- [ ] 5.1 出片滚产同面 gateway（先跑 `fd-build-channel` 判路）。验证 = 生产 pod 镜像 tag 前进。
- [ ] 5.2 上产后观测：下一个上游 5xx 窗口内应出现 skipped 行（车道 id + openUntil 可查）；若长期无窗，以 e2e 红绿双证 + 状态机单测收口，如实记录「生产显现待窗」不强行销账（沿 fix-fleet-model-drift 5.2 先例）。验证 = 回合查询 `status=skipped` 或单测台账。
- [ ] 5.3 回执 fd-wire 证据稿：`docs/paas-model-upstream-resilience-evidence.md`（真源在 fd-wire、镜像在 paas/docs）补「定谳回执」段——degradedTo 零触发=链长 1 如实、熔断=本 change 修 streak、modelRectified=drift 4.2 已修。验证 = 双文件同步。
- [ ] 5.4 归档 + 台账 §15.1xx 补记。验证 = `openspec validate --specs` 绿。
