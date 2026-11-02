# Text Engine · Screenplay Classics Suite / 文本引擎 · 剧本经典套件

## What this is

公版经典剧本的检索与研究：结构分析（幕场/折出骨架与情节推进）、角色检索（台词聚合与形象分析）、场景检索（按描述定位并细读整场）、相似段落（语义向量找近邻，跨用词差异找情境）。语料覆盖莎士比亚、希腊悲剧、元杂剧、明清传奇、现代话剧（老舍）、京剧，共 18 部；每个结果携带 provenance 三件套（source/stable_id/as_of）。检索走 fd-text-core 引擎的混合通道（关键词 CJK bigram + 繁简归一 ⊕ 语义向量 Qwen3-Embedding-8B）。

Retrieval and research over public-domain classic plays: structure analysis (act/scene skeleton and plot progression), character search (line aggregation and character-portrait analysis), scene search (locate by description and close-read a whole scene), and similar passages (semantic-vector nearest neighbors that find matching situations across differing wording). The corpus covers 18 works — Shakespeare, Greek tragedy, Yuan zaju, Ming–Qing chuanqi, modern spoken drama (Lao She), and Peking opera; every result carries the provenance triplet (source/stable_id/as_of). Retrieval runs through the fd-text-core engine's hybrid channel (keywords CJK bigram + traditional/simplified normalization ⊕ semantic vectors via Qwen3-Embedding-8B).

- Category: facade (plaza category enum v1)
- Official: yes — curated by FindData
- AI facade: yes — deployable as a conversational service

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Text Engine · Screenplay Classics Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 1mAJYooWE-SajhzqTNMhBw

3. From the market page: https://plaza.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
