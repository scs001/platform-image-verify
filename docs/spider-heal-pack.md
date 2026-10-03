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

## git 凭据（finddata 待办 ①）

签发 GitHub **fine-grained PAT**：仅 `FindDataTechnology/fd-industry-data` 一仓，权限仅
`contents:write` + `pull_requests:write`（无 admin/无 workflow/无 secret 读）。
交付后运营经重部署绑定（secret 名固定 `git_pat`；可选 `gh_actor`=commit 邮箱）：

```bash
PACK_ID=KkCie7NlrHluo4LiKPnn0w \
SECRET_GIT_PAT=<PAT> SECRET_GH_ACTOR=<email> \
NOTIFY_CHANNEL=<通道> BILLING_KEY=<运营键> \
PLATFORM_URL=… TOKEN=<运营 JWT> node scripts/spider-heal-pack.mjs --deploy
```

（省略某 secret = 保留现绑；PAT 缺失时所有工单按协议终态「转人工（凭据未配置）」。）

## 通知（四类事件）

工单终态 / PR 开出 / 总闸变更 / 超限转人工 → 部署绑定的通道（当前 `test-channel`，正式通道
换绑即全量切换）。事件文案模板见技能 `spider-heal-notify`。

## 部署 / 升级 / 回滚（运营配方）

- 升级：改 `scripts/spider-heal-pack.mjs` 内的 manifest 内容 → 带 `PACK_ID` 重跑（自动下一版本）→ runner 原地 drain 换新。
- 回滚：`POST /api/packs/KkCie7NlrHluo4LiKPnn0w/versions/<旧版本>/deploy`。
- 暂停/恢复：`POST /api/packs/KkCie7NlrHluo4LiKPnn0w/deployments/spider-heal/pause|resume`。

## finddata 侧待办清单

1. 签发 PAT（上述最小权限）并交付运营绑定。
2. 内容仓 `reports/health-tickets/` 工单流就位（五类分诊+verify 声明）。
3. （可选）中央库限流/总闸注册为 MCP server → 运营重部署追加 `mcpServers` 引用（总闸变更通知才生效）。
4. 首批真实工单试运行：SUBMIT → 观察 STATUS/pr-open → 人审 merge。

## 已验证（2026-10-03）

GitHub 出海（cheap1：github.com/api/ls-remote 200/ok）· 发布+部署+起服（:8799）·
门面 SUBMIT（凭据缺失→按协议终态 manual+结构化回执）· 重放去重 · STATUS 跨回合读盘 ·
允许清单放行。rhythm 自回合 burn-in 见 runner `meter.jsonl`（kind=self，部署后 ≤30m 首巡）。
