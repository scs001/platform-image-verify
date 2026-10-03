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

工单终态 / PR 开出 / 总闸变更 / 超限转人工 → 部署绑定的通道（当前 `test-channel`，正式通道
换绑即全量切换）。事件文案模板见技能 `spider-heal-notify`。

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
