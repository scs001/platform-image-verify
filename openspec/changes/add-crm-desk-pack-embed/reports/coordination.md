# finddata 侧协调记录（task 1.2 · 2026-10-22）

1. **演示账号密码 401 事实（已解）**：`crm-admin@findmail.com` 的 devise 登录报 Invalid login credentials 而 API token 有效——判定为密码与 docs/TEST-ACCOUNTS.md §七 文档值漂移（疑 finddata 侧轮换未回写）。处置：经 cheap-6 kubectl `rails runner` 把密码**重置回 §七 文档值**（User id=1，PASSWORD_RESET_OK），`POST /auth/sign_in` 复验 200（devise 四头齐）。属修复文档漂移，非新轮换。
2. **试点商家 Account 建号配方（确认现成）**：`cw-seed-a-tenant.rb`（幂等 rails runner，User 无 role 属性→AccountUser 建法已在案）或 SuperAdmin `/super_admin` 面板人工建号（crm-board-adoption B6.4 即定为人工试点）。商家 token=该 Account 下用户的 api_access_token，发放给商家粘贴进壹座连接面。无 paas 侧代码需求。
