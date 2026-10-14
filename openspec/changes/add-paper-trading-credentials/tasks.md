# Tasks: add-paper-trading-credentials

## 1. 存储与模块

- [x] 1.1 db.js 迁移 **v29**：`user_paper_trading_credentials`（email PK, token, stale,
      updated_at；单槽无 active——design D7）+ 访问器四件（get / set 整体替换+清
      stale / markStale / delete）；验证：迁移后 `schema_migrations` 见 v29 行且
      访问器单测过
- [x] 1.2 `paper-trading-credentials.js` 五件套：refName 字面 `"paper-trading"`、
      isRef、liveToken（stale/无行→null，否则原样返回——纯同步无续登）、markInvalid
      （置 stale 返回翻转）、staleEvent `paper_trading_credential_stale`、status 投影
      （connected/stale/updatedAt，永不含 token）；验证：模块单测 1.x 全绿 +
      投影断言无 token 材料
- [x] 1.3 `credential-refs.js` 注册第四条 ref（照 connector 行形状）；验证：
      `knownRef("paper-trading")` 为真、resolveCredentials 对带该 ref 的 server 行
      注入 Authorization 或省略

## 2. 安装链（handoff ⓪ 三处闭环，缺一不可）

- [x] 2.1 `pack-store.js` 的 `credentialConnected` 加 paper-trading 分派（修「错误按
      registry 放行」缺口）；验证：单测——paper-trading ref + 未连接凭据 → false
      （不再错走 registry 分支）
      - 实施中另发现**第二个分派点**（handoff 未列）：市场卡片直接安装路径
        `POST /api/extensions/mcp`（server/routes/extensions.js）独立硬编码判
        registry 凭据 + stamp `credentialRef:"registry"`——装 fd-paper-trading 卡片
        会把 registry 市场 token 注入柏讯服务（跨服务凭据错投）。已一并修复：
        分派函数上移 credential-refs.js（两个消费点共用），市场卡片路径改按
        `entry.metadata.credential_ref` 分派（409 拒 + stamp 各自 ref）。
        两端各有回归测试（4.2）。
- [x] 2.2 mcp.json 基线加 `paper-trading` 行：url
      `http://cheap6.mesh.finddata.cn:31894/mcp/`（**尾斜杠必须**，design D6）+
      `credentialRef: "paper-trading"`；验证：JSON 可解析、与 facet-market 行同构

## 3. 路由与面板

- [x] 3.1 `server/routes/paper-trading.js`：`GET /api/paper-trading/connection`（状态
      +serviceUrl 指路）/ `POST`（fdt_ 形状检查→probe GET `<origin>/api/v1/accounts`，
      **唯 401 硬拒**，网络失败/5xx 照存）/ `DELETE`；origin 从 mcp.json 行推导（D3
      单源）；匿名写 hosted 模式 401 门；验证：路由单测四态（200 存/401 拒/网络照存/
      匿名拒）
- [x] 3.2 server.js 挂载路由；验证：路由测试 GET 200 未连接投影 + 三端点全链（4.1 测试文件内）
- [x] 3.3 web `PaperTradingConnectPanel.tsx`（照 ConnectorConnectPanel 裁剪：粘贴框+
      状态+断开）挂 McpMarketView 市场头；i18n **五语一次做齐**（en/zh-CN/ja/es/fr，
      不留 fallback 债）；验证：typecheck 零新错（web+core 均 0）+ 五语文件条目在位
      （check-locales 五语 1275 key 全等）+ 面板渲染 e2e 绿（extensions.spec 20/20）
      + web build 成功

## 4. 测试

- [x] 4.1 模块单测（scripts/test-paper-trading-credentials.mjs）：refName 字面断言、
      存取/替换清 stale、markInvalid 恰一次翻转、liveToken stale→null、投影无 token；
      16/16 全绿
- [x] 4.2 pack-store 分派单测：`credentialRefForEntry`（metadata.credential_ref=
      paper-trading）+ `credentialConnected` 三分派 + **装包全链与市场卡片安装全链
      各一条**（未连接 409 credential-required + 拒因指路 + 无死行；已连接装为
      paper-trading ref）；scripts/test-paper-trading-credentials.mjs 16/16 绿
- [x] 4.3 全量单测回归：新失败为零（树上预存失败基线另册，不混入）
      —— `npm run test:unit` 1303/1304；唯一失败 test-harness-adapter 的
      [acp] session/cancel 系负载下时序 flake（单跑 3/3 过、整文件 18/18 过、
      与该测试零引用交集），非本 change 回归

## 5. 上线验收（handoff 定义的 done，四条全过才算）

- [ ] 5.1 出片（GHA→hkccr→relay→ccr 纪律）+ 三 deployment 同滚 + configmap
      paper-trading 行走 **GitOps** 落库（带外 apply 会被 selfHeal 打回——facet-market
      前车之鉴）；验证：生产 mcp.json 含该行、schema v29、路由 401 门在位
- [ ] 5.2 生产四验收：①两个壹座用户各 paste 各的 `fdt_` token 装包
      `DydB2cal-M9l91IMJYHshA` 成功且 server 行带 credentialRef: "paper-trading"
      ②两用户 `list_accounts` 各见各的账户 ③用户 A 吊销 token→401→stale→server 从
      A 的 profile 消失+WS 事件到达，B 不受影响 ④未连接凭据用户装包被 409 拒（指路
      文案在位）；四条各有实证记录

## 6. 对账回填

- [ ] 6.1 台账回填：`LINES-MCP-CONFORMANCE.md` 壹座侧各线 key 表加 paper-trading
      ref 行（照 facet-market 行形状）；finddata 侧 handoff（任务 3.3/3.4）回执对方
      change
