# add-doc-studio — Tasks

## 1. 切片① 执行层（runtime 镜像）

- [x] 1.1 仓根新建 `requirements-office.txt`（钉版：python-docx / openpyxl / python-pptx / mammoth；markitdown 实测出局——185MB 重依赖零质量加成，用户定案 B 瘦身），干净 venv 验证可装、无重依赖、三格式写读回环全绿（site-packages 58MB 实测留档）
- [ ] 1.2 Dockerfile runtime 阶段加 `python3 python3-pip`（沿用 aliyun apt 源惯例）+ pip 国内镜像装 requirements-office.txt；`docker build` 过，容器内 `python3 -c "import docx, openpyxl, pptx, markitdown"` 全通
- [ ] 1.3 实测镜像体积增幅并与构建前对比（预期 +80–120MB），结果记入本 change 备注；超 150MB 触发瘦身复查（extras/缓存层）

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
- [ ] 3.5 真机验证：R1–R4 样张 + 三场景样张在真实 Office 与 WPS 逐张打开验证（版式/兼容性），结果记 VERIFICATION.md（配方号/环境/日期/结论）；任何炸版即修配方重验
  - 代码面验证已完成（fenced 块逐字提取执行全过 + 双向 postcheck，台账已记）；**真机打开验证需用户在装有 Office/WPS 的机器执行**（VERIFICATION.md 表格逐行填）

## 4. 切片③ 发布与三面验证

- [ ] 4.1 组装官方功能集 `fd-doc-studio`（名「文档工坊」：技能=切片②产物；无 MCP 引用、无 pip 依赖声明），走创作者线发布 v1，谦面商店卡片显示唯一名
- [ ] 4.2 壹座 dogfood：cell 安装 → 三场景各跑一轮真实生成 → 产物条带出现、docx 预览可开、显式存入资源库成功；postcheck 失败注入一轮验证修复可见
- [ ] 4.3 萬星部署演示：引用文档工坊的服务部署 → 外部调用者回合拿到文本回复+文件引用（无文件字节外发），账单无 office 独立计量条目
- [ ] 4.4 收尾：`openspec validate add-doc-studio --specs` 过；样张与 VERIFICATION.md 归档入仓；镜像体积与发布备注留档

## 5. 归档门（后置）

- [ ] 5.1 全任务勾完后 sync-before-archive：specs 并入主 specs（新建 doc-studio、document-library-tools 增量），`openspec validate --specs` 全绿后归档
