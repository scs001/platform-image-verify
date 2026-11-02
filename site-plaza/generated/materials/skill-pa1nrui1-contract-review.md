# pa1nrui1-contract-review

## What this is

基于张海燕四步审查法+何力/常金光三观分析法，对合同进行深度审查。支持企业核验、多语言自动检测、Mermaid业务流程图、二段式审核意见、合同概览、客户可读合同编号、业务摘要、22类合同专项审查、续约提醒和 Word 修订模式审核红线稿。飞书正式交付物必须包含问题卡片列表和业务流程图；用户选择修订模式时，以原合同为只读来源，先生成 redline-plan.json，再运行 scripts/redline/apply_redline_plan.py 生成带真实修订痕迹和批注的 Word 审核修订稿，并完成红线 QA。其他记录保存为本地 Markdown。

- Species: skill (plaza category enum v1)
- Official: no

## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/pa1nrui1/legal-skills


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-02
