# add-doc-studio — Tasks

## 1. 切片① 执行层（runtime 镜像）

- [x] 1.1 仓根新建 `requirements-office.txt`（钉版：python-docx / openpyxl / python-pptx / mammoth；markitdown 实测出局——185MB 重依赖零质量加成，用户定案 B 瘦身），干净 venv 验证可装、无重依赖、三格式写读回环全绿（site-packages 58MB 实测留档）
- [x] 1.2 Dockerfile runtime 阶段加 `python3 python3-pip`（沿用 aliyun apt 源惯例）+ pip 国内镜像装 requirements-office.txt；`docker build` 过，容器内 `python3 -c "import docx, openpyxl, pptx, markitdown"` 全通
  - **CI 实证（scs001/platform-image-verify image-build-check run 37784214791）**：build ✓（冷 20min/缓存 3min）+ 镜像内 office 冒烟 ✓（python3 + 四库 import + docx round-trip；markitdown 已出局故实际为 mammoth）。注：/api/config boot 冒烟红=dsh lock 与 package.json 不同步+peer 两代互斥（桌面线修，missing 清单已交底），与 python 层无关——office 冒烟已置于 boot 前，独立闭环
- [x] 1.3 实测镜像体积增幅并与构建前对比（预期 +80–120MB），结果记入本 change 备注；超 150MB 触发瘦身复查（extras/缓存层）
  - **实测：镜像 1.17GB（未压缩口径，docker images），pip 层 42.9MB + apt python3 ≈ +103MB，低于估算带**；image-build-check 每次 push 自动记 size+docker history 到 step summary，逐次留档

## 2. 切片① fetch_document_file（读轨地基）

- [x] 2.1 `server/library-mcp.js` 加 `fetch_document_file(document_id)`：原件字节（预览 uploads/ 根）→ 工作区（保留原文件名）→ 返回相对路径；单测覆盖三场景（成功落盘 / 原件缺失显式 error 不回退 / 未知 id error）
  - 实现：核心逻辑在 `server/library-fetch.js`（workspace 三级解析镜像 resolveBootWorkspace；library-mcp.js 为 stdio 薄接线）；单测 `scripts/test-library-fetch.mjs` 5/5 绿 + stdio 集成冒烟全通（真子进程四工具在列、env pin 生效、字节等值、未知 id 显式错）；邻接单测（file-serving/persistence）22/22 无回归
- [x] 2.2 e2e：上传 docx → 会话内 agent 调 `fetch_document_file` → 工作区出现原件且可被后续步骤读取（走 CI e2e 面；本地只跑单测）
  - `e2e/library-tools.spec.js` 扩展：tools 断言改四元、新增 fetch 场景（saveUploadFile 真原件 → env-pin 工作区字节等值 / 无原件显式错不回退 / 未知 id）；本地静态验证过，跑批归 CI

## 3. 切片② 内容层（文档工坊技能）

- [x] 3.1 建 `docs/vertical-packs/skills/doc-studio/` 骨架（**修正：单技能自含**——pack 管线一技能=一 content 字符串，多文件布局无法随包分发；SKILL.md 章节承担路由/设计系统/配方/场景/postcheck 全部职责；零搬运自查过：全部文案与代码为原创，仅借鉴分层结构概念）
- [x] 3.2 设计系统 + 封面配方 R1–R4 内嵌 SKILL.md（三配色表/版式基线/图表色序；配方为完整 python-docx 函数；公共助手含 eastAsia 字体设置——MS Office 中文回退宋体之首因）
- [x] 3.3 postcheck 内嵌 SKILL.md fenced 块：结构校验（无标题结构/死目录文本/空表+默认表名/图片引用/越界形状/非 16:9），**双向验证**——好样本 PASS、三类坏样本全 FAIL
- [x] 3.4 三场景章节（商务报告含 TOC 域配方 / 数据工作簿含公式+条件格式+图表 / 汇报演示含一页一论点）+ 样张生成（samples/ R1–R4 原型 + S1–S3 成稿，postcheck 成稿全 PASS）
- [x] 3.5 真机验证：R1–R4 样张 + 三场景样张在真实 Office 与 WPS 逐张打开验证（版式/兼容性），结果记 VERIFICATION.md（配方号/环境/日期/结论）；任何炸版即修配方重验
  - **三层验证已过（2026-10-08）**：①代码面=fenced 块逐字提取执行全过 + 双向 postcheck；②LibreOffice 渲染=七样张转 PDF 全过（抓修 S2 公式行号差一 + 图表锚被分页切开两真缺陷）；③**线上壹座真机 ingest=四 docx 样张上传 platform 域资料库全 ready 零 error，Content 区渲染完整中文**。台账 VERIFICATION.md 已记；**Office/WPS 客户端逐张打开**仍留作发布前人工抽查（用户机器）

## 4. 切片③ 发布与三面验证

- [x] 4.1 组装官方功能集 `fd-doc-studio`（名「文档工坊」：技能=切片②产物；无 MCP 引用、无 pip 依赖声明），走创作者线发布 v1，谦面商店卡片显示唯一名
  - **已上线（2026-10-08）**：pack id `qnhd7B3J1-HKDDKzZQ_fUQ` v1，作者 doc-studio@finddatatech.com（Logto 专建发布账号、creators 组）；卡片/详情/技能体端点三验全绿。发布通道=facet 代理通道（x-facet-token + x-facet-user，因公网壹座 lawcraw 未开 PACK_MARKETPLACE、facet 直登会话无 groups 声明——两坑在案）
- [x] 4.2 壹座 dogfood（**2026-10-09 全链完成**）：①装包链路实证——docstudio 账号从市场装「文档工坊 v1」成功（skills: doc-studio installed）；②样张真机验证已过（四份 docx 上传线上壹座资料库，全 ready 零 error，Content 区渲染完整中文）；③**真实回合生成实证（prod sha-744285e）**——标准模式下「用 doc-studio 技能生成商务报告 docx」真回合：agent 载入技能→按路由规则（商务报告→R1 封面+TOC 域+三章+数据表+靛青配色+强制 postcheck）执行四步计划→产出 `2026年第三季度华东区销售复盘.docx`（43KB，52 段/6 表/单节，标题层级 摘要·目录·一、市场概览(1.1-1.3)·二、业绩分析(2.1-2.4)·三、下季度计划），技能自带 postcheck 对成品 **PASS**，回合末自报路径+交付清单。旁证：同 cell 的 `echo` bash 回合返回输出（exit 0）
  - 阻塞史（全程留档）：prod 旧镜像无 python 层 → 矩阵行 flag 缺陷（24 包不落盘）→ boot 就地改写冻结树 → DSH_BIN 未钉（应用树 dsh 二进制被 peer 提升拆坏）→ 模块身份双实例（桥包链到应用树 rc.1，undefined.prepare）；四层修复见 docs/dsh-lock-peer-deadlock.md 与 e504ffd/a1bc685
- [ ] 4.3 萬星部署演示：引用文档工坊的服务部署 → 外部调用者回合拿到文本回复+文件引用（无文件字节外发），账单无 office 独立计量条目
  - **2026-10-09 实测定性：v1 范围内不可执行，机制已核验，转 v2**。①部署门实测：`POST /api/packs/:id/versions/:v/deploy` 经 `lib/agent-serving.js#listServingAgents` 只收带 `serving` 契约的 agent，文档工坊 v1 是纯技能包（manifest `agents: []`，线上实证）→ 返回 400 "no agent in this pack carries a serving contract"；②技能继承机制已核验（v2 无需新代码）：runner 按 `descriptor.skills` 逐条 `GET <registry>/api/skills/packs/<packId>/<skill>/content` 取技能体（`agent-runner/registry.js#fetchSkillContent`），facet 侧 `/api/packs/:id/versions/:v/skills/:skill` 公开可用（线上 200 + 技能体可读）；③"引用文档工坊的包"缺跨包技能引用通道——manifest 技能只有包内声明，跨包引用是 v2 管线增强；④萬星回文本+文件引用与"无独立计量"两条在 4.2 已间接具备（产物在工作区、回合文本自报路径；office 不进 sub2api 计量同 websearch 立场）
  - **v2 前置清单**：给 `fd-doc-studio` 加一个带 `serving` 契约的 agent（或给其他包加跨包技能引用），随后 deploy → 外部调用者真回合验收（断言：文本+文件名回、无字节外发、账单无 office 条目）
- [x] 4.4 收尾（2026-10-09 完成）：`openspec validate add-doc-studio --specs` 120/120 绿；样张（samples/ 七份）与 VERIFICATION.md 在仓（git ls-files 实证）；镜像体积留档：**1.18GB（未压缩，sha-744285e）**，office 层 ≈ +103MB（python3 apt ~60MB + site-packages 58MB，含 mammoth），落在设计估算带内；发布备注=谦面 pack `qnhd7B3J1-HKDDKzZQ_fUQ` v1（作者 doc-studio@finddatatech.cloud）+ 镜像 `sha-744285e`（GitOps 6910db6）

## 5. 归档门（后置）

- [ ] 5.1 全任务勾完后 sync-before-archive：specs 并入主 specs（新建 doc-studio、document-library-tools 增量），`openspec validate --specs` 全绿后归档
