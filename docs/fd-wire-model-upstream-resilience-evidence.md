# fd-wire 递送：model_upstream 韧性实弹证据——降级路径零触发（镜像）

> 真源：`finddata/fd-wire/docs/paas-model-upstream-resilience-evidence.md`（2026-11-04，提出方 fd-wire/柏讯线）
> 本文件是投递到 paas 仓的镜像，内容以真源为准；状态：待评审。
> 对应：`fix-fleet-model-drift` 5.2（「真机验证挂账：等中毒再次复发」）、`fix-fleet-turn-attribution` §三/§四。

## 实弹观测（2026-10-28 上产后窗口，10-31 只读普查）

| 事实 | 数值 |
|---|---|
| 窗口内回合 | 199 条：ok 85 / 非 ok 114（**57.3%**） |
| 头号死因 | `model_upstream` **68 条**（67×503 + 1×502，token 网关 deepseek 窗口同源） |
| 降级触发 | **0 条** detail 带 `degradedTo` |
| 熔断开窗 | **0 条** `skipped`（§四 设计的开窗记录通道整窗未出一条） |
| 重灾区 | 识律政心监测舰 0/6 全非 ok；营销·官网内容舰 96 非 ok |
| 11-04 旁证 | ops 板 24h turns/errors=1552/1417（口径未对齐，仅证窗口仍在延续） |

对照：平台侧三缺口（可见性/0 秒 RNR/timeout 归因）验收全过，已回写 fd-wire ROADMAP-v2 Wave 0.1。

## 请壹座办理

1. 用 `fix-fleet-model-drift` 5.2 挂账场景收口——本窗口即「中毒复发」；
2. 回答降级为何零触发：触发条件未命中（<60s 快败 + 车道键解析）/ 配置未开 / detail 记录位遗漏，三选一或另述；
3. 若确认不咬合，立修复 change（验收：下次上游 5xx 窗口内出现 `degradedTo` 或熔断开窗证据，政心舰不再全灭）。
