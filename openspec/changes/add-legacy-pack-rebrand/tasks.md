## 1. 在仓资产改名（代码侧）

- [x] 1.1 `docs/fleet-architect.seed.json`：name 与 agent 显示名改「团队架构师（官方种子）/团队架构师」，
      persona 自称同步；`scripts/test-fleet-templates.mjs` 等钉名测试同步；en 副轨核对（已是 Team Architect）
      （**已核实在位**：现值 `团队架构师（官方种子）`/`团队架构师`；en 副轨 Team Architect 未动）
- [x] 1.2 `docs/official-packs/wanxing-fleet-assistant-manifest.json`：`萬星舰队助手`→`万星机群助手`
      （name + agents[].name + persona 自称 + 技能正文自称逐处核对）；en 副轨不变
      （**已核实在位**：现值 `万星机群助手`；en 副轨不变）
- [x] 1.3 全仓 grep 核验：在仓种子/官方包显示名无「舰队」字样；locale 门与 lint 门绿
      （**已核验**：`docs/fleet-templates/` `docs/official-packs/` `packs/*/manifest.json` `docs/fleet-architect.seed.json`
      五旧词（舰队/能力包/能力市场/智能体集群/阵列）0 命中；check:locales 全 5 语言绿）

## 2. 类目归位（代码侧，展示映射）

- [x] 2.1 线归位映射表（部署侧可配 `PACK_CATEGORY_LINES`，默认内置 daas/wire→柏讯供给、data/dash/analytics→数据、
      authoring/docs/writing→创作与文档、company→null 剔除），落点：
      `lib/pack-category-lines.js`（表 + `lineOf`/`slugsForLine`/`isLineWord`/`facetLinesOf`）；
      `gateway/packs.js` 行投影加 `line` + `list()` 按线词展开；`facet/marketplace-json.js` 插件投影归位；
      `facet/web→web/src/components/packs/PackMarketView.tsx` 分面 chip 从 `p.line` 聚合
- [x] 2.2 curation 写入端点仍收原 slug（零迁移）；单测：映射只影响展示，安装/订阅/可见性不变
      （`scripts/test-category-line-mapping.mjs`：写回 `wire` 存原 slug、`category` 字段逐字节不变、
      同一 pack 仍可见/在册；raw-slug 查询走精确匹配不受影响）
- [x] 2.3 facet 市场 e2e/单测：分面无线散词；未映射类目原样呈现
      （同上测试簇：company 从 chip 剔除；`custom-xyz` 透传；既有 `test-facet-marketplace-json.mjs` 5/5 与
      `e2e/facet-shell` 用 `legal` 未映射 slug 断言原值，逐字节兼容）

## 3. 市场运营（非代码，按需求单执行）

- [ ] 3.1 长尾包发新版改名：`萬星舰队助手`→`万星机群助手`、`数据-指标工坊`→`数据 · 指标工坊`、
      `数据-自助分析`→`数据 · 自助分析`（id 不变；admin 账号包走平台作者面）
- [ ] 3.2 六自种子新名随下次铸造上架核验（需求单 A2）；en 副轨随 `add-official-packs-i18n` 同版生效
- [ ] 3.3 验收（需求单 §5）：listing/search 无「舰队」包名；dash 两名可检；分面无散词；主力套件零变化

## 4. 收尾

- [x] 4.1 `openspec validate --strict` 绿 + 全量单测绿 + locale 闸绿
- [x] 4.2 台账 `docs/registry-maintenance.md` 补发布记录（与发版班次合账）
