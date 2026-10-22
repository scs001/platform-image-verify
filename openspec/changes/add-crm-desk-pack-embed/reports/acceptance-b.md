# B 面生产验收记录（add-crm-desk-pack-embed 7.x · 2026-10-22/23）

环境：壹座生产 platform sha-d279b7e（digest 622fe5fd，pod imageID 实证）；desk Account 1「寻数 FindData」+ Account 7「试点商家（验收）」（rails runner 建号：user merchant-pilot@findmail.com id=8 + inbox 2「商家挂件」）。

## 7.1 市场（6.1 收口）

- 技能公开 URL：gitee `FindDataTechnology/finddata-skills` master `crm-desk/crm-desk-reception-merchant/SKILL.md`（e0bc3a2）；registry 注册 200。
- pack 发布：`facet publish packs/crm-desk-suite/manifest.json` → **0aVynUNHmscTAxu7fGs-NQ v1**（作者 aloadtree@gmail.com；发布门接受 fullSurface+reason 形态）。
- 市场可搜：facet `/api/packs?q=客服` 命中本包；详情 public。

## 7.2 订阅安装 + 商家全链（6.1 验收 + 7.2）

以 aloadtree（真机浏览器）执行：

1. **订阅安装**：`POST /api/mypacks/install` → report：`chatwoot: bound`（bundled 行即本地行，配置未被改动）+ `crm-desk-reception-merchant: installed`。
2. **凭据切换**：连接面板断开 A 租户 token → 粘贴**商家 token**（Account 7）→ 已连接（token-only 如实提示）。
3. **账号发现**：商家变体技能 `profile_get` → 仅见 Account 7「试点商家（验收）」，ACCOUNT_ID=7。
4. **隔离读**：conversations_meta/list/messages 只见商家租户（conv #1/msg #8）；**寻数 Account 1 内容零出现**。
5. **草拟纪律**：种子为 outgoing 被如实标注；不编造商家支付政策（安全口径草稿）。
6. **发送走闸**：propose_action（account_id: 7, conversation_id: 1）→ ActionCard 批准 → 执行器以商家 token 经 stdio 分支发送 → **Account 7 conv #1 msg#9 落库**（API 复核）；**Account 1 会话零泄漏**（无草稿内容）。
7. 凭据已恢复为 A 租户 token（aloadtree 回到寻数面）。

发现并如实记录的行为面：**凭据轮换在 cell 内的生效需要 dsh 子进程冷启**（HMR 热交换不重启已 spawn 的 stdio 客户端——envRefs 家族既有行为，非本 change 引入；轮换后重启 platform 部署即生效）。另一次观察：边界纪律在凭据错配时正确工作——持 A 租户 token 跑商家技能时 agent 主动停下并指出「凭据作用域=寻数租户，与你设定的边界冲突」，拒绝读数。

## 7.3 越权负例

- 单测：test-desk-embed 6.3 三负例（未认证 401/他人无凭据 401 且零会话泄漏/token-only 422）+ test-crm-desk-pack-embed 3.1b（清凭据不回落共享 env）。
- 生产：商家 token 只见 Account 7（profile accounts 数组单元素）；发送落点双租户核验（上表）。

## 余项（如实挂账）

- **7.1 余**：无——市场可搜+订阅安装已验收。（注：HMR 轮换行为面已记录，属平台既有语义。）
- **6.3 边缘**：`desk-embed` 子域 DNS/Caddy 路由 + 部署 env `DESK_EMBED_HOST`/`DESK_EMBED_URL`（coordination.md 3）；代码侧全部就绪（8/8 单测），未配时入口如实「未就绪」。
- 试点商家建议在真实验收后于 Chatwoot 轮换 merchant-pilot 的 token（本验收记录不含该 token 明文）。
