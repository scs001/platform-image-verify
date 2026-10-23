# polish-facet-usability — Tasks

## 1. 系统层（先于页面层）

- [x] 1.1 字号收敛：灭 `web/src/components/packs/` 23 处 + `facet/web/src/` 3 处目测字号（按 design D1 归位），DESIGN.md 落微标白名单；`grep` 零残留断言入 tasks 收尾核对
- [x] 1.2 间距走查：双面任意值间距逐处归位语义阶，DESIGN.md 登记获准保留项（D2）
- [x] 1.3 动效词汇：骨架/stagger/供示三类 + `prefers-reduced-motion` 全局豁免（globals.css，D3）；真机 RM 模式核验
- [x] 1.4 `--font-sans` 补 CJK 回退序；`scripts/check-locales.js` 不倒退
- [x] 1.5 `facet/web/DESIGN.md` 初稿（阶梯/纪律/词汇/三态/语气五节，D7）

## 2. 壳面（facet/web）

- [x] 2.1 CurateView/MineView i18n 键化：14+ 裸文案 → 五语键；中英混排清除
- [x] 2.2 壳面三态：McpCatalog/MineView/CurateView 加载骨架替代裸文字、空态引导、错误重试（D 契约见 specs）
- [x] 2.3 IntroView 流程图升格为三节点图形（D5）；静态性与 CLI 单源断言保留
- [~] 2.4 暗色层级走查（D6 证据判定），成立才微调；test-palette-contrast 绿（对比度脚本 4/4 绿；真机暗色走查未做——留待 3.3 同批）

## 3. Store 面（web/src/components/packs/）

- [x] 3.1 PackMarketView/PackDetailDialog/PackDraftsView/MyPacksView 三态补齐（骨架列表/空引导/错误重试）
- [x] 3.2 Store 面字号/间距按 1.1-1.2 结果复核；e2e data-testid 零改动核对
- [ ] 3.3 双面真机走查：浅色/暗色/移动宽/RM 四态 × 五视图 × 两面（含 2.4 的暗色证据；需真机/浏览器会话）

## 4. 收口

- [x] 4.1 DESIGN.md 定稿（白名单与登记表落全）；`npm --prefix facet/web build` + `check-locales` + 既有 e2e（facet-shell/packs）全绿
- [ ] 4.2 出片：`fd-build-channel` 判路 → paas 标准线出片 → facet.yaml+platform.yaml 同 tag 滚产 → 双面真机验收（digest↔pod imageID 实证）→ 归档
