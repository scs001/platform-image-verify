# Wire · Portfolio Risk / 柏讯 · 组合风险

## What this is

柏讯组合风险四件套：风险预算（单票与板块上限 + 超限按比例重分配 + 迭代上限显式 + 未收敛如实报告，产出合规 TargetWeights）、回撤与波动体检（最大回撤起止/年化波动/HHI/前 N 占比/行业集中度/有效标的数 + 基准超额与跟踪误差，指标走计算面，体检不预测）、止损纪律（量级起点 -5%/-10%/20 日冷却 + 按标的波动重标 + 三处明示引擎不自动执行 + 触发检查只呈现状态不新增判断）、再平衡方案（逐标的差额/方向/股数 + 佣金印花税滑点分项成本 + 可送权重模式回测 + 不含择时）。与决策复盘套件的分工：复盘看现状（集中度/回撤/偏离），本套件定纪律（预算怎么分、止损怎么设、什么时候该动手），一静一动。与策略工坊的分工：工坊讲通用参数含义，本套件把纪律应用到用户的实际持仓上。paper-only：无真实资金；所有指标是历史与当前状态描述，不构成投资建议。

Wire Portfolio Risk, a four-skill set: risk budgeting (per-position and sector caps + proportional reallocation on breach + an explicit iteration cap + honest reporting when it fails to converge, producing a compliant TargetWeights instance), drawdown and volatility checkup (max drawdown start/end, annualized volatility, HHI, top-N weight, sector concentration, effective number of holdings, plus benchmark excess return and tracking error — indicators come from the compute plane and a checkup predicts nothing), stop-loss discipline (magnitude anchors -5%/-10% and a 20-day cooldown + volatility-based re-scaling per holding + three explicit statements that the engine never auto-executes + trigger checks that present status without adding judgments), and a rebalancing plan (per-holding delta / direction / share counts + itemized commission, stamp tax and slippage costs + a weight rule submittable to weight-mode backtest + no market timing). Division of labor with the Decision Review suite: review looks at the present state (concentration / drawdown / drift); this suite sets the discipline (how to split the budget, where stops go, when to act) — one static, one active. Division of labor with the Strategy Lab: the lab explains generic parameter meanings; this suite applies the discipline to the user's actual holdings. Paper-only: no real money; every indicator describes history and current state and does not constitute investment advice.

- Category: facade (plaza category enum v1)
- Official: yes — curated by FindData
- AI facade: yes — deployable as a conversational service

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Portfolio Risk", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install mFYxWUfp5oHsPcpRDhxAhw

3. From the market page: https://plaza.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
