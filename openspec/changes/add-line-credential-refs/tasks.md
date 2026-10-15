# Tasks: add-line-credential-refs

## 1. 存储与模块

- [ ] 1.1 db v29 `user_line_credentials`（email, line PK；token, token_exp, stale, updated_at）+ 访问器
- [ ] 1.2 `line-credentials.js`：三线分型（liveToken/markInvalid/status/pair-or-paste 投影）
- [ ] 1.3 credential-refs.js 注册三 ref（staleEvent=line_credential_stale）

## 2. 路由与浏览器铸

- [ ] 2.1 server/routes/line-credentials.js（GET connection/POST credential/DELETE）+ server.js 挂载
- [ ] 2.2 web/src/lib/line-mint.ts：PKCE 静默铸（弹窗轮询抓 code→token 端点→POST 后端；
      consent_required 降级交互窗）
- [ ] 2.3 面板三卡（柏讯/识律连接钮；萬星 caller 粘贴）+ core api 类型
- [ ] 2.4 mcp.json 基线三行（本地+configmap）

## 3. 测试

- [ ] 3.1 模块单测：三线分型（ID token exp 解析/sk- 形状）、翻面语义、投影无密钥
- [ ] 3.2 路由单测（形状校验 422/401）
- [ ] 3.3 web 类型检查零错

## 4. 上线与验收

- [ ] 4.1 出片双滚（platform/platform-demo）+ configmap 三行落库 + restart
- [ ] 4.2 生产 e2e：ego 浏览器静默铸 wire/lex → 三卡已连接 → 装包调 wire_market_browse/
      lex_me 以用户身份真数据
- [ ] 4.3 台账/roadmap/记忆收口
