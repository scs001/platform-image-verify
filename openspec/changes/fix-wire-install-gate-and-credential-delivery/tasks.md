# Tasks — fix-wire-install-gate-and-credential-delivery

## 1. 身份键别名验证（只读，不阻塞后续）

- [x] 1.1 静态核对：读 `db.normalizeIdentityEmail` 与 line-credentials 路由 identity()
  （ssoUser 优先）→ 写入器 owner（runtimeOwnerEmail 种子/改写点）的键归一化路径，确认
  两路是否存在可分叉的 email 形态；结论记入本节下方。验证：结论有代码行号支撑。
- [ ] 1.2 生产只读验证：在受影响 cell 上比对 `user_line_credentials.email`（wire-customer
  行）与 `[dsh-profile] omitting` 日志的 owner；坐实别名 → 在本 tasks 追加归一化修复任务。
  验证：比对结果记录（若生产通道不可达，明示 deferred，不静默跳过）。
  > 1.1 结论（2026-10-25）：无归一化分叉——line-credentials 路由（ssoUser 边界即
  > trim+lowercase，auth.js:313-317）与写入器判活（liveToken→ownerKey→
  > normalizeIdentityEmail，db.js:1592 同为 trim+lowercase）殊途同归；残余风险仅剩
  > 「铸币会话与 cell 绑定的 email 本串不同」（wire-tester2/wiretester2 双 slug 在
  > AI_CELL_ENDPOINT_MAP 并存为旁证）。
  > 1.2 状态：**deferred**——壹座平台生产库通道本会话未建立（.remote-dc.yml 是 IdP 栈
  > 非 paas 部署）。裁决过程：受影响平台 `SELECT email,line FROM user_line_credentials
  > WHERE line='wire-customer'` 与 `[dsh-profile] omitting` 行 owner 比对；随上产执行。

## 2. P0 安装闸表驱动补分支

- [x] 2.1 `credential-refs.js`：REFS 的 wire-customer/lex/wanxing-caller 条目增加
  `connected(email)` 与 `missingReason` 字段；`credentialConnected` /
  `credentialMissingReason` 改为先查表、未声明字段走既有 if 链。验证：既有四 ref
  分发单测（test-facet-market-ref-dispatch）全绿。
- [x] 2.2 单测扩展：test-facet-market-ref-dispatch（或新文件）覆盖——仅 wire-customer
  凭据判活 true/无凭据 false、lex 同形、wanxing-caller 同形、四既有 ref 判活与文案
  零变化、missingReason 文案指名线。验证：`node --test` 对应文件全绿。

## 3. P1 交付兜底归控制器 + 首行审计

- [x] 3.1 `server.js` `dshUpdateMcp`：非热交换兜底分支的裸 `dshBridge.restart` 改调
  `credentialDelivery.onCredentialChange(patchPath)`（保留 patchPath===undefined 之外的
  原有条件结构）。验证：scripts/test-dsh-mcp-delivery.mjs 全绿 + 引用点代码走查。
- [x] 3.2 `line-credentials.js` `store()`：落行前查有无既有行，无 → 日志
  `[line-credentials] credential line created: <email> <line>`（无 token 材料）。
  验证：test-line-credentials.mjs 增断言首行记事件、改行不记，全绿。

## 4. 回归与验收

- [x] 4.1 本地回归：`node --test` 跑 test-facet-market-ref-dispatch / test-line-credentials
  / test-dsh-mcp-delivery / test-registry-credentials / test-paper-trading-credentials
  / test-facet-market-credentials 全绿。验证：命令输出。
- [ ] 4.2 真机验收（随上产）：无 registry 凭据账号装 wire pack 成功；断开后 409 文案+
  connectPath 指线卡；lex 同形；新 cell 铸首行不重启 5min 内 tool_search 可见；清
  Logto 会话新浏览器完整铸币（consent 交叉面）；验证后 wire 侧撤 wire-tester2 占位
  registry 凭据。验证：验收记录补入本节下方。
