# Design: add-line-credential-refs

## D1 — 一个模块管三线（line 是维度）

`line-credentials.js` 按 line ∈ {wire-customer, lex, wanxing-caller} 分槽；一表 v29
（email, line PK）。ID token 线（wire-customer/lex）与长命粘贴线（wanxing-caller）行为分型：

| 行为 | wire-customer / lex（短命 ID token） | wanxing-caller（长命 sk-） |
|---|---|---|
| 建立 | 浏览器 PKCE 静默铸（首次一次交互授权）→ POST 后端存 | 面板粘贴（token.finddatatech.cloud 自铸） |
| 过期 | exp 前 10min 标记；liveToken 返回 null→该 server 行省略 | 不过期（revocation 驱动） |
| 恢复 | 浏览器会话打开壹座时自动重铸（line-mint.ts 扫描+刷新） | 用户重贴（401→stale） |
| 401 翻面 | markInvalid 清缓存（下次浏览器重铸即愈） | markInvalid→stale（facet-market 同款） |

## D2 — 浏览器静默铸（line-mint.ts）

```
GET {issuer}/oidc/auth?client_id={line.clientId}&response_type=code
    &scope=openid profile email&redirect_uri={line.redirect}
    &state&nonce&code_challenge(S256)&prompt=none
  ├─ 回调带 code → POST {issuer}/oidc/token（PKCE）→ id_token → POST /api/lines/:line/credential
  └─ 回调带 consent_required/login_required → 弹一次该线登录窗（授权后永久静默）
```

- 各线 client_id/scopes/redirect 从该线公开 `auth/config` 取（wire `/api/console/auth/config`、
  lex 同款——公开端点，不硬编码）；
- redirect_uri 必须是该线 SPA 注册过的回调（wire=`{origin}/console/callback` 实测有效）；
- code 换 token 在**该线域的回调页上下文**不可行（跨域）——实际做法：authorize 的
  redirect 直接指向**壹座自己的回调路由**？不可——redirect_uri 必须在该线 client 注册表里。
  **定案：redirect 用该线 SPA 回调，callback 页是我们的探针窗口**（pageflow 窗口读
  `location.search` 里的 code+state 后 `window.opener.postMessage` 或直接由壹座页面
  轮询同窗口 URL——实现取简单者：`window.open` 打 authorize，壹座页轮询弹窗
  `location.href` 抓 code（same-origin 不受限，弹窗 URL 可读），关窗，后端换 token）。
- nonce/state 后端不校验（壹座是 token 的搬运工；验签由 wire/lex 上游做——上游权威）。

## D3 — 注入与 mcp.json 基线

mcp.json 三行（configmap）：

```json
"wire-ops":     { "url": "http://cheap6.mesh.finddata.cn:31896/mcp", "credentialRef": "wire-customer" },
"lex-ops":      { "url": "http://cheap6.mesh.finddata.cn:31897/mcp", "credentialRef": "lex" },
"wanxing-ops":  { "url": "http://cheap6.mesh.finddata.cn:31895/mcp", "credentialRef": "wanxing-caller" }
```

liveToken 短命语义：ID token 过期→server 行省略（壹座 preflight 报 auth-rejected/omit）；
浏览器会话重铸后下次写入恢复。wanxing-caller turn 工具的用户体验：装包后 agent 调 turn
时凭据自动注入——caller key 仍是用户级计费身份（边界结算语义不变）。

## D4 — 路由与面板

- `GET /api/lines/:line/connection`（token-free 投影：connected/stale/expiresAt/line）；
- `POST /api/lines/:line/credential` {token}：wire/lex=ID token（形状校验 JWT 三段+exp 解析）；
  wanxing-caller=`sk-` 前缀校验；存后 reapplyProfile；
- `DELETE /api/lines/:line/connection`。
- 面板：McpMarketView 加三卡（柏讯/识律=静默铸按钮「连接」；萬星 caller=粘贴框+面板链接）。

## 不做

- 壹座后端代铸 ID token（aud 不匹配，实测拒绝——各线 Logto app 的 token 只能浏览器取）。
- refresh token 轨（壹座 callback 现在不收 refresh_token；引入它=改登录链，收益低——
  静默铸已够）。
