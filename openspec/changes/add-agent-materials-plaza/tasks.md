## 1. 导出管线与校验门

- [x] 1.1 `scripts/plaza-export.mjs`：从 facet 市场 API 经 `loadListedPacks` 判据拉全量 listing，产出 `snapshot.json`（带生成日期）—— 验证：对生产 API 实跑，条数与 `/api/packs` 对账相等
- [x] 1.2 `catalog.json` 生成：复用注释层形状（canonical.brief + human 五语 + whenToUse + provenance），来源=listing 字段 ∪ 既有 market-annotations（有则并、无则 listing 摘要兜底）—— 验证：schema 断言每条四字段齐
- [x] 1.3 `llms.txt` / `llms-full.txt` 生成（en 主 zh 镜，逐节指针+自足摘要）—— 验证：每条链接可达断言通过
- [x] 1.4 `materials/*.md` 生成（en+zh，slug=packId 派生稳定地址）+ `infrastructure.md`（输入-动作-产出表格化）—— 验证：三问结构字段（是什么/怎么获取/截至何时）逐页齐
- [x] 1.5 ai_readable 六条 lint 成门：自足节/实体写全/术语唯一/输入-动作-产出/三问结构/provenance 必带，红则 exit 非 0 且零产物 —— 验证：`scripts/test-plaza-export.mjs` 含故意坏例各红一条
- [x] 1.6 数目对账门入导出（差非零即红，双计数入错误信息）—— 验证：mock 差一即红

## 2. 官网静态站 site-plaza/

- [x] 2.1 站骨架：五语 hero + 五类素材卡墙（功能集/生态技能/MCP 服务/AI 分身/官方数据锚，各带实例）—— 验证：五语各页全节渲染，`node scripts/check-locales.js` 或站内 parity 断言绿
- [x] 2.2 机制链四段（发布→获取→运行→服务化，素材视角）+ 给谁用双栏（人/AI 机器面指针）—— 验证：冷读自足（每段不依赖上文可读）
- [x] 2.3 素材目录画廊：官方/分身徽章、垂类筛选、检索；客户端拉 `/api/packs` 实时刷新，失败静默退快照并标"快照截至 X"—— 验证：断网/断 API 两态真机各走一遍
- [x] 2.4 人面 JSON-LD + 机器孪生链接；页脚五行梯 + 兄弟站互链—— 验证：解析器抽 JSON-LD 成功；zhiyu/yongyi/facet 往返链接成立
- [x] 2.5 品牌串全部 v5 终词「壹座·智能体素材广场」/ "Yizuo Agent Materials Plaza"—— 验证：grep 站内旧词零命中

## 3. 上产与部署

- [ ] 3.1 部署物：静态目录上 cheap/雷池机【配置面已完成：deploy/README+Caddyfile 已写；主机落位+DNS 外部件未做】，Caddy 每域一块 file_server `plaza.finddatatech.cloud`（配方同台账 §15.59）；DNS A 记录由域主加（外部件，记录等待）—— 验证：域名解析后 200，无域名前经 hosts 验证
- [ ] 3.2 导出进部署链：deploy 前跑 plaza-export（红则中止不发车）—— 验证：故意破坏一条 lint，部署链拒发

## 4. 双面走查（出口判据）

- [ ] 4.1 人面走查：五语真机全页 + 两客户端（桌面/移动宽度）眼见—— 验证：截图入台账 §9
- [ ] 4.2 AI 面走查：派真实 agent 从 `/llms.txt` → `catalog.json` → 任一 material md → 真装一个包全链零人工干预—— 验证：走查报告记台账；冷读三问全对
- [ ] 4.3 兄弟站互链往返 + www products/facet 页加广场链接（外部件记挂）—— 验证：三站往返成立
