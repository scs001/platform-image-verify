# Tasks — search-relay-via-ciyuan

> 前置：`ciyuan-lane-pool-failover` 已上产（本表 0.x 任务在词元侧，纯配置）。

## 0. 词元侧配置（admin，零代码）

- [x] 0.1 词元 admin 建 internal 分组（websearch 价目 0）+ 专用 API key；`/v1/search` 用该 key 打一笔探针（200+费 0 用量行）。验证：词元用量面板见该笔、费率 0。
      实证（2026-10-15）：admin API 建组 `internal-search-relay`（id=10，platform=serpapi，is_exclusive，web_search_price_per_call=0）+ admin 绑定 allowed_groups=[3,10] + 建 key #68 `search-relay-internal`；探针 `POST /v1/search {"engine":"serpapi","q":"OpenSpec change proposal","num":3}` → 200 三条结果（meta.engine=serpapi）；用量行 93779 `serpapi:google_light` total_cost=0.0000000000 actual_cost=0.0000000000（归因 acct 37）。

## 1. relay 改造（repo services/search-relay/）

- [x] 1.1 `index.js`：keys.json 形状扩展 `ciyuan:{url,key}`（env `CIYUAN_URL/CIYUAN_KEY` 兜底，file wins 既有规则）；`ciyuanSearch(query,num,userKey)`——POST /v1/search、BYOK 头透传、信封拆包回 results、透传 `x-search-source`。验证：单测（fake 词元 server）形状映射+BYOK 头在。
      实证：`scripts/test-search-relay-lane.mjs` 5/5（真 relay+stub 车道：内部 key 上wire/信封拆包/BYOK 头透传/三态来源）。
- [x] 1.2 冷备熔断：车道失败分级（5xx/超时/401=不可用）计数 3 次进 60s 熔断直连，60s 探活恢复；直连路径沿用既有 serpapiSearch。验证：单测三形态（车道好/熔断/恢复）。
      实证：breaker 用例——3 连败开门、窗口内零车道调用、窗口后首请求探活成功关门；`RELAY_LANE_BREAKER_SECS` 可配（测试 1s）。
- [x] 1.3 `poolSearch` 改造：优先车道（user key 也经车道），失败落冷备；`x-search-source` 三态不变；503 文案含双路径皆败。验证：单测全路径+既有 byok/cooldown 用例不回归。
      实证：lane 5/5 + 既有 `test-search-byok.mjs` 11/11 + `test-search-relay-scoped.mjs` 9/9 不回归；503 双路径文案两形态（无冷备/双败）断言。
- [x] 1.4 `/v1/stats` 增 `upstream:{mode,reachable,fallbacks}`，keys 段保留（冷备视角）；日志路由标注。验证：单测 stats 形状。
      实证：stats 断言 mode/laneConfigured/reachable/breakerOpen/laneCalls/laneFailures/fallbacks；日志 `route=lane|direct-fallback|direct`；`server/routes/misc.js` 池端点透传 upstream。

## 2. 面板与文档（paas 仓）

- [x] 2.1 `WebSearchSection.tsx` 池健康区加「上游：车道/冷备」行（stats.upstream 消费，缺字段时优雅隐藏）。验证：web:build:e2e 过+组件测试。
      实证：`web:build:e2e` 绿（含 check:locales，五语言新增 4 键）；`websearch-api.ts` 类型加 `upstream`（可选，旧 relay 缺字段即隐藏行）；`misc.js` 池端点透传 upstream + `test-search-byok.mjs` 断言 mode=direct/laneConfigured=false。本仓无组件测试框架（无 vitest/jest），面板验证按既有惯例=构建门+服务端端点断言。
- [x] 2.2 docs：DEPLOY.md websearch 节改供给拓扑说明；`docs/sub2api-fork-patches/README.md` 台账登记收口事实。验证：文档 lint/链接。
      实证：DEPLOY.md「Web search relay」节补供给拓扑段（车道主供/serpapi 冷备/熔断/回滚态）+ stats upstream 块说明；台账§六新增「钥匙收口」条目；`keys.example.json` 形状同步（ciyuan 主供 + serpapi 冷备角色）。

## 3. 部署与验收（fd-infra-deploy + 生产）

- [ ] 3.1 manifest：ConfigMap 重嵌新代码 + secret 新 keys.json（`ciyuan{}`+冷备 serpapi[] 换新 key）→ gitee push → rollout restart。验证：pod Ready+/healthz 200。
- [ ] 3.2 生产验收四件：①普通搜索 200（stats mode=ciyuan）②BYOK 三态（带错 key→pool-after-user-failure）③停词元 serpapi 账号验冷备接管（mode=direct-fallback+结果正常）④恢复账号验回切。验证：stats 面板+日志路由标注。
- [ ] 3.3 观察一周后退役段：删直连路径与 serpapi[]、面板 keys 段隐藏、台账+spec 同步（本表续任务，届时勾）。
