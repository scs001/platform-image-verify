# legal-element-extraction

## What this is

当需要从案件描述、当事人陈述、聊天记录、媒体报道等非结构化文本中提取具有法律意义的事实时触发此技能。 典型触发场景包括但不限于： - 用户提供一段日常语言的案件描述，要求提取法律事实 - 用户要求将口语化、情绪化的叙事转化为法律分析可用的事实结构 - 用户要求区分案件叙述中的"客观事实""主观判断"和"法律评价" - 用户要求将提取的事实对应到特定法律关系的构成要件 - 用户要求整理案件时间轴或制作事实梳理表 - 用户要求将生活语言转化为法律语言（如"他一直拖着不还"→"履行期限届满后未履行"） 本技能的核心价值：将混杂的生活叙事整理为可进入法律推理的事实结构，是法律分析的前置步骤。

- Species: skill (plaza category enum v1)
- Official: no

## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/THUYRan/Legal-Skills-Chinese


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-02
