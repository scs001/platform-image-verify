# 爬虫自愈修复 Agent · finddata 对接一页纸

> pack：`KkCie7NlrHluo4LiKPnn0w`（private，萬星运营号自营）· agent：`spider-heal` ·
> 部署：fd-prod（runner cheap1）· 变更：add-spider-heal-pack · 2026-10-03

## 调用（经萬星门面）

鉴权/幂等/计费规则见 `docs/wanxing-serving-api.md`；本 agent 的消息协议（工单约定）：

```
POST https://platform.finddatatech.cloud/api/wanxing/v1/a2a/packs-kkcie7nlrhluo4likpnn0w-spider-heal
Authorization: Bearer sk-…（finddata 调用键，需运营加入允许清单）

SUBMIT FindDataTechnology/fd-industry-data reports/health-tickets/<date>-<src>-<id>.yaml
STATUS reports/health-tickets/<…>.yaml
QUEUE
```

- SUBMIT 秒级回执（入队/已见过/拒绝三态）；重复路径只回执不动手（agent 侧 inbox 去重 + 门面 Idempotency-Key 双层）。
- STATUS 读 agent 落盘状态（queued/working/pr-open/done/manual + note + prUrl）。
- 节奏：agent 每 30 分钟自巡检队列处理一单；外部 SUBMIT 立即入队（下次巡检或后续触发处理）。回合预算 20 分钟（超限平台硬停+转人工语义）。

## 工单 YAML 期望字段（finddata 侧产出）

- 分诊类别（network/structure/contract/source-dead/fallback）+ 诊断备注 + 目标单元 `spiders/<slug>/`
- **verify**：声明的验证链命令（平台技能会先 `--help`/dry-run 探测再实跑；缺省走基线校验）
- golden/口径文件路径（契约类工单时点名）

## git 凭据（finddata 待办 ① —— ✅ 已绑定 2026-10-03）

**PAT 已绑定**：运营经 v2 重部署入库（secret 名固定 `git_pat`，平台侧仅存 `ws_` 引用，
全链日志至多尾四位；child 凭据文件 `/data/packs-KkCie…-spider-heal/.credentials.yaml`
中 `git_pat` + `gh_actor=56543689+scs001@users.noreply.github.com` 已就位）。
轮换 / 换仓同下配方：

```bash
PACK_ID=KkCie7NlrHluo4LiKPnn0w \
SECRET_GIT_PAT=<PAT> SECRET_GH_ACTOR=<email> \
NOTIFY_CHANNEL=<通道> BILLING_KEY=<运营键> \
PLATFORM_URL=… TOKEN=<运营 JWT> node scripts/spider-heal-pack.mjs --deploy
```

（省略某 secret = 保留现绑；PAT 缺失时所有工单按协议终态「转人工（凭据未配置）」。）

## 通知（四类事件）

工单终态 / PR 开出 / 总闸变更 / 超限转人工 → 部署绑定的通道（当前 **`fd-ops`**，
2026-10-04 换绑完成；旧 `test-channel` 保留为备用绑定）。事件文案模板见技能 `spider-heal-notify`。

> **bot 命名备注（2026-10-04 实测）**：微信里实际在用的公众号（使用方称 qinfa）在平台里登记的
> bot 名是 `test`（appId `wx655b465a5f91bff1`）；平台里另一个叫 `qinfa` 的 bot
> （appId `wx29831ffdb4796ab1`）是另一只**未被使用**的号。`fd-ops` 通道绑在 `test` 号上——
> 排障时别被名字带偏。

## 部署 / 升级 / 回滚（运营配方）

- 升级：改 `scripts/spider-heal-pack.mjs` 内的 manifest 内容 → 带 `PACK_ID` 重跑（自动下一版本）→ runner 原地 drain 换新。
- 回滚：`POST /api/packs/KkCie7NlrHluo4LiKPnn0w/versions/<旧版本>/deploy`。
- 暂停/恢复：`POST /api/packs/KkCie7NlrHluo4LiKPnn0w/deployments/spider-heal/pause|resume`。

## finddata 侧待办清单

1. ~~签发 PAT 并交付运营绑定~~ ✅ 2026-10-03（v2 部署绑定，见上节）。
2. 内容仓 `reports/health-tickets/` 工单流就位（五类分诊+verify 声明）。
3. （可选）中央库限流/总闸注册为 MCP server → 运营重部署追加 `mcpServers` 引用（总闸变更通知才生效）。
4. 首批真实工单试运行：SUBMIT → 观察 STATUS/pr-open → 人审 merge。

## 已验证（2026-10-03）

GitHub 出海（cheap1：github.com/api/ls-remote 200/ok）· 发布+部署+起服（:8799）·
门面 SUBMIT（凭据缺失→按协议终态 manual+结构化回执）· 重放去重 · STATUS 跨回合读盘 ·
允许清单放行。rhythm 自回合 burn-in 见 runner `meter.jsonl`（kind=self，部署后 ≤30m 首巡）。

### v2 实跑（2026-10-03 晚，绑定 PAT 后）

- v2 发布+部署（secretRefs：`git_pat`/`gh_actor`；notify `test-channel`）；runner 原地 drain
  换新 child，日志实证「running on its own billing key (pk_e19083b4…)」+「pinned 2
  deployment secret(s)」，旧计费键引用未断。
- 门面合成工单实跑：`SUBMIT FindDataTechnology/fd-industry-data reports/health-tickets/<不存在>.yaml`
  → 真回合 110s（外部上下文 `wx:`，按调用键结算 2 分钟、已 settled）→ 终态 `manual`（工单不可读，
  四路核实 0 命中）→ 同 `Idempotency-Key` 重放返回首答、无第二回合/第二笔账（重放语义实证）。
- 注意：**平台滚动窗口内 `bot_notify` 会 503（单次纪律=不重试，通知即丢）**——本单终态通知恰逢
  pod 滚动未送达，rolling 结束后直发 relay 复测 `{ok:true}`。重要工单建议避开部署窗口。
- 另：该仓当前没有 `reports/health-tickets/` 树（四路核实），真实工单流就位后即可试跑。

## 运营侧四项处理（2026-10-04，使用方提出）

### ① 通知通道从 test-channel 换正式 —— ✅ 完成（2026-10-04）

- **通道 `fd-ops`** 已绑定 =（平台 bot `test`（=微信里的 qinfa 号），chat `oi_bc3J…`）——即使用方
  实际在用的那个微信会话；`POST /api/bots/channels` 一次建绑定。
- **重部署 v4**：`NOTIFY_CHANNEL=fd-ops`（计费键/密钥保留）；runner 日志确认
  「descriptor changed; draining old child for in-place upgrade」。
- **送达实证**：relay 审计 `fd-ops | sent | 73 chars`（05:46Z 验证消息已进微信会话）。
- `test-channel` 保留未删（同会话的备用绑名；要清时说一声即可）。

### ② 限流/总闸注册为 MCP server + 重部署 —— ✅ 完成（2026-10-04，含全链实证）

- **坐标**（使用方 2026-10-04 交付）：中央库 `fd_open_data.public.health_config`（key/value
  jsonb 六键 + updated_at）；只读账号 `fd_health_ro`（mesh `100.64.0.3:30432`，DSN 经安全渠道，不进 git）。
- **萬星侧落地**：只读 MCP shim `servers/fd-health-mcp/`（单文件 Node + pg，Streamable HTTP）→
  部署于 cheap1（容器 `fd-health-mcp`，`/opt/fd-health-mcp`，compose 网络 + tailnet `:8090`）→
  registry 注册条目 `fd-health-config`（上游 `http://100.64.0.11:8090`）→ pack **v3** 追加
  `mcpServers: ["fd-health-config"]` 并重部署（计费键/密钥/通道全保留）。
- **全链实证**：公网 `mcp.finddatatech.cloud/fd-health-config/mcp` 三流程
  （initialize/tools/list/tools/call）实测通过、返回真库值；runner 日志
  `cold-starting … (1 MCP, 3 skills)`；shim 日志见子进程握手 + **真回合内
  `tools/call:health_config_get`**。
- **技能升级**：`spider-heal-notify` 增「总闸核对」流程——每巡检 `health_config_get` 对比
  `$DSH_HOME/spider-heal/gate-state.json`，键值变化发一条 gate_change，首次只落盘；MCP 不可达
  记一句不重试。rhythm 巡检文案同步（v3 起生效）。
- 运维配方（重建/轮换/注册侧三坑）见 `servers/fd-health-mcp/README.md`。

### ③ runner 默认模型 / 计费核验 —— ✅ 完成（证据在案）

- **模型**：现役 runner（cheap1 `agent-runner-dsh`）默认 `AGENT_RUNNER_MODEL=deepseek-v4.1-flash`；
  child 的 finddata 路由（settings.yaml，baseURL `token.finddatatech.cloud/v1`）列 8 个模型、活跃即
  flash；sub2api 侧该部署键 **183 条用量记录全部为 `deepseek-v4.1-flash`**。
- **计费**：部署键 = sub2api **key id 31**（组 `openrouter`，属 user 1 万星运营号）；逐请求记账
  （in 1,155,054 / out 70,594 tokens；样例 `total_cost $0.00022383`），最新一条在查询前 16 分钟
  （rhythm 自回合持续消耗）——**部署键实付、门面调用键结算为两本独立账，双向均实证**。
- 如需改默认模型：runner env `AGENT_RUNNER_MODEL`（影响该 runner 全部 children）；per-agent 差异化
  需走描述符扩展（提需求）。

### ④ git PAT 权限范围 —— 实测**超范围**，建议收窄或书面接受

- 实测：该 PAT 可见 **12 个 FindDataTechnology 仓**且 push；单仓权限位报
  `{admin:true, maintain:true, push:true, triage:true, pull:true}`。契约承诺的最小范围 =
  仅 `fd-industry-data` 一仓、`contents:write` + `pull_requests:write`。
- 两条路：
  - (a) **收窄（建议）**：重新签发仅 `fd-industry-data` 的 fine-grained PAT（Contents RW +
    Pull requests RW，无 admin/workflow/secrets），萬星一条命令轮换：
    `PACK_ID=KkCie… SECRET_GIT_PAT=<新> PLATFORM_URL=… TOKEN=… node scripts/spider-heal-pack.mjs --deploy`
    （gh_actor/通道/计费 省略=保留）。
  - (b) 接受现状：以本文档记档（PAT 具备全组织仓 admin 能力，泄漏面远大于必要）。
