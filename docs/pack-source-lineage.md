# pack 源码所有权矩阵（2026-10-30 建制）

背景：市场（facet packs）是**唯一分发通道**，而很多官方包（功能集/智能体）的**源码**散在
finddata 侧目录里。此前 `~/finddata/fleet-packs`（14 枚官方包唯一铸源）**完全没有版本控制**——
一次误删/换机即源码全灭；且源与市场分叉两处已实锤（详见 §风险实录）。本文件钉死
「哪枚包的源码在哪、哪个仓保着、怎么防冲」，后续会话勿再摸黑。

## 一、源码落点矩阵（市场在册 96 枚中我方作者的官方包）

| 源码落点 | 保护通道 | 覆盖的包 |
|---|---|---|
| `FindDataTechnology/fleet-packs`（GitHub 私仓；本机 `~/finddata/fleet-packs`） | git main=ff315f1（2026-10-30 转 git；此前裸目录） | 共用层六枚（简报与报数/看板投稿/情报采集/数据问答/评测哨/蓝图构造师）+ 七线模板包（情报舆情/法规追踪/识律政心监测/识律营销/官网内容/谦面运营/萬星机群运营）+ 跨境电商政策盯梢（blueprints/） |
| paas 仓 `docs/fleet-templates/*.seed.json` | git（origin fd-craw-private） | 六枚官方种子（AI 公司/内容工厂/晨报情报站/投研晨会官方种子/客服班组/壹座产品介绍） |
| paas 仓 `docs/official-packs/*.json` + `server/pack-author-mcp.js`+`docs/pack-author.seed.json` | git | 助手三枚（柏讯助手/萬星机群助手/谦面助手）+ 分身类（寻数分身/分身工坊） |
| `FindDataTechnology/finddata-skills`（gitee，已同步） | git | 套件类技能的 SKILL.md 源（识律六套件←legal-presets、柏讯系列←wire-presets/market-analysis、CRM←crm-desk、平台运营←platform-ops 等） |
| 各 MCP 服务仓（fd-lex/wire-ops-mcp/facet-ops-mcp/wanxing-ops-mcp/wire-build-mcp/fd-legal-search-mcp/…） | git+gitee（惯例） | 包引用的工具面（registryName）与其 allowTools 事实来源 |
| `FindDataTechnology/fd-info`（GitHub 私仓；2026-10-30 转 git；此前**裸目录**） | git main=06b9291 | 情报线 MCP 服务本体（被 6 枚包引用：fd-info registryName） |
| **仅市场 packs.db**（无文件源） | cronjob `facet-packs-backup` 每日 03:17 快照 42 份 | 构造间铸造的其它包（如 柏讯·产物构建/投研三镜头/事件驱动等 blueprint 徽章件、看板类）——**再铸依据在铸造者 cell 的蓝图库里**，本仓不可见 |

> 蓝图格式契约真源 `blueprints/schema.md`（v2）现随 fleet-packs 入版本控制；
> paas `server/blueprint-validate.js` 的「格式真源」注释指向该仓。

## 二、防冲三件套（fleet-packs 仓内建制，2026-10-30）

1. **市场为真值**：源 `manifest.json` 必须逐字段等于市场现行版；显示字段改动的正确次序=
   先市场发新版 → 回填源。只改市场不改源 = 下次重发冲掉（词表改名曾全量分叉，实证过）。
2. **漂移哨**：`python3 fleet-packs/scripts/check_drift.py`（读 facet 实盘逐字段对拍 + 对外字段
   内部物泄漏扫描），发布前后各跑一次，exit 0 才算完。
3. **机器台账**：fleet-packs README「机器台账」节（slug→packId→版本→源目录）——cast 脚本
   `parse_ledger` 只认小写 slug 行；中文名行曾导致**重铸链整体断链而无人知**（`ledger empty`）。

## 三、本批已修风险实录

- fleet-packs 裸目录 → 转 git（fbe0602 原样快照 + ff315f1 对齐建制）推 GitHub FDT 私仓；gitee 企业 API 无门（404/400），第二保护位挂账。
- 源与市场分叉三层：manifest 名/描述（旧词）、cast.json tags、**template.json agents/fleet 还是第一代岗位文案（情报巡检员/XX舰队）而市场现行是改铸后的位词版** → 全部回填为市场真值；cast 脚本缺 `i18n` 透传（重铸会丢 11 枚英文副轨）→ 已补（skills 实跑副本与仓内 tooling/ 副本同版）。
- 市场对外字段泄漏内部物：`fleet-packs/blueprints/...` 路径、`schema.md` 路径、`L3/harness` 阶段词、`add-*` change ID、`共用层 L1`、`4.4 挂账销账` → 8 枚发去敏新版（跨境电商 v6、蓝图构造师 v7、共用五枚 +1、官网内容 v9），源同步回填。
- fd-info 裸目录 → 转 git 推 GitHub FDT 私仓（06b9291）。

## 四、挂账（不动，等裁决/另批）

- **双胞胎包待裁**：跨境电商政策盯梢（`C8wx14…`本仓铸 v6 vs `_PGsJcBw…`构造间再铸 v7）、
  投研晨会（`Bo2…`单岗 v5 vs `YMSt…`官方种子 v4）——留一退一=产品裁决。
- **tags 旧词清扫**：市场 tags 仍含「集群/舰队/模板/harness」词面（名/描述已清）——随词汇清扫批，
  哨以 KNOWN_LEAKS 降级不判红。
- persona/skill 正文的「集群」句（内容层）：v4 决议内容层不进改名面，维持原样。
- finddata 其余裸目录（attic/docs/dashboards/plans/resources/scripts/secrets 等）=工作文档非包源，
  不入本矩阵；secrets 目录**永不**入任何仓。
- facet/ 与 wanxing/ 与 marketing/ 三目录无 cast.json（手写 manifest 形态）：重铸需先补 cast.json
  或继续手编+哨兜底。
