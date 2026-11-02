# Infra Factory Fleet / 工厂集群

## What this is

工厂集群：Owner 自用的三岗运行编制——巡检岗按可计数阈值观测全部在册集群与基础设施并逐条目落异常清单；优化岗把已确认异常只经既有提案面转为配置/蓝图/技能/跨面提案并附条目依据；报班岗按周汇总异常台账、提案四态计数与成本走势，拍板件走 decision_queue 正式呈报。提案与批准分离：红线动作永远人工，批准前零写动作。 含集群模板 fleet 段（三岗编排：巡检→优化→报班；装包后经壹座「团队→从模板实例化」建队）。

Owner-facing three-post fleet: the sentinel audits all registered fleets and infrastructure against countable thresholds and lands a per-item anomaly ledger; the optimizer routes confirmed anomalies through existing proposal surfaces only, each citing its ledger entry; the shift lead delivers a weekly digest and puts decisions in the decision queue. Proposals and approvals stay separate; red-line actions are always human.

- Category: pack (plaza category enum v1)
- Official: yes — curated by FindData
- AI facade: no

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Infra Factory Fleet", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install bKipx4urGfO5TE6GjJ9Ihg

3. From the market page: https://agent.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
