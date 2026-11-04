# Wire · Decision Review Suite / 柏讯 · 决策复盘套件

## What this is

把「当时的判定」变成可审计的历史：决策落账（追加式、幂等、修订留痕）→ 到期按基准结算真实 alpha → 提炼反思（只注入决策者，不广播）→ 持仓体检与最近判定的一致性核查。以账本为准，不美化历史；样本不足不下结论。与决策类 pack 的分工：决策 pack 产出 Rating/TargetWeights 实例，本套件负责统一落账与复盘（语义相同，不重复实现）。

Turns 'the call made at the time' into an auditable history: decision logging (append-only, idempotent, revisions leave traces) → settlement at expiry against a benchmark for realized alpha → distilled reflection (injected only into the decision-maker, never broadcast) → portfolio check-up and consistency check against the most recent calls. The ledger is the source of truth and history is never embellished; no conclusions on insufficient samples. Division of labor with decision packs: decision packs produce Rating/TargetWeights instances, this suite handles unified logging and review (same semantics, no duplicate implementation).

- Species: facade (plaza category enum v1)
- Official: yes — curated by FindData

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Decision Review Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install wqpd5rPCFl3qIHg6oLDamg

3. From the market page: https://agent.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-04
