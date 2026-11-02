# Wire · Factor Selection / 柏讯 · 因子选股

## What this is

柏讯因子选股四件套：因子库与口径（52 因子九类清单、逐因子分子分母与报表期别、三个共线因子的剔除说明、数据可得性分档）、因子暴露与分层（走计算面，层数与极端值处理显式，IC 含 Pearson/Spearman，样本不足不作依据）、选股应用（多因子打分或条件筛选，产出候选 universe/目标权重，打分非预测）、无未来函数回测协议（财报用披露日而非报告期、universe 用当期成分、价格止于决策日、断言必须开启）。与自适应轮动套件的分工：轮动用价格类行业动量选组、本套件用基本面因子选股，两者可组合不重复；与个股投研套件的分工：那边做单只公司的深度报告，本套件做横截面的排序与筛选。因子值一律由计算面算出，不手算。回测为历史模拟，不构成投资建议。

Wire factor-selection four-skill suite: factor library and methodologies (a list of 52 factors in nine categories, with per-factor numerator, denominator, source statement and period, removal notes for three collinear factors, and data-availability tiers); factor exposure and quantile grouping (computed on the calculation surface, with explicit layer counts and outlier handling, IC incl. Pearson/Spearman, insufficient samples never used as a basis); stock-selection application (multi-factor scoring or conditional screening producing a candidate universe and target weights — scoring is not forecasting); and a no-look-ahead backtest protocol (financials dated by disclosure date, not reporting period; universe from current-period constituents; prices end at the decision date; assertions mandatory). Division of labor with the adaptive-rotation suite: rotation selects industry groups on price-based momentum, this suite selects stocks on fundamental factors — the two combine without overlap. With the single-stock research suite: that one produces in-depth reports on a single company, this one does cross-sectional ranking and screening. Factor values are always computed on the calculation surface, never by hand. Backtests are historical simulations and do not constitute investment advice.

- Species: facade (plaza category enum v1)
- Official: yes — curated by FindData

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Factor Selection", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install kimcQr9qSyGmbXej3CmeDg

3. From the market page: https://agent.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
