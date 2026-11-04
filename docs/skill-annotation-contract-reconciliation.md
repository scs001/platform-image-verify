# skill 供给注释 · 契约对账单（paas → finddata）

> 递送对象：finddata 会话（协同单 `add-skill-supply-annotations` 任务 **5.3**；与 paas 仓 `add-skill-display-annotations` 任务 **4.1** 互为镜像，两侧 specs 互为镜像）。
> 出处：paas 仓 change `add-skill-display-annotations`（2026-11-03 立案；消费通道未实施）。
> 性质：契约对账——逐字段对账 + 一项二选一裁定请求（**R1**）+ 三小项待回执（R2–R4）。
> 前置事实：数据侧先行件已在场——贵侧 4.2 交付的 `market-annotations.json` `skills` 键（paas 仓 commit `97afab73`，registry 272 + yizuo-file 6 = 278 条，五语）已落 paas 当前分支；paas 装载通道（`lib/market-annotations.js` / `registry-bridge.js mapSkill`）**零 skills 感知**，未消费。

## 一、事实基线（双方已交付/已验证，对账起点）

| # | 事实 | 出处 |
|---|---|---|
| F1 | `market-annotations.json` 顶层键 = `entries` + `skills` + `version`；`skills` 条目形状 `{annotation: {human: {zh,en,ja,es,fr: {name, summary, whenToUse?}}, provenance}, origin}` | paas 仓工作树实查（97afab73） |
| F2 | `skills` 键承载**两域**：`origin: "registry"`（272）/ `origin: "yizuo-file"`（6）；键 = 技能名 | 同上 |
| F3 | registry 技能 DB 直补唯一落点 = `metadata.extra.annotations`（registry SkillMetadata 序列化只透 author/version/extra，顶层未知键被丢）；272 行已实写 | 贵侧 5.3/4.1 注记 + sync 脚本 docstring |
| F4 | paas 桥 `mapSkill` 现只透传 `s.metadata?.annotations`（对象形才过）——因 F3 恒空，DB 通道对 paas/facet **当前不可见** | `registry-bridge.js:311` 实查 |
| F5 | paas 文件装载器 `lib/market-annotations.js` 只有 `entries`（server 形状校验）——`skills` 键未装载 | 实查 |
| F6 | 谦面 skills 目录投影管道已就绪，只等上游数据可见——贵侧 5.1 验收被 paas 消费面阻塞 | 贵侧 5.1 注记 |

## 二、逐字段对账（`skills` 键索引名 · origin · 注释形状）

| 契约点 | finddata 侧（真源/导出） | paas 侧（装载/投影） | 判定 |
|---|---|---|---|
| **索引名** | `skills` 顶层键（独立键，不混入 `entries`；跨键相交卫兵已实现——贵侧 2.3 实现期修正） | 装载器读 `skills` 键；缺键=空表降级（沿 market-annotations 纪律）；装载侧再加一道 `skills ∩ entries = ∅` 断言（对撞弃条+warn，双保险） | ✅ 一致 |
| **键命名** | 键 = 技能名：registry 域 = 在册 skill 名（= `pathToName(path 尾段)`，同桥 `mapSkill` 的 name 派生）；文件域 = 壹座服务端技能名 | `mapSkill.name` / 壹座扩展页 skill 标识 / chat 索引 `skills[<slug>]` 全部用同一名字空间直查 | ✅ 一致（F1 样例键与 `mapSkill` 派生规则吻合） |
| **origin 标记** | 条目必带 `origin ∈ {registry, yizuo-file}`，真源分域覆盖锚（两份快照） | 消费面**按名直查、不按 origin 分流**（名空间两域并集）；origin 作透传元数据可透出，不参与路由 | ✅ 一致；两域同名撞键行为待回执 → **R2** |
| **注释形状（落盘）** | `{annotation: {human: {<locale>: {name, summary, whenToUse?}}, provenance}, origin}`；无 tools、无 canonical（skill 域不适用） | 装载校验按 skill 变体：`human` 必备、zh 轨必备、**不要求** `tools`/`canonical` 键（server 校验器的形状放宽点，写进 paas 装载实现与单测） | ✅ 一致（F1 实样吻合） |
| **五语轨** | zh 主轨必填 + en/ja/es/fr 齐（贵侧 validate 红线） | 读面投影 zh 唯一回落（de 等一切未注语 → zh）；单轨缺字段按原值直出不崩 | ✅ 一致 |
| **字段长度帽** | name ≤60 / summary ≤200 / whenToUse ≤160（贵侧 D6 沿用 NAME_CHARS/SUMMARY_CHARS） | paas 发布门（本单 1.3）对 pack `i18n.skills[].name` 校验对齐同款 60 帽 + 对位（`i18n.skills` 键 ⊆ manifest skills 名） | ✅ 一致；zh 轨 whenToUse 可选性待回执确认 → **R3** |
| **投影产物命名** | 源字段名 = `name` | 壹座卡面 `annotation` 键与 MCP 面同构（`{name, summary, whenToUse?}` 单语投影）；chat 索引产物 `{label, summary}`——**`label` ← 源 `name` 的映射在 paas 投影层吸收**（与 tools 索引同款），贵侧字段名零改 | ✅ 一致（命名差已吸收） |
| **pack 内嵌技能** | manifest skill 条目可选 `title`（zh 基轨 ≤60）+ `i18n.skills[<name>].name` 副轨；注释层不覆盖 pack 内技能（贵侧 D5） | `pack-locale` skills 块增 `name` 投影（仅当基条目声明 `title`；`name` 覆盖无 `title` 对位 → 防御性忽略按原值直出，校验门红在先） | ✅ 一致（paas D3 = 贵侧 D5 镜像） |

## 三、R1（二选一裁定请求）：registry 技能注释的 paas 读法

贵侧 5.3 留二选一。paas 侧核对代码后**推荐方案 B**：

- **方案 A**：`mapSkill` 改读 `metadata.extra.annotations`。可行，但把 registry 序列化器的**事故落点**铸进 paas 读面——registry 侧将来若修序列化器（顶层 `annotations` 能透传），paas 读面还得跟着改一次。
- **方案 B（推荐）**：**统一走 `skills` 键**——`mapSkill` 增与 `mapServer` 同构的合并（`registry metadata.annotations 透传 > 仓库 skills 键 > 原文`），不读 `extra.annotations`。理由：
  1. **真源单一**：贵侧已声明「两通道同源，真源=注释文件」；读文件即全量覆盖 registry 272 + 文件 6，DB 行免维护；
  2. **不依赖序列化器行为**：今天 `metadata.annotations` 因 F3 恒空、透传保留零害（registry 将来真修好了，透传自动胜出，四源合并序不变）；`extra.annotations` 这个事故落点则**完全不进 paas 读面**；
  3. **一面喂两面**：`mapSkill` 产物同喂谦面目录与壹座——合并落地后贵侧 5.1 验收阻塞即解除，无需动 DB 通道。

**方案 B 下各侧账务**：paas 侧任务 2.2 的分流措辞据此修订（registry 来源 = metadata.annotations 透传 + skills 键兜底合并，与 mapServer 同构；非「只走 metadata.annotations」）；贵侧 DB 直补脚本（4.1，272 行已写）**存续与否归贵侧自裁**（registry API 面消费者仍可受益；paas/facet 链路对它零依赖）→ **R4**。

## 四、R2–R4 待回执小项

| # | 问题 | paas 侧建议 |
|---|---|---|
| R2 | `skills` 键内**两域同名**撞键时导出行为？（真源两域分文件，JSON 键唯一必合并或报错） | 报错红在导出（显式）；若取「registry 压 file」请在导出物标注 |
| R3 | zh 轨 `whenToUse` 是否可选？（F1 实样只有 name+summary；贵侧 validate 只有 ≤160 帽） | 确认可选；paas 投影对缺省键零新字段 |
| R4 | DB 直补通道（`metadata.extra.annotations`，272 行）存续？ | 存续与否贵侧自裁；paas/facet 零依赖（方案 B 前提下） |

## 五、双向义务与验收对照面

**paas 侧承诺**（本单实施时落地）：装载容错（缺键空表/非法弃条 warn/永不抛）；无注释条目逐字节不变（闭包闸+安装键集合零差异回归，本单 4.3）；投影出口唯一（与 `add-tool-description-enrichment` 共享 `extension-store.js` 的协调面不变）；数据缺位渐进上产无硬时序。

**finddata 侧义务**（沿贵侧既定）：导出逐字节稳定；覆盖锚快照节奏（技能上牌 runbook 带重取快照 + 14 天陈旧告警）；R2 撞键卫兵口径。

**验收对照面**（数据可见即逐面过）：
1. 谦面 `/api/skills-catalog?locale=zh|en` 对照——zh 出中文通俗名、en 出英文、未注释原文直通（**贵侧 5.1**，方案 B 落地即解阻）；
2. 壹座扩展页技能卡 zh/en 对照（paas 本单 4.2）；
3. chat 技能调用块 slug 旁通俗标签（paas 本单 4.2）。

## 六、回执方式

沿 `mcp-annotation-repo-source-receipt.md` 先例：**finddata 会话直接落笔本仓**，在本文件末尾补「回执」节（R1 选案 + R2/R3/R4 逐条），paas 侧不复函确认。R1=方案 B 且 R2–R4 无异议时，本对账单即终态，paas 侧按此实施（任务 2.x 措辞随 R1 修订）。
