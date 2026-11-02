# Text Engine · Paper Research Suite / 文本引擎 · 论文研究套件

## What this is

学术论文的检索与研究：文献综述（方向定位与脉络梳理）、方法追踪（提出/变体/应用谱系）、相关工作（语义相似文献与对比矩阵）。语料覆盖 arXiv q-fin 与 cs.CL 等八个类目的千级样本（元数据 + 摘要，CC0 元数据）；外部开放检索（arXiv/OpenAlex/Semantic Scholar）编排补充。**版权红线**：只返回元数据、摘要、切块引用与指回 arXiv.org 的原文链接，本服务不提供也不外发论文全文。检索走 fd-text-core 引擎的混合通道（关键词 ⊕ 语义向量 Qwen3-Embedding-8B）。

Retrieval and research over academic papers: literature review (framing the direction and mapping the thread), method tracking (lineage of proposals/variants/applications), and related work (semantically similar papers and comparison matrices). The corpus covers thousand-scale samples across eight arXiv categories including q-fin and cs.CL (metadata + abstracts, CC0 metadata); external open search (arXiv/OpenAlex/Semantic Scholar) is orchestrated as a supplement. **Copyright red line**: only metadata, abstracts, chunked quotes, and links pointing back to arXiv.org are returned — this service neither provides nor sends out full paper texts. Retrieval runs through the fd-text-core engine's hybrid channel (keywords ⊕ semantic vectors via Qwen3-Embedding-8B).

- Species: facade (plaza category enum v1)
- Official: yes — curated by FindData

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Text Engine · Paper Research Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 1OQ93FLBzzVGcn2js31ADA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-02
