# add-model-surface-budget-gate Specification

## 1. 预算检查
- **WHEN** 任一模型切换/派发前置检查
- **THEN** 调用 `BudgetEngine.checkBudget(model, estimatedTokens)`
- **THEN** 返回 `{ allowed, remaining, tier }`；`allowed=false` 时抛出 `BudgetExhaustedError`

## 2. 预算消费
- **WHEN** 真实 token 使用落地（metering 写入）
- **THEN** 调用 `BudgetEngine.consumeBudget(model, actualTokens)`
- **THEN** 更新三级窗口 used 计数

## 3. 超限处理
- **WHEN** 单次超限
- **THEN** 抛出 `SingleTurnBudgetExceeded` → 走 degrade chain（同 `fix-fleet-model-drift`）
- **WHEN** 日/月超限
- **THEN** 返回 `503 budget_exhausted`，记入 `budget_exhausted_log`

## 4. 窗口重置
- **WHEN** 每日 00:00 UTC
- **THEN** daily window reset（used=0, window_start=now）
- **WHEN** 每月 1 号 00:00 UTC
- **THEN** monthly window reset

## 5. 观测与报表
- **WHEN** 每日 01:00 UTC
- **THEN** 生成日报：各模型 single/daily/monthly used/limit/利用率
- **WHEN** 每周一 02:00 UTC
- **THEN** 生成周报：趋势、Top10 消耗、超限事件统计
