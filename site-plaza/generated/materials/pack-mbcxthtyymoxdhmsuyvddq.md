# Micro-Business · Core Checkup Suite / 生意体检 · 内核套件

## What this is

面向中国传统微型企业与个体户的经营体检内核：四段式工作流（问诊建档 → 单店算账 → 行业信号对照 → 行动清单）为入口技能，配套盈亏平衡、毛利结构、现金流账期三个计算器。所有金额与比率一律经计算器产出并附计算公式 + 输入基数 + 来源（来源名/地区/年份/口径时间），外部统计基数取不到时该项中止并明示「基数数据源未连接/未定码」，禁止用模型记忆的行业数字填充。未安装行业信号包时如实标注「未安装行业信号包」且不中断分析。单店生意档案可建立在 DAAS 实体模型上（一家店=一个实体，指标持久化 + 告警规则）。内核按小老板能听懂的标准书写，专业术语附日常解释；机构与政务渠道共用同一内核，仅外壳与推送方式不同。

Operating-checkup core for China's micro-enterprises and sole proprietors: a four-stage workflow (intake interview → single-store accounting → industry-signal comparison → action list) as the entry skill, with three companion calculators for break-even, gross-margin structure, and cash flow/payment terms. Every amount and ratio is produced by a calculator and carries its formula, input base, and source (source name/region/year/as-of date); when an external statistical base cannot be fetched, that item halts with an explicit 'base data source not connected/uncoded' notice, and filling gaps from the model's memory of industry figures is forbidden. When no industry signal pack is installed, this is honestly labeled and the analysis continues. Single-store business profiles can be persisted on the DAAS entity model (one store = one entity, with persistent indicators and alert rules). The core is written so small-business owners can understand it, with plain-language explanations for technical terms; institutional and government channels share the same core and differ only in shell and delivery.

- Species: facade (plaza category enum v1)
- Official: yes — curated by FindData

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Micro-Business · Core Checkup Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install MBcXTHtyyMOxDHmSUYvDdQ

3. From the market page: https://agent.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-04
