# Wire · Info Shock / 柏讯 · 信息冲击

## What this is

柏讯信息冲击四件套：冲击识别（先查来源健康度，游标拉取+检索补漏两路，按来源三型与七组冲击类型初筛，逐条附 item_id、发布时间与正文状态）、冲击解读（读正文抽金额/比例/期限/主体/生效条件五要素，结论分明确与需看条件两栏，每条结论附证据块：item_id + as_of + 经 locate_evidence 核对的原文逐字片段；强断言缺可定位证据时只作「据标题/摘要，正文未核实」弱表述）、影响窗口统计（前窗 5 日基准 + 后窗 5/10/20 日并列，样本量、分位、离散度与必选的反例比例随表输出，样本不足整表标注「不作依据」）、信息流跟踪（来源与类型计数、期间对比、健康度水位，滞后与不可用前置「信息可能不完整」）。与事件驱动套件的分工：事件驱动走 fd-cn-report 公告面，本套件走 info-stream 统一信息条目（公告+部委+互动），以 item_id 为引用锚点、以逐字证据为结论门槛。核心纪律：健康度前置（引用前先查 stream_health，lag 超阈值声明信息可能不完整，空结果不得写成没有事件）、不预测（不给涨跌预期）、正文支撑（标题只是检索入口）、历史分布非预测（样本量与反例比例强制随表）。不构成投资建议。

Wire Info Shock four-skill set: shock identification (source health first, then cursor pull plus retrieval as two complementary paths, initial triage by three source types and seven shock-type groups, each item with item_id, publish time and body status), shock reading (read the body and extract five element classes — amount, ratio, horizon, party, effectiveness condition — with conclusions split into 'explicit' vs 'depends on conditions'; every conclusion carries an evidence block: item_id + as_of + a verbatim quote verified through locate_evidence; strong assertions without locatable evidence are downgraded to 'per title/abstract, body unverified'), impact-window statistics (front 5-day baseline vs back 5/10/20 trading days side by side, sample size, quantiles, dispersion and a mandatory counterexample ratio accompany every table; insufficient samples mark the whole table 'not to be relied on'), and stream tracking (source and type counts, period comparison, health watermark; lags and outages are prefixed 'information may be incomplete'). Division of labor with the event-driven suite: event-driven works the fd-cn-report announcement face, this suite works info-stream unified items (announcements + ministries + interactions), with item_id as the citation anchor and verbatim evidence as the bar for conclusions. Core discipline: health first (check stream_health before citing; if lag exceeds the threshold, declare 'information may be incomplete'; never report an empty result as 'no events'), no prediction (no up/down expectations), body-text support (a title is only a search entry), historical distribution is not forecast (sample size and counterexample ratio are mandatory). Not investment advice.

- Category: facade (plaza category enum v1)
- Official: yes — curated by FindData
- AI facade: yes — deployable as a conversational service

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Info Shock", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install tXQaAuRY2F-Kog-rb21bCw

3. From the market page: https://plaza.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
