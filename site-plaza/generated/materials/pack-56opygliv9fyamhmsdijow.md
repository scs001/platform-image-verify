# 晨报情报站

## What this is

官方团队模板：每日晨报情报站——科技与市场情报员每日清晨分头巡检，情报主编 8 点合成晨报；另含团队引用岗（existing-cluster，每周一做深度聚合，演示团队 fan-out 引用与派生报数）。演示：双情报源并行、晨报流、cluster 引用岗（公司种子只演示了 a2a）；编导段为 trigger+handoff 链（两情报员巡检完成接棒主编合成）与团队 report 上行。铸造上架时 packId/agents 按铸造脚本补齐；本文件是清单真源，测试钉住其必须通过 fleet 段预校验。

- Category: pack (plaza category enum v1)
- Official: yes — curated by FindData
- AI facade: no

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "晨报情报站", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 56opYgliV9FYAmhmsDIJOw

3. From the market page: https://plaza.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
