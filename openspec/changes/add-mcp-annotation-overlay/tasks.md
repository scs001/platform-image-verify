## 1. 数据契约与源

- [x] 1.1 注释形状定稿：`human{zh 必填名/一句话/何时用, en/ja/es/fr 可选}` + `canonical.brief?` + `provenance{source,updatedAt}`；仓库目录 schema 扩展 `market-catalog.json`（含尺寸上限）；验证：schema 校验单测绿 + 超 limit 拒绝用例
- [x] 1.2 存量策展：现 10 个 bundled server 的英文 displayName/description 迁 en 副轨、新写 zh 主轨 + canonical brief（PR 评审）；验证：策展后 schema 校验全过、`official-locale-coverage` en 门对官方资产对表
- [x] 1.3 registry metadata.annotations 约定入 docs（`docs/ecosystem/` 或 pack-i18n 增补节）：挂载点、优先级、上限；验证：docs 落盘且 facet mapper 引用路径一致
- [x] 1.4 口径记账：`docs/pack-i18n-requirements.md` §3 显式记「显示层翻译范围扩到 MCP/tool/skill 注释；SKILL.md/persona 正文仍排除」；验证：docs diff 可见推翻句

## 2. lib 与壹座读面投影

- [x] 2.1 `lib/pack-manifest.js`：`LOCALE_OVERLAY_KEYS` 增 `mcpServers`（按声明 registryName 覆盖 description），复用既有 i18n 块校验；验证：单测覆盖合法覆盖/未声明名拒/`i18n.zh` 拒三例
- [x] 2.2 `extension-store.js` 合并投影：registry metadata > 仓库目录 > 原文，逐字段覆盖 + provenance 透出，零源行写；验证：单测三源优先级两例 + 源行不变断言
- [x] 2.3 读面透出：`/api/extensions/market`、`/api/extensions/mcp` 响应含注释字段；工具注释轻索引读面（`{server+leaf → label,summary}`）；验证：curl 实测双语条目 locale 投影 + 未注释条目逐字节对比
- [x] 2.4 投影 locale 解析复用 `lib/pack-locale.js`（参数 > Accept-Language > zh，zh* 归一）；验证：ja 请求回落 zh、无注释回落原文两断言

## 3. 壹座展示面

- [x] 3.1 `McpServerCard`/`McpMarketCard`：有注释渲染通俗名+一句话，连接要素折叠高级区可展开原值；无注释渲染不变；验证：组件测试两态 + Playwright 对照
- [x] 3.2 `ToolBlock`：一次性拉注释索引（D5），有注释工具块原名旁渲染通俗标签、复制得原名；无注释不变；验证：组件测试两态
- [x] 3.3 `AgentSpecSheet` full 变体工具桶：通俗名+原始 registryName 双显；验证：组件测试
- [x] 3.4 pack 草稿编辑器 mcpServers 描述副轨录入（沿 skills 覆盖交互先例）；验证：编辑器保存双语 manifest 过 `POST /api/packs/validate`

## 4. facet 接 locale

- [x] 4.1 `registry-bridge.js` mapper 透传注释字段 + `mcp-catalog.js` 两端点接 `?locale=`（同 pack-locale 优先级）；验证：curl `locale=en`/`locale=ja`/无参数三例，未注释条目响应与今天逐字节一致
- [x] 4.2 facet/web 目录卡与深度页渲染注释（原名保底可见、human 轨按 locale）；验证：真机切五语对照截图
- [ ] 4.3 【两面同文本由单测对表（facet-platform 投影用例）覆盖，跨面 e2e 待走查班补】两面同口径断言：同条目同 locale 在壹座与 facet 文本一致；验证：e2e 双面对表

## 5. 真机走查与出片

- [ ] 5.1 普通人可读性走查：未注释（原文照旧）vs 注释后（通俗可读）对照；验证：走查记录入台账（含「internal 词汇不再靠删 server 遮蔽」的验证注记）
- [ ] 5.2 兼容性回归：旧客户端（不感知注释字段）读面响应逐字节等价；验证：升级前后响应 diff 为空
- [ ] 5.3 出片走查 + 台账；验证：生产 sha 面上眼见注释渲染 + 闭包闸键零变化断言
