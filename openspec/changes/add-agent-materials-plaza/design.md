## Context

底稿 `docs/plaza-explore.md`（探索全记录：事实底座、五裁定、IA、管线、风险）。前置：`rename-agent-materials-plaza` 提供 v5 品牌终词。三个关键家世：①生产注释层 `market-annotations.json` 已有 canonical+human 五语+provenance 形状（AI 面零新增词汇的依据）；②官网部署配方在册（site-zhiyu 纯静态 + 雷池 WAF → 本机 Caddy file_server，台账 §15.59 yongyi/memory 双域名先例）；③facet `loadListedPacks` 是唯一上市判据（wire-marketplace-json-curation 疤——第二套上架规则已经出过一次事故）。

## Goals / Non-Goals

- Goals：让外部人与 AI 在零协助下理解"提供什么基础设施 / 怎么提供 / 现有什么素材"；清单真源单一；新鲜度可见；AI 面可被门守。
- Non-Goals：不改 facet 市场 API 与 facet-platform 行为（只读）；不做登录/发布/订阅（动作全部跳转壹座与 facet 既有面）；不做服务端渲染或新进程；本 change 不含 DNS 操作（外部件）。

## Decisions

1. **纯静态 + 构建期导出，不建服务**（D3 裁定落地）。备选"边缘函数实时代理市场 API"被否：多一个进程多一条运维面，而快照+客户端刷新已满足新鲜度；site-zhiyu 同配方零服务先例。
2. **catalog.json 复用注释层形状，零新词汇**（D4）。备选"自造 schema.org 全套"被否：生产注释层已是双向注释的家法，跨源不可混排（official-adopted-agents 律），AI 面与运行时面用同一形状才谈得上"平台内外的 AI 读到同一套素材"。
3. **单一上市判据 = import `loadListedPacks`**（D3/D4 交叉）。备选"导出端重写过滤"被否——判据漂移即假上架。
4. **AI 面三件套分层**：llms.txt（索引面，en 主 zh 镜）→ catalog.json（数据面）→ materials/*.md（叙事面）。llms.txt 生态尚在形成期，故自足 Markdown + JSON-LD 是主承载（D5 风险裁决）。
5. **六条 ai_readable lint 做成门而非守则**（星研纪律的家世：规则写了没人查就等于没有；星研把 ai_readable_check 做成了第 4 道机检，广场同法）。
6. **slug 稳定性走"内容寻址不做"**：slug = packId 派生（packs-<packId> 先例见 docs/wanxing-serving-api.md），内容更新不动地址；类目枚举带版本字段。
7. **域名 plaza.finddatatech.cloud**：一产品一域名家族（yongyi/memory/zhiyu/wanxing/facet/mcp）。备选"挂 www 子路径"被否：www 是另仓另班，互链即可不强绑。

## Risks / Trade-offs

- 快照新鲜度：静态面天然滞后；缓解=客户端实时刷新+快照日期永远可见（走查班验证两态）。
- 五语 L10n 成本：机器面 en 主 zh 镜已减半；人面五语沿用既有 parity 门，es/fr/ja 由导出模板产出后人工校。
- 冷读三问断言依赖模型判定，非确定性——lint 里做成"三问结构字段齐全"的确定性检查 + 走查班抽真机冷读双保险。
- facet 匿名读面若限流收紧，导出构建在 CI 可能被 429——导出脚本带退避与上次快照续跑。
