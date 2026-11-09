# Tasks — fix-overflow-attribution

## 1. 证据采集（无行为变化）

- [x] 1.1 `collectTurn` 在 `request/context` 分支记 `contextWindow`（只认运行时值，缺失保持 null）
- [x] 1.2 `collectTurn` 在 usage 更新处记 `lastInputTokens = max(prev, input + cacheRead)`、`steps`、`toolResults`
- [x] 1.3 `contextPressureDetail()` 接收并在溢出时带上这四个字段；非溢出路径逐字节不变
- [x] 1.4 失败行保留已观测 usage：`settle` 的 reject 分支带 `usage`，并在 `detail` 标 `usagePartial: true`

## 2. 提前收口（开关，默认关）

- [x] 2.1 `FLEET_OVERFLOW_PREEMPT=1` 开启；默认关，行为与现状一致
- [x] 2.2 每次 usage 更新后判定 `lastInputTokens >= contextWindow × 0.95`，命中则按 `context_overflow` 收口（复用早停的 `settle` 形状与收尾补数车道）
- [x] 2.3 窗口为 null 时不判定（无窗口可算，保守不动）

## 3. 测试

- [x] 3.1 溢出失败 detail 四字段齐全；`contextWindow` 缺失时为 null（不回落到声明值）
- [x] 3.2 失败行带 usage 且 `detail.usagePartial === true`
- [x] 3.3 开关关闭：同样输入下回合不提前收口（跑满原预算）
- [x] 3.4 开关开启：达 95% 即收口、话术与 `context_overflow` 一致
- [x] 3.5 非溢出路径（正常成功 / 普通超时 / 早停）detail 与现状逐字节一致
- [x] 3.6 反证：把 `max(lastInputTokens, …)` 改回覆盖式 → 3.1 红；去掉 `usagePartial` → 3.2 红

## 4. 规格

- [x] 4.1 `cron-module` 回合收口条款 + 4 场景（已随 proposal 写入 delta）

## 5. 上线与观测

- [ ] 5.1 快照 → GHA → relay → digest → GitOps → ArgoCD → 舱内确认 detail 带新字段
- [ ] 5.2 观测一窗：溢出回合按 `lastInputTokens / contextWindow` 分档（≥90% / 90–50% / <50%），确认"低 token 溢出"确实存在并点名模型
- [ ] 5.3 用 5.2 结果决定是否开 `FLEET_OVERFLOW_PREEMPT`，并量误停率（接近上限但本来能完成的回合数）
- [x] 5.4 读面口径（实现时偏离原任务，理由在下面）— 原任务写「排除 usagePartial 的行」，
  但那些 token **真扣了钱**，排除会**低估**花费。改为：**计入花费，并单独报出
  `partialTurns`**（`spendProjection` 各窗口与 allTime），让读面知道其中有半截快照。
  断言在 `test-fleet-context-pressure`；反证：去掉计数 → 红。
- [ ] 5.5 归档（`openspec validate --strict` 通过后）
