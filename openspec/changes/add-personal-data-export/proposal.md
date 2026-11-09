# add-personal-data-export

## Why

模块体检的 privacy 结论是「零实证」：`personal-information-protection` /
`privacy-compliance-audit` 既无 spec，也无导出/删除/最小化/合规报表的实现点。复核后
这句话对了一半——**导出与删除确实没有**（`grep export.*personal|deleteAccount|eraseUser|
dataExport|gdpr|pipl` → 0 命中），但审计能力比我先前说的强：vendor 审计
（`gateway/vendor-onboarding.js`）、`action_audit` 表（`db.js`）与两个专测都在。

同时我修正了自己先前"12 张用户表"的说法：**只有 9 张是按 email 键的个人表**。
`user_preferences` 是部署级键值（`agent.preset`、`llm.effort.<provider>`、
`toolScope.*`），`user_presets` 是共享的自定义预设花名册（无归属列），
`chart_bindings` 按 lineage 键——三者都不是某个人的数据。

导出是这条缺口里**唯一不破坏任何东西**的一半，所以先做。删除是级联的、不可逆的：
删到什么程度（只删凭据？连会话正文与磁盘产物一起删？）是产品裁决，不该由实现代选。

## What Changes

- **新增 `GET /api/users/me/export`**：只读，按调用者身份取数，返回 9 张个人表 + 会话
  **归属事实**（不含正文），凭据类列一律掩码为 `<held>`，并在响应里声明自身口径
  （包含什么、排除什么、密钥已掩码），使读者不会把它误当完整账号归档。
- **新增 `db.listPersonalRows(table, email)`**：表名走白名单，越界直接抛错——查询层
  不信任调用方传进来的表名；白名单里**不含**那三张部署级表，把"这不是个人信息"
  这件事钉在代码里而不只写在注释里。
- **7 条单测**钉住：调用者隔离、密钥不泄露、全局态排除、会话只带元数据不带正文、
  空车道降级为 `[]`、401/503、白名单拒绝（含三张全局表的诱惑）。

## Capabilities

### Added Capabilities

- `personal-data-rights`：个人数据导出的可移植性契约（谁的数据、包含什么、不包含
  什么、密钥如何呈现、失败如何降级）。

## Impact

- **代码**：`server/routes/user-bindings.js`（+1 路由）、`db.js`（+1 受限读取函数）。
- **测试**：新增 `scripts/test-personal-export.mjs`（7/7）。
- **行为**：纯新增只读端点，不改变任何既有路径；无迁移、无出片必需。

## 非目标

- **不实现删除/擦除**：级联范围（9 张表 + 会话归属 + documents/chat-store 磁盘产物）
  是不可逆决策，待产品裁定后再立项。
- **不做合规报表**与"最小化收集"的收口（后者是采集面改造，与导出无关）。
- **不导出会话正文**：那是归档面的职责，混进来会让导出变成对话导出。
