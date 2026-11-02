## Why

素材广场需要一个对外的"理解面"：让不同语言背景的**人**和 **AI** 都能理解我们提供了哪些基础设施、如何提供、现在具备哪些素材（用户原始令，2026-11-02）。平台内部已把 MCP 工具注释成"对 localized 人 + 对 AI canonical"的双面（market-annotations 生产层），广场把这个立场公开发布；清单真源复用 facet 市场单一上市判据，官网按 house 配方纯静态上产（site-zhiyu + 雷池/Caddy 先例）。

## What Changes

- 新增 `site-plaza/` 纯静态官网（plaza.finddatatech.cloud）：五语人面（hero + 五类素材卡墙 + 机制链四段 + 素材目录 + 给谁用 + 五行梯页脚）+ AI 面（/llms.txt、/llms-full.txt、/catalog.json、/materials/*.md、/infrastructure.md、人面 JSON-LD + 机器孪生链接）。
- 新增 `scripts/plaza-export.mjs` 构建期导出管线：从 facet 市场 API（`loadListedPacks` 单一上市判据）生成 snapshot.json / catalog.json / llms.txt / materials markdown / 人面计数注入。
- 新增导出校验门：ai_readable 六条 lint、catalog 与 /api/packs 数目对账、llms.txt 链接可达断言、五语 parity 沿用 check-locales。
- HTML 素材目录画廊双层新鲜度：客户端实时拉 /api/packs，失败静默退回构建期快照并标注"快照截至"。
- 品牌串全部按 v5 终词「壹座·智能体素材广场」/ "Yizuo Agent Materials Plaza"（前置：rename-agent-materials-plaza）。

## Capabilities

### New Capabilities

- `agent-materials-plaza`: 广场官网的行为契约——五语人面结构、AI 机器面形状、单一上市判据复用、快照新鲜度语义、导出校验门、自足 Markdown 纪律。

### Modified Capabilities

（无——facet 市场 API 与 facet-platform 行为零改；本 change 只读市场，不改市场。）

## Impact

- 新文件：`site-plaza/`（静态站，纯 HTML/CSS/JS + 五语 JSON 文案）、`scripts/plaza-export.mjs`、`scripts/test-plaza-export.mjs`。
- 部署：新域名 `plaza.finddatatech.cloud`（DNS A → 雷池 103.236.89.212 由域主加；Caddy 每域一块 file_server，配方同台账 §15.59）。
- 依赖：读 facet `/api/packs`（匿名可读面）；不新增任何写路径、不新增服务进程——纯静态 + 构建期脚本。
- 门：新 `test-plaza-export.mjs` 入 unit 冒烟；ai_readable lint 门入导出（红则构建失败）。
- 前置：`rename-agent-materials-plaza`（品牌终词）先行归档或同班落地。
- 外部记挂：www 官网 products/facet 页互链；兄弟站（zhiyu/yongyi/facet）页脚互链往返。
