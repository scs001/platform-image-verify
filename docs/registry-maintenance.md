# mcp-gateway-registry 维护文档（谦面组件）

> 归属：**谦面（facet）**的自有组件（paas ADR-0015「registry 是谦面组件而非外部依赖」；**ADR-0017「独立谱系 + 上游安全单行道」**——fd-1.0.0 起功能上不再追平上游）。
> 萬星（constellation）运行面从它取活（runtime-source 关系，ADR-0015）；壹座 MCP 市场与 pack deploy 消费它；柏讯（wire）只经 HTTP 契约使用它、不拥有它。
> 上游：[agentic-community/mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)（OSS）。
> 我们的 fork：gitee `FindDataTechnology/mcp-gateway-registry`（本地副本 `~/code/mcp-gateway-registry`）。
> patch 台账：`paas/docs/registry-fork-patches/`（本仓）。
> 文档基准：2026-10-05。

## 1. 它是什么、跑在哪

自部署的 MCP 网关+注册中心，是 `mcp.finddatatech.cloud` 的本体：

- **部署形态**：cheap-1 上的 docker compose 栈，`/opt/mcp-gateway-registry/docker-compose.prebuilt.yml`（项目名 `mcp-gateway-registry`）
- **容器分工**（关键——代码来源不同）：

| 容器 | 镜像 | 代码来源 | 职责 |
|---|---|---|---|
| registry-1 | `ccr.ccs.tencentyun.com/yizuo/mcp-registry:sha-c4b0994`（fd-1.1.1，中英双语控制台） | **fd fork 构建**（标准 TCR 线） | 控制台 SPA + `/api/*` 路由（服务注册/目录/审计面）+ patch-key 铸造面 |
| auth-server-1 | `ccr.ccs.tencentyun.com/yizuo/mcp-auth-server:sha-676a245` | **fd fork 构建**（标准 TCR 线） | `/validate` 鉴权、自签 JWT、Logto IAM、egress PAT 注入、wire 双 patch |
| mcpgw-server-1 | `public.ecr.aws/p3v1o3c6/mcpgw:1.32.0` | 上游预构建（已钉版） | nginx 转发 hop（`/mcp-proxy/{server}`） |
| mcp-mongodb / mcp-openbao | — | 官方镜像 | 审计流（`audit_events`，逐工具调用记录）/ 密钥 |

- **流量链**：公网 443（雷池 WAF safeline-tengine）→ 宿主 Caddy（:8080 每域一块）→ 各后端；mcp 域经 auth-server 的 mcp-proxy hop 进各 MCP server
- **注册的 server（8，2026-10-06 网关 Mongo 实测；全量台账见 finddata 工作区 `MCP-REGISTRY.md`）**：fd-open-data-mcp(71)/fd-daas-mcp(161)/**fd-find-data-business-mcp(24)**（实数；网关快照 9 为 2026-09-19 注册时旧工具面，滞后待刷新）/fd-cn-report(44)/law-bench(52)/fd-legal-search-mcp(10)/fd-health-config(0)/AI Registry tools(7)

## 2. 消费方（谁离不开它）

1. **壹座 MCP 市场**：paas `registry-bridge.js` 经 `MARKET_REGISTRY_URL+TOKEN` 拉全局快照（TTL 300s）→ extension-store / agent catalog
2. **pack deploy / agent-runner**：部署台账与取活（萬星运行面）
3. **萬星门面**：A2A 对外服务的内部侧依赖
4. **柏讯 wire 门面**（新增，wire-platform-v1）：`wire.finddatatech.cloud/mcp` 反代 registry 的 business-mcp 条目；audit 流=按行计量的数据源（`rows_returned`，2026-10-05 起 business-mcp 每响应带戳）

## 3. 谱系现状与去向（2026-10-05 定案：独立迭代，ADR-0017）

生产实际是**三条漂移线**，收敛去向已定（openspec change `hard-fork-registry`）：

```
upstream  1.29.0 ──── 1.30.0 ──── 1.31.0 ──── 1.32.0 ─── 1.33+（只读参照，仅摘安全修复）
                        │                        │
部署：      auth-server=1.29+补丁   registry-1=1.30.0   mcpgw=:latest（未钉）
                        └────────┬───────────────┘
                    最后收敛一次（cherry-pick 14 提交，剔裁剪提交 8ad0239f）
                                 │
                     fd-1.0.0 独立谱系（gitee 权威，自此永不再追功能）
```

**已落地（2026-10-05）**：fd-1.0.0 已发布（tag + 双仓）并经**标准 TCR 线**上线——`push github main → GHA 构建 → hkccr → cheap-3 relay → ccr`，三容器统一钉 `sha-7fbc2d6`，控制台横幅 `fd-1.0.0`。gitee main 的裁剪快照叙事自此归档为历史。cheap-1 `/opt/mcp-gateway-registry` = 部署检出 + 未提交本地部署定制（常态）。

- 上游关系收敛为**安全单行道**：功能永不并入；发版 notes 一周内评估，仅安全提交摘取（cherry-pick + 全量 pytest + 钉版换镜像），台账在本仓 `docs/registry-fork-patches/`
- `logto-support` 分支：收敛落地后删除存档
- 对冲：patch ①（wgk-key）PR 上游；PR #1791（logto）继续养

## 4. wire 双 patch（为什么、是什么）

**为什么自己造**：上游（截至 2026-10-04 的 1.32.0）没有「用户自铸、长命、可吊销的入站 API key」。最接近的 1.28.0 `MCP_TOKEN_*_TTL_HOURS` 是有寿上限 JWT（无吊销、scope 铸造时快照），不满足 B2B 客户机器客户端需要（token 过期=全线 401 误报的头号来源，萬星线已实证）。

| patch | 文件 | 功能 | 部署状态 |
|---|---|---|---|
| ① per-user 长命 key | `registry/api/patch_key_routes.py` + `registry/services/patch_key_service.py` + `registry/schemas/patch_key.py` + auth_server 校验路径 | `wgk-` 前缀 256-bit key，sha256 哈希存 Mongo `patch_keys`；`POST/GET/DELETE /api/patch-keys` 自助铸/列/吊销；无自动过期；吊销下次调用即 401；scope 每次现算（改组映射对存量 key 即时生效）；明文不落日志 | **校验半边已部署**（auth-server:wire-20261005，惰性——零 key 时与旧行为逐字节一致）；**铸造半边未部署**（跑在 registry-1，见 §5） |
| ② 额度预检 | `auth_server/preflight_quota.py` | mcp-proxy 转发前查 sub2api：充足放行/不足 402/计费面不可达 strict 503 fail-closed（`PREFLIGHT_MODE=postpaid` 降级放行）；调用者→sub2api 账户映射 `SUB2API_CALLER_MAP`；30s 结果缓存 | **已部署未开启**（`PREFLIGHT_ENABLED=false`，灰度开关） |

开关/配置见 patch 头注与 `paas/docs/registry-fork-patches/README.md` 登记条目。

## 5. 债已清偿（change `hard-fork-registry`，2026-10-05 上线）

原债（registry-1 不带我们的代码 → 铸造面不可达 → wire 3.2/4.4 被堵）**已清**：fd-1.0.0 经标准 TCR 线三容器上线，铸造 API 随 registry-1 部署可达（默认开启；无 key 时行为与旧版逐字节一致，已探针验证）。换版验收实录：auth 探针 200/401/401 全过；registry 首启健康、`/api/version=fd-1.0.0`、**市场快照 diff 零丢失**（7 servers/152 skills/5 agents 前后一致）。

全部验收完成（2026-10-05）：预检 **strict + 空表**灰度生效（活链三态实证：充足放行／不足 402 上游零触达／计费断连 503 fail-closed）；**客户 wgk- 真回合经 wire 门面全链通**（演示口径：Logto 角色 `wire-customers` → 最小 scope `mcp-business-wire-execute`；真数据 law_search/yearbook_read；audit_events 落行；`rows_returned` 戳在观察读取族实证）。演示期间修复四个集成接缝（已随 fd 线发布，见谱系账本 fd 发布记录）：列表门卫认 `accessible_servers`、egress vend 白名单收 `patch-key`、canonical `oauth2` vault 桶归一、egress claim 信任门放行 patch-key。余下（wire 线侧）：sub2api 入账管道、wire-platform-v1 4.4 账本硬停联调。

## 6. 运维速查

- **版本（2026-10-05 起）**：三容器统一 `sha-7fbc2d6`（fd-1.0.0 线）：registry/auth-server=`ccr.ccs.tencentyun.com/yizuo/*:sha-7fbc2d6`，mcpgw=`public.ecr.aws/p3v1o3c6/mcpgw:1.32.0`；控制台横幅 `fd-1.0.0`
- **CI 门槛**：GitHub Actions @ **FindDataTechnology/mcp-gateway-registry**（私有仓，发布分支 `main`；**`fd-*` 分支 push 自动跑 auth-server-test + registry-test 两套——注意 GitHub 的 `*` 不匹配 `/`，分支名必须用连字符（`fd-i18n-ui`），斜杠形式（`fd/x`）两个套件都不会触发**；另加 `frontend-test`（lint/build/i18n 套件/覆盖扫描，2026-10-05 起））——换镜像前须两套绿，本地全量为可选；上游发版一周内过 release notes 安全节（安全单行道，ADR-0017）
- **回滚（4.4 成文）**：换版时已留两份备份——`docker-compose.prebuilt.yml.bak-fd-20261005` 与 `.env.bak-fd-20261005`（cheap-1 `/opt/mcp-gateway-registry/`）。回滚 = 恢复备份（或仅把对应镜像行改回）→ `docker compose -f docker-compose.prebuilt.yml -p mcp-gateway-registry up -d --no-deps --no-build <service>`（**必须带 `--no-deps --no-build`**）。单服务回退目标：auth-server→`ccr.../mcp-auth-server:sha-676a245`（当前在用）、registry→`ccr.../mcp-registry:sha-6a3acf6`（fd-1.1.0；`sha-5518840` 再退一级，均可回拉）、mcpgw→`MCPGW_VERSION=latest`（旧镜像仍在本地）。**单服务 `up` 必须带 `--no-deps` 的另一个原因（2026-10-05 实测）**：compose 会为 `mongodb-init`/`mongodb-keyfile-init` 等一次性服务解析 `python:3.14-slim`/`alpine:3.21`，而 cheap-1 直连 Docker Hub 超时、这两镜像本地又不在（曾被清理）——全量 `up` 会中止；只重建单服务时加 `--no-deps` 即绕开。换版前先 `df -h /`（30G 盘，2026-10-05 换版时仅剩 1.5G，清掉 `sha-564592f`/`sha-eb26cee` 等废弃镜像后回到 6.3G）不可变 `sha-` 标签 = 任何历史版本永远可拉可切
- **发布/构建（标准 TCR 线）**：`push github main → GHA image workflow（matrix：mcp-registry + mcp-auth-server）→ hkccr → cheap-3 tcr-relay（每 5 分钟）→ ccr`；**不再在 cheap-1 本地构建**（torch 镜像 2.7GB 曾把该机 export 层撞满，标准线亦规避此风险）。操作手册：finddata 工作区 `docs/IMAGE-RELEASE.md`；relay 清单 `/etc/tcr-relay/repos.conf`（cheap-3）
- **令牌**：控制台「Get JWT Token」= 自签 JWT，`MCP_TOKEN_MAX_TTL_HOURS=168` 硬上限；**过期=四个 server 全 401 的头号误报源**（先查 token 年龄）；只读诊断可在 cheap-1 用 `.env` 的 SECRET_KEY 现场签 10 分钟 token——**但必须带 `token_kind: "user"` claim（断言 `aud=mcp-registry`、`iss=mcp-auth-server`、`groups/scope` 照抄旧 `.admin-jwt`），否则 `/validate` 边缘守卫直接 403「Token is missing the required token_kind claim」（2026-10-05 实测；表现为 nginx 403 而非后端错误体）**
- **鉴权矩阵**：`/api/servers` 吃 Bearer JWT；`/api/tools/*`、`POST /api/servers/register|remove`、`PATCH /api/servers/{path}` 要控制台会话 cookie + `X-CSRF-Token`（`GET /api/auth/csrf-token` 取）；**PATCH /api/servers/{path} 是 JSON Merge Patch，改描述等单字段的安全通道**
- **审计**：`mcp-mongodb` 的 `audit_events`（MCPServerAccessRecord：identity/server/tool/response/IP）——柏讯计量的数据源
- **已知问题（2026-10-05）**：公网 `/fd-open-data-mcp` 条目路由坏（405 + upstream `chengsi.mesh...:30899` mesh 502 + unhealthy）——开放 open-data 入口自身故障，待修；chengsi 权威 pod 会话撞顶已 restart（复发需查 reaping 与网关健康探测漏会话）
- **预检（preflight）事实（2026-10-05）**：`SUB2API_BASE=http://103.236.89.212:32080`（sub2api 落在本机 NodePort，容器内可达）；admin key 取自 k8s `wanxing-fleet.sub2api_admin_key`；**MAP 键 = 控制台登录名**（/validate 响应头 `x-user` 的口径，非 Logto sub）；审计 `/tmp/preflight_quota.jsonl`（容器内，STDOUT 镜像在 docker logs）；重启容器后首次探测偶发 401，复打即愈
- **egress 凭据链事实（2026-10-05）**：vault 键路径 `enc(auth)/enc(user_id)/enc(provider)/enc(server)`，桶恒 canon=`oauth2`；user_id=**Logto 用户 id**（非 sub/username）；wgk- 客户链路全通（canonical egress_user 铸造时捕获）。**连接受限=上游令牌有效期**（演示用 M2M JWT 1 小时，过期后到 Connected Accounts 重贴即可）
- **Jenkins 旁路**：cheap-3 Jenkins 若构建相关镜像 401，查 `/var/jenkins_home/.docker/config.json`（uid 1000、无 passwd 条目；hkccr+Harbor 双 auth 需以 root config 拷入）

## 7. 维护归属（为什么在 paas）

- ADR-0015 定性：谦面的核心能力（MCP 目录、运行时分发）归屋谦面——**管理面、UI、补丁面在 paas 维护**
- patch 台账（`paas/docs/registry-fork-patches/`）+ 本文档随 paas 仓走；fork 源码在 gitee 独立仓（软件不重写，继续 OSS+fork 补丁模式）
- 萬星：不改其「运行面从 registry 取活」关系；萬星门面对 registry 的依赖不变
- 柏讯：只经 env 可重指的 HTTP 契约消费（`REGISTRY_URL` 等），registry 的任何变更对 wire 是外部依赖版本变化

## 8. 上牌契约（2026-10-06 起）

MCP server 接入系统供给层的统一上牌契约，出自 openspec change **`facet-mcp-foundation-v1`**（spec：finddata 工作区 `openspec/changes/facet-mcp-foundation-v1/specs/mcp-surface-contract/spec.md`）。目标是对抗 server 增殖带来的 N×M 集成债——任何新 server 按同一套动作上牌后，即可被 pack 引用、被 agent 驱动、按宿主形态实例化，无需逐宿主定制接线。四个支点：

- **tool-surface manifest（server 仓自持）**：每个对外服务的 MCP server 仓内维护一份 manifest，声明：工具组级（可细化到工具级）暴露级别 `commercial`（可进商业供给面）/ `internal`（仅内部/本地）、可进 pack 的技能清单、支持的宿主形态（共享实例 / 按部署实例）；随代码变更同步维护。首实例 = DAAS 仓（9 组 161 工具分级 + 13 产品技能 + 宿主形态声明，change task 2.1）。
- **selfcheck 双向断言**：① manifest ↔ 工具注册表一致——注册表新增/删除工具而 manifest 未同步即失败并列出差异工具；② 商业集闭合——任何消费侧暴露的工具集 ⊆ manifest 的 commercial 集，消费侧（如 business-mcp 的 daas 域）CI 反向引用对应 server 的 manifest 做同样校验。
- **台账对账**：finddata 工作区根仓 `MCP-REGISTRY.md` 为网关在册 server 的唯一台账（照 PORTS.md 范式，含入口 path/上游/实际工具数/surface 状态/宿主形态），与本节 registry Mongo `mcp_registry.mcp_servers_default` 对账；**文档数 ≠ 实数即为缺陷**。首例已判（2026-10-06）：business-mcp「文档 24 / 网关快照 9」——运行时实测实数 24，9 是注册快照滞后，修网关条目（task 4.4）而非改文档。
- **v1 只登记不强制**：registry 不因 manifest 做强制校验或代码改动——注册条目不要求携带 manifest 引用，鉴权、审计（MCPServerAccessRecord）、scope→group 映射、patch-key/preflight 行为保持现状。未上牌 server 可照常注册入网关，台账标「未上牌」，但不得进入商业供给面 / pack 分发；manifest 强制校验留待 v1.x 评估。

现状（2026-10-06）：8 个在册 server 全部「未上牌」；DAAS 走 change 后首个上牌实例。
