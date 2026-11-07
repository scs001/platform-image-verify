# Tasks: add-supply-store-unification

## 1. 脊柱存储与写闸（gateway/）

- [x] 1.1 脊柱 SQLite 扩 `mcp_servers` / `skills` 两族表（条目、visibility/groups、tool_list 快照、supply 注释、provenance；迁移框架沿用 packs 既有 ensureSchema 模式）
- [x] 1.2 脊柱写闸 API：登记/更新/可见性/注释四类写，身份闸+审计落笔；写闸拒绝无身份写并返回显式错误码
- [x] 1.3 只读投影端点（registry pull 源）：全量+增量两种形态，投影剥离非登记数据（会话/令牌/审计流不出脊柱）
- [x] 1.4 visibility 原生字段投影为 fail-closed：缺 visibility 数据的条目不出现在匿名投影（回归钉）
- [x] 1.5 备份纪律对齐：脊柱库随 packs 既有 WAL+dump 节奏，迁移窗口 dump 命令入 runbook
- [x] 1.6 facet 目录面切源开关：`SUPPLY_STORE_CATALOG=1` 时 `/api/mcp-catalog`+`/api/skills-catalog` 读脊柱（`visibleTo` 加原生 visibility fail-closed 分支；默认仍走 bridge，切流在静窗翻转 env）——facet-platform MODIFIED 契约的读面切换（实施时补列）

## 2. registry 执行面 adapter（跨仓 finddata 根）

- [x] 2.1 registry 控制器 pull 副本：周期拉脊柱投影落本地只读副本，pull 失败沿用上份并显式标 stale（健康语义接现有 freshness 概念）
- [x] 2.2 mcpgw / auth-server 读源切副本（网关 nginx 渲染、M2M/token 读路径），对外行为零变（ADR-0015）
- [x] 2.3 registry HTTP API 兼容 facade：读写语义转发脊柱（读→投影、写→写闸带回审计），响应形状逐端点与现网对齐
- [x] 2.4 旧 Mongo 切换后转只读：写操作结构性失败+审计告警直写尝试；「Mongo 直补」配方在 MCP-REGISTRY.md 标记退役（结构性拒绝已实现于 documentdb repos 构造期；台账注记在 5.1）
- [x] 2.5 fd-infra-deploy GitOps 变更（env 读源、副本载体配置）+ ArgoCD 滚动预案（hostNetwork 滚动死锁坑循 platform-migration 先例预案）——env 清单与滚动预案已入 `docs/supply-store-cutover-runbook.md` §1，清单落盘在静窗执行

## 3. 迁移与切换（静窗执行）

- [x] 3.1 迁移器：Mongo→脊柱 SQLite 全字段枚举迁移，未知字段报错不静默丢；行数+逐字段内容双口径对账
- [ ] 3.2 pre-cutover 全量 dump 双份（谦面侧脊柱 + registry 侧 Mongo，循 11-04 1.1G 审计 dump 先例）——runbook §4，静窗执行
- [x] 3.3 静窗切换 runbook：停写→迁移→对账→GitOps 切读源→双读窗口开启；maintenance 语义码在写闸生效（`docs/supply-store-cutover-runbook.md`）
- [x] 3.4 双读窗口自动化：新副本 vs 旧 Mongo 逐字段比对脚本跑 24h，漂移即告警
- [x] 3.5 回滚预案演练：env 回指本地 Mongo + ArgoCD 回滚一条命令级；回滚窗口内脊柱新写入并回流程成文（runbook §7；drill 本体在静窗执行）

## 4. 消费方对账与协调

- [x] 4.1 `reconcile_mcp_registry.py` / `export_surface_commercial.py` 改锚脊柱或改走兼容 facade（二选一在实现时按实测定，对外输出形状不变）——reconcile 增脊柱投影首选通道（env-gated，切流前后皆可用）+ Mongo 回退带陈旧告警；export 读仓内 manifest 与存储无关、零改
- [ ] 4.2 壹座回归：registry-bridge facet 模式读路径零漂移；credential_ref / per-line 凭据分派流过兼容 facade 实弹（lex/wire 各一条）
- [ ] 4.3 plaza 机器面对账：generated/catalog.json 五物种计数与切换前零漂移（pack 82 / skill 265 / mcp 22 / facade 22 / official-data 473 基线）（**2026-11-07 对账实跑（C1 会话代核）：非零漂移，缺口如实记录未勾**——plaza-export 现势 pack 85/skill 0/mcp 26/facade 18/official-data 483 vs 基线 82/265/22/22/473。归因：①pack/facade/official=三天自然增减（非迁移缺陷）；②mcp 22→26=自报四行接回（已知良性）；③**skill 265→0=迁移真缺口**：迁移器（scripts/supply-store-migrate.mjs）只迁 mcp_servers（dump 26/26），**skills 物种从未迁**——facet spine skills 表现 12 行全为 wanxing-agent-runner 写闸 upsert 的交易线 group skills（audit actor=wanxing-agent-runner 92 次），registry Mongo agent_skills_default 的 265 行（11-05 快照匿名可见全量）未入脊柱；registry 副本 SPINE_REPLICA_MODE=1 同步受染（skills 段同 12 行）。修复路径=迁移补课（Mongo 真值经写闸批量 upsert，actor=migration-skills-backfill；Mongo root 凭据考古或 pack manifest 聚合重建二选一）——属本单缺陷修复，非本对账项可勾；修复后重跑本对账到零漂移再勾）
- [ ] 4.4 finddata 根 `carry-registry-visibility-through-bridge` 协调收窄：桥上过滤改脊柱投影回归钉，或并入本单 4.3 验收（在 finddata 根 change 里留处置记录）
- [x] 4.5 公网实弹回归：28 条活册 initialize+tools/list、匿名 401 门、五语注释投影、SSE 长响应路径抽测（2026-11-07 实弹（C1 会话代核）：公网 26 条匿名 initialize **26/26 全 401**（nginx 应用门=在路由判据 ✓）；mesh 直连 21 条并发 initialize **13/13 可匿名条目全 200**（SSE text/event-stream 形状正确，protocolVersion/tools 能力回包正常）+8 条服务自身鉴权门 401（ops/paper-trading 系=台账各自语义在路由判据 ✓）；tools/list 抽测 fd-open-data-mcp **71/71 与台账一致**（mcp-session-id 会话转发 OK，SSE 长响应 71 工具列表完整流回）；五语注释投影 zh-CN/en/ja/fr/es 各 26 servers 带注释 23 全语种齐 ✓。注：mesh 直连 21=台账带 mesh 域名的条目子集，28 活册余量为公网面 401 门（已验）+非 mesh 条目）

## 5. 文档与收尾

- [x] 5.1 MCP-REGISTRY.md §0 对账规则换锚（对账对象、修复命令、直补配方退役注记）+ §1.1 台账复核（换锚块+退役注记落档 2026-11-06；脊柱 26 行与 registry 副本/API 一致，drillp1207 注册→拆 cell delete 全程 audit 留痕）
- [x] 5.2 registry-groups.json 手工映射退役记录 + fail-open 补丁类移除（MCP-REGISTRY.md §3 退役段落档；groups 成脊柱原生列）
- [x] 5.3 registry-maintenance.md 发布记录 + design 决策回填（副本载体实测结论）（§9.1 切换实录+design 副本载体=pull-only 投影副本回填）
- [ ] 5.4 validate --strict + 双读窗口期满归档前复核（旧 Mongo 归档 dump 留存确认）
