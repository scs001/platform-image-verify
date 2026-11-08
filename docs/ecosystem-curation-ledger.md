# 生态素材审校台账（Ecosystem Curation Ledger）

首批白名单定稿 2026-10-07，依据：许可证桌面调研（2026-10-07 agent 报告，8 搜索 + 2 仓核）+ `docs/ecosystem-curation.md` runbook。**台面轴（S1 许可证 / Q1 维护活性 / Q2 传输）本台账已过**；**入库轴（S2–S7 / Q3–Q5 + egress 决议）在 1.4 托管 / 1.5 技能入库时逐条执行**——需要代码与容器在手，runbook 既定分期。

## 0. 背景事实（调研结论，影响全局）

- SKILL.md 已是跨 harness 开放标准（agentskills.io，2025-12-18 发布；Codex 2026-01、Gemini CLI 2026-04 采纳，~30 个 agent 读同格式）——单一格式策展成立。
- 官方参考 server 分两仓：活跃 `modelcontextprotocol/servers`（MIT/Apache 双许可）与冻结 `servers-archived`（MIT 但不维护）——**只收活跃仓**。
- 三条硬地雷：① anthropics 文档技能族（docx/pdf/pptx/xlsx）source-available 非开源；② firecrawl 引擎 AGPL+附加条款（其 MIT MCP wrapper 指云端是安全形态，但引入商业依赖，首批不收）；③ awesome 索引类条目许可证逐条核，无 LICENSE 即拒。

## 1. 首批 MCP server 白名单（12 条，上限内）

| # | Server | 上游 | 许可证 | 传输 | 台面轴 | 备注 |
|---|---|---|---|---|---|---|
| 1 | filesystem | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 沙箱文件读写，agent 基线 |
| 2 | fetch | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 网页取读；egress=open 候选 |
| 3 | playwright-mcp | microsoft/playwright-mcp | Apache-2.0 | stdio+HTTP | ✅✅✅ | 浏览器自动化，替代已档 puppeteer；egress=open 候选 |
| 4 | github-mcp-server | github/github-mcp-server | MIT | 原生 streamable HTTP | ✅✅✅ | **免托管**（GitHub 官方远端），只需注册处登记+凭据通道 |
| 5 | git | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 本地 git 操作 |
| 6 | memory | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 跨会话知识图谱 |
| 7 | sequential-thinking | modelcontextprotocol/servers | MIT/Apache | stdio | ✅✅✅ | 结构化推理脚手架 |
| 8 | excel-mcp-server | haris-musa/excel-mcp-server | MIT | stdio+HTTP | ✅✅✅ | xlsx 全读写；金融/法务工作簿核心 |
| 9 | postgres-mcp | crystaldba/postgres-mcp | MIT | stdio(Docker) | ✅✅✅ | 只读模式加固；接平台 fd-postgres 场景 |
| 10 | tavily-mcp | tavily-ai/tavily-mcp | MIT | 远端 HTTP | ✅✅✅ | 搜索/抽取；**需 Tavily 商业 API key**——托管前过 S6（凭据从平台侧注入 vs 用户自带）决议 |
| 11 | yfinance-mcp | narumiruna/yfinance-mcp | MIT | stdio | ✅✅⚠️ | 代码 MIT，**Yahoo 数据 ToS 是约束非许可问题**——台账记 ToS 合规义务 |
| 12 | CourtListener MCP | freelawproject | 宽松（入库时逐仓核 LICENSE 原文） | 远端+API | ✅✅⚠️ | 美国判例/案卷唯一严肃开源源；免费 API key |

可选第 13：time（官方，MIT，stdio）——日期类错误消除器，量小时顺带。

**明确不收（首批）**：sqlite/postgres/puppeteer 官方版（archived 冻结）；firecrawl（引擎 AGPL）；browserbase（商业云依赖）；brave/exa（API key 型，等需求再议——同 tavily 模式可后补）。

## 2. 首批技能集（~40 条，三源）

| 源 | 许可证 | 取用子集 | 台面轴 |
|---|---|---|---|
| anthropics/skills | 示例技能 Apache-2.0；**文档技能族 source-available 排除** | skill-creator、mcp-builder、artifacts-builder、canvas-design、frontend-design、webapp-testing、brand-guidelines 等 ~10 | ✅✅✅ |
| obra/superpowers | MIT | brainstorming、writing/executing-plans、TDD、systematic-debugging、verification-before-completion、code-review 族、subagent-driven-development、git-worktrees 等 ~18 | ✅✅✅ |
| VoltAgent/awesome-agent-skills | 逐条（索引） | data-analysis / web-research / documents 类精选 ~10；**硬门：只收链接仓库带显式宽松许可证的条目** | ✅⚠️✅ |

## 3. 台账条目（runbook §1 格式，逐条可追加）

### filesystem / fetch / git / memory / sequential-thinking（官方参考族）— 2026-10-07
- 上游: modelcontextprotocol/servers（活跃仓，commit 钉点入库时定）
- 许可证: MIT/Apache 双许可
- 状态: 入库待托管（1.4）
- 审校: S1✓ Q1✓ Q2✓（stdio——1.4 时按 runbook Q2 评估容器化/代理面）；S2–S7、egress 待容器审

### playwright-mcp — 2026-10-07
- 上游: microsoft/playwright-mcp
- 许可证: Apache-2.0
- 状态: 入库待托管（1.4）
- 审校: S1✓ Q1✓ Q2✓（HTTP 形态）；egress=open 候选（语义即浏览，S7 必过）

### github-mcp-server — 2026-10-07
- 上游: github/github-mcp-server（官方远端 streamable HTTP）
- 许可证: MIT
- 状态: 入库待注册（1.4 简化路径：免自托管，登记远端+egress vault 凭据模式）
- 审校: S1✓ Q1✓ Q2✓（原生 HTTP）；S6 决议=用户各自 GitHub PAT，不落平台凭据

### excel-mcp-server — 2026-10-07
- 上游: haris-musa/excel-mcp-server
- 许可证: MIT
- 状态: 入库待托管（1.4）
- 审校: S1✓ Q1✓ Q2✓；egress=none 候选（纯本地文件处理）

### postgres-mcp — 2026-10-07
- 上游: crystaldba/postgres-mcp
- 许可证: MIT
- 状态: 入库待托管（1.4）
- 审校: S1✓ Q1✓ Q2✓；egress=none + 只读模式强制；S6 决议=连接串归属（用户自带 vs 平台样本库）

### tavily-mcp — 2026-10-07
- 上游: tavily-ai/tavily-mcp
- 许可证: MIT（server）
- 状态: 考察中（商业 API 依赖待运营拍板）
- 审校: S1✓ Q1✓ Q2✓；S6 决议未定：平台注入 Tavily key（计费/额度谁担）vs 用户自带

### yfinance-mcp — 2026-10-07
- 上游: narumiruna/yfinance-mcp
- 许可证: MIT
- 状态: 入库待托管（1.4，带 ToS 合规注记）
- 审校: S1✓ Q1✓ Q2✓；Yahoo ToS 义务记档：频率克制、不转售数据

### CourtListener MCP — 2026-10-07
- 上游: freelawproject（具体 repo 入库时钉）
- 许可证: 宽松族（**入库时逐仓核 LICENSE 原文**）
- 状态: 考察中（免费 API key 流程待验）
- 审校: S1⚠️ Q1✓ Q2✓

### anthropics/skills（Apache 子集）— 2026-10-07
- 上游: anthropics/skills
- 许可证: Apache-2.0（仅示例技能；文档族 source-available **已排除**）
- 状态: 入库待整理（1.5）
- 审校: S1✓ Q1✓ Q2✓（内容型）；S5 注入面逐条过 SKILL.md 正文

### obra/superpowers — 2026-10-07
- 上游: obra/superpowers
- 许可证: MIT
- 状态: 入库待整理（1.5，~18 条）
- 审校: S1✓ Q1✓ Q2✓；S5 逐条

### VoltAgent/awesome-agent-skills 精选 — 2026-10-07
- 上游: 逐条目仓库（索引非源）
- 许可证: 逐条——**无 LICENSE 即拒（硬门）**
- 状态: 考察中（精选 ~10 条待逐条定）
- 审校: S1 逐条 Q1 逐条 Q2✓；这是无证条目渗入的高危面

### anthropics/skills（Apache 子集）— 入库执行 2026-11-03
- 上游: anthropics/skills，**逐技能读 LICENSE.txt**（仓库级 None 不可采信）；pin `ca45fc496a3436251f191354091d557da31c15b5`
- 入库: 10 条新 eco-*（frontend-design / web-artifacts-builder / webapp-testing / theme-factory / algorithmic-art / slack-gif-creator / internal-comms / brand-guidelines / academy-guide / discernment-nudge），既有 3 条（skill-creator / mcp-builder / canvas-design）不动——其 md_url 仍指 /main/（可变），重钉版留待再审批
- 形态: `POST /api/skills`（admin JWT 自签 HS256+token_kind=user 走边缘 auth_request；两单 504=扫描完成晚于响应，本体均已 enabled/active；扫描未完不上市场列表=预期行为）；md_url=pin 的 raw 提交 URL（不可变，免疫漂移自动停用）；license=Apache-2.0；tags=[ecosystem,anthropics]；metadata.extra 记 provenance=ecosystem+pinned_revision
- 排除: **pdf/docx/pptx/xlsx=Proprietary（"may not distribute/create derivative works"）永久拒**；doc-coauthoring=无许可声明拒；claude-api=许可合法但 60+ 辅助文件超包边界，不列
- 双面上产: 同 13 条已作 **official-adopted 功能集**发市场（facet packs，中文门面+en 覆盖层，packId 台账见 fleet-packs `adopted/LEDGER.md`）；注册处目录=材料广场源（facet catalog 207，eco 13 全见）
- 审校: S1✓ Q1✓ Q2✓ S5 逐条（正文即上游快照）；许可门逐技能原文留证（`/tmp/curated-raw/*/provenance.json`+audit.json）

### obra/superpowers — 状态改判 2026-11-03
- 考察中→**本批不入库**：15 条技能正文以执行能力为前提（跑测试/建分支类指令），装进 handless 转正产物即谎报触手；改铸需逐条改写执行段=创作工作量，另立项再议

### VoltAgent/awesome-claude-code-subagents — 改铸上市场 2026-11-03
- 许可证: MIT（仓库 LICENSE 实读）；pin `ed74d115b7fb7026a22a4f816a8e3250f425e3b4`
- 处置: 不走注册处单条入库，**8 岗「读—判—说」改铸**成一支官方 pack「研发评审小队」（`jwDL7dSYKjp7_NnQpk7DPA` v1，persona-only/chat 面，逐岗 persona 留上游文件出处+钉版）；176 角色中的"动手型"一律规避
