# case-dashboard

## What this is

律师案件看板。本地零依赖看板服务（案件总览、任务三态看板、期限预警、进度写回）＋周研判分析。当用户说"打开看板/dashboard/案件面板/看下案件进度/给我案件周报研判"时使用。案件状态写入与上下文管理用 case-progress（/progress 命令也归它）。不要用于：案件实体分析、文书起草、法律研究。

- Species: skill (plaza category enum v1)
- Official: no

## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/cat-xierluo/legal-skills


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-02
