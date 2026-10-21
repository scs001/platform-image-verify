# Tasks: reconcile-knowledge-specs

## 1. 校验与文档

- [ ] 1.1 `openspec validate reconcile-knowledge-specs` 绿——重点核对四份 REMOVED delta 的需求名与主 spec 逐字一致（25 条全量）
- [ ] 1.2 `PRODUCT.md:34` 删「bundled WeKnora knowledge sidecar …」虚假段，改为本地文件库如实描述（本地确定性抽取 + FTS5 + library MCP 三工具）
- [ ] 1.3 全文扫残留：`rg -i weknora` 过一遍仓内文档（README/PRODUCT/docs），死引用逐一清除或标注历史

## 2. 归档与同步

- [ ] 2.1 归档 change：主 spec 同步后四份退役 spec 留空需求 + 指针注释（依 document-management 空壳先例，指向 document-* 四份），不物理删目录
- [ ] 2.2 归档同步时顺手清 `document-management` / `document-collections` 头部 WeKnora 残留注释（spec.md:8-9，注释行非需求）
- [ ] 2.3 归档后全量 `openspec validate` 基数核对（需求总数 -25），提交时只 stage 本 change 相关显式路径（勿 -A，33 项 Purpose 回填单独先提）
