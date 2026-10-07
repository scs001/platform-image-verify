# add-caller-preferences — Tasks

## 1. 门面偏好层（fd-wanxing）

- [x] 1.1 `store.js` 增 `wanxing_caller_prefs` 表与 CRUD（(user_id, agent_slug) 主键；callback_url/secret、reap_minutes、updated_at），单测覆盖 upsert/清除/查询回落
- [x] 1.2 门面 prefs API：`GET/PUT /api/wanxing/v1/prefs/:slug`——调用键 Bearer 认证（probeKeyLiveness 解析 userId，同 A2A 门），写校验（URL https、密钥长度、reap 正整数分钟且上下界）、清除语义、无效键拒绝，单测覆盖认证/校验/清除三态
## 2. 回调派发（fd-wanxing）

- [x] 2.1 `core.js` 回合完成点挂派发：HMAC 签名（t+v1 头，覆盖全体）、体含 trace_id/outcome/时长、指数退避三次（总窗 ≤15m）、fire-and-forget 不阻塞回合响应，单测覆盖签名可验证/重试窗/密钥不出现在任何外发内容
- [x] 2.2 派发审计：失败窗尽记 jsonl（url 脱敏、原因、trace_id；无密钥），探针脚本对 stub 接收端验证签名/重试/幂等锚三件套
## 3. 收割窗传导（fd-wanxing + paas runner）

- [x] 3.1 共享解析函数（门面 `a2a.js` 导出 `encodeReapWindow`/`parseReapWindow`；36 进制窗段 + 旧格式回落），门面 `contextIdFor` 派生时编码生效值（偏好→默认），单测覆盖偏好/默认/自带 context 三态
- [x] 3.2 paas `agent-runner/manager.js` reap pass 接最小拷贝的解析函数取每会话 TTL（旧 `wx:` 无窗段回落默认），单测覆盖编码会话按偏好收割、未编码按默认、非法段回落
## 4. CLI（paas facet/cli）

- [x] 4.1 `facet.js` 增 `prefs` 子命令（--key/FACET_KEY、--set-callback/--set-reap/--clear/--show，USAGE 同步），直连门面 prefs API；单测覆盖参数解析与门面交互（stub fetch）
## 5. 集成验收与上线

- [x] 5.1 本地快检（单文件单测/lint/build）+ push CI 全绿（fd-wanxing 套件 + paas unit + e2e fast 若覆盖 prefs 面）
- [ ] 5.2 部署序上线：runner（解析先行）→ 门面 → CLI npm 发版；上线探针：CLI 设偏好 → stub 回调收签名 POST → 收割窗编码会话按偏好收割（低 reap 值实证）→ 清除回落
- [ ] 5.3 `openspec validate --strict` + `validate --specs` 绿后归档（caller-preferences 新建、wanxing-facade 两 requirement 并入核对）
