# Registry fork 谱系账本（cheap1 `/opt/mcp-gateway-registry`）

> 自 2026-10-05 起，registry 跑**独立谱系 fd-1.0.0**（ADR-0017）：上游收敛到 1.32.0 一次后切断，
> 功能永不再追；上游关系 = **安全单行道**（发版 notes 一周内评估、仅安全提交摘取）。
> 本文件 = ①历史补丁台账 ②fd 发布记录 ③安全单行道登记簿。
> 维护总览：`../registry-maintenance.md`。

## 一、历史补丁台账（均已随 fd-1.0.0 进入生产）

| Patch | 内容 | 状态 |
|---|---|---|
| `2026-10-03-logto-enriched-groups-scope-remap.patch` | auth-server `/validate`：DB 富化 groups 的 scope 重映射（上游 #1127 只修 PingFederate；我们泛化到 logto）。没有它，平台 `paas-agent-callers` 组拿不到 `invoke_agent` → A2A 403 | **LIVE**（fd-1.0.0 内，sha-7fbc2d6）；曾以 `mcp-auth-server:logto` 单独部署（回滚锚已随 fd 切换退役） |
| `2026-10-04-per-user-longlived-keys.patch` | patch ①：控制台自助铸/列/吊销不设过期的 `wgk-` key（SHA-256 入 `patch_keys`，明文仅铸时一次；scope 随用户组映射现算）。`PATCH_KEY_AUTH_ENABLED`（默认开）+ `PATCH_KEY_MAX_ACTIVE_PER_USER`（默认 20） | **LIVE + e2e 实测**（2026-10-05：铸 201/明文仅一次 → 无 cookie Bearer 200+7 servers → 列表无明文 → 吊销 → 立即 401；惰性回归过） |
| `2026-10-04-preflight-quota-probe.patch` | patch ②：mcp-proxy 转发前 sub2api 额度预检（充足放行 / 不足 402 / 计费面断连 strict 503 或 postpaid 放行；`SUB2API_CALLER_MAP` 未映射者整体跳过）。`PREFLIGHT_ENABLED` 默认 **false** | **LIVE（2026-10-05）：strict + 空 MAP**（未映射跳过；活链三态实证——充足放行/不足 402 上游零触达/断连 503 fail-closed；客户映射随 5.4 接入） |

## 二、fd 发布记录

| 版本/tag | 镜像 | 基线 | 内容 | 验收 |
|---|---|---|---|---|
| `fd-1.0.0`（tag，双仓） | `ccr.ccs.tencentyun.com/yizuo/mcp-{registry,auth-server}:sha-7fbc2d6` | 上游 **1.32.0** + cherry-pick 14 提交（Logto 线 + wire 双 patch；剔裁剪提交 `8ad0239f`/`2b36f87c`） | 独立谱系首发；保守瘦身（-16 万行：6 IdP、多云面、metrics-service、docs 大部）；CI=两套测试套 + image.yml 标准发布线 | pytest 全绿（CI 两套）+ 上线探针（鉴权 200/401/401、`/api/version=fd-1.0.0`、市场快照 diff 零丢失）+ 铸造面 e2e |

## 三、安全单行道登记簿（SECURITY-LANE）

规则（ADR-0017）：上游每次发版 **一周内**过 release notes；仅安全修复摘取（cherry-pick → 全量
pytest → CI 两套绿 → 标准线发布）；**功能永不并入**。每条登记：

```
| 日期 | 上游版本/提交 | 摘要 | 移植提交 | 测试凭证 | 发布 sha- |
|---|---|---|---|---|---|
```

| 日期 | 上游 | 摘要 | 移植提交 | 测试凭证 | 发布 |
|---|---|---|---|---|---|
| 2026-10-05 | `1.32.0`（收敛基线，非摘取） | 基线记录：1.30→1.32 全量安全修复随收敛继承（读面越权过滤、url_guard、forward-proxy egress 等） | fd-1.0.0 支线 | CI 两套全绿 + 上线探针 | `sha-7fbc2d6` |

## 四、操作配方

**发布（标准 TCR 线，唯一正道）**：`git push github main` → GHA `image` workflow 构建
matrix（mcp-registry + mcp-auth-server）→ 推 hkccr → cheap-3 tcr-relay（≤5 分钟）回灌 ccr →
部署节点改 compose pin 拉 `ccr.ccs.tencentyun.com/yizuo/<img>:sha-<7>`。手动补发 =
Actions → image → Run workflow。操作手册：finddata 工作区 `docs/IMAGE-RELEASE.md`。

**回放历史补丁到新克隆**（仅考古用）：`git apply docs/registry-fork-patches/<patch>.patch`。

**cheap-1 本地 docker build = 已废弃**：torch 镜像 2.7GB 曾在 export 层撞满该机盘（96%），
且 containerd 内容仓被搞脏后连环 rename/extract 报错（重启 containerd 可救，勿再走此路）。

Notes:

- 旧换镜像 smoke 配方（throwaway 容器 + `lawbenchtestadmin` 自签 token + A2A 头打
  `/validate`，2026-10-03 实录矩阵）保留作考古参考；现行验收 = CI 两套绿 + 上线探针
  （鉴权 200/401/401 + 快照 diff + `/api/version`）。
- 上游 issue 候选仍在册：PingFederate-only 的 scope 重映射门是上游 #1127，同一富化路径适用
  任何 `IDP_USER_GROUP_FALLBACK` provider（logto 即是）——上游 PR #1791（logto provider，
  scs001 fork）继续养；patch ① 上游 PR = **[agentic-community#1847](https://github.com/agentic-community/mcp-gateway-registry/pull/1847)**（draft，2026-10-05，基于 upstream/main 14f8589a，patch-key 三件套 38 测试绿）。
