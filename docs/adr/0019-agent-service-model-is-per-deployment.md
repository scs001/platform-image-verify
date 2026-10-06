# Agent 服务的模型逐部署选择，弃 runner 级单模型（D8 翻案）

2026-10-07，萬星 agent 配置层（服务配置/调用者偏好）定形时翻案。add-a2a-agent-serving 的设计 D8 白纸黑字把 LLM 定为 runner 级：`AGENT_RUNNER_LLM` 一个 env，runner 内所有 child 共用，理由是运维简单。但配置层的核心维度就是模型——没有模型的配置页是空壳：部署者无法按服务区分成本档与能力档（爬虫自愈用 flash、推理重的服务用深档），只能动 runner env 波及全体。**决定：模型成为服务配置（Service Config）的一个字段，逐部署生效——registry agent entry 的 descriptor 携带 effective model，runner 据此为各 child 取 LLM，未设置者回落 `AGENT_RUNNER_LLM` 默认（向后兼容）。选项合法性以部署键（Deployer Key）在 sub2api 的 group 车道授权为准，作者可在 serving contract 里声明白名单进一步收窄；合法性在**配置写入时校验**，不让服务带着未授权车道上线后运行时 404（llm-model-discovery 实录教训：group 不绑即 404）。模型变更经升级同款的排水重生通道生效（5 分钟窗内排干在途回合、child 重生）。**

## Considered Options

- **维持 runner 级单模型**（D8 原状）：运维最简，但配置层失魂，部署者对"这个服务用什么模型"无从下手——弃。
- **模型下放到调用者偏好（per caller）**：计费按时长结算（ADR-0014），调用者选模型只移动平台成本、不动自己付费，车道选择属于套餐（Plan）的策划维度，不是调用者自由选项——弃（词条「调用者偏好」已载明此边界）。
- **逐部署模型（本决策）**：部署者出钱驻留、按服务选档，与部署键的车道授权天然对齐；代价是 runner 内 child 各持模型，配置面需写入时校验。

## Consequences

- 一个 runner 同时承载不同模型的 child；内存足迹模型不变（仍一 agent 一 child）。
- 配置写入时须做车道校验（对 sub2api group 绑定的可用模型求交），非法选项在 UI/API 层拒绝。
- 升级不重置部署者的模型选择：服务配置挂部署不挂版本（Overlay 差异语义，未覆盖字段跟随新 manifest 默认）。
- runner 的 LLM 管线（含 `LLM_PROVIDERS_STORE` 路由真件）需接受逐 child 覆盖——本决策隐含的实现工作量主体在此。
- supersede：取代 add-a2a-agent-serving 设计 D8 的「runner 级 by design」条款；`AGENT_RUNNER_LLM` 从唯一真源降级为未配置时的默认值。
