## 1. 前置事实与活体

- [x] 1.1 Chatwoot SPA 登录态持久化形态活体探测（cookies vs localStorage、字段名与作用域）：用演示账号真登录 desk 一次，记录 SPA 会话存储与请求头形态，定 D6 注入法——embed-probe.md：cw_d_session_info cookie（devise 头 JSON）+ user.id/expires_at；SAMEORIGIN 同源 iframe 合规；注入法=服务端 sign_in+构造 cookie+按用户注入 devise 头
- [x] 1.2 协调 finddata 侧：重置/确认演示账号密码（§七 密码 devise 401 事实）、试点商家 Account 建号配方确认（SuperAdmin/cw-seed 脚本）——coordination.md：密码漂移已修（重置回 §七 值，sign_in 200 实证）；建号配方确认现成（seed 脚本/SuperAdmin 人工）

## 2. chatwoot 凭据面（D1）

- [ ] 2.1 新 credentialRef `chatwoot`：按 (ref,email) 存储 token+email+password，连接中心新增面板（粘贴表单、深链、状态聚合），单测覆盖存取/清除/stale
- [ ] 2.2 保存连接物化本地 stdio 行（config 同源 bundled、`credentialEnv: {CHATWOOT_API_TOKEN: "chatwoot"}`、嵌入凭据同 ref），清除连接移除该行；单测双分支+轮换覆盖

## 3. stdio env 逐用户凭据解析（D2）

- [ ] 3.1 toMcpClientEntry 增 `credentialEnv` 解析（liveTokenForRef(ref, ownerEmail)），无活凭据→条目整体省略（静默）；writeMcpPatch 组合序接入；单测：有凭据注入、无凭据省略、与 envRefs/requiresEnv 正交
- [ ] 3.2 工具层 401 使该用户凭据置 stale（走 invalidateRef）；单测断言不误伤部署 env 路径

## 4. 动作闸双凭据（D3）

- [ ] 4.1 `crm.message.send` 增 credentialRef；preflight 三分支：已连接→过、已认证未连接→拦截+连接指引、机器 owner 无凭据→回落部署 env；单测三分支
- [ ] 4.2 执行器 stdio 分支取凭据同序：用户 token 注入子进程 env；用户路径 401→invalidateRef+提案失败，部署路径 401→现行报告；桩单测 2×2（用户/部署 × 成功/401）
- [ ] 4.3 审计无凭据扩展到新路径（args digest、日志、提案行），突变验证断言有效

## 5. CRM 客服套件 pack（D4/D5）

- [ ] 5.1 写商家变体技能 `crm-desk-reception-merchant`（profile 发现 account_id、BYOK 说明、失败四分类、守界问答）+ 使用说明；单测：工具名⊆98 面、不出现钉死 account_id
- [ ] 5.2 pack manifest（registryName chatwoot + allowTools 98 名单≡operator-tool-face 快照的单测断言）+ 按 facet-pack-builder 配方产出 pack；发布闭包校验通过
- [ ] 5.3 本地安装链路单测：已连接即时绑定/未连接 awaiting-local-binding/连接后激活（对 pack-installation 既有行为，只断言不改动）

## 6. 嵌入反代（D6/D7）

- [ ] 6.1 新反代路由（认证门后、按用户会话映射、进程内不落盘）+ 应用中心客服台卡片（未连接→连接面板指引；仅 token→如实提示）
- [ ] 6.2 服务端代登录注入（按 1.1 探明的形态实现），登录失败/上游不可达→可读错误页；桩+真机单测
- [ ] 6.3 越权负例单测：未认证访问被拦、两用户会话互不可见、A 租户内容不出现在商家侧

## 7. 出片与生产验收

- [ ] 7.1 出片滚 platform（fd-build-channel 判路 → 公开快照仓线）；谦面市场上架 CRM 客服套件；验证市场可搜、订阅流程走通
- [ ] 7.2 商家全链真机验收：连接自带凭据→订阅 pack→cell 组合出逐用户 chatwoot 面→草拟→发送走闸（写自己租户）→嵌入直达自家租户；A 租户现行四链路回归不回归；证据落 reports/acceptance-b.md
- [ ] 7.3 越权负例生产实证：商家侧不可见 A 租户会话、A 租户不可见商家会话、审计无凭据

## 8. 收尾

- [ ] 8.1 `openspec validate add-crm-desk-pack-embed --strict` 绿；回 finddata `crm-board-adoption/tasks.md` 勾 6.1/6.3（注明证据落点）；B6.4 试点运营负担记录转交 finddata
