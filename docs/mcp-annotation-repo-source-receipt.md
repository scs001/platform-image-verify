# MCP 供给注释 · 仓库源跨仓联调回执（paas → finddata）

> 递送对象：finddata 会话（需求书 `docs/mcp-annotation-source-requirements.md` 出处）。
> 出处：paas 仓 change `add-mcp-annotation-overlay` §6（已实施+归档，2026-11-02）。
> 本单即贵侧遗留任务 **6.2 跨仓联调实测** 的闭环证据。

## 一、paas 侧交付（全部按需求书原文形状，零发明）

| 需求书条目 | 落点 | 状态 |
|---|---|---|
| §B loader | `lib/market-annotations.js`：`validateAnnotation` 同器校验、(file, mtime) 进程缓存、非法弃条+warn、缺文件**静默**空表、永不抛错 | ✓ |
| §C 合并点（只此一处） | `registry-bridge.js mapServer()`：`mergeAnnotations({registry: DB metadata, catalog: 仓库源})`，复用既有语义（逐字段压过/tools 按 leaf/provenance 跟胜者/双空 null）；skills 侧未动 | ✓ |
| §D 出片 | `Dockerfile` COPY 一行；`dist-opensource` 系全树+黑名单制 → `market-annotations.json` 自动进公开快照（泄漏扫描零命中，已核） | ✓ |
| §E 四不变量 | `scripts/test-market-annotations.mjs` 9 例钉死（含「注释不发明工具行」：深度页行集合恒以 registry `tool_list` 为准） | ✓ |

## 二、贵侧数据已上产

23 条 × **587 工具** × 五语 + 每工具 canonical brief 已替换初版样例上产：

- 镜像 `yizuo/platform:sha-d7695b6`（源 `ec2152b8`，digest `88dba08d` 双仓实证）；
- GitOps `6b5d6da` 三面滚（platform/platform-demo/**facet**——facet 目录端点直读桥快照，必须同代）；
- 真机验收（生产眼见，非本地）：
  - facet `/api/mcp-catalog?locale=` 五语名/一句话**各不同且可读**；`?locale=de` 回落 zh；
  - 深度页 `/api/mcp-catalog/fd-quant` **50/50 工具行全带注释**、语言随 locale 切换；
  - 壹座 `/api/extensions/market` 31 条目中 21 条 registry 来源 **17 条注释渲染**（airegistry-tools 与 3×fd-wire-cell 未注释→原文照旧、零新字段）；
  - 两面同条目同 locale 文本**逐字节一致**（e2e 对表）。

## 三、需要贵侧处理的三件事

1. **键名口径（已替你们改掉，但请回改真源）**：贵侧 `fd-quant/tool-surface.json` 的 `registry.entry_path=/fd-quant-compute` 与活册不符——生产 registry 实查该条目 path=**`/fd-quant`**（28 条全册逐名核对）。paas 侧文件键按活册取 `fd-quant`，数据全量生效；但贵侧汇总脚本若继续按 tool-surface.json 取键，会产出 `fd-quant-compute` 的**孤儿键**（loader 不报错、静默不渲染）。请修正 tool-surface.json 或把汇总脚本的键真源指到 `/api/servers` 实册。
2. **cust1 停用已联动生效**：`/fd-daas-mcp-cust1` 经 is_enabled=false 停用后，桥快照与市场面同步消失（无需 paas 侧动作）。
3. **`/law-bench` 可见性待拍**：注释数据已注入（渲染正常），但条目仍 `group-restricted ['registry-admins']`——改 public 仅需贵侧一条 PATCH，paas 侧零改动。等识律线点头。

## 四、增量供给契约（此后滚动更新走这条路）

- **单一落点** = paas 仓根 `market-annotations.json`；`version`+`entries` 形状与键规则同需求书 §2.A/§3 不变；
- **更新通道** = 贵侧汇总产物 → paas 提交（走 PR 评审，GitOps 纪律正源）→ 出片滚版生效；**TTL 300s**，镜像内静态，无热更；
- **覆盖门建议保持贵侧**（你们遗留任务 2.5 同款判断）：注释 leaf 集合 == registry `tool_list` 名字集合的持续哨兵归 finddata 侧（paas 只有读时校验形状，无"缺注释即红"的发布门——缺条目=无注释=原文渲染，这是设计行为）；
- **registry 逐字段压过仓库源**：若某条目将来在 registry metadata 写注释（≤64KB 的条目可以），DB 侧优先生效、文件侧自动补差——两源不冲突。

## 五、挂账清零声明

需求书 §2.E/§4 全部验收口径已在生产逐项通过；§5「配套」中两件事（cust1 停用、law-bench 待拍）状态如上。贵侧两项未勾任务：6.2=本回执闭环；2.5=按你们判断保持贵侧，paas 不重复建设。

---
*证据链：paas 台账 `docs/registry-maintenance.md` §15.124（上产+走查全录）；change 归档 `openspec/changes/archive/2026-11-02-add-mcp-annotation-overlay/`（validate --specs 237/0 当班绿）。*

## 六、补记（2026-11-03）：wire cell 注释数据请拍板

`fd-wire-cell-drillcust001/pgauto001/wiretester2` 三条（各 193 工具）不在 23 条交付内，谦面深度页如实回退原文渲染（机制正常，纯数据缺口）。请贵侧二选一：

1. **补策展**：三条 × 193 工具 × 5 语 ≈ 2,895 条工具级注释（server 级另计）——体量大，可先只做 server 级注释（每条 1×5 语），工具级按曝光频次渐进；
2. **接受原文**：客户实例受众为客户侧开发者，英文原文可读——在台账把三条标「特殊（不注释）」即闭环，paas 侧零改动。

无论哪条，paas 深度页已同步立项 `polish-facet-catalog-depth`（前端数据 locale 跟随切换器 + 193 工具区分组/过滤/折叠重排），注释一旦补上即刻五语可读。
