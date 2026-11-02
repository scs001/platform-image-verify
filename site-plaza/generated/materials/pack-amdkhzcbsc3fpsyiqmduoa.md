# Wire · Sentiment-Driven / 柏讯 · 舆情驱动

## What this is

柏讯舆情驱动三件套：把公告文本变成带原文引用、可核验、可追踪的观察维度——公告舆情审读（sentiment-document-review，逐篇打分必带引用与字符定位、多篇给分布而非平均情绪、服务拒答如实转述、低置信显式标注）、舆情转向追踪（sentiment-trend-watch，按公告发布日排布、转向点必须附对应文档、样本门槛单期 ≥3 篇且高置信 ≥2 篇、覆盖面与置信度固定两栏）、舆情与价格持仓的描述性对照（sentiment-signal-bridge，只陈述时间先后不断言因果、相关性陈述须 ≥12 对且走计算面、严禁给买卖建议与「信号」称谓）。与投研套件的分工：研报的催化剂章引用本套件分数，不重复打分（同一服务同一幂等键，重复调用命中缓存）；与策略工坊的分工：那边做信号与回测，本套件只做描述性对照不给信号。分数不预示价格、当前版本（gold-v10 / prompt v7）两轮复测置信桶单调递增、方向一致率 99.19%，但五档精档之间仍有相邻档误判，均如实标注。

Wire Sentiment, a three-skill set that turns announcement text into observable dimensions that carry verbatim quotes and can be verified and tracked — announcement sentiment review (sentiment-document-review: per-document scores must carry citations with character offsets, multiple documents yield a distribution rather than an average mood, service refusals are relayed as-is, low confidence is flagged explicitly), sentiment turn tracking (sentiment-trend-watch: scores laid out by announcement publication date, every turn point must cite its corresponding document, sample thresholds of ≥3 documents per period and ≥2 high-confidence, coverage and confidence as two fixed columns), and a descriptive comparison of sentiment against prices and holdings (sentiment-signal-bridge: states temporal order only and never asserts causality, correlation claims require ≥12 pairs and go through the compute plane, buy/sell advice and the word "signal" are strictly forbidden). Division of labor with the Equity Research suite: the report's catalysts section cites this suite's scores instead of re-scoring (same service, same idempotency key — repeat calls hit the cache); division of labor with the Strategy Lab: that side builds signals and backtests, this suite only does descriptive comparison and gives no signals. Scores do not predict prices; in the current version (gold-v10 / prompt v7) two rounds of re-testing show monotonically increasing confidence buckets and 99.19% directional agreement, yet adjacent-band confusion persists among the five fine bands — all stated as-is.

- Category: facade (plaza category enum v1)
- Official: yes — curated by FindData
- AI facade: yes — deployable as a conversational service

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Sentiment-Driven", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install aMdkHzCbsc3fPsYiqMDUOA

3. From the market page: https://plaza.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
