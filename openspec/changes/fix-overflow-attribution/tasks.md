# Tasks — fix-overflow-attribution

## 1. 证据采集（无行为变化）

- [ ] 1.1 `collectTurn` 在 `request/context` 分支记 `contextWindow`（只认运行时值，缺失保持 null）
- [ ] 1.2 `collectTurn` 在 usage 更新处记 `lastInputTokens = max(prev, input + cacheRead)`、`steps`、`toolResults`
- [ ] 1.3 `contextPressureDetail()` 接收并在溢出时带上这四个字段；非溢出路径逐字节不变
- [ ] 1.4 失败行保留已观测 usage：`settle` 的 reject 分支带 `usage`，并在 `detail` 标 `usagePartial: true`

## 2. 提前收口（开关，默认关）

- [ ] 2.1 `FLEET_OVERFLOW_PREEMPT=1` 开启；默认关，行为与现状一致
- [ ] 2.2 每次 usage 更新后判定 `lastInputTokens >= contextWindow × 0.95`，命中则按 `context_overflow` 收口（复用早停的 `settle` 形状与收尾补数车道）
- [ ] 2.3 窗口为 null 时不判定（无窗口可算，保守不动）

## 3. 测试

- [ ] 3.1 溢出失败 detail 四字段齐全；`contextWindow` 缺失时为 null（不回落到声明值）
- [ ] 3.2 失败行带 usage 且 `detail.usagePartial === true`
- [ ] 3.3 开关关闭：同样输入下回合不提前收口（跑满原预算）
- [ ] 3.4 开关开启：达 95% 即收口、话术与 `context_overflow` 一致
- [ ] 3.5 非溢出路径（正常成功 / 普通超时 / 早停）detail 与现状逐字节一致
- [ ] 3.6 反证：把 `max(lastInputTokens, …)` 改回覆盖式 → 3.1 红；去掉 `usagePartial` → 3.2 红

## 4. 规格

- [ ] 4.1 `cron-module` 回合收口条款 + 4 场景（已随 proposal 写入 delta）

## 5. 上线与观测

- [ ] 5.1 快照 → GHA → relay → digest → GitOps → ArgoCD → 舱内确认 detail 带新字段
- [ ] 5.2 观测一窗：溢出回合按 `lastInputTokens / contextWindow` 分档（≥90% / 90–50% / <50%），确认"低 token 溢出"确实存在并点名模型
- [ ] 5.3 用 5.2 结果决定是否开 `FLEET_OVERFLOW_PREEMPT`，并量误停率（接近上限但本来能完成的回合数）
- [ ] 5.4 读面（成本汇总）显式排除 `usagePartial` 的行，避免半截用量被当整轮
- [ ] 5.5 归档（`openspec validate --strict` 通过后）
