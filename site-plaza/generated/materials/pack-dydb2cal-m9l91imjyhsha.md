# Wire · Paper Trading Suite / 柏讯 · 模拟交易套件

## What this is

柏讯模拟交易（paper trading）三件套：对话操作（账户/持仓/下单/撤单）、策略工作流（模板与沙箱自定义代码、回测解读、纸面实盘）、行情检查（搜索/历史K线/覆盖边界诚实呈现）。paper-only：模拟盘、无真实资金；调用者身份逐请求鉴别，只操作自己的账户；行情覆盖由部署的概念族决定，技能以诚实呈现覆盖边界为第一纪律。

Wire paper trading three-skill suite: conversational operations (accounts/positions/orders/cancellations), strategy workflow (templates and sandboxed custom code, backtest interpretation, paper-live runs) and market-data inspection (search/historical candlesticks/coverage boundaries stated honestly). Paper-only: simulated account, no real money; the caller's identity is authenticated per request and only their own accounts are touched; market-data coverage is set by the deployed concept families, and the skills' first discipline is to present coverage limits honestly.

- Category: facade (plaza category enum v1)
- Official: yes — curated by FindData
- AI facade: yes — deployable as a conversational service

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Paper Trading Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install DydB2cal-M9l91IMJYHshA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
