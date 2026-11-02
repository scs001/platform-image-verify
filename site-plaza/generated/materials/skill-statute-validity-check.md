# statute-validity-check

## What this is

法条检索与效力核查。当用户要查某法条原文、核对某条文是否现行有效、确认条号是否因修订变动、查某法律问题的法律依据（"能不能""是否有效""如何认定""依据哪一条"）时使用。语义召回候选条文后逐条锚定效力状态，输出带效力状态与 provenance 的法条清单；非"有效"版本明确标注不得作现行法。

- Species: skill (plaza category enum v1)
- Official: no

## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.

## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-02
