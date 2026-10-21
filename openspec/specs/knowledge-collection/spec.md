# knowledge-collection Specification

## Purpose

已退役（2026-10-21，change `reconcile-knowledge-specs`）：本 spec 描述的 pageindex LLM 索引管线（复用服务端 LLM 凭据做自动索引 + 异步进度流 + 线性检索）已被 2026-09-12 `rebuild-knowledge-as-file-library`（BREAKING）整体替换为本地确定性抽取 + FTS5 + agent 工具面。现管真源：摄取 `document-management`、分块索引 `document-search-index`、工具面 `document-library-tools`、页面 `document-management-ui`。

## Requirements

<!-- All requirements removed by reconcile-knowledge-specs change -->
<!-- Phase 3（embedding/混合检索/CJK 分词）是 09-12 重建显式规划未做的后继方向，立项时以 document-* 为真源，勿复用本退役 spec -->
