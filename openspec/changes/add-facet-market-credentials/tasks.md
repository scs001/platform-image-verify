# Tasks: add-facet-market-credentials

## 1. 存储与模块

- [x] 1.1 db.js 迁移 v28：`user_facet_market_devices`（email PK, device_id, public_key,
      private_key, facet_email, stale, token, token_exp, paired_at, updated_at）+ 访问器
- [x] 1.2 `facet-market-credentials.js`：设备身份管理（keygen raw32B base64url、deviceId
      规约）+ pair（POST /api/app/pair）+ ensureFresh 串行锁（challenge→sign→login）+
      liveToken（同步缓存+10min 余量+fire-and-forget 刷新）+ markInvalid + status 投影
      （token/私钥永不出现）
- [x] 1.3 `credential-refs.js` 注册 `facet-market` ref（staleEvent=
      facet_market_credential_stale）

## 2. 安装链

- [x] 2.1 pack-store.js：credentialRef 数据驱动（entry.metadata.credential_ref ?? registry）
      + 对应连接门槛分派
- [x] 2.2 mcp.json 基线：facet-market 服务行（mesh 31893 + credentialRef）
- [x] 2.3 facet-market-mcp registry 条目 metadata PATCH（credential_ref）——运维动作

## 3. 路由与面板

- [x] 3.1 server/routes/facet-market.js：GET connection / POST pair / DELETE connection
      （镜像 connector 家族；reapplyProfile 热替换同形）
- [x] 3.2 server.js 挂载路由
- [x] 3.3 web 面板：FacetMarketConnectPanel（McpMarketView 市场头挂载；i18n 内联中文 fallback，五语条目待补）

## 4. 测试

- [x] 4.1 模块单测：keygen/签名对拍（RFC 8032 确定性）、pair 成功/401、ensureFresh 串行
      （并发只一次挑战）、缓存余量分支、markInvalid 翻转、吊销 stale 不复活、投影无密钥
- [x] 4.2 pack-store 单测：metadata.credential_ref 分派 + 未连接报 credential-required
- [ ] 4.3 e2e（部署后）：面板配对→mcp 行注入→facet-market-mcp 真调（facet_market_pack_browse
      author_me=true 拿到用户自己的 pack 列表）

## 5. 上线

- [ ] 5.1 出片+滚动（三 deployment 同滚纪律）+ 生产 4.3 验收
- [ ] 5.2 台账/规约回填（facet-market ref 归入 LINES-MCP-CONFORMANCE 各线 key 表）

## 实施实录（2026-10-13）

- 单测 scripts/test-facet-market-credentials.mjs 10/10（假市场全协议对拍：raw32B base64url 公钥/
  deviceId:nonce 签名/base64url——真 node:crypto 验签；串行锁恰一轮；翻面恰一次+自愈；吊销不复活）。
- scripts/test-facet-market-ref-dispatch.mjs 4/4（credentialRefForEntry/credentialConnected 纯函数化）。
- web 类型检查：本 change 文件零错误（树上 SessionToPresetDialog 3 个预存错误系他线未提交工作，不动）。
- 台账联动：registry 条目 /facet-market-mcp 已 PATCH metadata.credential_ref=facet-market（实测回显）。
- 全量单测回归：13 fail 为树上预存（dsh 树坏基线 6+webTurnSessions 适配漏 1 等，与本 change 无关——
  失败文件均非本 change 触碰面；详见提交说明）。
