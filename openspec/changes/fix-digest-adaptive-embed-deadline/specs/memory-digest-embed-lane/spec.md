# memory-digest-embed-lane Specification

## Purpose

digest 向量档位的预算与降级纪律：单次 embed 的等待预算按近期真实延迟自适应、慢样本必须被如实记录、调用方超时必须大于该预算，使「向量召回档位在可用时被用上」与「不可用时快速降级」两者都不被固定阈值浪费。

## ADDED Requirements

### Requirement: 单次 embed 预算按近期延迟自适应

digest 的 embed 等待预算 SHALL 由近期**真实** embed 耗时的分位数推导，而非固定常量；推导结果 MUST 被 clamp 在配置的上下界内（下界避免过快放弃，上界避免拖死调用方）。环境变量 `FD_MEMORY_DIGEST_EMBED_DEADLINE_MS` 的语义 SHALL 为该预算的上限（而非固定值），其存在 MUST NOT 改变既有部署的行为下界。

#### Scenario: 近期快则预算收紧

- **WHEN** 近期成功 embed 的 p90 为 1.2s，且配置上限为 8000ms
- **THEN** 本次 embed 的等待预算显著低于上限（按 p90 留出余量），耗时超过预算即降级为关键词召回，不空等到 8 秒

#### Scenario: 近期慢则预算放宽但仍受上限约束

- **WHEN** 近期成功 embed 的 p90 为 11s，且配置上限为 8000ms
- **THEN** 本次等待预算不超过配置上限 8000ms，超出即以降级收场并在 `model_note` 记明超时

#### Scenario: 无近期样本时回落默认

- **WHEN** 进程刚启动、成功样本为空
- **THEN** 使用默认预算（不因无样本而退化为 0 或无穷），且首个样本落库后自适应立即生效

### Requirement: embed 慢样本必须记录真实等待时长

embed 采样 SHALL 对成功与失败两类都记录**实际经过的时长**与失败原因分类；因触达预算上限而中止的样本 MUST 被标记为超时类（可与其他失败原因区分），MUST NOT 把耗时记成预算值或 0 以致掩盖真实延迟。

#### Scenario: 超时样本可区分真实延迟

- **WHEN** 一次 embed 在预算耗尽时被中止，实际已等待 8 秒
- **THEN** 该样本记录实际等待 8 秒并归入超时类，`/admin/metrics` 的失败原因分布能看到该类计数

#### Scenario: 成功样本驱动下一次预算

- **WHEN** 连续若干次 embed 成功且耗时逐步上升
- **THEN** 采样中保留这些真实耗时，下一次预算据此放宽，而非沿用首启时的默认值

### Requirement: 调用方超时必须大于 fd-memory 的 embed 预算上限

记忆读面的调用方（集群回合注入、主聊天注入、facade/智语注入）SHALL 以可配置的超时调用 digest；生效的调用方超时 MUST 大于 fd-memory 侧 embed 预算上限，否则 digest 在能给出结果前即被调用方放弃，产生「明明可降级却整块丢失」的浪费。调用方超时未被显式配置时 SHALL 使用一个与 fd-memory 上限相匹配的默认值。

#### Scenario: 预算匹配时慢 embed 仍拿到结果

- **WHEN** fd-memory 预算上限 8000ms、调用方超时 9s，而某次 embed 耗时 6s
- **THEN** digest 在调用方放弃前完成并返回结果（向量档或带 `model_note` 的关键词档），不出现整块丢失

#### Scenario: 调用方配置过小被识别

- **WHEN** 运维把调用方超时配成小于 fd-memory 预算上限的值
- **THEN** 该配置属于违反不变量的误配，系统 MUST 在日志或自检面留下可辨识的迹象（如持续的 digest 超时降级 warn），使误配可被定位而非静默

### Requirement: 降级状态可被外部探针判定

系统 SHALL 提供只读手段让外部探针判断「此刻向量档位是否在降级」，且该判据 MUST 反映当前状态而非历史累计。累计计数器 MUST NOT 作为唯一判据——它们不自愈，一次历史故障会让判定持续报错。

#### Scenario: 恢复后不再报降级

- **WHEN** 一段降级过去、当前 digest 已重新走向量档
- **THEN** 外部探针得到「健康」结论；历史降级计数可以展示为历史，但不得使判定为降级

#### Scenario: 正在降级时可判定

- **WHEN** 此刻 embed 车道上游失败、digest 正在返回关键词档
- **THEN** 外部探针能得到「正在降级」的明确结论，并取得可读的失败原因
