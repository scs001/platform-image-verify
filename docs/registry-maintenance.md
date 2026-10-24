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
| registry-1 | `ccr.ccs.tencentyun.com/yizuo/mcp-registry:sha-ad118d4`（fd-1.2.2，技能正文随版本传播修复） | **fd fork 构建**（scs001 临时线 `fd-skill-content-propagation`，基线=origin/main 5bfb6894（fd-1.2.1 谱系）；fd-1.2.1 card examples 版 sha-c9a2015 为上一版） | 控制台 SPA + `/api/*` 路由（服务注册/目录/审计面）+ patch-key 铸造面；本地 embedding 推理=fastembed ONNX（`~/mcp-gateway/models/all-MiniLM-L6-v2-onnx/`） |
| auth-server-1 | `ccr.ccs.tencentyun.com/yizuo/mcp-auth-server:sha-3739eb7`（fd-1.1.3，行数门 server 作用域+拒绝审计） | **fd fork 构建**（scs001 临时线 `fd-quota-gate-scope`，基线=生产在跑的 0aad2b53 谱系，未夹带品牌线） | `/validate` 鉴权、自签 JWT、Logto IAM、egress PAT 注入、wire 双 patch |
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
- **tool_list 快照刷新（2026-10-11）**：发布门（`add-mcp-tool-scoping`）以条目 `tool_list` 为工具名真值；快照滞后会让合法声明读成「缺失」，而公网 MCP 路由在预检 fail-closed 时一律 **503 `BILLING_UNAVAILABLE`**（活探测不可达 → 判为「无法确认」而非「不存在」）。刷新动作已脚本化：`node scripts/refresh-registry-tool-list.mjs --path /<entry> [--dry-run]` **首选走 registry 自带的 `POST /api/refresh/<path>`**（服务端重抓，不需要上游凭据、不受计费门阻挡；2026-10-11 三条已上牌条目实测 200/healthy、条数不变）；只有它没接住变更时才用 `--upstream <ledger 上游 URL>` 或 `--from-json <file>` 自行读取后 PATCH 写回。**上游直连要自己的凭据（401），registry token 不通**。两类路径都需控制台会话凭据（`REGISTRY_COOKIE` + `REGISTRY_CSRF`）。**上游直连通常要它自己的凭据（401），不是 registry token**——此时在能连通的主机上抓 `tools/list` 再用 `--from-json`。判据：刷新后条目 `tool_list` 条数与运行时真值一致，发布门对应名字不再报 unresolved。
- **tool_list 直写回填（2026-10-20，wanxing-ops-mcp）**：发布门报「无 registry 快照条目」→ 查得生产 registry（mcp.finddatatech.cloud）里 `/wanxing-ops-mcp` 条目 **`tool_list=[]`** 且活探测因上游 auth_gate 401 不可达 → unresolved。**registry 拓扑先勘明**（见下），Mongo 直写 `mcp_servers_default`（对象数组 7 条，`num_tools=7`；字符串数组会静默裁 0 的坑依旧成立）→ 公网 `/api/servers` 60s 缓存过期后回读 7 条 → 萬星舰队助手 pack 发布过门。**拓扑（重要，Caddyfile 注释已陈旧）**：`mcp.finddatatech.cloud` → SafeLine(103.236.89.212:443) → Caddy(:8080) → `reverse_proxy 100.64.0.15:18080`（**.15，k8s/裸容器形态**，`/opt/mcp-registry-k8s/mongo` 数据 + mongod rs0 127.0.0.1 绑定；凭据在 registry 容器进程 env `DOCUMENTDB_*`）。**cheap-1 与 212 本地的 18080 都是陈旧/旁路实例**（各 19 条、无 ops 系条目）——查数据先认 Caddyfile 的 reverse_proxy 目标，别信注释。直写配方：212 跳板 → .15，`nsenter -t <uvicorn pid> -m -u` 进容器用其自带 pymongo 执行回填脚本（/tmp/wanxing-backfill.py）。
- **审计**：`mcp-mongodb` 的 `audit_events`（MCPServerAccessRecord：identity/server/tool/response/IP）——柏讯计量的数据源
- ~~**已知问题（2026-10-05）**：公网 `/fd-open-data-mcp` 条目路由坏（405 + upstream `chengsi.mesh...:30899` mesh 502 + unhealthy）~~ **已恢复正常（2026-10-06 复测，本条销账）**：公网 `POST /fd-open-data-mcp/mcp` 匿名 401、带现场签 token（SECRET_KEY + `token_kind:"user"`）`initialize` 200 + `tools/list` 71；registry `/api/servers` 该条 `health_status=healthy`；nginx location 未注释、上游 `chengsi.mesh:30899` 直连 200（cheap-1 宿主/容器内 DNS 均解析 100.64.0.1）。**判读更正**：`GET/PUT/DELETE` 405 = 上游 FastMCP 正常方法应答（在役 `/fd-daas-mcp` 逐字相同），**不是**故障；只有「匿名 POST→405」才是不在路由（落 catch-all）。405 的机制：`registry/core/nginx_service.py:1117-1146` 对不健康 server 写注释掉的 location 块 + `SECURITY_BLOCK_UNSAFE_SERVERS=true` 可自动 `is_enabled=false`——即历史 405 与 502 同源=上游当时不可达/条目被摘。chengsi 权威 pod 会话撞顶已 restart（复发需查 reaping 与网关健康探测漏会话）；**残留风险**：该条仍带 `security-pending` 与 2 个 HIGH 扫描记录，再注册/改定义会重跑扫描，可能重演（台账挂账，见 finddata `MCP-REGISTRY.md` §3）
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

## 9. fd-1.2.0 发布记录（slim-registry-image，2026-10-11 上线）

**镜像依赖瘦身**：2.72GB → **843MB（-69%）**。剔除 base 依赖 torch/sentence-transformers/matplotlib/scikit-learn/awscli（torch 系移入 `local-torch` extra 留逃生门；sympy 因 strands-agents-tools 传递保留）；本地 embedding 推理换 fastembed+ONNX。

| 项 | 值 |
|---|---|
| 生产镜像 | `yizuo/mcp-registry:sha-2c2ad48`（BUILD_VERSION=fd-1.2.0） |
| 构建线 | **判路用 `fd-build-channel`**（2026-10-14 起唯一入口）。历史表述"org 账单阻断期→scs001 临时线"**已更正**：那不是账单阻断，是私有池 2000 分钟/月用尽；且 scs001 私有线 10-11 已耗尽。hkccr → cheap-3 tcr-relay → ccr 标准通道**不变** |
| CI | scs001 三测试套件绿 + image 预算门绿（843MB ≤1600MB、fastembed import OK、torch import 拒绝） |
| 引擎等价 | 切换前实证：同文本跨引擎余弦 0.999999、语义邻居 top-3 重合 8/8（evidence 在 paas change 目录） |
| 切换验证 | entrypoint「ONNX found」+「fastembed loaded Dimension: 384」、容器内 encode (N,384) 归一化、health healthy、向量集合 190 条原封未动、公网 200/401 正常 |
| ONNX 权重 | `cheap-1 ~/mcp-gateway/models/all-MiniLM-L6-v2-onnx/`（model.onnx md5 9efe4122ed…，五文件；与 torch 权重目录并存不覆盖） |
| 回滚 | compose 行回 `sha-65139f8` + `.env` 回 `sentence-transformers`（备份：`docker-compose.prebuilt.yml.bak-slim` / `.env.bak-slim`）；`up -d --no-deps registry` |
| 待办（2026-10-11 收尾后） | ① `/reindex` **降级为可选**：语义搜索实证优秀（weather→eco-mcp-time、法律检索→fd-legal-search-mcp、database query→daas/cell、网页抓取→研究类 workflow，头名全中、跨 servers/skills/tools/virtual_servers 实体类型），既有 190 条向量被新引擎正确召回，等价实测 0.999999 → 不重建亦完全可用；需要时 admin `POST /admin/embeddings/reindex`（按 paths，无全量模式） ② 浏览器验收 **已完成**（2026-10-11，Agent 实测）：登录页→控制台（横幅 fd-1.2.0）；搜索框标注 SEMANTIC SEARCH；`weather forecast`→eco-mcp-time 64% match、`法律检索`→fd-cn-report 2%、`数据库查询`→fd-cn-report/eco-mcp-fetch——中英跨语言命中、匹配分数正常渲染 ③ mcpgw 转存 **已完成并归档**（`ccr.../yizuo/mcpgw:1.32.0` + `.env` ECR_REGISTRY 覆盖，容器 healthy、真流量 `POST /mcp 200`） ④ registry ArgoCD 入驻（占位 change `onboard-registry-argocd`） ⑤ gitee 线全线同步归 wire-onboarding 会话收尾（其 compose 曾预指 sha-68e95e2 品牌线，本发布改指 sha-2c2ad48，品牌线合流后另行滚动） |

### 9.1 交接说明（给 wire-onboarding 会话 ff 时注意）

本发布在 cheap-1 部署树上留了三处改动，ff gitee 线时请勿覆盖：

| 文件 | 行 | 内容 |
|---|---|---|
| `docker-compose.prebuilt.yml` | 51 | `image: ccr.../yizuo/mcp-registry:sha-2c2ad48`（fd-1.2.0；你线曾预指 sha-68e95e2 品牌线，待其发布后由你决定何时再改指并滚动） |
| `.env` | 988 | `EMBEDDINGS_PROVIDER=fastembed`（代码默认同值；留 `sentence-transformers` 会静默降级为纯关键词搜索） |
| `.env` | 1152 | `ECR_REGISTRY=ccr.ccs.tencentyun.com/yizuo`（mcpgw 转存，原 public.ecr.aws 海外源） |

第 410 行 auth-server 已由 fix-quota-gate-server-scope（2026-10-12）滚至 `sha-3739eb7`（基于你线 0aad2b53 的直系修复，非品牌线）；compose environment 块新增 `FD_WIRE_QUOTA_SERVERS` 透传一行 + `.env` 名单三 wire server。备份在 `.bak-quota-scope`。

### 9.2 fix-quota-gate-server-scope 发布记录（2026-10-12）

**事故**：wire 行数门（3.2，10-10/11 上线）无 server 维度，lex 客户（caller map 共享、sub2api 56）在 wire 额度面 404 → 无条件 503 QUOTA_UNAVAILABLE，lex 直连入口整线不可用。移交包另报"被拒调用仍转发"——**翻案**：`mcp_response.status=success` 审计是 `/validate` 的鉴权成功记录（先于 mcp-proxy 跳）；后端 200 来自同时段虚拟入口探针（`/_vs_backend` nginx 直连上游，天然不过门）。真缺陷=审计流无拒绝最终局。

**修复**（scs001 分支 `fd-quota-gate-scope`，基线 0aad2b53，sha-3739eb7，BUILD_VERSION fd-1.1.3）：
1. `FD_WIRE_QUOTA_SERVERS` opt-in 名单（未设=全量现状；设了=只管名单）。名单=`fd-find-data-business-mcp,fd-wire-cell-drillcust001,fd-wire-cell-pgauto001`（14 天审计窗经验定稿：wire 客户 16/67/70/71/72 只打这三个）。余额门不受豁免影响。
2. mcp_proxy 四闸（tier/scope/preflight/call-grant）拒绝时经 mcp_logger 写最终局 `status=refused` 审计（对账取最终局，/validate 的 success 行保留）。
3. 单测：`TestWireQuotaGateScope` + 归一等价钉死 + 路由级 refused 审计四态，preflight 专项 103 全绿；全仓仅 4 个预存 call_grant 失败（base 复证非本次引入）。

**部署两步灰度**：①滚镜像不设 env（中间态实证：lex 仍 503 且审计出现 refused 记录=修复代码生效）→ ②`.env` 设名单+compose environment 块补透传行+重启（"Running"不重建的坑：FD_WIRE_* 是白名单式 environment 透传，.env 新变量必须同步加 compose 行）。

**验收**：initialize 200 ✅；law_search 真数据+provenance 三件套（source=law_db.laws/stable_id/as_of）✅；线内执法实证（lex key→business-mcp 503+jsonl 落行）✅；wire 回归=drillcust001 修复后 156 次 success 穿门 ✅；jsonl 无 lex 直连拒绝行 ✅；场景 6 重释版（同 id 双记录：validate success + proxy refused）✅。余额 402 逻辑由单测覆盖（生产验证需耗尽余额，未做破坏性测试）。

**回滚**：`.env` 去 `FD_WIRE_QUOTA_SERVERS` + 重启（回全量现状，lex 复 503）；或 compose 行回 `sha-0aad2b5`；总闸 `FD_WIRE_QUOTA_GATE=false`。备份 `.bak-quota-scope`。

**运维纪律（新）**：注册新 wire server 后必须同步 `.env` 名单（漏加=行数门静默失效，余额门仍在）；名单核对配方=容器内 `grep mcp_preflight_quota /tmp/preflight_quota.jsonl | jq -r .server | sort -u`（注意 jsonl 只记拒绝，放行流量不在内）。

### 9.3 fix-skill-content-propagation 发布记录（fd-1.2.2，2026-10-12 上线）

**缺陷**（finddata 交接 docs/spider-heal-fleet-egress-handoff.md P1）：pack 部署侧每次 upsert PUT `skill_md_content`+版本化 `skill_md_url`，但 `SkillRegistrationRequest` 无该字段——pydantic 静默丢弃，正文永不落库；`skill_md_raw_url` 只在 create 时翻译一次 → 内容端点回退拉取永远拿 v1 旧正文（spider-heal 凭据事故的根因之一：子机读到的是 v1 旧指令）。finddata 已直写 Mongo 热修 v10（与本修兼容，滚动后四条 spider-heal 技能 content/raw_url 完好复核）。

**修复**（origin/main ad118d4a = 5bfb6894 + 075eb7ec；scs001 分支 `fd-skill-content-propagation`，BUILD_VERSION fd-1.2.2）：
1. `SkillRegistrationRequest` 增 `skill_md_content: str | None`（空串归一 None）；service 层 None 守卫——PUT 不带/null/空串绝不清空存量正文。
2. `update_skill` 对 `skill_md_url` 实际变更重跑 `translate_skill_url` 刷新 `skill_md_raw_url`，正文或 URL 任一真实变化刷新 `content_updated_at`（raw_url 成为服务端派生不变量）。
3. create 路径 `_build_skill_card` 透传正文（部署侧对新技能走 POST，首版即入库）。
4. 测试：模型/服务/路由三层新增单测 + skill 面 431 绿 + 全量 7577 绿（1 失败=security_scanner_ssrf 缺 yara，venv 环境性预存）+ 进程内冒烟 8/8（v1→v2 两连击+UI 编辑不清空）。

**发布载体实录**：原 D4「cherry-pick fd-1.1.2」前提过时——实际生产已是 fd-1.2.1（card examples，sha-c9a2015），origin/main 也已含全部三笔（PR #4/#5）→ 直接 rebase 上 origin/main 发 patch fd-1.2.2。org Actions 仍账单阻断（4-6s startup failure）→ scs001 临时线（与同日 quota 发布共用通道，无碰撞：其滚 auth-server、本发布滚 registry）。镜像 `yizuo/mcp-registry:sha-ad118d4` 双 job 绿（预算门过）。

**验收**（生产实证）：启动日志 fastembed 双 worker loaded + /health healthy + 公网 200/401；容器内 `SkillRegistrationRequest.model_fields` 含 `skill_md_content`；**真 HTTP 端到端探针**（wanxing-facade pod 内以 AGENT_SERVING_REGISTRY_TOKEN，即部署同款鉴权）：POST 注册一次性技能 201 → PUT 带 `skill_md_content` 200 且卡片回显正文 → GET content 200 `source:inline` 直取探针正文 → DELETE 204 清场。**下次 spider-heal 升级（v11）即首次自然传播**，事后 mongosh 三查（content=新版本正文/raw_url=v11/content_updated_at 滚动）。

**运维备注**：换版前盘 97%，清掉 auth 家族陈旧 `sha-0aad2b5`（quota 发布的回滚梯；不可变 tag 仍在 ccr，需回滚时重拉即可）。备份 `.bak-fd122-skillprop`（compose+.env）。回滚=compose 行回 `sha-c9a2015`（本地在）+ `up -d --no-deps registry`。

### 9.4 add-packs-product-home 发布记录（fd-1.4.0，2026-10-15 上线）

**产品门面**（openspec `add-packs-product-home`，paas 仓）：匿名 `GET /` 分流出壹座·Packs 落地页（价值主张+三步上手+市场计数+开发者入口；基线资产 `registry/static_landing/` 入镜像，`LANDING_ASSETS_DIR` ConfigMap 覆盖、滚动生效不热更）；`GET /api/public/summary` 匿名聚合计数+策展精选（public+enabled 过滤器+handler 内二重复核、卡片 allowlist 无后端地址、策展条目失效静默剔除）；品牌串→Yizuo Packs（zh=壹座·Packs）。分支 fd-product-home（6225f1af+f8ccd531），本地 13 新测试全绿+13 预存红 worktree 基线实证；i18n:scan 1301/1301 PASS。

**出片改道**：FindDataTechnology 私有池额度尽（FDT 2011/2000，判红两分法 7 秒终 run 实锤）→ `testaction005/build-pool` 快照线（`fd-build-snapshot --ref fd-product-home`；**坑×2 在册**：①工具默认 clone origin/main，分支快照必须显式 `--ref`；②先推后设 BUILD_* 变量=run 读到空值必炸，dispatch 重跑即愈）。镜像 `sha-689ec5e`（BUILD_VERSION=fd-1.4.0，digest 7784b015，relay OK+ccr skopeo 实证）。

**滚动实录（三段）**：GitOps 0f6a9f1（registry.yaml 换 tag+新增 `landing-config` ConfigMap 挂 `/app/public-featured`）→ ArgoCD hard refresh，pod 新镜像 Running。**但公网仍 fd-1.3.0——双宿主收口**：cheap-1 compose 栈（sha-adeac80）仍占 `100.64.0.11:18080`，Caddy 三处上游原指它 → 切 `100.64.0.15:18080`（cheap-8 k8s pod，Caddyfile.bak-producthome-* 备份）→ 公网过 k8s。**再修 `/api/version` 显示**：外建 Secret `mcp-registry-env` 内 `BUILD_VERSION=fd-1.3.0` 覆盖镜像 ENV（镜像本身正确）→ patch secret=fd-1.4.0+rollout restart。onboard-registry-argocd 的「compose 双轨观察期」至此**完全收口**（cheap-1 compose 栈仍在跑但已无公网流量，退役另案）。

**验收（生产探针 2026-10-15）**：匿名 `/` 200 渲染落地页（landing-hero 锚点）零跳转；携 `mcp_gateway_session` cookie 200 返回 SPA 壳（无 landing 锚点）；`/login` 与 `/api/stats` 401 语义不变；`/api/public/summary` 匿名 200 `{servers:12, agents:10, skills:128}` featured=[]（策展空=基线策略）、未知条目 404 不泄露；`/api/version`=`fd-1.4.0` + `ui_title=壹座·Packs`。应用中心「壹座·Packs」卡片换链 `https://mcp.finddatatech.cloud`（paas fd42437，app-center e2e 4/4 绿）。回滚：GitOps 回 0f6a9f1 前 tag（sha-a95f7a0 本地有）+ Caddyfile.bak-producthome-* 复原。

### 9.5 fd-1.4.0 补丁一：登出闭环 + 根路径 Vary（2026-10-15 上线，sha-115fea3）

用户报告两症状：**①登出后停在「已成功退出」页（5 秒后跳 /login），不是回首页；②再进首页直接进登录页而不是落地页**。

**根因（两个独立缺陷，均生产实证）**：
1. **登出终点错**：IdP 的 `logout_uri` 指 `/logout`（已注册白名单页=确认屏），其自动跳转写死 `navigate('/login')` —— 退出闭环把人送回登录墙，落地页再不出现。修=自动跳 `/`（匿名态即落地页），主按钮「返回首页」，保留「重新登录」次级入口。**`/logout` 仍为 IdP 回调，白名单未动**（改 `redirect_uri` 需 Logto 侧同步登记，风险更高、收益为零）。
2. **`/` 分叉缺 `Vary: Cookie`**：我自己的分流让 `/` 按 cookie 返回两种响应却没声明差异 → 浏览器把登录态的控制台壳缓存复用，登出后访问拿到缓存旧壳 → SPA 401 → 跳 /login，表象正是「进首页直接进登录页」。修=两变体均加 `Vary: Cookie` + `Cache-Control: no-cache`（copilot 式启发式缓存不再串味）。

**探针教训（重要）**：第一版探针自己跳 `/logout` 复现出「cookie 未清」的**假失败**——`/logout` 是 IdP 回调确认屏，**不结束会话**；真登出端点是 `/api/auth/logout`（`Sign out` 按钮用的）。curl 实测其一早返回 `Set-Cookie: Max-Age=0` 是好的。**「断言失败」先怀疑探针路径，再怀疑产品。**

**验收**：root-split 10 绿（新增 4 条缓存契约：Vary 双变体+no-cache+ETag 可区分）、Logout 页 5 绿（含 4999ms 边界）、i18n:scan 1302/1302；**真浏览器 8/8 全绿**（匿名落地→进入控制台→SSO 登录→带 cookie 出控制台→真登出 cookie 清除→回首页出落地页）。回滚锚：GitOps 回 sha-689ec5e。

### 9.6 fd-1.4.0 补丁二：Logto 登出闭环（2026-10-15 上线，双镜像 sha-8b376ae）

用户视角验证（真点 Sign out 按钮，`scripts/verify-logout-return.mjs`）揪出补丁一未触及的真问题：**登出最终停在 Logto 的 `/oidc/session/end/success`，不回我们域名**——确认屏的 5 秒回跳根本没被走到。

**两处根因**：
1. **auth-server `oauth2_logout` 的 Logto 落进 Cognito 形状 else 分支**：参数名 `logout_uri`，而 Logto 只认 `post_logout_redirect_uri`（OIDC RP-initiated logout 标准）→ 参数静默丢弃。修=新增 Logto 分支（provider 名或 `/session/end` 路径匹配），发标准参数 + id_token_hint。
2. **registry 端 `redirect_uri` 指 `/logout`，但 Logto 客户端白名单登记的是裸 origin `/`**（管理 API `oidcClientMetadata.postLogoutRedirectUris` 实证）→ 未登记的 URI 被丢。修=redirect_uri 改指 `/`：登出时会话 cookie 已清，根路径即匿名落地页，一步到位。**管理 API 排查配方**：M2M token 要 `resource=https://default.logto.app/api&scope=all`（业务 resource 不行）；`GET /api/applications` 找 app → 看 `oidcClientMetadata`。

**测试**：test_logto_logout 5 绿（分支形状+Cognito 无回归）、logout_handler 17 绿（redirect_uri 钉为裸 origin）。

**GitOps force-push 竞态（新坑在册）**：推 091d2d1 后并行会话 `forced update` 把 gitee main 顶回不含我的历史（"not our ref" ComparisonError + registry/auth tag 在 LiveManifest 里双双回退）。处置=rebase 到新 head 重放（8552702）再推。**多会话并行滚 GitOps 后必查 `git ls-remote` 确认 head 未被 force 回退**。

**验收（真点按钮 5/5）**：登录→控制台→点 Sign out→**最终落 `https://mcp.finddatatech.cloud/` 产品首页**（非 Logto 域）→ 会话 cookie 清除→再进 `/` 落地页。回滚锚：GitOps 回 7e6ea90（registry sha-115fea3 / auth sha-a95f7a0）。

---

## 10. 萬星·词元修复与产品面刷新（fix-ciyuan-oidc-login + refresh-ciyuan-intro + add-ciyuan-partner-intro，2026-10-15）

**背景**：用户报告三问题——①词元 OIDC 登录不可用；②面板首页介绍落后（三车道/词元品牌零提及）；③缺一份可发合作伙伴的介绍材料。当日全链收口。

### ① OIDC 登录修复（fix-ciyuan-oidc-login）

**根因（双缺陷咬合，均实测实证）**：
1. `oidc_connect_redirect_url` 单值只登记 token 域；Logto 应用（`jm955c6cnud2yoa6tytno`，auth-admin 管理台可达）也只登记该一条回调 → router 域发起的 authorize 被 Logto 以 `400 oidc.invalid_redirect_uri` 拒绝。
2. sub2api 的 state/nonce cookie 不设 Domain（host-only）→ 即便回调放行，「起点主机 ≠ 回调主机」也必然 `invalid_state`。router 域登录**每次必败**（终态 `token.../auth/oidc/callback#error=invalid_state`）。
3. 附带脆弱点：`authorize_url/token_url/userinfo_url` 三设置空 → 每次登录实时拉 discovery（15s 超时无缓存）；10-15 15:28 生产日志一次真实 500（`context deadline exceeded`，15014ms），30 秒后该访客改邮箱注册。pod 内 auth 域经 CoreDNS 钉 `100.64.0.1`（tailnet 边缘，coredns-recovery ConfigMap）。

**修复**：
- fork `ee4d03092`：`oidcRedirectURLForRequest` 别名白名单派生（`oidc_connect.redirect_url_aliases` / env `OIDC_CONNECT_REDIRECT_URL_ALIASES`，请求有效主机 X-Forwarded-Host 优先、去端口；命中返回别名 URI 原文，未命中回落单值）。新缝点两处（config.go + auth_oidc_oauth.go）已登记 fork 台账 §二；单测 9 例。
- Logto Management API（M2M `https://default.logto.app/api`）补 router 回调——双回调 authorize 均 303。
- 设置三端点填入（`/oidc/auth`、`/oidc/token`、`/oidc/me`）→ 登录路径零 discovery 拉取（pod 日志 0 次，start 15014ms 超时形态消失，实测 ~0.15s）。
- 出片：build-pool testaction001（test job 钉 go1.27.0 **全绿**，run 38734451231）→ sha-678937c；并发会话合流滚 sha-893f610（含 Seedance 修复 e8794277f）；GitOps 2c84d70→dc56ded（gitee=ArgoCD 真源）。

**验收**：①router 域 OIDC 全链 PASS（登录→回 `router.finddatatech.cloud/dashboard`）；②token 域回归 PASS；③派生实证：router start 的 redirect_uri=router 回调、token start=token 回调；④伪造 Host（`evil.example.com`/`router-x...`）不派生，回落 token 单值（SafeLine 边缘另 404 域名白名单）；⑤密码登录双域 401 = **改前基线即如此**（测试账号走 OIDC 建号，与本次无关）。**回滚**：移除别名 env 即回落单值（Logto 双登记无害可留）。

### ② 首页产品面刷新（refresh-ciyuan-intro）

- **结构性缺口先修**：`home_content` 此前只活在词元 DB（10-05 写入，三仓无源码）→ 单一事实源落地 paas `docs/ciyuan/home-content.html` + 灌入脚本 `scripts/apply-ciyuan-home.mjs`（admin API 部分 PUT——上游 `omittedSettingKeys` 机制保其余设置不重置，已实证）+ 基线副本 `home-content.baseline-2026-10-05.html`（回滚锚）。
- 首页重写 23901→26731 字符：hero/顶栏补「萬星·词元」品牌 + 三车道一句话；**新增「模型车道」段**（ASR/TTS/rerank/websearch 四卡：端点/形状/计量口径，与 `/lanes` 同源）+ lanes.sh curl 示例；五线叙事/计费/备案保留。
- 灌入后浏览器双宽（1440/390px）验证：车道段/品牌/计量全渲染，零 page error。
- 官网 `finddatarouter.md`（zh/en）同改（tagline + 模型车道小节 + 品牌名）；出片滚产 sha-710bfb4（与并发会话星研线合流），official-web 双副本滚完，线上 `/zh/products/finddatarouter/` 眼见四关键词全渲染。

### ③ 伙伴介绍材料（add-ciyuan-partner-intro）

- 新增 `finddata/docs/ciyuan-intro.md`（wire/vaas 试用指南同形态）：是什么/入口登录/快速上手（chat 双协议+三车道 curl）/能力清单七行表/计量与计费（硬顶+错误码）/注意事项/支持。
- 口径纪律实证：无价目数字、无上游供应商身份、无谱系治理词；测试账号表留占位（伙伴名单未定）。

## 10-A. 词元第二轮：车道白屏修复 + 视频上首页 + 试用账号（fix-ciyuan-lanes-white-screen + show-ciyuan-video-on-home + add-ciyuan-trial-account，2026-10-16）

**背景**：用户报告四问题——①介绍文档没有测试账号（要求全能力+$10）；②控制台「模型车道」白屏；③首页车道卡计量徽标未底部对齐；④视频已支持但首页未展示。当日全链收口。

### ① 车道白屏修复（fix-ciyuan-lanes-white-screen）

**根因**：`lanes.ts` 六条车道形状文案含裸 `{`/`}`（如 `请求 {query, documents[]…}`），vue-i18n 运行时编译抛 `Unterminated closing brace`，整组件树死亡 → /lanes 白屏。构建期无人拦（守门测试 `localesMessageCompile.spec.ts` 存在但不在 Makefile FRONTEND_CRITICAL_VITEST 清单；fork CI 额度死，测试门只在本地）。

**修复**（ciyuan-v0.2.16-8，源 64cebfaae，镜像 sha-6f11590 / digest 4cb5e8a2）：
- 6 条字符串按仓内先例转义（`{'{'}`/`{'}'}`，见 admin/settings.ts）；Makefile 守门测试入 FRONTEND_CRITICAL_VITEST。
- **fork 前端测试债清偿 13→16**：fork 给 `platformCatalog.builtin.json` 补了 siliconflow/serpapi/openainext 三车道平台但没同步前端断言清单 → platforms.spec.ts + UserPlatformQuotaModal.spec.ts 17 例红（先 git worktree 到父提交复证 pre-existing 再修）。
- 出片走 testaction004/build-pool（run 38779870953 绿）；GitOps 92d9b2e（先并 github/main b5ad7f5 分叉再 bump）；ArgoCD sub2api 自动同步实证 revision 对齐。
- **线上眼见**：真 OIDC 链登录探针（scripts/probe-ciyuan-lanes-live.mjs）zh PASS + en PASS——4 车道行 + 形状字面量渲染 + 零 console error。en 探针坑：locale key 是 `sub2api_locale`，且须等 OIDC 回调落库后再 set。

### ② 首页对齐 + 视频节（show-ciyuan-video-on-home）

- `docs/ciyuan/home-content.html`：`.lane` 改 flex column + `.meter{margin-top:auto}`（四卡计量徽标底部对齐，生产实测 gap [21,21,21,21] spread 0px，desktop/390 双宽）；lead 补「并支持视频生成」；新增 `#fdr-video` 段（异步任务协议 create+poll curl）。灌入 26731→27749 字符。
- 官网 finddatarouter.md zh/en 双份：tagline + 能力 bullet（`/v1/contents/generations/tasks` 异步任务协议）；**en 页在站点根 `/products/`（无 /en 前缀）**，部署容器名是 `web` 不是 official-web。滚产 sha-7fa6a51（digest d86961ae），ArgoCD fd-web app 管辖，手动 set image 会被回滚——须推 deploy YAML。
- 探针：scripts/probe-ciyuan-home-lanes.mjs（对齐 gap 等值 + #fdr-video + lead 关键词，双宽 ALL PASS）。

### ③ 试用账号（add-ciyuan-trial-account）

- user 93 `ciyuan-trial@findmail.com`（密码 2026-10-18 已轮换——原值因误推事故作废，新值离线保管），$10 财务硬顶，**两把密钥**（key74 group3 openrouter=chat+三车道；key75 group9 image=视频+图像）——一把密钥绑一个分组，全能力必须两把。
- **四能力实调全绿**：chat 200×3 模型（坑：group3 /v1/models 列 26 个但只有部分可路由——deepseek-v4.1-flash=model_not_found、mimo-v2.5=upstream_error，可用例 cohere/north-mini-code:free、inclusionai/ling-3.1-flash、nvidia/nemotron-3.5-lightning:free）；rerank 200（relevance_score 返回）；websearch 200（serpapi 5413ms）；视频任务 queued→running→**succeeded**（doubao-seedance-2-0-fast-260128，completion_tokens=108900）。
- **余额对账**：10 → 8.968675，chat+车道+视频全在扣。凭据只落伙伴文档 `/Users/chengsishi/finddata/docs/ciyuan-intro.md`（第一节账号表+两把 sk- 全文），paas 侧一切材料只留指纹（邮箱/用途/额度，无密码无 key）。
- 文档口径三修：快速上手④注明视频用第二把密钥；登录步骤提醒「OIDC 登进的是您自己的账号，不是测试账号」；第一节补密钥按分组划能力的桥梁说明。

### ④ VAAS 专用账号（2026-10-16，vaas-ciyuan-lane-providers 前置）

- user 94 `vaas@findmail.com`（username `vaasline`，role user，**$20 财务硬顶**，allowed_groups=[3]），**非人类账号**——VAAS 生成后端（wanxing 线）专用，与试用账号隔离。两把密钥：key76 `vaas-tts-lanes`（group3=chat+三车道，实际用于 TTS）、key77 `vaas-image-video`（group9=图像+视频）。密码与 sk- 全文落 VAAS 部署密钥件（`/root/vaas-deploy-secrets.txt` 同级，仅部署面），paas 台账只记本指纹。
- **三车道实调全绿**（key76/key77 真调）：TTS 200（qwen3-tts-flash+Cherry，215KB RIFF WAV）；图像 200（gemini-3-pro-image，合规 b64_json，解码 778KB 真 JPEG 1408×768）；视频 queued→running→**succeeded**（doubao-seedance-2-0-fast-260128，108900 tokens，下载 2.3MB 真 MP4）。**余额对账 20 → 17.987435 全在扣**。
- 实测坑两枚（对 VAAS 集成方）：①图像 `gpt-image-1/2` 返回 HTTP 200 但 `Content-Type: text/html`（openai-next 网页 UI，两不同 prompt 同一 favicon URL）——集成分支必须校验 Content-Type；②doubao-seedance-1-0-pro / seedance-2-5 = 503、veo3.1/sora-2/kling = 404（目录挂名不可路由），可用面仅 seedance-2-0-fast 家族。调查记录在案：VAAS 会话曾因 shell 变量跨调用未持久误判 key 失效（401=空 Bearer），排障先验 key 是否真实到达请求头。

## 11. 桌面萬星①-④生产滚动（add-desktop-fleet-runner 全片，2026-10-15 深夜）

**出片通道**：FDT/law-ai-official/scs001 私有额度**全部实锤耗尽**（三仓 images run
均 5-7s 终+payments failed；fd-build-channel 的 law-ai 剩 17min 读数为滞后）。
转 **testaction004/build-pool 通用池**（1996min）出 paas，**testaction001** 出
fd-wanxing 两镜像。为此给 build-pool workflow 落了三项通用增强（向后兼容）：
`BUILD_ARGS` repo 变量（多 target Dockerfile 的 SERVICE=）、`BUILD_CONTEXT`（子
目录 Dockerfile 如 wanxing-web）、Go test job 加 `backend/go.sum` 存在门（非 Go
租户零动作过，`hashFiles` 不能上 job-if、`working-directory: backend` 目录缺失
bash 起不来——两坑在册）。

| 镜像 | tag | 源 | 池 |
|---|---|---|---|
| yizuo/platform | sha-51c33c3 | paas 4c03c19 | testaction004 |
| yizuo/wanxing-facade | sha-43bfb29 | fd-wanxing 3e294b6 | testaction001 |
| yizuo/wanxing-web | sha-67f2f2f | fd-wanxing 3e294b6 | testaction001 |

**滚动（七面）**：platform/facet/agent-runner-serving/agent-runner-b/c 同代
sha-51c33c3 + facade sha-43bfb29 + web sha-67f2f2f。fd-infra-deploy 166a978→
27d2215。**wanxing-fleet secret +seat_deploy_secret**（三处 env 引用：facade
deployCore 签票、platform/facet deployHandler 验票——单一信任根）。

**坑三条**：①agent-runner-serving 有 init+main 双 image 行，正则 count=1 只中
init 容器（live 迟迟不滚的根因）；②fd-prod compute-quota 双顶（cpu 15/15 后
memory 28Gi/28Gi——RollingUpdate surge 全卡 FailedCreate；提 cpu 16+memory
30Gi，web 还吃了 RS 退避需 rollout restart 推一把）；③并行会话同窗在滚
sub2api（gitee 非快进+detached HEAD 事故——reset 重放五文件解决）。

**生产验证**：facade healthz 200（3080 口）；信箱 ingest 无票 401；redeem 坏码
401；web 新版资产 hash 眼见（index-OJt9mj6X.js=本地 build 同 hash）；facet
healthz 200；七 deployment rollout 全 OK。

**桌面版 v1.3.12 出片（2026-10-16 补完）**：走**公开仓免费线**——私仓 bump 版本 →
`make-public-snapshot.mjs --init` → 推 `FindDataTechnology/platform` main → 打
`v1.3.12` tag 触发该仓 `release.yml`（macos×2 + windows 矩阵，公开仓标准 runner
**免费无限**，不受 FDT 私有额度影响）。win-smoke 用同仓 `workflow_dispatch` 指
tag 复验。

**v1.3.12 出片实证**：release run 38770836031 三矩阵全绿（dmg-arm64/dmg-x64/exe
——含 dmg-x64 的 Rosetta Node 路径）；assets 304/312.2/230.5MB 附 Release；
win-smoke 38772823000 三相全绿（Phase C 窗口渲染 self-test exit 0）。
release.yml 的 tag 触发与 win-smoke 的 dispatch(tag) 配方照旧有效。

**官网上架（release-sync 四步链，`DL_HOST=cheap3`）**：`node scripts/release-sync.mjs
v1.3.12 --dl-live --prune` → ①Release 资产映射 ②快照条目校验 ③写
fd-official-web `src/data/desktop-releases.json` + 推 github/gitee ④rsync 三产物
到 cheap3 `/srv/dl/platform/1.3.12/`（prune 掉 1.3.5）。随后滚官网镜像
`fd-web.yaml` sha-443f415（GitOps→ArgoCD fd-web 应用）。**验证**：dl 直链
arm64/exe 双 206；源站（124.220.7.175 https 本机）v1.3.12；公网
www.finddatatech.cloud 中/英双站 v1.3.12 眼见。
**坑一笔**：www 域穿腾讯 EdgeOne CDN（max-age=300）——源站/pod 已新版但公网
仍显旧（1.3.8），是缓存不是没滚；等 300s 或 cache-bust 即新。**1.3.11 从未上官网
（数据文件停 1.3.8）——版本跳档已由 1.3.12 直接覆盖。**

**认知订正（用户指正 2026-10-16）**：先前把 app-build.yml 的 macOS 计费当阻断是
错的——那条 workflow 属**私仓** app-build 线；桌面发行一直走公开仓 release.yml
（v1.3.0-v1.3.11 的 Release 资产即其产物）。**开源线的免费额度就是桌面打包的
正路，私仓 macos 只是 app-e2e 之类内部验证才碰**。

**快照线新增排除**：`docs/ciyuan/home-content*.html`（词元线首页部署存档，含对外
联系 QQ——公开清单不该带公司联系标识符；forbidden-pattern 扫描拦下）。

## 12. 技能包（add-packaged-skills）滚动次序手册（2026-10-16 立）

**为什么有次序**：pack manifest 的技能可携带 `files`（技能包目录树）。旧 cell 的校验器
**不认识也不拒绝**未知键——files manifest 发到旧 cell 会静默装出丢文件的哑技能。 facet 侧
`PACK_FILES_ENABLED` 发布门（**默认关**）把这个窗口期变成显式未开放，门的开关次序因此是
硬约束，不是建议：

1. **先滚 cell**：fd-prod GitOps 滚新镜像（新校验器 + 装包透传 + 确认门；门关时生产行为
   与旧版逐字节一致——存量 manifest 全不带 files）。**清单三张：platform.yaml +
   platform-demo.yaml + facet.yaml**（市场发布路由在 facet 进程——见 §12.2 坑一笔）。
2. **桌面版随下一版本**：`release.yml` 公开线出片（桌面版内嵌 cell）；桌面用户按月节奏
   自行升级——门开着之前他们装 files 包会看到明确「未开放」错误而非哑技能，可接受。
3. **开门**：facet `PACK_FILES_ENABLED=1`（env，读在每请求——改 fd-prod 的 facet
   ConfigMap/Secret 后滚动 facet 即生效；「无需等代码版」前提=①已把 facet 滚到带门镜像）。

**发布记录模板备注（本手册要求每条涉及 files 的发布记录带上）**：
- 滚动时的 cell 镜像 sha + 桌面版最低版本号（=首个带新校验器的桌面版）；
- 开门时间点 + 开门人；
- 首个 files 包的 packId（回溯锚点）。

**配套事实**：jsonLimit 24mb 三处同抬（gateway 路由默认 / facet 全局解析器 / server.js
包前缀解析器——facet 的全局 1mb 曾是真墙，路由级 limit 被遮蔽）；raw-md 端点对树技能
fail-loud（registry 单文档注册不会造出丢树孪生）；CLI 侧 finddata
`build_pack_manifests.py` 组 files、`validate_manifest.py` 对拍真校验器。

### 12.1 add-packaged-skills 滚产记录（2026-10-16）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-1eda304`（digest `63e5a5dd`；snapshot sha ≙ paas `7d565f8`） |
| 出片线 | `scs001/platform-image-verify` 公开仓免费线（run 38793699374 绿 7m0s，烟测门过；`image.yml` 恢复提交即出片 tag——快照 scrub 老坑照旧） |
| 滚动 | fd-infra-deploy `c203f6e`（platform.yaml:54 + platform-demo.yaml:71 双清单）→ gitee 双端 → ArgoCD hard-refresh → 两 deploy 滚完，pods Running 新 tag |
| 实证 | in-pod `/api/config` 200（packMarketplace live）；`sha-1eda304` skopeo ccr 实证后才 bump（硬门序） |
| 门状态 | **`PACK_FILES_ENABLED` 未设（关）**——本滚只交新校验器/装包线/上传通道，生产行为与旧版逐字节一致；开门按 §12 次序（桌面版下一版本带新 cell 后） |
| 门待办 | 桌面版 release.yml 公开线随 v1.3.13 带此 cell → 那之后才开门 + 记录首个 files 包 packId |
| 验证账 | 单测 1449/1449（新增 27 例）；e2e 全链 1/1 + 兼容回归 40/40；typecheck 绿；CLI 对拍 vaas 88 文件真校验器 ✓ |

### 12.2 v1.3.13 出片 + 开门记录（2026-10-16，§12 次序走完）

| 项 | 值 |
|---|---|
| 桌面版 | `v1.3.13`（release run 38797895288 三矩阵全绿 13m04s；assets arm64 303.9MB / x64 312.1MB / Setup.exe 230.6MB） |
| win-smoke | 4 连红同签名（Phase A node.exe 活、47600 拒连 2min）→ 三轮 debug 工作流实证 exe 健康（直跑 server.js 200 / GUI 200 / 冒烟原样启动+netstat 127.0.0.1:47600 Listen+settings 种子正确+main.log 干净）→ **tag+main 双跑 smoke 三相全绿**（38808977012 / 38808972478，Phase A+/B/C）定案 **runner 池瞬态**（同日 macOS Node native crash 佐证；与 v1.3.12 exe 差异仅 1 前端文件） |
| 排障残留 | win-boot-debug ①②③ 临时工作流已从公开仓 main 删除（b95df82/b9bca51）；**判读配方**：smoke Phase A 红先看 main.log 镜像（`%APPDATA%\platform\main.log` 含 piped server 子进程日志）+ `Get-NetTCPConnection -OwningProcess`，别再盲重跑 |
| 官网上架 | release-sync 四步链 `DL_HOST=cheap3 node scripts/release-sync.mjs v1.3.13 --dl-live --prune`（数据 c45c955 双端推；3 产物 rsync cheap3 `/srv/dl/platform/1.3.13/`，prune 1.3.8）→ 滚 `fd-web.yaml` sha-c45c955（digest `6a692df8` ccr 已核，deploy 837b333）→ ArgoCD gen96 2/2 |
| 验证 | dl 直链三产物 3× **206**；公网 `www.finddatatech.cloud` 中/英 products 页 **v1.3.13 眼见**；EdgeOne 300s 缓存坑照旧（age 命中即旧） |
| 开门 | **`PACK_FILES_ENABLED=1` 已开**（2026-10-16，开门人=工程）；facet.yaml `cf86e72`：镜像滚 `sha-1eda304` + env 开门一滚到位 → in-pod `PACK_FILES_ENABLED=1` 眼见 + `/api/health` ok；前置条件=v1.3.13 已带新 cell 出片（win-smoke 双跑绿） |
| 基线 | 开门时 packs.db **96 版本、0 个 files 包**（`SELECT … WHERE manifest LIKE '%\"files\"%'`）——**首个 files 包 packId 回溯锚待首包落地**（该 SQL 即锚点查询） |
| 坑一笔 | **§12.1 滚动漏了 facet.yaml**：packs 市场发布路由跑在 facet 进程（`facet/index.js` 挂 `gateway/packs.js` 路由），platform.yaml 只是 `/api/packs` 代理——次序手册里的「先滚 cell」**必须含 facet 面**，否则开门 env 落在无门代码的旧镜像上等于没开。手册③的「无需等代码版」前提= facet 已在新镜像 |

### 12.3 v1.3.14 滚产：成果筛选 + save_to_library 模型入藏（add-resource-filters + add-save-to-library-tool，2026-10-16）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-836bdc6`（digest `cab3545d`；snapshot sha ≙ paas `14d9da1` = 3394b66 两 change + 14d9da1 adapter allowlist 修复） |
| 出片线 | `scs001/platform-image-verify` 公开仓免费线。**首跑真红**（非 flaky）：新桥 `platform-save-library-bridge.js` 直 import `@deepseek-ai/dsh-tools` 违反 ADR-0023 适配器边界 → 加进 `scripts/dsh-adapter-files.json`（`14d9da1`）后全绿；`image.yml` 恢复提交 `836bdc6` 即出片 tag（scrub 老坑第三次照旧） |
| 构建 | build-check run `38823998437` 全绿（lint→typecheck→unit→locales→build→e2e+contracts 烟测）；image build-push run `38825720268` 绿（boot 烟测门后推 hkccr） |
| 滚动 | fd-infra-deploy `ca32718`（platform.yaml:54 + platform-demo.yaml:71 双清单）→ gitee 双端 → ArgoCD hard-refresh → 两 deploy rollout 完成新 tag |
| 实证 | in-pod：`platform-save-library-bridge.js` 在位、契约 skill 含 save_to_library×2、web bundle 含 resource-created-at；真库探针 `listResources({groups})` + 9 组 facets ✓；`saveFileFromModel` 工作区外路径 `invalid_path` 拒 ✓；**save-declared 三个 loopback cell 端口全 `200 ok:true`**（网关化拓扑下 3100 gateway 面 401=预期——转发后 remoteAddress 非 loopback，桥调用只发生在 cell 内部） |
| 新能力 | 成果页：时间窗（今天/7天/30天）+类型组 chips（facet 计数、默认预勾图表/文档/表格/图片）+卡片创建时间；模型侧：`save_to_library` 工具（≤10 路径逐条回报、第四座 loopback 桥、source=model 会话级溯源、产物契约"交付即调"条款） |
| 验证账 | 相关单测 74/74（新增 filters 7 + bridge 7 + api 3 + store 1）；e2e 11/11（含 380px 窄屏）；dsh-contracts 17/17；spec sync 后 151/151 |
| 归档 | ① `2026-10-16-add-resource-filters`、② `2026-10-16-add-save-to-library-tool`（均 sync 主 spec 后归档） |

### 12.4 v1.3.15 滚产：壹座部署表单模型/回合预算输入（add-deploy-form-model-budget，2026-10-16）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-343ad99`（digest `f61f2768`；snapshot sha ≙ paas `fd48a6b` = ad915b0 功能全链 + v1.3.15 bump） |
| 出片线 | `scs001/platform-image-verify` 公开仓免费线；快照 `9c038f8` 强推 + `image.yml` 恢复提交 `343ad99` 即出片 tag（scrub 老坑第四次照旧，推后立即恢复） |
| 构建 | image build-push run `38829026658` 绿（boot 烟测门后推 hkccr）；relay OK 行 08:31:39 + skopeo ccr digest `f61f2768` 实证后才 bump（硬门序） |
| 滚动 | fd-infra-deploy `eca6120`（platform.yaml:54 + platform-demo.yaml:71 双清单）→ gitee 双端 → ArgoCD hard-refresh → 两 deploy rollout 完成；首查 image 字段仍旧=ArgoCD 刷新→同步窗口（~60s），非异常 |
| 实证 | in-pod：`AgentsPage-CsBVP5qS.js` 含 `pack-deploy-model-`/`modelLanesUnavailable`（bundle `index-qce88fQq.js` ×5 locale）；公网同 hash chunk 眼见；healthz 200 |
| 新能力 | 部署区每 serving agent 增模型输入（modelWhitelist datalist + 声明默认 placeholder）与回合预算输入（1-120 整数客户端挡提交）；空输入=维持现状三态（既有覆盖→声明→平台默认，升级存续语义对齐，不发 null）；部署请求带 `models`/`budgets`；`MODEL_LANE_REJECTED`/`MODEL_NOT_IN_ROSTER`/503 三分支本地化——**503 窄分支新修**：`billing plane not configured…` 文案会误中 catch 的 `/not configured/i` 把整个部署表单换成自托管引导面板、埋掉真因（专项回归测试钉住） |
| 验证账 | typecheck/biome/check:locales 绿（12 key×5 locale）；e2e `pack-deploy-config` 3/3（route-mock 线约断言：空输入省略、预算落体、无效挡提交、模型落体+闸拒本地化+503 回归守卫）+相邻回归 23/23（packs/agent-service-config/preset-publish-flow/packaged-skills） |
| 归档 | `2026-10-16-add-deploy-form-model-budget`（spec sync：pack-marketplace ADDED 部署表单需求 + MODIFIED 部署区副标题，该 capability 17→18 需求后归档） |

### 12.5 v1.3.16 滚产：功集发布预校验 dry-run（creator-pack-forge-support，2026-10-16）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-c303424`（digest `3631feb2`；snapshot sha ≙ paas `b12ffe0` = d575e39 功能全链 + v1.3.16 bump） |
| 出片线 | `scs001/platform-image-verify` 公开仓免费线；快照 `432883c` 强推 + `image.yml` 恢复提交 `c303424` 即出片 tag（scrub 老坑第五次照旧，推后立即恢复）；image run `38904625661` 绿 447s，四道烟测门全过（/api/config、agent liveness、dsh contracts、module identity），体积 1.41GB |
| 构建 | relay 手动补单 `21:09:13 OK yizuo/platform:sha-c303424 (20s)`；skopeo ccr digest `3631feb2` 实证后才 bump（硬门序） |
| 滚动 | fd-infra-deploy `6ce7d05`（**三清单**：platform.yaml:54 + platform-demo.yaml:71 + **facet.yaml:66**——发布路由跑在 facet 进程，§12.2 坑册的次序教训已内化为常例）→ gitee/github 双推 → ArgoCD hard-refresh（argocd CLI 公网入口超时，改 kubectl patch 发起 sync，phase=Succeeded）→ 三 deploy rollout 全绿 |
| 实证 | in-pod：`collectPublishVerdict` ×4 引用 + `/api/packs/validate` + `PACK_VALIDATE_RATE_MAX` 在位；facet `/api/health` ok。**生产眼见四例**：① 匿名 validate 401 与 publish **逐字节同形**（含 `loginUrl`）② 创作者身份 200 `{valid:true,errors:[],caller:{publishEligible:true}}` ③ 非创作者 200 `valid:true` + `caller:{publishEligible:false,reason:"Creator group required"}` ④ **parity 对拍**：同一非法 manifest 上 publish 400 body 与 validate `errors[0]` 逐字节相同 |
| 新能力 | `POST /api/packs/validate` dry-run：任何登录用户可调；信封体 `{valid,errors[],caller}`；errors 为**全量收集**（publish 早退，validate 一次给全）；每项即 publish 对应拒绝响应的完整体（code/toolGate 标记保留）；零副作用（不铸 id/版本、不落库、不耗发布预算）；独立限流桶（`PACK_VALIDATE_RATE_MAX`，默认 120/h）。门序列收敛为单一纯读收集器 `collectPublishVerdict`，publish 传 `shortCircuit:true` 保住"拒绝路径零 registry 往返"性质 |
| 实施期修 | 顺手修 `lib/publish-tool-gate.js:106` 既有日志 bug：`missing.length - stillMissing` 漏 `.length`，"N name(s) confirmed by live probe" 注记**一直为 NaN**（只影响注记文本，不影响判词） |
| 验证账 | 全量单测 **1494/1494**；相邻 packs 14 套 117 项；新测试 `test-pack-validate.mjs` 8 项（parity 语料双端对拍 8 例 + 全量收集 + 副作用 + 独立限流 + 匿名 401 + registry 503 fail-closed）；openspec validate 绿；biome 干净 |
| 边界 | 出片**只交路由**——validate 是给创作者 pack（finddata 侧「谦面工坊」独立 change）用的地基，本滚不改变任何既有生产行为（新路由 + publish 内部等价重构）。工坊 pack 发布前另有 infra 第零步（airegistry-tools 路由修复 + 快照回填 + mcpgw 凭据姿态） |
| 归档 | `2026-10-16-creator-pack-forge-support`（spec sync：pack-marketplace ADDED「不发布即可校验」+ tool-discovery 补澄清 Scenario 后归档） |

### 12.6 前置第零步之一：airegistry-tools 路由修复（2026-10-16，工坊线）

| 项 | 值 |
|---|---|
| 背景 | 「谦面工坊」creator pack（finddata 侧待开工）要用 `airegistry-tools` 做发现源；其条目此前 `tool_list=0`+公网 405（land UNHEALTHY_URL_BLOCKED），没有快照就过不了发布门的 allowTools 对拍 |
| 原挂账判断 | finddata `MCP-REGISTRY.md` §3 条 2 记为"`mcpgw-server` 无 DNS，补 Service 后把 `proxy_pass_url` 指到 `.svc.cluster.local`"——**方向有误**（本栈全 hostNetwork + `dnsPolicy: Default`，svc 名同样解析不了；且改 URL 会掉出源码的三元组身份绑定） |
| 根因（生产代码路径复现） | `proxy_profile_for_entity_target` 选中 `builtin-airegistry-tools` profile ✓ → `validate_url` 抛 `DNS resolution failed: Name or service not known` → `UNHEALTHY_URL_BLOCKED` → nginx location 被注释 → grep 405/`tool_list=0` |
| 实修 | fd-infra-deploy `ee45bec`：`mcp-registry/prod/registry.yaml` 的 `hostAliases` 加 `mcpgw-server`，与既有 `auth-server` **同一 ip 条目内**。⚠️ 首修 `18775fe` 拆成两条同 ip 条目**未生效**（last-applied 注解有新值而 `spec.template.spec.hostAliases` 恒旧值）——同 ip 的 hostAliases 必须合并为一条 |
| 原理 | url_guard 对 `trusted_hostname` 显式放宽 loopback（`_validate_resolved_ips` 把解析出的 IP 加成精确 CIDR 放行）；拓扑前提天然具备（两容器同 hostNetwork 同钉 cheap-8） |
| 实证 | pod `/etc/hosts` 含别名；`validate_url` OK pin `['127.0.0.1']`；`num_tools=7`+`tool_list` 7 条自动回填；工具名实弹全集与源码 7 个 `@mcp.tool` 逐条吻合；公网 `POST /airegistry-tools/` **405→401**（与 `/fd-open-data-mcp/` 同态）；registry 日志 `Creating location block`；`security_scan` 五项全清 |
| 凭据姿态 | mcpgw 未配静态令牌/M2M = **调用者 bearer 转发**（姿态 A 成立，无管理员视图全透出风险）；`_INTERNAL_INGRESS_RELAY_SERVERS` 硬编码仅放行此一条的进站 Authorization |
| 剩余（工坊线另两件） | ① 快照回填**已随本修自动完成**（7 工具）；② 「谦面工坊」pack 内容与 facet-market-mcp 第七工具（finddata 侧 change） |


### 12.7 工坊线收口：facet-market-mcp 第七工具 + 「谦面工坊」上架（2026-10-16）

| 项 | 值 |
|---|---|
| 背景 | creator-pack-forge-support（§12.5）铺了 `POST /api/packs/validate`；本段把 finddata 侧两件做完——市场 MCP 接出该工具 + 创作者 pack 上架 |
| 工具面 | finddata `facet-ops-mcp` 加 `facet_market_pack_validate`（第 7 个，薄包转发；docstring 写明三条语义纪律：errors 原样转述、caller 必须同呈、建议流程 browse→validate→publish）；surface manifest 同步（marketplane commercial 6→7 + `skills_eligible` 加 `facet-forge-assembly`）；**27 测试 + 双面 selfcheck PASS（13 tools）**；源真 sha `0174f3e` |
| 出片 | **testaction003/build-pool**（law-ai-official 仅剩 17 min 不够；scs001 无该 images 仓）→ `sha-0a2dba6`；坑：`fd-build-snapshot` 带 `--keep-workflows` 会取消 `/.github` 排除 → 源仓无 `.github` → rsync --delete **把 pool 自己的 image.yml 删掉** → 推了快照无 run。恢复提交即出片 tag（`0a2dba6`）；**不带该 flag 时 --exclude 会保留 pool 的 workflow**（已在 file 头部留纪律注释） |
| 滚动 | fd-infra-deploy `68eac31` **双清单**（facet-market-mcp + facet-ops-mcp，同镜像双面）→ 双端推 → ArgoCD hard-refresh → 两 deploy rollout 完成；运行时实弹 7 工具（`create_server(Settings(face='market'))` + `list_tools()`） |
| 快照回填（关键门） | registry 条目 `tool_list` 6→7 + `metadata.surface.commercial_tools` 6→7。**踩坑**：先写成**字符串数组** → Mongo 看着正常但公网 `/api/servers` 返回 `num_tools=0`（`tool_filter._tool_identity` 取 `tool.get("name")`，字符串取不到 → fail-closed 裁空）。改**对象数组** `[{name,description}]`（描述从运行时 `list_tools()` 实取，不手写）后公网回读 7 条 |
| E2E 实证 | 工坊 manifest 过门：`{"valid":true,"errors":[],"caller":{"publishEligible":true}}`——同时证明 `airegistry-tools`(5 allowTools) 与 `facet-market-mcp`(5) 两处声明都对得上快照 |
| 上架 | 「谦面工坊」`_B99vDq0CFBNQGvmfy5iSw` v1，作者 aloadtree@gmail.com，public，匿名可见；3 技能（assembly 带 3 个 references 文件 / adaptation / acceptance）+ 双 MCP 收窄 + 铸造师 persona + 三步指南；**真校验器零 error**；files 匿名可读实弹 |
| 真对话验收（浏览器实测，已做） | 装机六项全物化（3 技能含 3 files + `scriptFiles: []` + 双 MCP + 铸造师）；会话内**真实 MCP 调用成立**（一轮 36 次：`mcp__fd-daas-mcp__daas_search_functions` / `gateway_list_data_mcps` / `mcp__connector__list_apps`，trace 可查）；**诚实纪律真机生效**——助手两次如实报告"airegistry-tools 没挂载/取不到"并声明不编造。前置凭据链走通：连工具市场 + 谦面设备配对（6 位码）齐全后报告才由 `credential-required` 变 `installed` |
| 断连根因（已修，2026-10-16 第二跳） | 真因=**调用链末跳**：`nginx(registry) → auth-server 的 mcp-proxy → http://mcpgw-server:8003/`，**末跳在 auth-server 容器**，它同样 hostNetwork+Default DNS 解析不了该名字 → 公网 initialize **502** → 壹座 `[mcp-preflight] server-error (initialize 502)` → 会话判 disconnected。首修（`ee45bec`）只治了 registry 容器自己的健康检查/url_guard。**实修** `6be0653`：auth-server.yaml 加同款 hostAliases。实证：容器内解析成功 + `/health` 200；platform pod 打网关由 **502→401**；后续 preflight 不再报 502 |
| 判词两种病灶 | **405 = 健康门**（条目非 healthy，location 被注释）；**502 = 末跳解析失败**（链路某容器解析不了上游名）。别混判 |
| ⚠️ 残留 | dsh 运行时仍持旧连接态（连接是进程内缓存），需 **cell runtime 重启**才对已有会话彻底生效——重启属用户会话级操作，未擅动。另观察到 `facet-market-mcp: auth-rejected (initialize 401)`：它走网关 URL 而网关只对 airegistry-tools 转发 Authorization，故走网关必 401（其正确形态是 mesh 直连，见 §1 表） |

### 12.8 v1.3.17 滚产：业务角色/可配置布局/意图首配 三案 + **打包事故与冒烟门加固**（2026-10-17）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-68314d5`（digest `d8cc1a31`；snapshot sha ≙ paas `223a089` = 707595c 三案功能 + 5f92e20 v1.3.17 bump + 223a089 打包修复） |
| 出片线 | **testaction003/build-pool**（FDT 私有额度已耗尽 2011/2000；公开线需私有源码入公开仓，按 AGENTS.md 改走通用池）。三次快照：`6b546fa`（❌ 源未推送，镜像无新码）→ `6e4e8a1`（❌ 打包缺 packages/）→ `68314d5`（✅） |
| 滚动 | fd-infra-deploy 三清单（platform.yaml + platform-demo.yaml + facet.yaml）→ gitee/github 双推 → kubectl 发起 ArgoCD hard-refresh（`d178e8a` 修正 →`2dd523f` 回滚 →`31dd961` 终版）→ 三 deploy rollout 全绿 |
| 生产验证（in-pod 活体） | ①**代码同一性**：pod 内 11 个新/改模块（`server/{roles,layout,onboarding,auth}.js`、`server/routes/misc.js`、`gateway/{index,roles,layout}.js`、`packages/core/src/lib/{surfaces,roles,recipes}.ts`）md5 与本地工作树**逐一相等**——证明跑的就是验的那份；②**模块活体**：pod 内跑真实路径 `resolveForUser(legal)` → 4 项 `[chat,knowledge,resources,agents]`（三案联合：角色层收窄+配方预设+注册表）、无配方角色 → 7 项、8 角色枚举在位、`validateAnswers(screenplay)` 拒、`buildPlan(legal).packs` → `[{legal-contract, install}]`、`selfAssignment` 保 admin；③**前端同一性**：公网 `https://platform.finddatatech.cloud` 下的 `index-up4AtDK6.js` md5 `50fb64c5…` 与 pod 内 `web/dist` 同文件相等，且公网 index.html 引用的 assets 集与 pod 完全一致；④**注册在盘**：`gateway/index.js` 内 `/api/roles`、`/api/roles/assignments`、`/api/layout/config` 注册行在运行文件中；⑤`/healthz` 200 且 `{"cells":1}`（**gateway 形态**，非单进程） |
| ⚠️ 判据更正 | 早先记录的「三条新路由 401 而非 404 ⇒ 路由存在」**不是有效判据**——实测不存在的路径同样 401（鉴权门先于路由短路）。已用上条 ①②③④ 取代。凡以 HTTP 状态码判别「路由/功能是否上线」，必须先证明该码区分存在与不存在；本项目公网匿名请求恒 401，状态码无鉴别力，只能用**代码指纹（哈希）＋模块活体执行** |
| ✅ HTTP 端到端（终局判据，2026-10-17 复验） | 直打 cell（pod 内 `http://127.0.0.1:43325`，`x-cloud-gateway-secret` + `x-forwarded-email`）：**注**：`x-forwarded-roles` 线格式是**数组** `["primary",...secondaries]`，传对象会被 `parseRoleHeaders` 判非法并回落 `standard`（首测踩中，非缺陷）。实测：`["legal"]`→nav 4 项 `[chat,knowledge,resources,agents]`；`["stock"]`→同 4 项；`["screenplay"]`（无配方）→7 项不收窄；`x-forwarded-layout: {"hidden":["tasks","fleet"]}`→7 项收至 5 项（部署层终局生效）；`["stock","legal"]`+`x-forwarded-role-admin: 1`→`isAdmin:true` 且 secondary 保留，去掉 admin 头→`false`（自频道不授 admin 不变量成立）；**伪造**：带身份头但无 secret → **401**（信任边界成立）。网关侧 `/data/cells/roles.json` 已初始化（`{assignments:{},default:null,roster:["aloadtree@gmail.com"]}`），`layout.json` 未配置（无部署层布局，符合预期） |
| 🔥 事故 | 首次滚 `sha-6e4e8a1` 后 **platform 与 platform-demo 双双 CrashLoopBackOff**：`ERR_MODULE_NOT_FOUND: /app/packages/core/src/lib/recipes.ts`。**根因**：本 change 新增 server→packages 运行时 import（`server/{roles,layout,onboarding}.js` 与 `gateway/layout.js` 引共享契约），而 Dockerfile runtime 阶段从未 `COPY /app/packages`。本地与 e2e 全绿是因为仓库树里有 `packages/`，**只有打包镜像暴露此缺口** |
| 处置 | ①立即回滚三清单 → `sha-c303424`（`2dd523f`），服务恢复（`/healthz` 200、两部署 1/1）②Dockerfile 补 `COPY --from=builder /app/packages ./packages`（设计原意即「packages/core 由 web 与 server 共用」，非权宜）→ `223a089` |
| 🛡️ 防线加固（为何 CI 没拦住） | 通用池 `image.yml` 的通用冒烟门带 `SMOKE_MODE=skip`（日志实证 `smoke=skip`），本仓又无 `scripts/ci-smoke.sh`，钩子落空 → **坏镜像直通推送**。新增仓库自有 `scripts/ci-smoke.sh`（池 workflow 优先执行它，**SMOKE_MODE 无法跳过**），四道门：`/api/config` 可达 + `/api/ready` 翻转（dsh 握手）+ 启动日志无 `ERR_MODULE_NOT_FOUND`（打包缺目录类）+ 九个共享契约/新模块文件在盘（把本次故障形态钉死）。重出片日志实证：`smoke: running scripts/ci-smoke.sh` → `/api/config healthy` → `/api/ready healthy` → `smoke: OK — ... shared-core files all verified` |
| 教训（计入坑册） | ①**新增 server→共享层的运行时 import，必须同步 Dockerfile COPY**——这类缺口本地/单测/e2e 全绿（仓库树有文件），只在镜像里暴露；②**快照必须从已推送的 commit 出**——`fd-build-snapshot` clone 自 remote，未推送的本地提交会被静默漏掉（首次滚产即踩，产出「同 tag 无新码」的假绿）；③**冒烟门是否真跑要看日志里的脚本执行行**，`smoke=skip` 与 `smoke: OK` 是两回事 |
| 归档 | `2026-10-16-role-system` / `2026-10-16-layout-configuration` / `2026-10-16-intent-onboarding`（spec sync 后归档） |

### 12.9 真机试用（新账号注册→首跑）暴露三缺陷 —— 三案「验收合格」结论**不成立**（2026-10-17）

2026-10-17 用真实邮箱注册了一个全新账号（`zztrial-*@maxxspace.com`，走生产 Logto 注册：用户名 → 邮箱 → **真实验证码** → 设密码），在公网域名做完首跑。结论：**部署/代码同一性验收全过（§12.8），但产品功能在真实托管形态下有 3 个缺陷，用户可见地不工作**。§12.8 的「生产验证」只证了「镜像里的代码对」，证不了「端到端可用」——这是两种验收，不能互相代替。

| # | 缺陷 | 证据（可复现） | 根因 |
|---|---|---|---|
| ① | **首配写的角色被网关头覆盖，布局永不生效**（用户可见：选了「法律」，导航仍是 7 项默认） | cell 内 `roles.assignments` 确实写入了 `{primary:"legal"}`；但直打 cell 带网关实际所盖头 `x-forwarded-roles: ["standard"]` → `roles` 变 `standard`、nav 回到 7 项；不带该头 → `legal` + 4 项。网关 `roleStore.assignmentFor()` 读的是**自己的** `/data/cells/roles.json`（为空 → fallback standard），而 `/api/onboarding/answers` 写的是 **cell 自己的** `deployment_config`。`resolveAssignment` 里 gateway 源**优先于** stored（`server/roles.js:147`） | 设计 D1 明写「托管走 gateway 指派存储的内部写入」，实现只写了 cell 侧存储；网关无 `/api/onboarding/*` 路由，故该写入路径不存在 |
| ② | **配方 pack id 全部解析不到**（首配「安装」全部失败） | `POST /api/onboarding/provision` → `{"results":[{"packId":"legal-contract","status":"failed","error":"Pack version not found"}]}`；市场实测 38 包无 `legal-contract`/`stock-research`/`china-macro`，真实 id 是**随机串**（如 `J9sO_wRCgUVjbYVEqD4Pog`=法律-合同），且无 slug 字段 | `RECIPE_CATALOG` 用的是**人类可读 slug**，市场用的是生成的 id，两者无映射表 |
| ③ | **选默认专家抛异常 → 显示为「失败」** | provision 返回 `{"expert":{"status":"failed","error":"Cannot read properties of null (reading 'user')"}}` | `onboarding.js` 传 `ctx.switchAgentTo(id, null)`，而 `switchAgentToInner` 首行即用 `ws.user` 解引用（`server/agent-session.js:413`）——自服务通道没有 ws |
| ④ | **确认列表里 `{name}` 字面量外露**（用户可见） | 首配确认清单渲染成 `Install {name}` | 项目用 **react-i18next**（`{{name}}` 双花括号），本轮新加的 `onboarding.planPack` / `onboarding.readyTitle` 用了单花括号；5 个语言文件全中，共 2 键 ×5 语区 |

**未被证伪的部分**：同一账号实测通过的——真实注册链（含邮件验证）/ 首跑问卷出现且题型正确（三维度就绪角色卡 + 备注 + 跳过）/ 提交后确认清单出现 / 激活走到 done / 回答后问卷不再复现 / 重开入口预填已存答案（`aria-pressed=true`）/ `layout.config` 部署层隐藏头生效（7→5）/ 伪造身份头无 secret → 401 / 分权不变量（`role-admin` 头与 roles 头必须同行，且自频道不授 admin）。

**方法论教训（重要）**：§12.8 的验收（模块 md5 比对 + 模块级活体调用）**证明了代码部署正确，但没有穿过 HTTP + 网关头注入这条真实路径**。三个缺陷都只在「带身份走完整请求链」时才现形——①甚至需要**先知道网关会盖什么头**才能构造出复现。**结论：新能力上产后的验收必须包含一次真实账号端到端首跑**（注册→首跑→看用户可见结果），模块级验收只能证「形」，不能证「用」。相关坑：`{name}` 单花括号（react-i18next 不吃）。

### 12.8 平台指南 v3 缩篇：制作技能收成「编排补篇」，主创作路径单点指向《谦面工坊》（2026-10-16）

| 项 | 值 |
|---|---|
| 动因 | 工坊上架后，平台指南的 `facet-pack-builder`（11.2KB）与工坊三技能内容重叠，两处各维护一份方法论会各自漂移（共识：单一事实源） |
| 动作 | 该技能缩成**编排补篇**（11.2KB → 6.6KB）：只留工坊不覆盖的 ①批量套件定义 schema（`facet-preset-suite/v1`，含组装规则与 persona 追加指引）②registry 侧技能注册（供各处复用，非 pack 内联；单文档注册不承载树技能）③四道闸全貌（含需平台运维介入的②③两道，工坊只写用户能自救的①④）。正文开头即指向工坊；包描述同步写明分工 |
| 发布 | pack `3LUWFBGS3RJe5BIV9MvBFw` **v3**（续版）；真校验器零 error + 发布门 `valid:true`（含续版归属检查）后经集群内 loopback 发布（含代码块走公网会被边缘 WAF 拦） |
| 实证 | 公网读到 v3：`facet-pack-builder` 正文 3960 字符、开头为"先分清用哪个"指向段；`yizuo-wanxing-guide` 未动 |
| 待办 | ~~已订阅用户需升级 v3~~ → **核销（2026-10-16）**：packs.db 实测平台指南订阅总数 **0**（无外部订阅者），v3 即唯一可见版本。**另：真对话补验 `mcp__facet-market__facet_market_pack_validate` 真实调用成立**（trace 有 tool/call + tool/result），至此 finddata 侧四件全部完成 |

### 12.10 首配四缺陷修复与滚产（§12.9 的收口，2026-10-17）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-ef54bb0`（digest `2779e2e4`；snapshot sha ≙ paas `b91e8666`）。三清单同 tag（platform + platform-demo + facet），pod 内 imageID 实测 = 该 digest，restarts=0 |
| 出片线 | `testaction003/build-pool`（私有源码走通用池）。**快照从已推送 commit 出**（`git log origin/main..HEAD`=0 在先）——快照仓 clone 复核五处修复全在。冒烟门实证真跑：`smoke: running scripts/ci-smoke.sh` → `/api/config healthy` → `/api/ready healthy` → `smoke: OK` |
| 门 | hkccr 与 ccr digest **全等**（`2779e2e4…`，relay 日志 `OK yizuo/platform:sha-ef54bb0`）→ 才 bump；三 deploy rollout 全绿 |
| 修① | **托管态自服务角色写回**：新增 `POST /api/roles/self`（gateway，共享密钥鉴权、目标恒为请求者自身、admin 位保留且永不授予）+ `writeSelfAssignment`（cell 侧，CLOUD_MODE 时经网关写入，失败即 502 不落假成功）。设计 D1 原本要求的「托管走 gateway 内部写入」至此补齐 |
| 修② | **recipe 改作者名引用**：`packs:["法律-合同"]`（原为臆造 slug `legal-contract`）；`buildPlan` 增 `resolved` 入参返回 `{ref,packId,name,status}`；新增 `resolvePackReferences`（按名 search 市场，同一可见性面）与 `localMarket.findByName`。解析不到 → `unavailable` + `degraded`，不阻塞其余项 |
| 修③ | **无 ws 专家切换**：`switchAgentTo` 增 `{user,onError}`，`ws` 全程可选（`reply()` 容错）；失败必带原因（原为空解引用后静默 failed） |
| 修④ | **i18n 双花括号**：`onboarding.planPack/readyTitle` `{name}/{role}` → `{{name}}/{{role}}`（5 语区）；新增 `doneIssues/doneExpertUnavailable` 键，done 屏改为**如实报告**未装成/不可用项（原为无条件「已就绪」） |
| 测试 | 单测 **1552/1552**；e2e 三面 **27/27**；新增 `scripts/test-onboarding-hosted.mjs` **2/2**（真 gateway+真 cell 无 dsh 依赖：托管写入落网关照头、引用解析到本部署 id、无 ws 装包+切专家、幂等、伪造无密钥 401、自频道不授 admin）。**突变测试验证断言有效性**：改坏 `readyTitle` → e2e 红；`planPack` 那半在 marketplace-off 下**测不到**（无 pack 行），已在注释里写明由另一套覆盖 |
| 生产验收（真账号重跑首配） | 同 trial 账号改为选「股票」：确认清单显示 `Install 数据-股票`（**作者名，非随机 id**）且无裸花括号；标题 `Ready to set up for Equity research`；激活后 `/api/auth/me` → `stock`、`/api/config` nav **收窄至 4 项**；cell 库实测 `installed_packs` 有 `Y5uR57UBAXi7_xruKQBsfg`（数据-股票 v3）、`agent.preset=pack-industry-analyst`；网关 store `/data/cells/roles.json` 落有该账号 `{primary:"stock"}`。**10/10 断言全过** |
| 教训（续 §12.9） | ①**修完必须真机重跑**：四处缺陷里①③只在真实请求链上现形，本地模块级与既有 e2e 全绿；②**突变测试是断言有效性的唯一证法**——写完「不该出现 {name}」的断言后要故意改坏看它红，否则可能像本文 planPack 那样在特定配置下恒真；③**平台侧新能力要一次给全**：本轮四个缺陷同源——把「本地单进程」的假设带进了「托管多租户」形态（写存储、拿 ws、拿 id），凡跨这两个形态的路径都要问一句「托管下谁是真源」 |

### 12.11 registry 列表分页取全量（registry-list-completeness，2026-10-17）

| 项 | 值 |
|---|---|
| 缺陷 | 网关 `GET /api/{skills,servers,agents}` 是分页端点（默认 `limit=20`，信封带 `total_count/has_next`），调用方裸读当全量。实测源起：wire-presets `register_skills.py` 只读 20/212 条 → 17 个既有技能被判缺失（8 个重提交被 409 兜住）+ verification 报 0/17 与事实相反。paas 侧同源：`registry-bridge.js` 的 `/api/agents` 裸读（23 取 20，enabled 净丢 1：daas-analyst），另有四处 `limit=500` 硬顶是同一假设（网关上限实测 2000，`limit=5000`→422） |
| 修复 | `fetchAllPages` 助手（has_next 翻页/空页与 offset 不推进与同页重放三重防护/`total_count` 退化/非 2xx 抛错走 last-good），`registry-bridge.js` 三端点 + `agent-serving` + `agent-runner` + packs fleet scheduler + `wanxing-fleet`（保 8s 预算，超时部分返回+告警）+ `facet/cli verifyCallerKey` 全部接入；截断告警含端点+实取条数+total_count。paas `a1c1a60c`，openspec change `registry-list-completeness` 四件齐 |
| 测试 | 测试先行三用例（桩钳页 20 强制多页）先红后绿；**突变自检**（改回单页读 → 分页用例转红）证断言非恒真；14 套件 243 用例全绿。坑：`registryCall` 显式 `method:"GET"` 会坏掉按 `!init.method` 判 GET 的桩/旧网关（agent-serving 三端口用例红过的根因），助手改裸 `doFetch(path)` 保持线形 |
| 出片线 | 公开快照线（scs001/platform-image-verify）构建验证绿但 **image-build-check 不推镜像**（纯构建检查，relay 无 sha-a1c1a60c，第一次"RELAY OK"是 SSH 缓冲误报）→ 改走 `testaction002/build-pool`。**首跑红：Dockerfile not found = 池 repo 变量 `BUILD_CONTEXT=web` 是上一位使用者残留**（workflow 去 `web/Dockerfile` 找）；删变量回默认 `.` 后同 run rerun 绿。出片 tag `sha-d1c1cb3`（≙ paas `a1c1a60c`） |
| 门 | relay 日志 `OK yizuo/platform:sha-d1c1cb3`（16:28:26，copied=3）；hkccr digest `2f767fb1` skopeo 实证 → 才 bump `fd-infra-deploy`（platform + platform-demo + facet 三清单，`1de0cb7` 双远端推）→ ArgoCD hard-refresh → 三 rollout 全绿，pod imageID 实测 = `2f767fb1` 与 digest 全等，restarts=0 |
| 生产验收（cell 内通道） | gateway secret + cell 端口（日志 `cell … on 127.0.0.1:40575`）打 `/api/catalog`：registry-sourced agents **11→12**，`daas-analyst`（孤儿条目，pack 已 404）出现——与 registry enabled 口径一致；pod 日志无 truncated 告警；模块活体 `import registry-bridge.js` OK；pod 内 md5 与本地工作树全等（`296e6655`） |
| 教训 | ①**出片通道要分清「构建验证」与「出片」**：image-build-check 是 build-only，成功≠镜像存在；relay 验证必须对具体 sha tag 抓日志行（上一轮的 grep 模式过宽+SSH 缓冲复用产出过一次假绿）；②**通用池是共享资源，repo 变量会被上一个使用者留下**——fd-build-snapshot 设了 NS/IMAGE 但 BUILD_CONTEXT 是 repo 级手配，首跑红灯就是它的锅；通用池使用前 `gh variable list` 核一遍目标三件套；③验收走 cell 内通道 + gateway secret（memory `prod-liveness-evidence-discipline`），公网匿名 401 无鉴别力 |
| 待办 | finddata 跨仓两件 → **核销（2026-10-17）**：独立 session 按交接文档执行完毕，gitee `finddata-skills` `21c8740→7d4fc94`（分页 all_skills 回推 + `--rescan` NameError 修复 + wire-presets 版脚本首次入仓消双拷贝）；实跑验收 `existing skills on gateway: 212` + 19/19、17/17 全 SKIP + 干净 clone 复跑同证。遗留开放项仅 4.3（网关侧默认页大小/告警头契约，需与网关仓所有者确认） |

### 12.12 网关侧收口：列表端点默认 limit 20→500（4.3，2026-10-17）

| 项 | 值 |
|---|---|
| 改动 | `mcp-gateway-registry` 三列表端点（`/api/skills` `/api/agents` `/api/servers`）默认 `limit` 20→500（`le=2000` 上限不动；不设告警头——信封 `total_count`/`has_next` 已是完备性契约，加头是冗余）。commit `5af96c16`（分支 `fd-product-home`），含 6 处测试断言跟进 + 3 条新默认值契约测试（261 pass；1 失败 `test_include_tools_true_returns_tool_list` 为既有 bug——fixture 里 tool_blocks override 是裸 coroutine，基线同红，不属本改动） |
| 出片事故①（relay 竞态） | 构建池 testaction005 首跑带残留 `BUILD_DOCKERFILE=docker/Dockerfile.auth`（上一位使用者）→ cancel 时**坏镜像（auth 构建，a0cf5efd，Created 10:25:09）已推到 hkccr 同名 tag** → relay 18:27:25 把坏 manifest 抄回 ccr → rerun 的好镜像（81779c28）推 hkccr 后 relay 因 seen-tags 已记录而**跳过回灌** → ccr 同名 tag 仍是坏镜像 → 滚产后 CrashLoop（`sed: can't read nginx_rev_proxy…conf`）。**修复=skopeo copy hkccr→ccr 强推 + deployment 改按 digest 引用**（`IfNotPresent` 会永远吃坏缓存，tag 引用不可信） |
| 出片事故②（快照默认分支陷阱） | digest 修复后公网仍 limit=20：pod 内模块 md5=旧码。**根因=`fd-build-snapshot` 从远端干净 clone 只取默认分支**（源仓默认=main），commit message 写 `@ 5af96c16` 但内容是 main 旧码——跨分支出片必须 `--ref <branch>`。重出快照 `bfd0de4`（真内容）→ digest `c740d37a` hkccr=ccr 全等 → 滚产 |
| 生产验收 | pod imageID=`c740d37a` + 模块 md5 `a48b0879` 与本地全等 + pod 内代码 `Query(500`。公网裸读：skills **216/216**、servers **23/23**、agents **23/23**，均 `has_next=false`。paas 回归：catalog registry-sourced 12 与 enabled 口径一致、`daas-analyst` 在、无截断告警 |
| 教训 | ①**relay 的 seen-tags 是「tag 级」去重**：同 tag 二次推送（cancel 重跑、修复重推）不会自动回灌——同名 tag 重推后必须 `skopeo copy` 手动回灌 ccr，或换新 tag；②**cancel 不能假定「没推完」**：push 步骤在 cancel 生效前可能已完成，先查 hkccr 实际 digest 再决定 rerun；③**fd-build-snapshot 的 commit message 只是标签不是内容**：跨分支源码必须 `--ref`，且上产前 pod 内 md5 比对是唯一可信同一性证据（本次靠它抓住第二个事故）；④fd-infra-deploy 双远端并行会话高频碰撞（本日 3 次 rebase），push 前先 fetch，被拒后 rebase 重推，勿 force |
| 状态 | paas `registry-list-completeness` tasks 4.3 **核销**；4.1/4.2 已于 §12.11 核销——该 change 全组任务完结，归档 |

### 12.13 settings-connect-center：连接分节 IA 重组上产（2026-10-18）

| 项 | 值 |
|---|---|
| 改动 | 壹座设置 IA 重组（openspec `settings-connect-center`，四件齐）：新「连接」分节（能力组首位）收拢五类凭据卡+搜索服务（谦面归组单卡/连接器/产品线/模拟交易/BYOK+admin 接线）+ 品牌速查 + `?panel=` 深链；`GET /api/connections` 白名单状态聚合（凭据材料结构上不可入载荷，admin 附加池健康）；网络搜索分节退役为 `/settings/websearch→connections?panel=search` 稳定重定向；商店 tab 三态减二态纯货架化（连接卡迁出、外部市场并入为技能子视图分区）；credential-required 409/pack 项带 `connectPath`、线铸造回跳改址；LineOps/FacetMarket i18n 键五语补齐；死代码清理。CONTEXT.md 新增 6 词条（连接/外部技能/词元/车道/词元账号/生态产品） |
| 验证 | e2e **53/53 绿**（新增 connections.spec 4：API 白名单+凭据不可泄、速查+panel 深链+未知 panel 退化、websearch 重定向、商店纯货架；registry-connect 5 在新家全链含静默 SSO；external-sources 9 含「工具子视图无外部区」新契约；extensions 20；settings-modal 15）+ 单测全绿 + 五语 parity + tsc/biome。6.1 四条真流（connector/facet/wire/lex/paper）与 6.3 非 admin 视角留真机走查（hermetic 无法覆盖 Logto/外部服务/auth-on） |
| 出片线 | 公开快照线：`make-public-snapshot --init`（HEAD `99f63cb7`）→ **发现镜像仓 workflows 已被修剪到只剩 image-build-check，image.yml 缺失**——从孤儿提交 `c303424`（10-16「restore image.yml」run 的 headSha）取回；快照 `.github` 修剪到只剩 image.yml（快照纪律，免误触 app-e2e/win-smoke）→ 恢复提交 `22489c8` 即出片 tag → force push mirror → run 39077891938 绿 |
| 门 | relay `OK yizuo/platform:sha-22489c8`（07:16:40）；ccr skopeo digest `2ba5cf1c` → 才 bump `fd-infra-deploy` 双清单（`f31e0b9` 推 gitee）→ ArgoCD hard-refresh → platform + platform-demo 双 rollout 全绿 |
| 生产实证 | pod imageID=`2ba5cf1c` 与 ccr digest 全等；镜像内模块活体（`/app/server/routes/misc.js` 含 `/api/connections`、`credential-refs.js` 含 `connectPathForRef`）；新 chunk `ConnectionsSection-PowPHyBE.js` 在 `/app/web/dist/assets`。注：pod 内 3100 是网关口，匿名 401 连未知路径也同形（网关先于路由拦截），无鉴别力——`/api/connections` 的带身份实测并入真机走查 |
| 教训 | ①**设置分节清单三处同源**（web `sections.ts` / `packages/core/src/lib/surfaces.ts` SETTINGS_SURFACES / 服务端 resolvedLayout）——只改其一，新分节被 resolved 列表静默滤掉、深链回落 General，e2e 才抓住；②**e2e 服务吃预构建 dist**，改前端必须先 `web:build:e2e`（首轮 12 个假失败全是旧包症状）；③**RegistryConnectPanel store 未知时渲染 null**，新挂载点必须自带 `refreshRegistryConnection()`；④镜像仓 workflow 会被快照 force-push/修剪冲掉，出片前先 `gh api contents` 核 image.yml 在不在，缺了从孤儿 run headSha 取回 |
| 状态 | L1 落地。后续刀：L1b 应用中心统一网格、L2a 词元账号线（零粘贴一次到位：词元仓编程铸 key 端点现成 `POST /api/v1/keys`，跨仓开发量=0）、L2b 语音（硬前置「词元 audio 车道 openainext 池 429」**已于 2026-10-18 解除**——`audio-lane-multi-upstream` 跨协议上游 v-11 上产，豆包+腾讯双通；L2b 本体 10-19 上产，生产 ASR 走腾讯路径 PASS；**残余边界**=豆包 ASR 需部署侧配公网音频前缀 `audio_public_base_url`/`LANE_AUDIO_PUBLIC_BASE_URL`，至 10-22 归档仍未配，腾讯路径不受影响）、L3 对话内 connections 工具 |

### 12.14 真机验收抓出两缺陷并修复上产（settings-connect-center 6.1/6.3 核销，2026-10-18）

真账号（`aloadtree@gmail.com`，生产 Logto）走查发现：**§12.13 的「上线」对角色用户等于没上**——该账号 `roles={primary:stock,secondary:[legal]}`，`/api/config` 的 `resolvedLayout.settings` 只有 `[general,account,wechat-app,devices]`，新分节**不在**；`/settings/connections` 与 `/settings/websearch` 深链全部 fallback 到「常规」。这正是 §12.9/§12.10 同一形态的第三次复现：模块级与 hermetic 全绿，真请求链上用户看不见。

| 项 | 值 |
|---|---|
| 缺陷①（用户可见） | **`simple` 布局预设没跟上新分节**：`FACTORY_PRESETS.simple.settings` 是手写四项，`legal/stock/economic` 三个首配配方全部 `layoutPreset:"simple"` → 走首配的角色用户看不到连接分节，也无法通过任何深链到达（`SettingsDialog` 用 resolved 列表过滤，缺即回 General）。修：`simple.settings` 加入 `connections`（它是「让工具/搜索能用」的入口，本就在非技术骨架内）；同步三处硬编码断言（`test-layout-storage` ×2、`test-layout-resolution` ×1、`e2e/layout.spec` 的 `ALL_SETTINGS`） |
| 缺陷②（真 bug） | **`pack-store.js` 用了未绑定的 `connectPathForRef`**：该文件把 `credentialRefForEntry/credentialConnected/credentialMissingReason` 三个助手 re-export 成局部名，§12.13 新加的 `connectPathForRef` 只 import 了模块却直接裸调 → 无凭据装 pack 内 MCP 时抛 `ReferenceError`。单测 `test-paper-trading-credentials` 4.2 抓到。修：补一行 `export const connectPathForRef = credentialRefs.connectPathForRef` |
| 出片线 | 公开快照线（scs001/platform-image-verify）：HEAD `94fe1ee1` → 快照 `bed11a5`（.github 修剪到只剩 image.yml）→ run 39082801261 绿（4m42s）→ relay `OK yizuo/platform:sha-bed11a5`（08:36:40）→ ccr skopeo digest **`08c7f322`** → bump `fd-infra-deploy` 双清单（`da63b75` 双远端）→ ArgoCD hard refresh → platform + platform-demo 双 rollout 全绿 |
| 生产实证 | 两 pod imageID 均为 `sha256:08c7f322…`（与 ccr digest 全等）；pod 内 `surfaces.ts` 的 `simple.settings` 含 `connections`、`pack-store.js:95` 有绑定、`misc.js` 含 `/api/connections`、新 chunk `ConnectionsSection-DUionncr.js` 在 dist。**真机复验 60/60 ALL PASS**（`scripts/verify-live-connections.mjs`），其中关键一条：角色账号的 `resolvedLayout.settings` 现为 `[general,account,wechat-app,devices,connections]` 且深链直达分节（修复前该断言红、`data-section=general`） |
| 6.1 五条连接流（真机） | `scripts/verify-live-connect-flows.mjs`：wire 静默铸造 → `line-wire-customer=connected`（无失败标记）；lex 铸造 → `line-lex=connected`（首次走 `consent_required` → `mint/start?interactive=1` 交互重试，与设计一致）；paper-trading 贴非 `fdt_` → 可读拒绝且保持 disconnected；search 共享池测试 → HTTP 200。registry/connector 已连接态与 UI `data-*-state` 同 `/api/connections` 全等；断开→重连由 `FLOW_RECONNECT=1` 可选实操（默认不跑，免动真实凭据） |
| 6.3 非 admin（真机） | pod 内以 `x-forwarded-email: zztrial-1792171761@maxxspace.com`（网关无 admin 头）直打 cell：`/api/connections` 的 `search` 条目**无 `shared` 字段**（admin 区信息不泄漏），八条目状态照常返回；`/api/config` 对无角色账号给出完整 settings、对 `stock` 给 `simple` 骨架。trial 账号密码未留存 → 浏览器非 admin 眼见留待下次注册（组件门逻辑原样搬迁 + admin 正证已覆盖） |
| 教训 | ①**新增设置分节必须同时问一句「哪些布局预设要包含它」**——预设是手写白名单，不是「默认全含再删」；漏了就只有默认角色看得见，而首配角色恰恰是最需要连接卡的人；②**re-export 不是 import**：把一个模块的助手逐个导出成局部名时，新加的助手要同步补，否则裸调处只在特定分支（无凭据装 pack）才炸，主路径全绿；③真机验收的价值再次被证实——60 条断言里唯一抓出用户可见缺陷的，正是「带业务角色看设置」这条真实请求链 |
| 状态 | settings-connect-center **tasks 6.1/6.2/6.3 全部核销**，可归档；单测 1555/1555；e2e 受影响面全绿（connections 4/4、layout 13/13、registry-connect 5/5）；全量 fast 有 17 红但 stash 基线同样红（既有 flaky，与本改动无关） |

### 12.15 app-center-unified-grid：应用中心统一网格 + 连接徽章上产（L1b，2026-10-18）

四刀路线第二刀。应用中心原是两张网格两种卡（静态五线卡 vs `/api/catalog` 三产品卡），同一品牌拆在两区、发现面看不到连没连；app-center spec 在 10-13 删掉产品区后 fusion-ia 又把代码加回但 spec 没跟。定案依据不在 explore 会话（只剩一句标题），而在 **CONTEXT.md:253「生态产品」词条**（单卡/一句职责/连接状态与设置·连接同源/「打开」+「去连接」；「产品线」「平台应用」为 Avoid 词）。

| 项 | 值 |
|---|---|
| 范围 | 单网格八卡品牌序（壹座 / 壹座·Packs / 谦面 / 萬星 / 萬星·词元 / 萬星·连接器 / 识律 / 柏讯），一种卡形；分区标题退役；连接徽章四态 `connected/partial/stale/disconnected`（柏讯挂两条连接常见只连其一，故需 partial；stale 优先）+「去连接」深链 `/settings/connections?panel=<首个非 connected id>`；`/api/catalog` 与 `/api/connections` 两路并行 fetch 各自 `catch→null`，品牌卡零等待。**映射按宿主**：`registry→yizuo-packs`（弹窗铸造宿主 `MARKET_REGISTRY_URL`=mcp.finddatatech.cloud 即该卡 url），非按 L1 的「谦面」归组——谦面双胞胎命名遗留，改名另议。纯函数全在 `web/src/lib/appCatalog.ts`（node --test 直接 import .ts） |
| spec | `app-center`：REMOVED「五线产品线卡片」（旧名是 Avoid 词，MODIFIED 保不住标题）+ ADDED「统一网格——一卡一生态产品」「连接徽章与去连接」+ MODIFIED「文案与质量线」；主 spec 遗留 `TBD` Purpose 同轮补上 |
| 本地门 | 单测 `test-app-center.mjs` 5→13 条（归属/排序/四态/映射守门/五语）+ 全量 1563/1563；e2e `app-center.spec.js` 4→8 条（四态走 `page.route` mock，hermetic 只有「全未连接」一种真实态）+ connections 4 条 = 12/12；五语 parity 绿；typecheck/lint 绿 |
| 出片线 | 公开快照线：HEAD `4ea84848` → `make-public-snapshot --init` → **快照带回 7 个 workflow 且缺 image.yml（我漏做手动修剪，首推 `ee8898f` 误触 CI + image-build-check，已 cancel）** → 从镜像仓旧提交 `bed11a5` 以 `gh api contents?ref=` 取回 image.yml、修剪到只剩它 → 恢复提交 **`8b184a1`** 即出片 tag → run 39126471173 绿 → relay `OK yizuo/platform:sha-8b184a1`（20:21:43）→ ccr skopeo digest **`0a9758d3`** → `fd-infra-deploy` 双清单 `33cc6fa`（gitee+github 双端核过）→ ArgoCD hard refresh → platform + platform-demo 双 rollout 绿 |
| 生产实证 | 两 pod imageID `sha256:0a9758d3…` 与 ccr digest 全等、restarts=0；pod 内新 chunk `AppCenterPage-S8UwKjOI.js` 含 `app-center-grid`/`connection-badge`，`app-center-platform-apps` 旧标记 0 处；`/healthz` 200 |
| 真机走查 | `scripts/verify-live-app-center.mjs`（真 Logto 账号 `aloadtree@gmail.com`，`roles={stock,[legal]}`）：**期望网格用页面同一套纯函数对生产 `/api/catalog`+`/api/connections` 实算**，再逐卡比 DOM——八卡顺序全等；六张徽章逐卡与聚合全等（生产实况：registry/facet-market/connector 已连 → 壹座·Packs/谦面/萬星·连接器 `connected` 且无去连接；三线+paper 未连 → 词元/识律/柏讯 `disconnected`）；壹座/萬星两卡无徽章；点词元「去连接」→ `?panel=line-wanxing-caller` 且高亮锚 `line-wire-customer`（三线共卡 ids[0]，设计如此）；词元「打开」→ `/external/wanxing-token`。**21/21 ALL PASS** |
| 观察（非缺陷，待拍板） | 该角色账号（stock 配方）的主导航**没有「应用」项**（`nav-apps` 不可见，直开 `/apps` 正常）——§12.8 角色 nav 收窄至 4 项是设计；但这意味着首配角色用户到不了发现面，而词元卡「去连接」正是 L2a 的入口。是否把 `apps` 加进角色 nav，一行配方改动，另立决定 |
| 教训 | ①**快照 `.github` 修剪是手动步**，`make-public-snapshot` 的 scrubber 不做它——照 skill 直接 push 就会把全仓 7 个 workflow 推上公开镜像仓（公开仓免费所以只是噪音，但 **image.yml 不在快照里 → 根本不出片**）；下次产完快照先 `ls .github/workflows` 再推；②镜像仓被 force push 后旧提交 **`git fetch <sha>` 取不到**（非 ref 可达），用 `gh api repos/…/contents/<path>?ref=<sha>` 直取文件；③真机脚本断言懒加载分节必须 `waitFor`，hermetic 本地快所以 e2e 用 `toHaveCount` 自动重试没暴露，生产即时 `count()` 假红一次 |
| 状态 | L1b 落地、已归档。后续刀：**L2a 词元账号线**（零粘贴一次到位，`POST /api/v1/keys` 现成；词元卡徽章翻绿即其验收面）、**L2b 语音**（硬前置变了：openainext 429 冷却已自愈，现为上游对转写 POST 挂起 120s 超时，我方不可修；硅基 SenseVoiceSmall 实测可用但 `LanePlatform(audio)` 硬编码需改码或换 base_url——两方案待拍板）、L3 对话内 connections 工具 |

### 12.16 事故：出片链 `;` 断链把私仓全历史推上公开镜像仓 + 全量轮换（2026-10-18 深夜）

`make-public-snapshot --init` 被 **gitleaks 拦截**（原因=新测试文件里有字面假 `sk-` key），快照目录未生成；但我的命令链里 `git remote add … 2>/dev/null;` 后面是**分号**——`cd dist-opensource/platform` 失败后 `&&` 链本应中止，`;` 之后全部命令落回主仓执行：往主仓 `.github/workflows` 写入 image.yml、删了主仓 7 个真实 workflow、在**主仓**提交 `1458d109`、并把**主仓 main 全历史 force push 到公开仓 `scs001/platform-image-verify`**（约 10 分钟暴露窗口）。GHA 还自动构建了泄露 commit 的镜像（run 39141174893，tag `sha-1458d10` 推入 hkccr/ccr，未部署）。

| 项 | 值 |
|---|---|
| 止损 | 本地 `git reset --hard origin/main`（origin/gitee 未被碰）；修掉 gitleaks 拦截根因（三个文件的字面假 key 改拼接构造，commit `868ee362`）；重建干净快照顶回公开仓（`40ab011`→…→`86820e6`，泄露 commit 已不在任何 ref 上）；ccr 上 `sha-1458d10` 已 skopeo delete |
| 泄露面盘点（gitleaks 全历史 982 commits + 定向 git grep） | **真实凭据仅两处**：①台账里的词元试用账号密码（`CiyuanTrial2026!`）②10-13 提案文档里的 github_pat（**实测 401 已失效**，疑截断）。`llm-providers.json` **从未入库**（gitignore:63、无历史）——部署 key 未经此仓泄露；其余命中全是假 key/环境变量名/文档示例 |
| 轮换（宁可多做） | ①词元部署 key（id 2）：DB UPDATE + 生产 31 个带旧值的文件**等长替换**（含各 cell `.credentials.yaml`、`/data/llm-providers.json`、app.db）+ `platform-secrets` 的 `LLM_API_KEY` patch + 双部署重启——**轮换中发现该 key 同时活在 pod env（volces 路由真源），漏了它生产聊天会断**，patch+重启后内部路由探针 200；②试用账号密码：htpasswd bcrypt（$2y→$2a 前缀转换 Go bcrypt 兼容）UPDATE users 表，新密码实测登录 200，旧密码作废；③文档两处去敏（`21ee57d9`） |
| 教训 | ①**出片链命令禁用 `;`**——`cd` 失败必须让全链中止（本次已改为全 `&&` + `pwd`/`test ! -f llm-providers.json` 双哨兵）；②gitleaks 拦截是在救你，先修根因再出片，别绕；③轮换密钥前先 `grep -rl` 全部存在位置（env/Secret/卷/DB 四层），**pod env 是最容易漏的一层**；④假 key 一律拼接构造，别写字面量 |
| 状态 | 已收口。GitHub 侧泄露 commit 作为 unreachable object 仍在（可发 support 请求 GC，但内容已无有效凭据，风险可忽略） |

### 12.17 双刀上产：admin-layout-exempt + ciyuan-account-lane（2026-10-19 凌晨）

**admin-layout-exempt**（规格变更：管理员不吃业务角色层收窄）。背景=§12.15 晚间用户报告 admin 账号管理界面消失——两层根因：测试角色留在 admin 账号（数据，已清）+ **role-system spec 明文「admin 兼任角色走角色布局」是有意设计**（v1.3.17），simple 预设裁掉整套管理面；`adminOnly` 谓词只挂 3 节救不回 models/channels/diagnostics/status。修法=核心层 `resolveLayout`：`authOn && isAdmin` 时丢弃 role 层（auth off 保持收窄，hermetic/本地预览不受影响）。

**ciyuan-account-lane**（L2a：词元账号零粘贴 + 模型车道用户级计费）。服务端 login→`POST /api/v1/keys` 铸组 3（与部署 key 同组）→按身份只写存储（密码/token 用后即弃，单测断言零落盘零日志）；托管 cell 内 `ensureCredentialsStore` 第三层覆盖→下一请求按用户计费，断开/stale 回落种子；单进程不覆盖+卡面如实说明；wanxing-caller 引用账号 key 优先、手贴兜底零迁移，断开删两源；`/api/connections` 与应用中心词元卡换挂 `ciyuan-account`（旧 panel 别名保留）；LineOps 卡去 Caller 行，粘贴入口迁为逃生口。

| 项 | 值 |
|---|---|
| 出片（三轮） | ①`40ab011`（paas `868ee362`，digest `27a3637c`，infra `903cc48`）——真机抓出**硬编码 provider id 缺陷**；②`0a4ff39`（`4d52105c`，digest `91b62d1d`，infra `9bd74b9`）——修 `CIYUAN_PROVIDER_IDS` 后又抓出**生产模型真源是 volces 环境路由**；③`86820e6`（`22785b48`，digest `762ad65b`，infra `a0f28b7`）——补 `LLM_API_KEY` 覆盖，终态。每轮 relay OK→ccr digest→双清单→ArgoCD→双 rollout 绿、imageID 全等 |
| 两个生产真相（模块级测试测不到） | ①部署的词元 provider 叫 **`finddata-token`** 不是 `finddata`（仓内未跟踪的本地 json 与生产不同名）；②生产模型调用走 **pod env `LLM_API_KEY` + NodePort 32080 直达词元**（volces 保留路由），provider ref 那路在生产 cell 的 store 里多为空——覆盖面两者都要 |
| 本地门 | 单测 1579/1579（新增 test-ciyuan-account 12 条：假词元 http 桩、覆盖/回落、单进程守卫、双 provider id、env 路由覆盖、legacy 优先级、脱敏 grep）；e2e ciyuan-account 6 + connections 4 + app-center 9 + layout 13 = 28/28（新增 `e2e/ciyuan-stub.js` 三端点可编程，webServer 挂 `CIYUAN_API_BASE`）；五语 parity/typecheck/lint 绿 |
| 真机（admin） | `scripts/verify-live-admin-layout.mjs` **8/8 ALL PASS**：临时 PUT stock → resolvedLayout 三容器与无角色基线全等（nav 7 项、settings 13 节）→ 侧边栏眼见 应用/任务 在 → finally 复原 standard |
| 真机（词元） | `scripts/verify-live-ciyuan-account.mjs` **18/18 ALL PASS**（词元 trial 账号实测）：bind → 卡/聚合/应用中心全 connected；**恰好一个 cell 的 `.credentials.yaml` 带用户 key**（值不等于种子集合判定）；词元 `api_keys` 出现 `yizuo-1da519d4-20261018` 组 3 user 93；探测 200；**绑定态聊天一句 → `usage_logs` 记到铸的 key 上（计费主体切换实证）**；断开 → revoke 提示 + cell 文件回落种子 + 徽章回 disconnected。脚本软删测试 key |
| 教训 | ①**跨仓 id/配置要运行时探测别硬编码**（provider id 两名并存）；②真机验收三轮各抓一个「模块级全绿但生产形态不工作」的缺陷，第三次复现 §12.9 形态；③绑定触发的 dsh/mcp 热重载有秒级窗口，真机脚本发消息前要 settle；④词元 usage 异步落账，断言要轮询 |
| 状态 | 双刀落地、可归档。词元试用账号密码已轮换（新值离线交付）。后续：L2b 语音（等词元 audio-lane-multi-upstream）、L3 对话内 connections 工具、role nav 是否加 `apps` 项待拍板 |

### 12.18 词元嵌入通道：provider 钉扎 + fd-text-core 切入（ciyuan-embedding-lane，2026-10-18）

**背景**：硅基流动账户曾对全部嵌入模型 402（`Qwen3-Embedding-8B/4B/0.6B`、`bge-m3`、
`bge-large-zh-v1.5`、`/v1/rerank` 无一可用），两个嵌入消费方同时停摆；余额当日恢复但暴露
「两线共用单一上游账户、一挂全停」的结构性问题。

**变更**：

- **词元侧 provider 钉扎**（fork 补丁级 12，镜像 `sha-8c0f4f8` / digest `bbca6ec9`）：
  新增账号级 `extra.embedding_provider_only`，在 `ForwardEmbeddings` 注入/覆盖请求体
  `provider` 选择器；只增于 embeddings 转发路径，未配置时 body 不改写。
  **实测依据**：同文本连调 10 次，不钉扎 min_cos=**0.996511**（漂移）、钉 Nebius
  **0.999925**（过门）、钉 DeepInfra **0.997614**（不过门）→ 必须钉 Nebius。
  客户端自带值被覆盖（实测传 `NoSuchProviderXYZ` 仍 200，上游回
  `No allowed providers are available … nebius, siliconflow, deepinfra`）。
- **上游与价目**：OpenRouter `qwen/qwen3-embedding-8b`（Nebius $0.01/M）；
  组 8「embedding」配 `Qwen/Qwen3-Embedding-8B` token 价 in=3e-08/token out=0。
- **消费方切换**：`fd-text-core` 改 `FDTEXT_EMBEDDING_API_BASE/_KEY` 指词元，
  模型（8B）与维度（1024）未变 → **零重嵌**。

**验收（生产）**：锚点余弦 **0.999935**（gate）/ 0.999944（自跑）过 0.999 门；
真实查询两域命中（`screenplay` 双通道融合、`papers` 纯向量）、`degraded: []`；
计量 12 次请求 96 tokens、余额实扣；pod 日志零错误；镜像 digest 未变（env-only）。

**坑在案**：①build-pool 仓 `BUILD_NAMESPACE` 是共享变量，被并发使用者改成 `sub2api`
时推送报 `denied: no permission`（首个 run 39131350681 因此红，**非代码缺陷**）——
出片前须核 run 的 `target:` 行；②模型名匹配**大小写不敏感**，两写法同配报
`MODEL_PATTERN_CONFLICT`；③词元上**无 0.6B 端点**，故 `fd-legal-search-mcp`
维持 0.6B 硅基流动直连（实测其库为 0.6B 所建：自我检索 0.9999、12 点 0.99989~0.99992）。

**补充实证（归档后补跑，原三项旁证全部达成）**：①直连上游**不钉扎** min_cos=0.992257
（漂移）vs 网关注入钉扎 0.999918（过门）——钉扎必要性二次证实；②把钉扎临时改为不存在值
（等价上游不可服务）→ 嵌入 404 如实报原因、不透 key、不给假向量，恢复即 200；
③嵌入不可用期间 `hybrid_search` 如实标 `degraded:['vector:…']` 且**仍有结果**
（关键词兜底 3 条），恢复后 `degraded:[]` 双通道回归。
（注：`admin/accounts/:id/disable` 端点不存在、`schedulable` 经 PUT 不生效，
故改用「改钉扎值制造上游失败」达成同等待证。）

**遗留（与本 change 无关、未修）**：`conformance_gate.py` 另报 3 项——doc 7487
无损切块还原失败（切块/冷存域）、`corpus_chunks_gov` 与 `eval_runs` 两表不在
迁移链内（schema 域）。**锚点余弦门 PASS 才是本次切换判据**，三项属既有债务。

**graphiti 线（fd-legal-kg）交接**：`finddata/docs/handoff/ciyuan-embedding-channel-handoff.md`
（finddata 非 git 仓，无法归档）。3 项待办：客户端 provider 钉扎会被网关覆盖（应置空）、
客户端截断 vs 服务端 MRL 语义不同（切通道须重嵌）、LLM/嵌入是否统一网关待定。

**密钥**：内部服务密钥 `embedding-internal`（组 8）明文只落
`finddata/INFRA-NOTES.md`（部署秘密件），不进任何仓。

### 12.19 三刀同车上产：voice-lane（L2b）+ chat-connect-guidance（L3）+ role-nav-apps（2026-10-19 凌晨）

**前置核实**：词元 `audio-lane-multi-upstream` 已落地（ciyuan-v0.2.16-13，paas 侧 change 22/25，5.4 生产复验腾讯 ASR / 豆包 TTS 200）；立项前再以 **group-3 铸造 key**（壹座绑定用户同款凭据）单探针：`POST /v1/audio/transcriptions` **200/3.5s 真转写**、`POST /v1/audio/speech` **200/1.2s 16KB 合法 mp3**（02:4x）。探针 key 用后软删。

**voice-lane**（L2b）：壹座只说固定 OpenAI 音频协议，渠道差异全在词元侧（用户定调）。`server/routes/voice.js`：`/api/voice/transcriptions`（multipart→ASR）、`/api/voice/speech`（JSON→TTS 二进制）；key 三级解析 绑定用户铸造 key → `VOICE_API_KEY` → `LLM_API_KEY`（皆无 503）；用户 key 上游 401/403 → 标 stale + 广播 + 回 401 带 `connect:{panel:"ciyuan-account"}`；部署 key 401 → 502；>25MB 413；`voice` 配置块 deployment_config > `VOICE_CONFIG` > 默认，`PUT /api/config/voice` admin 门，`GET /api/voice/status` 无密钥，`/api/config` 附 `voice`。Composer 麦克风（MediaRecorder，点录点停）+ `+` 菜单「语音转文字」专用音频入口（**不走文档附件路径**，绕开 EXT_TYPE_MAP 415 / 无抽取器 / 无 accept 三阻断）→ 转写文本插入输入框不自动发送；AssistantTurn「朗读」三态单播放器；模型节 VoiceCard。

**chat-connect-guidance**（L3）：`server/connect-guidance.js` 分类（模型车道凭据错→ciyuan-account；`mcp__<server>__`→ref→panel），dsh-events 两处附着 `connect` 字段（**文本一字不改、持久化不带**），客户端错误块/失败工具块渲染「去连接」深链。

**role-nav-apps**：`simple.nav` 加 `apps`（§12.15 观察项，用户 10-18 拍板）；七处硬编码断言同步。

| 项 | 值 |
|---|---|
| 测试门 | `test:unit` **1599/1599**（新增 voice 14 + guidance 6）；fast e2e 新 spec **21/21**（voice 9 含假麦克风录音与真 mp3 播放、guidance 3、layout 9）；全套 475 过 / 13 红 → 隔离重跑 10 个纯 flaky 全过，`intent-onboarding:244` 是 nav 列表第七处漏网（已修），`composer-stop.spec` 为 main 固有竞态（**HEAD 基线 worktree 对照 7 轮各 5/6 红**，`:63` 单跑 5/5 过，级联自 IME 用例的 new-session 广播竞态） |
| 提交 | paas `afd27184`（nav）+ `23ba5136`（voice+guidance），origin+gitee 双推 |
| 出片线 | 公开快照线：`make-public-snapshot --init` gitleaks 干净 → **修剪到只剩 image.yml**（从镜像仓 `86820e6` 以 `gh api contents?ref=` 取回；链路只 `&&` + 哨兵 `pwd`/`test ! -f llm-providers.json`/`test ! -f .env`/toplevel 校验）→ 快照 **`6be8400`** 强推 → run 39161136227 绿（4m31s）→ relay `OK yizuo/platform:sha-6be8400`（04:06:40）→ ccr skopeo digest **`29d08729`** → `fd-infra-deploy` 双清单 `955aea7`（双远端）→ ArgoCD hard refresh → platform + platform-demo 双 rollout 绿 |
| 生产实证 | 两 pod `sha-6be8400` imageID `sha256:29d08729…` 与 ccr 全等、restarts=0、`/healthz` 200；pod 内 `/app/server/connect-guidance.js` 在位；served chunk 含 `turn-connect-cta` 与 `"chat","knowledge","resources","agents","apps"` 各 1 |
| 真机 ASR（`scripts/verify-live-voice.mjs`） | 真 Logto 账号 + 绑定词元 trial（key `yizuo-1da519d4-20261018` id 111）：`/api/voice/status` 绑定前 `keySource=deployment` → 绑定后 `user`；真语音 wav 经 `composer-audio-input` → `/api/voice/transcriptions` **200 keySource=user** → 输入框得文本 `"FFFFGGGG like!"`、零附件、未发送；词元 `usage_logs` 该 key **+1 行 `audio:stt`（计费主体=用户）**；断开后回落 `deployment`；麦克风入口、模型节 VoiceCard（available）均在位。**13 项 PASS** |
| 真机 TTS | **FAIL 4 项——词元上游阻塞，非壹座缺陷**：`/api/voice/speech` 回 502（pod 日志 `[voice] upstream 502 on speech (lane_upstream_error)`）。**完整根因链（04:5x 用户反馈「TTS 已测可用」后追查定案，用量行取证）**：豆包 TTS 最后一次真成功 = **01:49 CST**（本 change 立项探针，usage 行 `109340/109341`：ASR 走 #38 siliconflow whisper、TTS 走 #43 豆包）；此后到 04:5x 生产 `/v1/audio/speech` **零 200**（16×502 + 7×503）。三条上游各自病灶：**#43 豆包**=WS 握手 `403 {"error":"[resource_id=volc.seedtts.default] requested resource not granted"}`（绕过车道直探 5/5 复现，`seed-tts-2.0` 与 `volc.service_type.10029` 同报；期间 12 小时长冷却到 16:12，DB 清过一次又被新 403 重写为到 16:53）；**#44 腾讯**=TTS 云 API HTTP 200 带 `Response.Error`（错误码被车道吞掉，无法远程读取；同凭据 ASR `SentenceRecognition` 签名正常 → 疑似语音合成未开通/未授权而非签名问题）；**#38 openainext**=ASR 正常、TTS 上游 503。用户「已测过」对应的成功均早于授权失效（昨晚 22-23 点 audio-lane 5.4 验证 + 01:49 探针）；**admin 账号测试按钮直连适配器绕过冷却/池子，测通≠车道通**。壹座侧行为符合规格：502 脱敏 toast、不标 stale、ASR 不受影响（04:52 复验 ASR 200 走腾讯） |
| 词元侧交接 | ①**火山引擎控制台**核实 seed-tts 2.0（`volc.seedtts.default`）资源授权状态——01:49 后变 not granted，控制台「试听」不校验 API key 资源授权，须以 API 实测为准；修复后**清 #43 的 temp_unschedulable 冷却**（现压到 16:53 CST，DB 字段 `temp_unschedulable_until` 或 admin 界面）；②**腾讯云控制台**核实「语音合成 TextToVoice」是否开通（ASR 已开通且签名正常，TTS 疑似未开通——错误码被车道吞掉无法确认，见③）；③`doubaoUpstreamError`/腾讯 `bodyExcerpt` 把真实错误体丢弃、把握手失败记成 `status 200`——把上游错误码进 WARN 日志，本次定位多绕了三步；④词元 4.4「跨协议轮转」任务未勾与「豆包一挂 TTS 全停」直接相关 |
| 复跑 | 上游恢复后 `node scripts/verify-live-voice.mjs` 应 **ALL PASS**（脚本已覆盖 TTS 200 audio/mpeg + `x-voice-key-source: user` + usage 行 + 播放态） |
| 复跑（05:5x，腾讯 TTS 恢复后） | **`node scripts/verify-live-voice.mjs` 21/21 ALL PASS**。TTS 全链通：`/api/voice/speech` **200 audio/mpeg**、`x-voice-key-source: user`、同源探针 **9648B 真 mp3**、`turn-speak` 进 `playing`；用量两行 `audio:tts` 落在绑定用户铸造 key（124/125）**account 44 `tencent:101007 /TextToVoice`**（ASR 同样 `tencent:sentence`，均计用户 key）；断开后回落 deployment。排查期两把探针 key（123 单探针 19008B、124/125 脚本）已软删，`yizuo-l2b%` 存活 0 |
| 验收脚本 | 浏览器侧对二进制响应只给 0B（Playwright 不捕获 body），故「真载荷」判据改为同源重放探针量字节；`ttsBytes` 只作 header 级佐证。生产复跑两次均 ALL PASS |
| 遗留 | ①`composer-stop.spec` 固有 flaky 在案（非本刀引入）；②同一台账 §12.17/§12.18 曾错位（12.18 正文卡在 12.17 标题下，并行会话各自追加所致），本次已归位 |


## §9 发布记录：舰队记忆面切片 2 上产（add-fleet-memory-v1，2026-10-19；**已归档 2026-10-22**）

| 镜像 | tag | 源 | 池 |
|---|---|---|---|
| yizuo/fd-memory | sha-b2fc387（首版 f170dae→f73eef0→b2fc387 三轮：池 Dockerfile 路径/bind host/容器无 git） | fd-memory 1edb6e5+ | testaction005 |
| yizuo/platform | sha-54da09c | paas 457ba1f8 | testaction004（池内 image.yml 默认根 Dockerfile） |

**新服务 fd-memory**（cheap 集群 fd-prod，cheap-4 单实例 + PVC 5Gi + ClusterIP 49375）：
舰队工作记忆（OKF 真源/跨 owner 物理隔离/fdm_ 三族令牌/capture 脱敏/MCP 八工具）。runner-serving 同车滚 sha-54da09c + `AGENT_RUNNER_MEMORY_*` 开门（令牌=带外 secret fd-memory-runner，pepper=fd-memory-env）。fd-infra-deploy 0018d19。**生产验收三判据全过**（change reports/2026-10-19-prod-acceptance.md：spider-heal 真实回合写 handoff→跨会话认领 claim-once；scale 0 回合照常；代采观测落库）。

**实施期三起旁发现**：① runner 数据根 LLM key 死钥（10-18 轮换漏 /data/llm-providers.json，已修 in-pod，**cheap-1 rsync 源未同步登记待办**）；② wx-alpha 部署者计费键死（sk-a4…401，需部署者重绑）；③ fd-health-proxy NO_PROXY 缺集群 DNS 域（dsh child MCP 被代理劫走——已补 `.svc.cluster.local,.svc` 并滚 runner，普适修复）。**凭据暴露**：mihomo 代理凭据入本会话 transcript（读 NO_PROXY 带出），择时轮换。


## §9 发布记录：消耗统计面上产（add-stats-plane-v1，2026-10-19；**已归档 2026-10-22**，fd-wanxing `0c3bc7e`）

| 镜像 | tag | 源 | 池 |
|---|---|---|---|
| yizuo/fleet-observer | sha-5ef1480 → **sha-bbf54c3**（digest 2d6f4650，sub2api 四修复验后滚产） | fd-wanxing ed9a567 → `3efd4df` | testaction004 |
| yizuo/wanxing-facade | sha-5ef1480（同镜像双入口，FLEET_ENTRY 显式） | fd-wanxing ed9a567 | testaction004 |
| yizuo/wanxing-web | sha-d10ba31（Dockerfile.web 根上下文变体，SMOKE=skip） | fd-wanxing acc4d8b | testaction004 |

**stats plane**：observer 姊妹库 stats.db（13 月明细+永久日聚合）+ stats API 四端点（source/basis
口径分离硬约束）+ /ingest/local（fsc_ 令牌）+ sub2api 小时只读拉取（wanxing-fleet 借用凭据）；
门面 stats 四路由代理；console 消耗页签（三口径分列）。回填 892 条（7d=865 回合/24.9M tok）；
本机 collector 2978 条回灌+launchd 小时循环。**坑三条**：池无 build-args 管道（SERVICE 静默失效
→一镜像双入口+env 显式）；同源零 diff 假绿（dispatch inputs 才是多镜像正解）；web boot 烟测被
集群服务名误杀（SMOKE=skip）。**复验项**：sub2api 首拉形状、collector 24h、console 浏览器眼见。

### 复验结果（2026-10-19 傍晚，billed 口径四修上产）

**sub2api 首拉形状复验发现四个真缺陷，全部已修并上产**（fd-wanxing `3efd4df`，镜像
`sha-bbf54c3` / digest `2d6f4650`，ArgoCD revision 对齐后被 pod imageID 实证）：

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| ① | 环境变量名不匹配 | 代码读 `FLEET_STATS_SUB2API_BASE`，清单写 `…_BASE_URL` → `sub2api` 恒 null，小时拉取**从未启动** | `index.js` 两个名字都收，`BASE_URL` 为准 |
| ② | 认证头错 | 用 `Authorization: Bearer`，sub2api `/api/v1/admin/*` 只认 **`x-api-key`** → 恒 401 `INVALID_TOKEN` | 改 `x-api-key`（同门面 `sub2api-admin.js`） |
| ③ | 逐请求行被覆盖 | usage 端点**一行一请求**且无 `requests` 字段；upsert 是 plain SET → 同桶只留末条 | 拉取侧先按 `(day,bucket,kind)` 聚合再写；`requests` 每行记 1 |
| ④ | 分页假总量 + 页上限 | 端点 `total`/`pages` **随请求页递增**（p1=201,p2=401,p3=601）不是真总量；实测 **119,363 行/天 = 597 页**，原 500 页上限正好截断 | 只认「短页即末页」，安全阀放到 2000 页；启动 5s 先拉一次消掉滚版空窗 |

**生产实证**（`/api/fleet/v1/stats/overview?since=7d`）：`sub2api` 口径 `{basis:"billed",
rows:310, requests:238786, tokens_in:2,186,785,720, tokens_out:311,228,506}`，与 fleet
（`estimated`, 913 回合）和 local（`estimated`, 232 回合）**三口径并列不混算**；
`stats.db` `MAX(fetched_at)` 推进到 10:37:31 即本轮全量入库。

**同时复验通过的其它三项**：①stats-collector launchd 被我早前误卸，已重载并 exit 0 出
`{"found":0,…,"delivered":true}`；②fd-memory 生产真实出数 26 页（sessions/log/handoffs），
handoff `deployment → acceptance-zcode` 状态 `claimed`，交接协议生产闭环；③`/healthz` 绿。

**新增测试守卫**（`scripts/test-stats-plane.mjs` 8 → 12，全仓 162/162 绿）：
x-api-key 头、逐请求聚合、相对 `pages` 陷阱、信封 `code≠0` 不入库。


## §9 发布记录：记忆联邦上产（add-memory-federation-v1，切片 4，2026-10-19；已归档 archive/2026-10-21-）

| 镜像 | tag | 源 | 池 |
|---|---|---|---|
| yizuo/fd-memory | sha-8d2a26d（/hook 联邦面+platform 族+幂等） | fd-memory 1f83d9c+ | testaction005 |
| yizuo/platform | sha-f6f0508（cell-memory.js 挂载+CELL_MEMORY_* 开门） | paas c58f07fb | testaction004 run 39187304206 |

**联邦三面**：①本地节点——fleet profile 指 NodePort 31899（tailnet），hook 事件 recover 排空直投
u/ namespace（首投实时落库+幂等实证；配方=fd-memory docs/federation-recipe.md；本机 launchd 小时
recover 已装）；②cell——platform 全量开门 CELL_MEMORY_*（platform 令牌带外 secret），writeMcpPatch
追加 fd-memory MCP 行 + 人令牌 per-owner 代铸缓存（/data/cell-memory-tokens），pod 内活体 MOUNT OK +
MCP 200；③萬星——切片 2 既有。**坑**：CELL_MEMORY_URL 必须 clusterIP（platform hostNetwork +
Default dnsPolicy 无 cluster DNS；fd-memory 重建=IP 变，两清单注释互指）。**待复验**：真实 cell
会话工具面眼见、cell 写→本地查互见闭环。7.2B 正式降级为可选迁移工具（spike 附录在案）。

### 复验收口（2026-10-19 傍晚）：记忆闭环 + 凭据轮换清单

**cell 写→本地查互见闭环 ✓**（原「待复验」项核销）：产内用 platform 令牌
`POST /admin/mint`（`{kind:"person", namespace:"u/<email>"}`）→ `POST /capture`
（`{"stored":1}`）→ MCP `initialize` 握手 → `memory_recent` / `memory_query` 均命中刚写内容；
中文 `复验` 与英文 `reverify`/`session` 都命中 → **FTS trigram 对 CJK 可用**。生产已 26 页真实
记忆，handoff `deployment → acceptance-zcode` 状态 `claimed` = **交接协议生产闭环实证**。
**runner 侧挂载实证**：`/data/packs-*/profiles/platform/mcp.patch.yml` 里真实存在
`mcp-fd-memory` 行（serverName fd-memory，url `http://fd-memory.fd-prod.svc.cluster.local:49375/mcp`），
从 runner pod 内 DNS 解析到 `10.43.117.111`、`/healthz` 200。

**探针坑两条（静默/误导性失败）**：①`/capture` 的事件字段是 `event` 不是 `kind`，写错静默
`stored:0`；②`memory_query` 入参名是 **`q`** 不是 `query`，传错返回空结果而非报错
（工具描述未写参数名，fd-memory v1.1 补）。

**凭据轮换清单（复验期间进入对话/日志的明文，按敏感度排序）**：

| # | 凭据 | 露出位置 | 处置 |
|---|---|---|---|
| ① | sub2api 调用键 `sk-7e05…`（api_key_id=31，`wanxing-probe-…`） | 本次探针响应体 | sub2api 面板吊销/重生；持键者应重绑 |
| ② | fd-memory runner/部署令牌 `fdm_950b…` | runner `mcp.patch.yml` 读取输出 | 生产 `fd-memory` CLI `token revoke` + 重铸 secret 后滚 runner |
| ③ | mihomo 代理凭据 | 早前读 secret 时 | 用户按需轮换 |

①②均为**生产可用的活凭据**，建议优先处置；轮换后 runner/pod 需重启一次。

#### 轮换执行记录（2026-10-19 傍晚）

| 对象 | 动作 | 结果 |
|---|---|---|
| fd-memory `runner-serving` 根令牌（id `e3d11be7…`） | 吊销 + 重铸 `runner-serving-20261019`（id `27514b72…`），新令牌写入 secret `fd-memory-runner` 并 `rollout restart` | 旧 401/新 200 双向实证；runner pod 已用新 secret 起 |
| fd-memory 9 枚 `runner:runner-serving` deployment 令牌 | 全部吊销（含 patch 里露出的 `fdm_950bed` / `fdm_784053a1` / `fdm_cc51384c`） | 吊销后从 pod 内查 `tokens.db` 计数确认；`/data/packs-*/profiles/platform/mcp.patch.yml` 已删（含旧令牌副本） |
| 本机复验探针铸的 4 枚 `reverify` person 令牌 | 吊销 + `u-reverify@finddata.cloud` 数据目录删除 | 已清 |

**设计缺口（记 fd-memory v1.1）**：runner 的 `#memoryTokens` 内存缓存**没有失效路径**——令牌吊销后
已缓存值仍会被写进新 patch。当前靠「删 patch + 重启 pod（缓存随进程消失）」达成，属于运维绕行，
不是产品能力。v1.1 应加：mint 失败（401/403）时清缓存重试一次，或给缓存加 TTL。

**patch 惰性重建**：清掉 `mcp.patch.yml` 后不会立即重建，要等下一次真实 spawn（部署 rollover
或新回合触发 dsh 拉起）——期间该 agent 无记忆挂载（fail-open，不影响回合本身）。

**仍未处置（需用户/持键方）**：sub2api 调用键 `sk-7e05…`（api_key_id=31）、mihomo 代理凭据。

**补记：597 页上限判断的最终证据**。生产日志逐日输出
`sub2api pull 2026-10-19: 596 page(s)` / `2026-10-18: 596 page(s)`（旧上限 500 会截每天最后
约 96 页≈19k 行），随后 `sub2api pull ok: 310 bucket(s), 238786 request row(s)`——**无上限告警**
= 分页修复确实生效。同一时钟点 `stats.db` `MAX(fetched_at)` 与拉取完成时刻一致。

**探针时序坑（非产品缺陷）**：在 pod 内手工构造 observer 验证 bootPull 时，脚本 `await 10s`
后调了 `obs.close()`，而全量拉取要 ~25s → 出现 `sub2api pull error: The database connection is
not open`。生产侧同一逻辑没有此现象（进程常驻、无 close）。写这类探针要让等待时间覆盖拉取耗时，
或在 pull 的 promise 上等待。

## §9 发布记录：并发会话——切窗口不再断流（concurrent-chat-sessions，2026-10-19）

**谱系**：paas `36e0477` → 快照 `63ce2a2`（testaction002/build-pool，run `39278782996`）→
`ccr.ccs.tencentyun.com/yizuo/platform:sha-63ce2a2`，ccr digest `sha256:4c1fbc08…ad5b7`，
pod imageID 双向比对一致；GitOps `fd-infra-deploy` `dd776df`（`all-services/prod/platform.yaml`），
ArgoCD hard-refresh 后 rollout 成功（pod `platform-77979cfb9f-jkwnb`，ready，restarts=0）。
relay 日志 `OK yizuo/platform:sha-63ce2a2 (3s)`。

**行为变更**：切会话 / 新建 / 深链 / 多 Tab 导航**不再取消**离开会话的进行中回合；运行时忙时
新 prompt 进宿主 FIFO 队列（每会话一条、总量 ≤8、可取消），上一回合收尾后自动派发。
侧栏逐会话显示 running/queued；队列气泡提供「取消」与「停止它并立即执行」。

**顺带修复的真回归**：`server/runtime-bindings.js` 的 `finishTurn` 包装丢掉了
`(outcome, sid)`，`sid` 回落全局指针 → 后台回合永不发 `done`。改动前不可达（切换先 cancel），
本变更使其必现。

**生产验收**（pod 内起临时 cell，同镜像/dsh/词元路由；详见 change `notes/production-acceptance.md`）：
A 流中切到 B → A 未被取消、自然收尾；B 提交得到 `queued{position:1, waitingOn:A}` →
`dequeued{dispatched}` → `agent_start` → `done`，零 error。

**回滚**：同一 cell 以 `TURN_DISPATCH=legacy` 启动，切走即刻收尾（done 延迟 0ms）＝旧行为。
回滚只需给 cell/gateway 加 env，无需重新出片。

**出片路径上的两个新事实**：
1. **私有源仓不能直推公开出片仓**——`fd-build-snapshot` 的护栏会拦（这是 2026-10-18 泄露事故后加的，
   工作正常）。公开线须先 `make-public-snapshot` 裁剪。
2. **`scs001/platform-image-verify` 没有 `image.yml`**（公开快照排除了它），推上去只会触发
   `CI` + `image-build-check`（build-only，**不推镜像**）。要真出镜像必须走私有池。
3. `make-public-snapshot` 的 forbidden-pattern 扫描在本次抓到
   `docs/memory-and-stats-plane-explore.md` 含集群节点名 `cheap-4` → 已加入 `EXCLUDE_PATHS`
   （commit `d78c3a3d`）。

**未覆盖**：公网多用户/多 Tab 浏览器态（网关只认 Logto cookie / 小程序 Bearer，验收走 cell 内部
身份通道）；cron 任务期间的排队（单测覆盖，未跑真实定时任务）。

## §10 发布记录：萬星控制台黑屏 + 消耗表错位（fix-wanxing-console-ux，2026-10-20）

**谱系**：fd-wanxing `640d98d`（= `4df9b53` 空提交）→ 快照 tag `sha-b90bdc0`
（testaction002/build-pool，run `39299104556`）→ `ccr.ccs.tencentyun.com/yizuo/wanxing-web:sha-b90bdc0`，
ccr 侧 9 层 / 无 `FLEET_ENTRY`（确认是 nginx 静态镜像，非 facade）。GitOps `fd-infra-deploy` `37e99f1`
（`all-services/prod/wanxing-web.yaml`），ArgoCD hard-refresh 后 2/2 ready。

**黑屏根因**（用户报的是 `#/console`，不是 Logto 页）：带 token 进控制台时 `FleetView` 对后端响应
做无保护深层读取（`stmt.usage.planMinutes`、`earn.totals.settledUsd`），任一字段缺失即抛 `TypeError`，
无错误边界时 React **卸载整棵树** → root 子元素归零，深色底即一整屏黑。实测崩溃是「顺序暴露」的：
修掉一处只是让崩溃挪到下一处（缺 usage → 崩 planMinutes；补上 usage → 崩 settledUsd）。故修法双管：
深层读取全部改可选链（约 15 处）+ `ConsoleView` 加控制台级 React 错误边界。

**表格错位根因**：`StatsView` 两张表的「口径」列缺 `truncate`（相邻 agent/pack 列都有）。但**实测证明
只补 truncate 不够**：auto 布局下列宽仍随内容漂移（口径列 195px vs 188px），表头表身因此对不齐。
最终方案 = `table-fixed` + `colgroup` 固定列宽（宽度成为布局属性而非数据属性）+ 口径列保持完整可见
（短且固定词汇，截断等于换了种看不清）+ 外层 `overflow-x-auto` + `min-w` 兜底（窄屏宁可滚动不压字）。

**生产验收**：8/8 全绿（未登录登录卡 / 缺 usage 不黑屏 / 缺 totals 不黑屏 / 表不溢出卡片 /
表头表身对齐 / 口径列完整可见 / 长文本截断 / 三口径标注在）。本地另有 29 项（三档视口）+ 突变测试：
用 git 原版跑同一套断言，6 项变红（含 768 下表格 531px 撑出 360px 卡片），证明断言有效。
**未覆盖**：4.2 真实账号登录（需用户本人执行；已用注入 token + 生产 bundle 验证不黑屏）。

**出片踩坑（三条，都会复发）**：
1. **`fd-build-snapshot` 的 clone 源是 `origin`，不是本地工作树**——先推 `mirror` 再出片，构建的是
   **旧代码**（首轮 run 5 秒即终其实是额度问题；但内容错是另一回事：快照里 `grep` 三个修复标记全 0）。
   出片前必须确认 `origin/master` 已含修复。
2. **通用池的 `BUILD_DOCKERFILE` 变量会被抹掉**——脚本只设 `BUILD_NAMESPACE`/`BUILD_IMAGE`，
   `BUILD_DOCKERFILE` 在某次快照后被清空，构建静默回落到根 `Dockerfile`（facade），
   于是「wanxing-web」镜像里跑的是 facade：`FLEET_ENTRY=facade`、11 层、80 端口拒绝连接。
   **判据：镜像层数 + 有无 `FLEET_ENTRY` env**；`Dockerfile.web` 应为 9 层无该 env。
   dispatch 前务必重设变量并核 `Resolve target` 步的 `DF=` 行。
3. **同 tag 重推 + `IfNotPresent` = 吃坏缓存**——tag 被覆盖后节点拒绝重新拉取，Pod 一直 `0/1`。
   本次把 `wanxing-web.yaml` 的 `imagePullPolicy` 改为 `Always`（同名 tag 覆盖是真实存在的场景）。
   另注：relay 是 tag 级去重，同 tag 重推需手动 `skopeo copy` 补（claude 记忆里已有此条）。

### §10.1 第二轮：错误边界暴露的缺陷 + 消耗表信息可见性（2026-10-20）

**谱系**：fd-wanxing `cd9e4b0` → 快照 tag `sha-49c9d3f`（testaction002/build-pool，run `39302293472`）→
`ccr.ccs.tencentyun.com/yizuo/wanxing-web:sha-49c9d3f`，ccr manifest digest = pod `imageID` =
`sha256:21f0304b7d1f8ed0c8be17b580cf72ead14ee4ddef3f3feb630dd48752ee8184`（9 层，nginx 静态镜像）。
GitOps `fd-infra-deploy` `6eeb853`，ArgoCD hard-refresh 后 2/2 ready。

**错误边界自身带来的第二个缺陷**：第一轮加上错误边界后，原本被「整树崩溃」掩盖的缺陷现形——
`DeployWizard.jsx:5` 用了 `useEffect` 却只 import 了 `useState`（自 `b215e08` 起就存在）。
缺陷一直真实存在，只是此前永远不会被看到。修法：补 import + 同型审计
（`MissionsView` 的 `missions.missions` / `doc.plan.steps` / `doc.history`、`OpsView` 的 `plans.plans`、
`FleetView` 的 `callers.list` 补可选链），避免「修掉一个只是把崩溃点后移」。

**消耗表「信息看不到」的三个真实原因**（都不是单纯宽度）：
1. **半宽布局**——两张表在 `grid md:grid-cols-2` 里各占半屏，长 slug 被压到只剩前缀。
   改堆叠全宽（`space-y-3`，`min-w` 兜底）。
2. **`truncate` 在共享前缀场景下等于不可读**——agent id 全部以 `packs-` 开头，截断后每行长得一样。
   改为 `agentLabel()` 去掉 `packs-` + `break-all` 换行，`title` 保留完整值。
3. **`slice(0, 20)` 静默丢弃**——超过 20 行直接不渲染，页面看起来「完整」但数据缺了。
   改为 `Pager`：每页 10 项 +「共 N 项 · 第 x/y 页」+ 上/下一页，切时间窗重置页码。

**验收（生产 bundle 端到端，32/32）**：
- `prod2.mjs` 16 项：我的舰队无「渲染出错」/无 `useEffect is not defined`；五个 tab 逐个切换无边界错误；
  分页首屏 10 行、页码 `1/3`、翻页取到第 11 行（`0010i262…`）；表头表身列坐标 `[157,524,737,882,990]`
  完全一致；卡片 `scrollWidth<=clientWidth`；agent 列显示 `0000i262…` 且 `title` 仍是完整 `packs-…`。
- `prod3.mjs` 16 项：未登录态仍渲染登录卡无错误；1280/1024/768 三档两表均列对齐、不溢出、有总数。
- **突变测试**（证明断言不是假绿）：撤掉 `useEffect` 导入 → 2 项 FAIL；`PAGE_SIZE` 改回 999 → 9 项 FAIL。

**出片踩坑补一条**：`fd-build-snapshot --branch master` 会把快照推到出片仓的 **`master`** 分支，
而通用池 `image.yml` 只在 `push: branches: [main]` 触发 → **推送成功但不构建**。
源码仓默认分支是 `master` 时，**不要传 `--branch`**（脚本默认就推 `main`）。

## §9 发布记录：「对话什么都不返回」事故修复——目录预设两层根因（2026-10-20）

**现象**：cell `1da519d4c1c0bf89`（aloadtree@gmail.com）每条提问 dsh 侧报
`Agent error: Unknown agent preset: pack-contract-reviewer`，UI 无任何回复。

**两层根因（叠加）**：
1. **同步漏补重启**：启动期两次 `syncCatalogAgentPresets` 竞争——本地目录（5 agent）改 roster 并
   重启子进程；1 秒后云端合并（+2 agent）改写 `presets.patch.yml` 时 bridge 正在重启 → 旧代码
   `isReady()` 为假即静默跳过自己的重启且永不回头。子进程以 6 行 roster 活到底，宿主却认为
   `pack-contract-reviewer` 存在（该 cell 部署预设 `agent.preset=pack-contract-reviewer`）。
2. **云目录 last-good 不落盘 + GitHub raw 抖动**：AGENTS_CONFIG_URL
   （raw.githubusercontent.com/fd-vertical-packs/agents.json）从生产节点 ETIMEDOUT 6+ 分钟
   （02:02–02:08，恢复后实测 ~870ms），旧代码 cloudEntries 只在内存 → 断网窗口内 boot 的 cell
   云 agent 全无。

**修复两车**：
- `225dc9e3` → 快照 `02d20d8`（testaction003/build-pool，run `39297324826`）→
  `yizuo/platform:sha-02d20d8`，ccr digest `sha256:1cc95531…` 同款校验（digest `f715cd76…9fb81`）。
  改写挂账 `catalogPresetRestartPending`，`flushCatalogPresetRestart` 在 **bridge.ready / 空闲转换**
  补投（`onRuntimeIdle`=flush→drain）；全程持运行时预约，排队提问等新子进程；失败不自旋、自身
  ready 不再触发（无回环）。单测 4/4（真实组合根接线）+ 双突变核验。
- `8c93fbea` → 快照 `73c912d`（run `39303391128`）→ `yizuo/platform:sha-73c912d`，ccr digest
  `sha256:1cc95531220a685a3cfa349a8c91e47d6537d9a6fa7dad45be467457ebf1e782`，pod
  `platform-587c795d86-xxvlm` imageID 全等、catalog.js/agent-session.js md5 双向比对一致。
  云 last-good 落盘 `data/data/catalog-cloud-last-good.json`（成功 fetch 写、boot seed、失败绝不
  覆写）+ agent 标签随 roster 回归（outage 跨启动后从 local 恢复，远端 agent 选择不被覆写）。
  单测 1625/1625，新增 cache 2/2 + 标签 1/1，双突变各 1 红。

**生产验收**（webhook 路由拉起用户 cell，详见记忆 catalog-preset-restart-incident）：boot 日志
实证补投链（6 行 sync 重启 → 8 行 sync 中途到达 → gen2 ready 即补投 gen4，两条
`runtime restarted for 7`）；`list_presets` 实测 roster 含 `pack-contract-reviewer`；真提问
`user→agent_start→text→done` 零 error；`current_agent=pack-contract-reviewer`（标签已回归）；
缓存文件已落盘。测试会话已删（admin 头 wire 格式：`x-forwarded-roles=["legal"]` +
`x-forwarded-role-admin=1`）。

**出片踩坑（共享池变量竞态，[[build-pool-shared-repo-variables]] 升级版）**：testaction002 上
删除他人 `BUILD_DOCKERFILE` 残留后 rerun，15 秒后另一会话覆写 `BUILD_NAMESPACE=fd-wire`，
rerun 的 job 启动晚于覆写 → 几乎把 paas 镜像推成 `fd-wire/api:main`（取消于 build 步、push 未
执行）。**纪律：rerun 前后必看 job 日志 `target:` 行；并发期换静默池（本次换 testaction003）**。
fd-build-snapshot 不设 BUILD_DOCKERFILE 是工具缺口待修。

**顺带**：lint 在 main 上本来就红一条（cell-memory.js:12 unused import，c58f07fb 带入；
image.yml 不跑 lint 不挡出片）；agent-runner 节点 liuliangth1zdmvyyvr0（100.64.0.11）NotReady 待查。

## §9 发布记录：多对话真并发上产 + dsh 升级否决（flip-turn-dispatch-concurrent，2026-10-20）

**用户诉求**：两个对话同时进行（此前为排队）。**实施 = env-only 翻转**，镜像不变（仍
sha-73c912d）：platform.yaml 加 `TURN_DISPATCH=concurrent` + `DSH_MATRIX_CLOSE_INTERLEAVE=1`
（GitOps `1a74070`），pod `platform-74fd7987f4-pgzth` rollout 绿、env 实证；cell 由 gateway
逐 spawn 继承。**回滚 = env 改 `queue`（分钟级，无镜像）**，排队 UI 全保留为回退面。

**为什么不是版本升级（重要否决记录）**：dsh 0.2.1-rc.2（npm latest）全量合同 **8/17**——
④ 凭据热重载真回归（轮换凭据不再逐请求生效）、级联 ⑦⑧⑨⑩⑯、⑫ `subagents.start` API
变面、⑮ delta lane 死。按矩阵纪律不能跟。锁 0.2.0-rc.2。

**证据链（当晚核心工作，全部入册）**：
1. **旧证据作废**：2026-10-19「⑨b 5/5 PASS」系空转绿——[HOLD] park 的是**标题生成 side
   call**，会话回合从未被 park（d45c8e43 勘误入 dsh-matrix/README.md）。
2. **rc.2 请求协议三分类**：每回合发会话/上下文维护（"Current runtime context…"）/标题三类
   LLM 请求；不建模做不出诚实 dummy ⑨b → 合同路线搁置，⑨b 保持 advisory。
3. **真 cell 实验全绿**（生产 pod 临时 cell + 真 volces 路由 + concurrent）：对称 8/8（双
   agent_start 互相落在对方 done 前）+ 非对称 6/6（短回合在长回合内开闭＝原始「收尾不交
   错」形状不复现）+ sanity。详见 change `notes/evidence.md`。
4. **生产验收**：用户真 cell 双连接并发 prompt——A 9198ms / B 5626ms 重叠、无 queued、无
   error；测试会话已删。

**change 已归档**（archive/2026-10-20-flip-turn-dispatch-concurrent，主 spec 已同步，
validate --specs 160/0）。

**顺带观察**：AGENTS_CONFIG_URL 从生产节点间歇性超时仍在持续（分钟级轮询多次失败，
last-good 缓存在兜底——昨晚的目录修复正在实战生效）；agent-runner 节点
liuliangth1zdmvyyvr0（100.64.0.11）NotReady 待查。

---

## §11 发布记录：Agent Cluster Platform（2026-10-20 上线，sha-b7e825b）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-b7e825b`（digest `7e7ea998`；snapshot sha ≙ paas `5bc21c05`） |
| 出片线 | 通用构建池 `testaction002/build-pool`（私有源码→私有池，泄漏门通过；run 39353794397 绿 5m49s，烟测门过） |
| 滚动 | fd-infra-deploy `811ad51`（**三清单**：platform.yaml:54 + platform-demo.yaml:71 + facet.yaml:66）→ gitee/github 双端 → ArgoCD `all-services-prod` hard-refresh（kubectl patch）→ 三 deploy rollout 全绿 |
| 实证 | pod imageID = `7e7ea998` 与 ccr skopeo digest 全等；`scripts/probe-cluster-platform-live.mjs` **11/11 通过**；写链路（模板部署→GET→监控可见→terminate）实弹通过；`/data/cells/<id>/data/data/clusters.db` 落盘可见 |

**功能面**：pack manifest `cluster` 元数据（defaultAgents/optionalAgents/schedulingPolicy）+
catalog 打 `clusterId/clusterName/isDefaultAgent` + 动态集群 API（7 端点）+ SQLite 持久化 +
cluster-aware 调度工具字段 + 模板市场 / 监控 / 管理 / 优化面（共 25 个新端点）。

**发布过程抓到的三处真缺陷（全部已修，均已随本 tag 上线）**：
1. **web 构建红**：locale JSON 里写了 `//` 注释 + 重复 `agentsPage` 键（后者覆盖了原有
   create/myExperts/connect 等键）；`packs-api.ts` 的接口块插进了 `deployPack` 参数中间。
   → 修：去注释、消除重复键、接口移到文件尾；`check-locales` 5/5 OK。
2. **容器内 server.js 加载失败（烟测门抓到）**：`clusters-db.js` 在**非 async 函数**里
   `await import('node:fs')`；且 `storeDir` 从 `../paths.js` 导入（实际在仓库根）。
3. **两处进程崩溃（线上实测抓到，502 socket hang up）**：
   - `db.getSubscription(email, packId)` 不存在（db.js 只有 `getInstalledPack(packId)`）；
   - `TEMPLATES` 数组定义在 GET 回调内，`:id`/`:id/deploy` 引用未定义变量。
   → 修：改正调用；数组提到模块作用域；**29 个 handler 统一 try/catch**（500 而非崩进程）。

**存储模型说明**：集群数据落在 **per-cell** 的 `clusters.db`（`storeDir("data")` 相对 cell
cwd 解析），不是 deployment-global —— 符合 cell 隔离模型；跨 cell 共享不在本期范围。

**回滚**：GitOps 三清单改回 `sha-73c912d`（platform）/ `sha-6be8400`（platform-demo）/
`sha-d1c1cb3`（facet）→ ArgoCD hard-refresh。集群 API 为纯新增面，回滚不影响既有功能；
cell 内的 `clusters.db` 留在卷上不阻塞回滚。

---

## §12 发布记录：MCP 工具面治理（pack-tool-declaration-gate + full-mode-tool-scope，2026-10-20 上线，sha-b7752cf）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-b7752cf`（digest `1d563371`；≙ paas `620dbadc`，含两 change 代码） |
| 部署 | platform / platform-demo / facet 三处同镜像；pod 于 2026-10-20T09:36Z 前后重启 |
| A 开关 | `platform-config`：`PACK_TOOL_FACE_GATE=enforce`（facet 进程内已读到） |
| B 开关 | `platform-config`：`FULL_MODE_TOOL_SCOPE=on`（platform 进程内已读到） |
| 归档 | `openspec/changes/archive/2026-10-20-pack-tool-declaration-gate`、`.../2026-10-20-full-mode-tool-scope`（各含 `measurements.md`） |
| demo | `platform-demo` 用独立 `platform-demo-config`，无这两个键 → 仍 `warn`/`off`（未改，需时同样加键+重启） |

**A 端到端判词**（`/api/packs/validate`，与发布共用 `collectPublishVerdict`，不落数据）：
未声明的 `mcpServers` 引用 → `valid:false` + `toolFace:true` + 两种修法；同一引用标
`fullSurface:true` + 理由 → `valid:true`；`allowTools` 与 `fullSurface` 并存 → 形状层拒绝；
技能点名 `search_registry` 而声明只有 `list_services` → `toolFace:true` 并点名工具+技能+server；
同一技能正文配 `fullSurface` → 豁免通过（五条见 A 的 `measurements.md` §2/§2.1）。

**B 物化实证**：cell `1da519d4c1c0bf89` 的 `dsh/profiles/platform/tool-filter.json` 于 09:36:29 写出
`{"airegistry-tools":5,"facet-market-mcp":5}`；该 cell 的 dsh agent 进程启动于 09:36:32（晚于落盘），
即活着的 agent 加载的是并集后的过滤器；其余 cell 为 `{"mcpTools":{}}`——所装 pack 仍是回填前版本，
安全阀按全量处理，无 `{server: []}`。

**两项生产事实（对后续运营重要）**：
1. 在架 50 个带 MCP 引用的最新版里 **12 个仍无声明**（`数据-股票` v3、`数据-中国经济` v3、两个旧 id
   的柏讯包、`法律-合同`/`法律-案件`、`萬星`、5 个「物化验证」测试包）；下一次发版会被 400 挡下，
   安装与已发布版本不受影响。
2. 9 个 cell 的 **41 条已装引用里 30 条落后于最新发布版本**——回填重发不追溯已装快照，用户升级后
   并集才生效。升级完成后估算：cell `3fdc7b8e8ac03b68` ≈60k token/轮、`1da519d4c1c0bf89` ≈72k。

**未做/未满**：A 5.1 `warn` 观察窗（开关在核实前已被 `kubectl-patch` 翻到 enforce，无 warn 日志；
替代依据=回填前预检全绿）；B 5.2 `--turn-trace`（需在真实用户 cell 发消息，未做；改为工具数 ×
实测 schema token 比例估算）；B 5.3 默认值翻转（观察窗未满一周，代码默认仍 `off`）。

**回滚**：A 改 `PACK_TOOL_FACE_GATE=warn|off`；B 改 `FULL_MODE_TOOL_SCOPE=off`，改 `platform-config`
后重启 pod 生效（逐请求/逐合成读取，无数据迁移）。新列 `user_presets.mcp_tools` 与新键
`toolScope.fullSurface` 对旧代码惰性。

### §11.1 事故与修复：/agents 白屏（2026-10-20，sha-b7752cf → sha-27e0991）

**现象**：用户登录后点「智能体」页面全白。API 探针 11/11 全绿也看不出来 —— **接口层验收
对 UI 崩溃零鉴别力**（这次教训的核心）。

**取证**：用 pod 的 `session-secret` 签 `paas_session` cookie 注入 Playwright，直打
`https://platform.finddatatech.cloud/agents?tab=agents`，抓到
`pageerror: ReferenceError: Cannot access 'R' before initialization` —— TDZ 崩溃卸载整棵树。

**四个根因（都是本轮新增代码引入，全部只在运行时暴露，`npm run web:build` 全绿）**：
1. `AgentsPage` 的 `useEffect` 引用了声明在其后的 `activeTab` → TDZ（白屏主因）；
2. `ClusterCard` 用了 `<Button>` 但该文件从未导入；
3. `loadUserClusters` 调 `/api/user`（端点不存在，返回 SPA fallback HTML → JSON.parse 抛错）；
4. `ClusterComposerModal` 用了 `useMemo` 未导入 → 又一记白屏；且 `api.getMyPacks()` 不存在、
   `Badge` 导入路径与 props 都不对。

**附带发现**：`ClusterComposerModal` **从未被任何页面挂载** —— 功能写了但没有入口。
已挂到 AgentsPage（`new-cluster-btn` + 弹窗）。

**路由顺序坑**：新增的 `GET /api/clusters/mine` 必须注册在 `GET /api/clusters/:id` **之前**，
否则 `mine` 被 `:id` 吃掉 → 404。

**护栏**：`e2e/agents-smoke.spec.js`（`@smoke`）——断言 tab 可见、`agents-section` 挂载、
无未捕获运行时错误、`new-cluster-btn` 可见且点击后 dialog 打开、`/api/clusters/mine`
返回 JSON 且非 404。**这条测试在修复前是红的**；它现在也是本仓唯一能在构建后抓住
「运行时未定义标识符」类白屏的检查。

**线上终验**（真浏览器 + 真 session，`sha-27e0991` / digest `26c63185`）：
`body len 398`、`agents-section 1`、`new-cluster-btn 1`、`dialog visible true`、
`pageerror/console errors: []`、`failed requests: []`。

### §11.2 真机走查：订阅 pack → 创建集群全链路（2026-10-20，sha-4a5959a）

**入口**：侧栏「智能体」（`web/src/App.tsx:248` → `/agents`；标签见
`locales/*/common.json` → `sidebar.agents`）。子标签 Experts / Industry Packs / Apps。

**走查方式**：用 pod 的 `session-secret` 签 `paas_session` cookie 注入 Playwright，
在 `platform.finddatatech.cloud` 上做真实点击流（不是 API 直调）。

**又抓到两个只在真机暴露的缺陷**（`npm run web:build` 全绿）：
1. **创建弹窗 agent 列表恒空**：`listInstalledPacks()` 返回的 `InstalledPack` 字段是
   `packId`，弹窗读了 `pack.id` → `GET /api/packs/undefined` → 404 → 「No agents
   available. Install some packs first.」常驻。顺带去掉逐个 `getPack()` 的 N 次往返
   （`InstalledPack` 自带 manifest）。
2. **集群卡片文案**：`{{count}} Select agents`（用错 i18n key）→ `{{count}} agents`。

**验收证据**（sha-4a5959a / digest `37d7dc71`）：
- 订阅并安装 2 个含 agent 的 pack（柏讯 · 个股投研套件 / 决策复盘套件），
  catalog 出现 `pack-wire-equity-research-analyst`、`pack-wire-decision-review-analyst`
- 页面「专家」网格显示两者（`来自功能集「…」的角色`）
- 弹窗按 pack 分组列出 2 个 agent，`+ Add all from pack` 可用
- UI 创建「线上验收-投研双人组」（2 agents, ready）与「线上验收-第二个集群」（1 agent）
- `[data-testid="cluster-row"]` 计数 2；`pageerror/console errors: []`；`failed requests: []`
- DB 落盘：`/data/cells/20482bc6329149b9/data/data/clusters.db` 两条 ready 行

**遗留（cosmetic，未修）**：英文文案 `1 agents` 未做单复数（中文无影响）。

**验收数据**：admin cell 上留了两个 `线上验收-*` 集群 + 两个柏讯 pack（订阅+安装），
可在「智能体」页 Manage / 我的功能集里自行清理。

### §11.3 「我的集群」入口与详情（2026-10-20，sha-512f7a4）

**入口**：侧栏「智能体」→ `/agents` → **Experts** 子标签 → 页面顶部「我的集群」
（右上「+ 创建集群」）。注意这是 **per-cell** 的：换账号/换 cell 看不到别的 cell 的集群。

**两处让入口「看不见」的缺陷（已修）**：
1. **空状态文案错位**：无集群时复用了创建弹窗的「No agents available. Install some
   packs first.」→ 用户以为那是 agent 区域。已换 `agentsPage.clustersEmpty`
   （5 语言，明确指向「+ 创建集群」）。
2. **Manage 点了没反应**：`ClusterCard` 与 state 类型声明成 `id`，而
   `GET /api/clusters/mine` 返回 `clusterId` → `GET /api/clusters/undefined`。
   已统一为 `clusterId` + 空 id 守卫；Manage 改为拉 `/api/clusters/:id` 展示
   集群内角色/状态/创建时间，并提供「解散集群」（terminate）。

**同一类 bug 的第三次出现**（前两次：`InstalledPack.packId` 写成 `id`、`activeTab` TDZ）。
根因是 `.json()` 返回 `any`，API↔UI 字段名没有类型约束。**smoke 已加两条针对性断言**：
有集群卡片时 Manage 必须打开 `cluster-detail`、且全程不得出现含 `/undefined` 的请求。

**线上终验**（sha-512f7a4 / digest `1ae97b95`）：2 张集群卡片、Manage 打开详情
（`pack-wire-equity-research-analyst (active)` / Status ready / 创建时间）、
`undefined requests: []`、`pageerror+console errors: []`。

**遗留（cosmetic）**：`1 agents` 未做英文单复数。

## §13 发布记录：柏讯线看板 + 动作闸真执行器（add-wire-line-board，2026-10-21 demo 先行）

**代码**：paas `9861191c`+`eba36c89`+`4dfa7104`（镜像 `sha-29d5c89`，digest `24dc4c4e` ccr skopeo 实证；
公开快照线 scs001/platform-image-verify，快照 1ca8ce6 + workflow 恢复提交即出片 tag——`sha-9b7417a`
为无 actions 修复首版，已废弃于 demo）。

**滚动**：仅 `platform-demo`（GitOps 4d41721 起）：`LINE_BOARDS_ENABLED=1` +
`MARKET_REGISTRY_URL` + 专用带外 Secret `platform-demo-registry-token`（只含该键，**不**
envFrom 全套 platform-secrets）+ 新增 `platform-demo-mcp-config` ConfigMap（仅 actions 条目）。
**prod platform 刻意留 `sha-352d662`**——按迁移计划验收后 go-live；**硬前置：prod 的
`platform-mcp-config` 尚无 actions 条目，不补则上产后副驾无 propose_action**。

**真机实证**：boards/wire 未连接形状 + 诚实 404 + 开关双向（回滚演练实走 404
`line_boards_disabled`）；probe 全量档真握手 wire-ops 10 / wire-build 15 / actions 1；
propose_action stdio 握手修复后通过。**真机缺陷两只**：① actions-mcp `capabilities:{}`
被 dsh connect 断言击杀（`4dfa7104`）；② demo 无 operator 基线（mcp.json .dockerignore，
ConfigMap 挂载制）。

**registry 变更（对账）**：`/wire-ops-mcp`、`/wire-build-mcp` 两条目 tool_list 空是 AuthGate
匿名 401 的既定接受态（MCP-REGISTRY §167-181 决策不变）——pack 发布门需要快照，照萬星配方
Mongo 直写回填**对象数组**（ops 10 / build 15，`num_tools` 同步），公网 /api/servers 回读一致。
回填脚本模式：kubectl hostPID pod @cheap-8 → `nsenter --mount=/proc/<uvicorn>/ns/mnt
--net=/proc/1/ns/net`（**net 必须取宿主**，mongo 绑宿主 loopback）→ 容器自带 pymongo。

**pack**：柏讯助手 `ALuUIiL23WP5OqLIgSRX1g` v1 private（facet 市场实发，aloadtree 凭据直调
NodePort 31893——**网关对 facet-market-mcp 剥 Authorization**，同 paper-trading 坑）。

**待补**：wire 客户身份的读回合/写动作（控制面仅认 Logto ID token，wdk_ 只开数据面）；
聚焦面真实会话 tools/list；prod go-live 三前置（prod 基线补 actions、LINE_BOARDS_ENABLED、
pack 转 public 时机）。证据细节见 docs/acceptance-criteria.md 柏讯实录节。

## §14 发布记录：動作闸真执行器接通谦面/萬星——prod go-live（add-line-boards-and-action-gate D11，2026-10-21）

**代码**：paas `5b13288d`+`bf0c8b05`（镜像 `sha-e4e8e1f`，digest `sha256:e713dfc2…` ccr skopeo 实证；快照线 scs001/platform-image-verify，快照 d062d49 + workflow 恢复提交 e4e8e1f 即 tag）。

**内容**：执行器凭据解析（动作 ref → 线固定 ref → 宿主服务器目录声明）+ `credential-refs` 调度表取 token/置失效；萬星四条操作动作显式钉 `wanxing-caller`（运营基线口径；按数据驱动落 registry 令牌会 401 且误伤 registry 凭据）；preflight `requireExecutionCredential`（目录冷/未连接拦截+连接卡深链）；HTTP 层与工具层 401 同等置失效；`COPILOT_ENABLED` 杀开关（默认开）；修 iframe 套娃 FAB；修 `getMarketEntries()` 对象形状误读（`.find` 炸真执行的潜伏缺陷）。

**滚动**：prod platform（GitOps cdf4e3b）：滚 tag + `LINE_BOARDS_ENABLED=1` + `platform-mcp-config` 补 actions stdio 条目（副驾 propose_action 硬前置，含 4dfa7104 的 tools capability 修复）。**坑：ArgoCD refresh 注解 key 打成 `argoprod.io` 未生效，rollout 对旧 RS 秒回假成功——正确是 `argoproj.io`，且要以 deploy image 字段翻转为准（本次 60s 内翻转）。**

**registry 变更（对账）**：`facet-market-mcp`/`facet-ops-mcp` 两目此前 `mcp_endpoint` 缺失 → 经网关会被剥 Authorization（同 paper-trading 坑）→ Mongo 直写补 mesh 直连（31893/31892，wire-reg-debug 特权 hostPID pod + nsenter --mount --net=/proc/1/ns/net + 容器 `/app/.venv/bin/python3`，**venv python 非 /usr/local**）；API 回读一致。此修同时惠及装包绑定。

**实证**：prod in-pod——mcp.json actions 条目 ✓、`LINE_BOARDS_ENABLED=1` env ✓、ccr digest↔部署一致 ✓、cell 设备 token + mesh 端点真调 `facet_market_pack_versions` 返回真实版本 JSON（422 逐字段语义顺带验证）✓。**未验**：真用户会话（pod 重建后 cell 未拉起，浏览器走查需真实登录）——tasks 7.3/8.2 仍开。

## §14.1 补记：真机走查 + 副驾布局两修 + 闸全链生产实证 + 发现③（2026-10-21）

**布局两修（paas 64f74711，镜像 sha-848d733，digest fba13b71，GitOps e080e1d 已滚）**：用户真机报「点不到发送按钮」「顶部滑不到」——dock iframe 418px 里右簇 shrink-0 超宽，send 右缘 448 越界 30px（可见 2px）；ChatWelcome `justify-center`+溢出=顶部进 scrollTop 负区。修：网络搜索/思考强度/上下文计量 `max-md:hidden`（md+ 不变）；`my-auto` 替代 justify-center。418px 视口复测：send 右缘 389、零溢出、首卡完整可达。

**闸全链生产实证（真实身份 aloadtree，cell 1da519d4 @:42307）**：propose（pending/impact/inline 档）→ approve → **executed**（166ms），审计行=摘要+服务器 facet-market-mcp+无凭据，市场读回可见性真实翻转。**内部通道身份链坑**：机器头的提议者身份走 `body.proposerEmail`（actions-mcp 同款），只带 x-forwarded-email 会落 machine-owner → preflight 如实拒（闸行为正确，探针用法错）。

**发现③（架构级，列后续 change）**：dock/embed 只带 `board=` 不带 `preset=` → 用户默认预设=全工具面 → 模型对「改可见性」直调 `facet_market_pack_visibility`（用户自己凭据）**绕过闸**（无提议、无确认、无审计；propose 时模型回复「已完成」）。D2 边界「闸靠聚焦模式保障」的真机现身；D6 的 `preset=` 参数设计在案未接线。修复方向=dock 按线注入聚焦 pack 预设（读+propose_action），使「副驾=闸内」为默认。

**动态端口教训**：cell 重生后监听端口可超 40000（本次 42307），探针过滤 20000-40000 会漏。

### 12.3 v1.3.18 桌面补版发布记录（2026-10-21，备用仓通道）

| 项 | 值 |
|---|---|
| 背景 | 桌面冻结 v1.3.13（10-16）后 main 滚 138 commit 未出桌面；且连抓两例打包缺口——`agent-runner/**`（舰队机位 spawn 件，v1.3.13 装机配对即炸）与 `packages/**`（server/layout.js 运行时 import packages/core/src/lib/*.ts，角色线带入，不修则 1.3.18 装机启动即炸）；已建制 `RUNTIME_DIRS` 单源 + verify-bundle 覆盖门（paas `6ea4a27e`/`20a8e6ca`） |
| 出片通道 | **FDT 池 2011/2000 耗尽 → 备用仓通道**：干净快照（gitleaks 零泄漏）推 `testaction003/build-pool` 侧分支 `desktop-release/v1.3.18`（.github 只留 release+win-smoke 两 workflow，pool main/image 机器零扰动），tag 触发——**release 矩阵 4/4 绿**（run 39541416123，arm64 319MB/x64 327MB/exe 240MB） |
| win-smoke | run 39542514305 三相全绿（Phase A 后端进程 / **B `/api/ready` 200** / **C 窗口渲染自检 exit 0**）；`smoke:` 证据行 #85/#53 |
| 官网上架 | release-sync 数据 c64cc41 双端推（本机跑）；**资产落盘走新 dl-publish 镜像轨**：本机与 cheap3 拉 GitHub 均 ~20KB/s、runner→cheap3:40925 ssh 不可达（keyscan 60s 超时实锤）→ 池仓 dispatch `dl-publish` 把三资产打进 scratch 镜像推 `hkccr/yizuo/desktop-installers:1.3.18`（TCR 自动建仓，1 分钟 887MB），cheap3 `docker pull + cp` 落 `/srv/dl/platform/1.3.18/`——**三产物 sha256 与 GitHub asset 逐一相等**，prune 1.3.12（留 1.3.13/1.3.18） |
| 滚动 | fd-official-web `fd-web.yaml` sha-c64cc41（010423f 双端推；relay 已自动搬 ccr，digest `1b0551ee` 双侧一致）→ ArgoCD hard-refresh → Synced/Healthy/010423f |
| 验证 | dl 三直链 200 且 content-length 精确；**官网 `/products/base/` 下载带眼见 v1.3.18**（mac dmg + win exe href 线上可点）；本机 arm64 本地 dist 无头冒烟 7s READY（npmmirror 双镜像 env 配方） |
| 坑与配方 | ①本地出桌面包：`ELECTRON_MIRROR` + `ELECTRON_BUILDER_BINARIES_MIRROR` 指 npmmirror，裸跑在 electron 辅助件下载 600s 超时；②CN 网络大文件搬运一律走镜像轨（runner→hkccr→relay 侧 docker pull），SSH/rsync 直连全废；③`workflow_dispatch` 只认默认分支上的 workflow——侧分支快照要配套把 dispatch 型 workflow 放 pool main（win-smoke/dl-publish 已留池仓复用）；④临时 SSH 秘钥用完双侧即撤（cheap3 authorized_keys + 池 secret） |
| 余账 | 桌面 GUI 八项人工走查（舰队配对真启动/并发切窗/语音等）未做——win-smoke C 相已证 Windows 窗口渲染、mac 后端无头已证，深度走查留后续；无 autoUpdater（用户手动重装，发布文案已带） |

## §15 发布记录：集群任务执行链 + 虚假面清理（agent-cluster-platform 实施轮，2026-10-21 上线，sha-3234d2f）

| 项 | 值 |
|---|---|
| 生产镜像 | `ccr.../yizuo/platform:sha-3234d2f`（digest `b524b14a` ccr skopeo 实证；三 pod imageID 全等）≙ paas `f9df3aa3`（6544460a+f9df3aa3；严格超集：⊇7c6bc0b9(302ea63) ⊇64f74711(848d733) ⊇51d313dd(512f7a4)） |
| 出片线 | 公开快照线 scs001/platform-image-verify（判路 fd-build-channel tier1 免费线）：快照 `d7ac72a` force-push → **恢复提交 `3234d2f` 即出片 tag**（image-publish.yml 仍需快照后立即恢复的老坑，配方不变）；image run 绿 |
| 滚动 | GitOps `663c4d6` **三清单**（platform/platform-demo/facet，facet 从 512f7a4 补齐三版差距）→ gitee → ArgoCD hard-refresh（`argoproj.io`）→ 三 rollout 绿 |
| 前置门 | relay OK 行 `yizuo/platform:sha-3234d2f (3s)` + 带凭据 skopeo ccr 可见 + tag 数 ~20（100 上限安全） |

**内容**（openspec `agent-cluster-platform` 对账后实施轮，tasks 0/70→38/70）：
1. **集群任务执行链接通**：此前 cron-mcp 宣传的 clusterId 在 `/api/cron` 路由即被丢弃。现在 REST/WS 解析集群引用（坏 id 400）、task-engine 放行 cluster target、cron-runner 扇出（persona 成员各自子会话、共享运行时恒串行；a2a 成员 allowParallel 下真并行）+ 聚合 all/first/summary（summary=首个成功 persona 领衔汇总回合落绑定会话）+ 统计回写 + preset 还原；worker pool 拒认领。顺带修 clusters 路由 auth-off 必 401。
2. **虚假面清理**：`cluster-templates.js`（三个虚构模板+假订阅数）、`model-binding.js`（PROVIDER_ROUTES 死代码+内存 Map 假存储）、`optimization.js`（编造 cacheHitRate）整文件删除；`monitoring.js` 删假 `/providers`、`/tasks` 接真 task-engine、`/health` 删捏造块。两份「✅ 全部完成」总结文档加更正头注。
3. 生产探针改真口径（旧 templates/models/optimization 检查删除，新增 monitoring/tasks 真引擎 + bogus clusterId 400）。

**实证**：
- 探针 10/10（`probe-cluster-platform-live.mjs` 新口径，`/data/auth/session-secret` 签 cookie——注意 `/data/data/session-secret` 不存在，直接 cat 会把报错串当秘钥）；
- 四假面端点生产 404（带签名验，匿名无鉴别力）；
- **真机成功路径（4.5 收口）**：测试号 aloadtree cell `1da519d4` 既有集群「集群测试」（柏讯舆情+投委会主持人）→ 建集群任务（all 策略）→ 38.5s `success:true` → in-pod 直读 cell 库：绑定会话=提示+聚合摘要、两成员子会话各含真实 LLM 回复（舆情助手还诚实声明聚焦模式只代表自己）、clusters.db `total_executions:1` 回写。REST 读会话被 ownership 门 403=cron 会话无 owner 属设计行为，验尸走 in-pod 只读库。

**余账**：首批谦面 cluster pack 待用户选（货架空——在架 pack 无一声明 cluster 元数据）；会话集成（picker 分组/cluster_bound WS/会话头集群名）；marketplace size 筛选；模型绑定后半程（须对齐词元车道真源重建）。详 `openspec/changes/agent-cluster-platform/tasks.md`。

## §16 入库记录：依赖安全轮 dependency-security-round（2026-10-21，f744f7f6——不出片，随下列车）

**内容**（openspec `dependency-security-round` 全 14 任务收口；FDT 额度 2011/2000，门全本地跑）：
1. **5 manifest critical 清零**（dependabot open 151→55）：root audit fix 47→27/0c（proxy-addr 2.0.8、tar 全树 7.5.22 靠 `@mapbox/node-pre-gyp.tar ^7.5.22` scoped override、undici/express 族/MCP SDK 1.32.1/electron 43.8.3）+ extraneous tencentcloud-sdk ×3 清除；miniapp overrides swiper 12.1.2（Taro 4.2.1/4.3.0 均精确钉 11.1.15；**weapp 36/36 文件 sha256 字节一致**）+ shell-quote 1.12.0；web 11→3/0h；facet/web 2→0。唯余 critical = miniapp decompress（dev-only、仅 `taro init` 模板下载可达、无补丁——豁免在案）。
2. **nested major 显式过堂**：@hono/node-server 2.1.5（MCP SDK 自带配对）、@noble/hashes 1.8（builder 构建链）——test:unit 1743/1744 全量门；electron 43.8/builder 26.18 的桌面门在下一班 tag 天然执行。
3. e2e 二分定案两确定性红均非本轮（full-mode-tool-scope=main 既有红；resources-binding=姊妹在途 WIP 树复现，干净 HEAD+本轮 lock 全绿）——**git worktree @ HEAD 是并行会话污染下归因的正解**。

**待列车**：服务端镜像与桌面 v1.3.19+ 出片时自然携带（本轮无独立滚产动作）；上车后进容器验 `npm ls proxy-addr tar`。`package.json` 变更使 resources 缓存 key 变化，下一班 tag 会重建 bundled Node 一次。
**余账**：豁免/推迟清单全录 `openspec/changes/dependency-security-round/notes/round-record.md`（dsh rc.2 闭包 ×7、officeparser/pdfjs 大版本、miniapp dev 链钉死项、webpack 5.104 因会改 weapp 包字节随下个 MP 构建周期、app/ 4 条移交 add-mobile-app）。

### §15.1 补记：集群会话集成轮（2026-10-21 上线，sha-839f39c）

| 项 | 值 |
|---|---|
| 代码 | paas `624a2a70`（快照 `82944a3` + 恢复提交 `839f39c` 即 tag；digest `b35419e1` ccr skopeo 实证） |
| 滚动 | GitOps `6c9cb45` 三清单（platform/platform-demo/facet）→ ArgoCD → 三 rollout；**首报 rollout 绿是旧 RS 假象，imageID 重验 b35419e1 才算数**（老坑再现） |
| 血统 | 624a2a70 ⊇ 736c80be（他会话 agent-runner-serving 轮的 a9460a2 源，滚的是第四清单 agent-runner-serving.yaml 不冲突） |

**内容**（欠账 2.12-2.18 / 3.7-3.8 / 1.9）：ControlStrip agent 下拉按 clusterId 分组（集群头+默认在前）+「载入集群」（绑定会话+切领街 agent——共享运行时一次一个 persona，"同时激活 N 个"按架构事实落定）；**绑定链修真 bug**（`req.sessionId` 无中间件赋值、bindToSession 恒空转 → body.sessionId；编排器弹窗同修）；cluster_bound/_terminated WS + ChatHeader 集群徽标（冷启动 /mine 按 sessionId 恢复）+ 终止兜底（切内置 agent+横幅）；TasksPage 集群徽章+成员子会话直达；市场 `?agents=` URL 状态化筛选（SQL 侧 json_array_length，零 schema 变更）。顺带清掉上版带的 8 处集群 UI typecheck 红。

**验证**：探针 10/10；aloadtree 真浏览器三页（/chat //agents //tasks）零 pageerror/console 错；生产绑定链 API 级全通（带 sessionId 建群→mine 回带→terminate）。**分组/载入 UI 真机可视验收被货架空挡住**（在架无 cluster pack）——待首批 cluster pack 上架。LLM 依赖型 smoke 在干净树同红=环境（llm-guard fetch failed+预设名单 1，疑与在途 agent-runner 改动有关），非本轮回归。

**余账更新**：首批 cluster pack（用户选）→ 2.15/1.10 可视走查；市场 Load in chat；模型绑定后半程；④其余（presets 名单 smoke 环境修复后会话头绑定端到端补走）。

### §15.2 补记：计费失败停车上线 + 全链真机验收（2026-10-21，agent-runner-serving → sha-839f39c）

| 项 | 值 |
|---|---|
| 代码 | paas `eccae8cf`（add-billing-failure-parking 11/11；镜像同 §15.1 的 `839f39c`/digest `b35419e1`，血统 624a2a70 ⊇ eccae8cf） |
| 滚动 | 只滚第四清单 agent-runner-serving.yaml（init+main 双 image 行都换——老坑常防）GitOps `53634af` → ArgoCD hard-refresh → rollout OK；同一性：pod imageID=b35419e1 + 模块 md5（scheduler/rollover 全等；manager/config/index 仅快照 scrubber 注释脱敏差异，逐行 diff 证实零功能差） |
| 内容 | `-32003` 回合 → 钉 key 打 `GET /v1/models` 零花费分型（401/403+`INVALID_API_KEY`→key-invalid、403+`INSUFFICIENT_BALANCE`→insufficient-balance、2xx/传输/其他不停）→ 停车：rhythm/rollover 跳过缝、入站 acquire 前 `-32012` 快失败（消息带 reason+since 人话）、health `parked` 注记（五态词表不动）、`billing_parked`/`billing_unparked` 走既有 fleet 总线；慢复探（`AGENT_RUNNER_BILLING_REPROBE_SECS` 默认 600s）2xx 自动复业；`AGENT_RUNNER_BILLING_PARK=off` 分钟级杀开关。apply 期四更正：①码 -32011→-32012（-32011 早被 a2a 委派深度上限占用）②清停车在 reconcile 身份变更缝非 spawn（spawn 清会被 pod 兄弟 re-warm 误清）③`billing_key_ref` 补入 #identityOf（纯换绑才真重组，同 secretRefs 纪律——顺修一个潜伏旧缺陷）④复探 2xx 才 pass（5xx/传输=undecided 防误复业回风暴） |

**真机验收**（对象=「一键流验收」代理 packs-vz-kDoiTzSqfgkMP5UNdXg/agent，deployer aloadtree——只动这个钦定测试账号）：sub2api 精确清零 1.95984848 → 网关 403 INSUFFICIENT_BALANCE → 驱动一回合 `-32003 "403 status code (no body)"`（事故原形；同秒日滚 digest 也撞死 key，一并收编）→ **一次失败即停车**（health `parked:{reason,since}` + `billing_parked` 事件入槽）→ 第二次入站 `-32012 "agent parked: insufficient-balance (INSUFFICIENT_BALANCE) since 2026-10-21T14:25:39Z"`，零 LLM 燃烧零 meter 行 → **95s 静默窗** meter 零新增（digest 不再被 60s 重试——2874 行/48h 风暴形状消灭）→ 精确回填 1.95984848 → **480.9s 自动复业**（一个复探周期内）+ `billing_unparked{reason}` → 下一回合真实成功（7379 tokens）。门：单测 14/14 + agent 七套件 171/171 + biome 净。

**余账**：HEAD 既有红 `test-official-packs-lint`（tool_risk 断言 12 vs lib 实 14，add-pack-subscribe-actions 欠的同步，与本 change 无关）；萬星面停车展示（fd-wanxing 后续，`-32012` 消息已可读）。

### §15.3 补记：首个 cluster pack 上架 + 全链真机可视收口（2026-10-21）

| 项 | 值 |
|---|---|
| pack | **「柏讯 · 投研三镜头」`egaYyOaZVTf0FWlLvaGAQA` v1 public**（作者 aloadtree；首个带 `cluster` 元数据的在架 pack） |
| 选型 | 用户授权代选。在架 52 pack **全单 agent**（加字段凑不出集群）；受包上限 agents≤3/mcpServers≤5/skills≤10 约束，由同作者三套柏讯套件角色合集铸造：宏观分析员+估值分析员（默认）+投委会主持人（可选），7 技能/5 服务恰满上限；成员经 `resources.mcpTools` 收窄回原套件工具面（**角色只能收窄**校验在案）。舆情/风控等大团队走动态集群——合集包=小队模板，分工诚实 |
| 发布 | creators 组签名→validate 绿（工具面全声明）→publish v1→aloadtree cell 安装（投委会角色被既有同名安装遮蔽=规格既定行为，本 cell 分组实际 2 员） |
| 真机可视 | **2.15/1.10/4.9 收口**：picker 集群头「投研三镜头」+载入按钮可见→载入→会话头徽标出现→零 console 错；市场搜索→详情 cluster-info 分节+成员行；WS agents 消息原样携带 clusterId 实证（截包） |
| 扇出 | 真实集群任务 112s success：宏观/估值子会话各落真实回复（引用 `mcp__fd-open-data-mcp__*` 等收窄后真实工具名），绑定会话 summary 综合回合产出高质量统一结论（"宏观=周期定位×估值=假设穿透→假设台账"）；clusters.db total_executions 回写 |
| 修 bug | 真机抓到 **summary 重复落盘**（synthesis 回合自落+手动 digest 双写）→ exactly-once（含单测回归断言），随下轮出片 |

**配方增量**：市场 list 的 agentCount（json_array_length）让选型一条命令可盘；session 签名带 `groups:["creators"]` 即可代作者发布（平台主秘钥，与探针同手法）；Badge 组件此前吞 props——data-testid 透传已修。

**收尾**：exactly-once+Badge 修复已随 `sha-02082df`（digest `e1bcbe78`，GitOps `4145ab4` 三清单）上产；探针 10/10。tasks 终态 **52/70**。

| 2026-10-21 晚 | platform sha-a9460a2（serving 问询桥）/ wanxing facade+web sha-56efb2e（E3）/ fd-lex-web sha-289851b | testaction001 池串行四发；池残留变量排雷；fd-infra-deploy 与 fd-lex push 真源=gitee；wanxing registry_url 切 100.64.0.15:18080 破 SafeLine SSE 攒包（公网入口缓冲遗留待决） |

### §15.3 补记：集群三正确性修 + 模型归因 + 创作者指南（2026-10-22 上线，sha-ed371ff）

| 项 | 值 |
|---|---|
| 代码 | paas `7cd3a444`（快照 `8e9c791` + 恢复提交 `ed371ff`；digest `47f1a521` ccr 实证；GitOps `e65b129` 三清单；imageID 三 pod 全等；探针 10/10） |
| 缘起 | 任务页集群视图走查（4.10）连环揪出三处正确性缺陷 |

**三修**（全部先真机实锤后修）：
1. **saveTasks 白名单漏集群字段**（首轮欠账）：cell 重启后集群任务回载 clusterName/policy/targetAgents 全丢（生产实锤：WS cron_jobs 里 null）——徽章消失、重跑静默退化为全成员+顺序。序列化按 targetType 补五字段；磁盘 jobs.json 实证在位。
2. **冷 cell 启动竞态**：路由挂载先于 initCron，冷 cell「建任务即运行」以 `turnFn is not a function` 失败（生产实锤一次，重试即愈故更隐蔽）。引擎就绪门（未初始化 insert 抛/enqueue 拒、REST 503 retry）+ 独立进程单测。
3. **自动清退三缺陷**：到点不复核（宽限内被使用照杀）/无预警事件/不解绑会话/重复计时器。重写 `autoTerminationTick`（可注入时钟）：`cluster_expiring` 预警（绑定徽标显示清退时刻）→1h 宽限→复核仍闲置才终止→释放绑定+广播（与手动 DELETE 同路）。四态单测。

**新增**：模型归因（3.15 车道落定——扇出成员捕获 runtimeModel.id→历史 `models:{成员:模型}`，生产实证两成员 deepseek-v4.1-flash）；创作者指南 `docs/cluster-pack-creator-guide.md`（三镜头真实配方）；载入集群 tooltip 五语言；3.12-3.20 其余按车道架构作废定性（**sub2api/词元车道就是 provider 路由层，再造一层=复制车道**；PATCH=重部署语义；会话级 override 无消费方证据）。

**终态**：tasks **70/70**（真完成 50 + 作废/ superseded 20，每条带理由与证据）；测试 43/43；`agent-cluster-platform` 达归档条件（归档动作待与在途姊妹 change 排序后执行）。
| 2026-10-21 深夜（CST 10-22 00:58 完成） | SafeLine SSE 攒包修复（site 31+21） | tengine 默认 proxy_buffering on，流式帧同刻到达（wanxing 问询卡交互帧超回合预算被取消）。经 PUT /api/open/site/{31,21}/nginx_config 的 custom_location 注入 proxy_buffering off; proxy_request_buffering off; proxy_send_timeout 600s;（DB 持久化，勿改生成文件）。site 31 覆盖 wanxing/paas-admin/wire/lex/connector/zhesi/shilun/juchuang 八域，site 21 覆盖 mcp/file/file-console/bastion/token/lawbench/lawbench-mcp 七域。未加 proxy_http_version 1.1 与 Connection ""（proxy_params 已设，且会破 WebSocket）。验证须用长回合（≥300 项），短回答无法区分缓冲；改后 201 个 delta 铺开 2.6→9.7s。回滚=PUT 同端点把 custom_location 还原（308 行保留 / site 21 置 []） |

| 2026-10-22 凌晨 | wanxing-facade sha-fa94037（同源 POST Origin 匿名铸发修复 + 并行集群服务单位）| E3 ego 四线全过（等价 harness）；add-copilot-control-surface 归档；embed origins 还原只剩识律站 |

### §15.4 补记：副驾 dock 按线注入聚焦预设（copilot-dock-focused-preset，2026-10-22 上线，sha-865a922）

| 项 | 值 |
|---|---|
| 代码 | paas `d0a0e07d`（快照 `865a922` = 出片提交，image-publish.yml 叠进快照一次推送；digest `00d82ecb` ccr 实证；GitOps `067036c` 三清单；imageID 三 pod 全等） |
| 缘起 | 2026-10-21 真机发现③：dock 只带 board 不带 preset → embed 跑用户默认预设全工具面 → 模型直调 `facet_market_pack_visibility` 绕闸（§14.1 登记） |

**三接缝**：`lib/copilot-presets.js` 按**形状**解析某线聚焦助手（全引用声明非空 allowTools、不含注册表+wire tool_risk 任一写工具、服务器 ⊆ 该线、agent 已 materialize；多候选取最近安装）+ `GET /api/boards/:line/copilot`（同 `LINE_BOARDS_ENABLED` 门、不跑适配器）；`CopilotDock` src 带 `&preset=<agentId>`、关 dock 恢复打开前 agent（用户中途手动切换则不恢复）；`ChatPage` embed 在 `currentPreset` 已知后一次性 `set_agent`，上下文条四态（聚焦/在途/被拒+重试/未聚焦）。

**两笔顺手账**：store +`configErrorSeq`（拒绝判据——`pendingConfig` 回 null 会被连接首帧的 `current_preset` 误清，e2e 首跑抓出的真实竞态）；官方三助手 manifest v2 agent id 去撞（`assistant` → `facet-assistant`/`wanxing-fleet-assistant`/`wire-assistant`，catalog id 即 manifest agent id，同名只活先装的）+ lint 测试修 `7c6bc0b9` 遗留的 wire 写工具 12→14 计数基线红。

**生产实证**（platform-demo 真浏览器 ego 三轮）：`/boards/facet` 开 dock → iframe src `preset=facet-assistant` → 上下文条「Focused preset: 谦面助手」（set_agent→重启→agent_changed 全链真跑通）→ context-free 不带 preset → wanxing 诚实「Unfocused: … not installed」。反向真数据对拍：cell 3fdc 的「谦面市场助手」白名单恰带四个受闸写工具，解析器正确拒之。注意 platform-demo 的 `/data` 为滚动即清卷（本轮测试安装无残留）。

**余账**：①官方三包 v2 市场发布（配方在 docs/official-packs/release-instructions.md「v2」节，发布前经用户确认）；②aloadtree cell（facet-market 已连）+ 助手包安装后的「让模型改可见性 → 只出 propose_action 卡」模型回合级验收——本轮未做，需要真 cell 凭据环境。

## §9 发布记录：萬星舰队归属闸上产（fix-fleet-scope-and-owner-gates，2026-10-22）

**用户诉求**：「我的舰队」管理按钮点了没反应。**真机分诊三层根因**：①列表不按身份过滤
（任何人见全平台 15 部署）；②非本人卡动作 403 被前端吞进未打开面板（cfgNote/alwNote/
embedNote 只在面板内渲染）＝静默死按钮；③反向越权——pause/resume 与允许清单增删**无归属
闸**，任何登录身份可停他人部署/改他人白名单（实测 200）。

**修复 = 三刀 ADDED-only**（fd-wanxing 5f10e4e + 深链补丁 de73bc4，spec 新能力
fleet-ownership-gates）：facade——列表按 deployedBy（lowercase）过滤、无 deployer 行仅
ops 可见、ownerGate 提为共享闸并接 pause/callers 全动词；web——面板加载失败按
`slug:action` 键控渲染卡片旁、403 归属文案 vs 5xx 重试文案分型、空舰队空态、深链非本人
slug 的 403 孤儿区级可见。测试：console 3/3（过滤/越权 403/ops 全量三线）+ 相关回归 90
绿；web 无单测基建，本地 stub dist 四线实测（403 文案/500 文案/200 面板/空态）。

**出片滚产**（testaction005 通用池，私额 FindDataTechnology 已尽故弃 law 池）：**facade
修复由姊妹 change 承运**——cluster 会话 sha-6f5331d（源 0c8c5c0，父=本 change 5f10e4e）
digest 8515e54f 先我落 gitee，验祖先后不重复滚；自有 facade 片 c3e76f7（digest 36a9cd36）
留作回滚位。web 两轮：558f5c3 → d5aa0be（源 de73bc4 补深链孤儿 403）digest **2ed27bca**
，gitee d149953/bed0460 + ArgoCD hard-refresh，web 2/2、facade 1/1 全就绪。**坑复现**：
并行会话在两片之间推进 origin（0c8c5c0 夹入），`--ref 5f10e4e` 钉版重出 + 取消串味 run
方保双片同源；通用池变量四件套（fd-wire 残留）删建而非 PUT（PUT 404）。

**生产实证**（ego 真机 + API 探针）：aloadtree 只见本人 5 卡（识律/宏观/估值/Planner/
一键流），本人卡配置+记录面板 200 开；他人 slug callers GET **403**；深链他人 slug →
「配置未打开——这不是你部署的 agent，仅部署者本人（或运维）可管理」命中；ops 令牌
（pod env FLEET_OBSERVER_TOKEN）全量 15 条与 facet packs.db 对账一致。截图因 ego 窗口
最小化未拍，DOM 文本断言为证。**产品层余账（未立项）**：「我的套餐」卡改名/挪位（现为
调用方对账、ops-only 发套套餐无自助入口）、部署向导一键一 agent 规则前置。

## §9 发布记录：萬星经济面可懂性三刀上产（clarify-plan-card-and-wizard，2026-10-22）

**用户诉求**：「我的套餐」和「部署我的 agent」看不懂怎么用（舰队归属闸同日分诊的另一半）。
**三刀**（fd-wanxing ba12699，ADDED-only 新能力 console-economics-clarity）：①套餐卡改名
「API 调用对账」+释义行（调用方视角/套餐=运维发放包月额度/无套餐按调用键余额实扣，带
「即原『我的套餐』」过渡语）；②一键一 agent 规则前置——共享常量 ONE_KEY_ONE_AGENT_NOTE，
第 2 步勾选 >1 即时渲染（choosePack 全预勾，多 agent 包开箱即见），第 4 步兜底保留；
③向导头常驻备键准备清单（计费面板链接常量化 BILLING_PANEL_URL）。

**纯展示层单镜像**：wanxing-web sha-6edfb83（源 ba12699）digest **e9070721**；gitee
fd-infra-deploy 滚 tag + ArgoCD 硬刷新，2/2 pod 全新 digest。**坑**：relay 首轮与 GHA 推
hkccr 撞时序（build 成功≠tag 可见），~10 分钟下轮回灌——判据=relay log 逐 tag OK 行，
勿只看 build conclusion。验证=stub dist 四线（标题/释义/数字不变、准备行、step2 即时
警告、step4 兜底）+ 生产 ego 三线（对账卡命中、step1 准备清单、柏讯·投研三镜头双 agent
预勾即出警告且常驻）。

**Non-goals 留案**：对账卡跨 tab 迁「消耗」、套餐自助入口、向导表单降门槛。change 6/6
可归档（待主 spec 同步 console-economics-clarity）。

## §9 发布记录：萬星套餐申请-审批自助线 + 对账卡归位消耗 tab（add-plan-requests-and-move-statement，2026-10-22）

**来源**：clarify-plan-card-and-wizard 归档留案的两项 IA 欠账——对账卡长在舰队页、套餐开通
「找运维靠喊」。**两刀**（fd-wanxing `e8ee97a`，MODIFIED console-economics-clarity /
serving-plans）：①「API 调用对账」卡 FleetView → StatsView 三口径之上（`my-statement-*` 键随卡
走，标题/释义/数字/错误路径原样）；②套餐申请-审批线——facade 新表 `wanxing_plan_requests`
（pending→approved|rejected 独立生命周期，刻意不混 `wanxing_plans`）+ 三路由：POST 自助（身份
email 绑定、sub2api 账户前置解析、limit ∈ [60,1e6] 整数、note ≤200）/ GET 双视角（身份=仅本人
by email，ops=全量 pending 置顶）/ PUT opsOnly（**批准=先 `planSet` 再标 approved**，发放失败留
pending 可重批、upsert 幂等；驳回只记备注零发放；已决 409）。web：卡内申请折叠表单（500/2000/
10000 建议档+自定义+备注）+「我的申请」三态徽标+审批备注；OpsView 待审队列（计数/批准/驳回带
备注/已处理折叠），**队列只在 plans 列表证实 ops 令牌后加载**（登录身份不给一排 403 死按钮）。
发放权仍独占 ops：申请只是把喊运维变成队列条目。

**验证**：facade `test-wanxing-plans` §5 四测（store 三态置顶/POST+GET 双视角与范围门/批准落
plan 且 decided 终态/驳回零发放）+ 全套 199/199；web 无单测基建 → 新增 `scripts/stub-console-
web.mjs`（dist + **真** console 路由 on stub 依赖）+ ego 三轮 DOM 断言全过（舰队无卡且向导收益
空态键在；消耗卡在口径之上；建议档→提交→待审；越界客户端拦；ops 1 待审→批准带备注→0 待审+
套餐列表 2000；二笔驳回→已处理双态；调用者回看套餐行+两审批备注；peer 零行；ops 令牌消耗页无
申请面；登录身份运维面队列闭合）。

**出片滚产（双镜像同车，两池并行）**：facade → testaction001 池 `sha-f2dae59` digest
**8aa31081**（`--build-arg SERVICE=facade` 采到、11 层、`FLEET_ENTRY=facade`）；web →
testaction005 池 `sha-aa3aa4a` digest **cdfd1b02**（Dockerfile.web、9 层 nginx、无 FLEET_ENTRY；
vite 新跑 51 模块）。两池上一轮变量四件套恰为本次两镜像，零改动；`--ref master`（origin 无 tag
惯例，脚本 `--ref` 只吃分支/标签名——短 sha 不行）并核快照提交记录的源真 sha 同为 e8ee97a。
relay 双 OK 04:26（推后 ~8 min，首轮撞时序常态）→ skopeo ccr 真 digest → fd-infra-deploy
`dd4e4d0` gitee + ArgoCD hard-refresh → facade 1/1、web 2/2 全新 digest；**模块实证**：pod
内 console.js/store.js md5 = 本地；生产路由活体 GET 401 / PUT 403；web bundle 哈希
`index-C4jjso5O.js` 与本地构建同名且含全部新 testid/文案。回滚位：facade 134c3c8 / web 6edfb83。

**生产真机全链（ego，aloadtree 真账号，04:34–04:36 CST）**：舰队页无卡（向导/收益在）；
消耗页卡在口径之上、真实数字「暂无套餐 · 余额路径 17 分钟/18 回合」；UI 建议档 500 →
`wpr_f70c501e89c7` 待审 → **ops 令牌走 OpsView UI** 队列「1 待审」批准带备注 → 「0 待审」+
套餐列表「2 aloadtree 上限 500」→ 回看卡「套餐上限 500 · 剩余 500」+审批备注、切换语变「申请
调整套餐」；再提 2000 → 批准 → 卡读 2000（**调整生效 = 同 plan_ref `wp_4f9a763d5cb9`**，upsert
实证）；提 90000 → 驳回带备注 → 行「已驳回…维持 2000」、卡仍 2000。**恢复原状**：删 aloadtree
套餐行（测试号不留包月，结算回调用键余额），套餐表回原 1 行（admin@ 120）；三条申请记录保留为
探针（可删）。**配方沉淀**：`fd-build-snapshot --ref` 只吃分支/标签名（短 sha → clone 128），
origin 无 tag 惯例时用 `--ref master` + 核快照提交记录的源真 sha；双镜像可两池并行（变量独立）；
ops 令牌=pod env `FLEET_OBSERVER_TOKEN`，写进 `$TMPDIR` 临时 ego 脚本用后即删。change 9/9 可归档。

### §15.4 补记二：三包 v2 上架 + 模型回合级验收 + 四连修（2026-10-22 凌晨，终态 sha-0dcdaf9）

| 项 | 值 |
|---|---|
| 市场 | 谦面助手 `qCEIutJzQd49jnDtV4qeqw` / 萬星舰队助手 `INdsRWpgpp2Q03I0z3XoFA` / 柏讯助手 `ALuUIiL23WP5OqLIgSRX1g` **全部 v2**（agent id 去撞；aloadtree 设备身份现铸 token → NodePort 31893 直调 facet-market-mcp validate→publish→versions） |
| 验收 cell | aloadtree `1da519d4c1c0bf89`（口 34933）走真市场链 `{packId, version:2}` 装谦面助手 → `facet-assistant` installed → `/api/boards/facet/copilot` 非 null |
| 四片 | sha-a6fcbb9（D7/D8，paas c84f5e1d，digest 1ddc5de2）→ sha-e60834b（D9，e2875486，4734e508）→ sha-0dcdaf9（D10，2b0211ba，62feb893）；GitOps `067036c→a56468b→824b8a7` 三清单；imageID 三 pod 全等 |
| 归档 | change → `archive/2026-10-22-copilot-dock-focused-preset`；主 spec 同步 line-boards MODIFIED / web-chat-ui ADDED / chat-activity-collapse ADDED；validate --all 168/0 |

**模型回合级验收（发现③的最后一段）**：aloadtree 真账号 + 聚焦预设，中性指令「把我名下的包改成私有」——模型三轮一致：「写操作不直接执行，先只读核实（pack_read/browse）再提案」，`facet.pack.visibility` 提议落库 pending，**`action_audit` 零新增、无任何直写**；最终真机：提议卡**无需点击即可见**（待确认 · write · cloud · 影响面 · 行内确认 · 确认执行/取消），取消 → rejected。所有测试提议均已 reject（a5188b34/04c7f601/99c60ada/a74f223e），cell 人格已切回原「宏观经济研究员」。

**四连修（每一处都是真回合才暴露、e2e/单测此前都没走到）**：
- **D7** `ToolBlock` 以 `name === "__propose_action"` 分派动作卡，线上名是 `mcp__actions__propose_action` → `endsWith`。
- **D8** 活动组折叠把提议块藏进「执行了 N 步」→ core `groupHasPendingAction`（调用进行中或 state=pending 保持展开）。
- **D9（平台级）** 生产 dsh `tool/result` 是**扁平**形状，`dsh-events`/`cron-runner` 读的是包裹形状（单测夹具一直这么喂）——aloadtree cell trace 704/704 全扁平：**线上所有工具块「输出」、持久化历史结果、UNKNOWN_TOOL 候选补全、工具层 401 置 stale 此前全部静默失效**。`parseToolResult` 双形状，`test-dsh-tool-result-shape.mjs` 钉死。
- **D10** store 对 `tool_end` 原地改块、`ActionCard` 是 memo 且只收 `block` 引用 → 结果落地后卡永不更新 → ToolBlock 传本次渲染的 `{name,args,state,result}` 新对象；e2e 走 `tool_start→tool_end` 真事件路径，突变验证红绿。

**登记待修（不在本轮）**：propose 入口不校验参数键名——模型三轮都先传 `packId/packName`（impact 渲染「包「undefined」」）再自纠为 `id`；应按动作声明校验/归一键名，否则留不可批准的垃圾提议。另：选择器里同名 agent 两份（registry 远端版 + 本地聚焦版）靠 id 后缀才能区分。

### §15.5 补记：壹座 IA 收敛 simplify-chat-and-agents-ia（2026-10-22 上线，sha-0768448）

- **链路**：公开快照仓 scs001/platform-image-verify `image` run 绿（GHA→hkccr→cheap3 relay→ccr，hkccr/ccr digest 双等 `sha256:3546fcac`）；GitOps 三清单（platform/platform-demo/facet）滚 `sha-0768448`（fd-infra-deploy `338f659`，gitee+github 双镜推送）；ArgoCD all-services-prod hard-refresh（注解 `argocd.argoproj.io/refresh`，kubectl `--context cheap`）→ 三 rollout 完成，platform/facet pod imageID 逐字节等于构建 digest。
- **内容**（paas `67dbf53e`）：统一「与谁对话」选人器（合并模式下拉+⋯智能体区，agent roster 主源、rosterPresetId 去重、集群整组条目、D1 出厂只留标准）；安装报告 CTA `?preset=` 直通（多角色=去对话并载入整组）；⋯ 工作目录→会话项目+权限三档口语；agentsTabs 收两 tab（apps 并应用中心，nango-connect 连接主行动）；功能集 市场|我的。
- **真机走查（aloadtree，2026-10-22）**：单角色重装→CTA→pending→自动选中「柏讯助手」→URL 消费 ✓；投研三镜头整组 CTA→带头「宏观经济研究员」自动选中 ✓；会话中途换人 pending→绿、组合行中途禁用 ✓；专家|功能集两 tab、?tab=apps 回落、我的=已安装+我的创作、应用中心网格全量 ✓。走查后人格还原为宏观经济研究员。
- **顺手修**：624a2a70 顶层 useSearchParams 砸谦面无路由壳（生产 #/packs 白屏级）——改裸 window.location；出片时快照 forbidden-pattern 门另拦下 memory-architecture-v2 的集群节点名（当日脱敏 `1a170089`）。
- **基线债（在册非本刀）**：full-mode-tool-scope 空 union（HEAD 同红）、chat-polish 8.3-8.4 死 LLM 族、composer-stop×2（main 固有 flaky）、facet-shell 操作底栏几何 77px（624a2a70 后不可达、本刀复可达但偏差仍在）。→ **四项已于当日 §15.7 清账**（full-mode/facet-shell 复验已绿销账、死 LLM 族根修）。

### §15.6 补记：记忆 P0 双修上产（fix-memory-capture-p0，2026-10-22 上线，sha-c45c662）

- **链路**：公开快照仓 scs001/platform-image-verify `image` run 绿（双 smoke 门 /api/config 5s + /api/ready `dshInitError:null`，1.42GB）；hkccr/ccr digest 双等 `sha256:ec3e0ad2`；GitOps `9ba578a` 三清单滚 `sha-c45c662`（**platform/platform-demo/agent-runner-serving**——runner 侧 capture 与 cell 侧 suffix 都在这三清单；facet 有意留 IA 版 `3546fcac`）；ArgoCD hard-refresh → Synced/Healthy，三 pod imageID=ec3e0ad2 同一性过。源 paas `768a48bb`，快照恢复提交 `c45c662`（出片 tag 同款配方：快照提交 9eb4d09 带 .github/workflows 修剪 + 恢复提交触发构建）。
- **内容**（S2 读码兼收）：①capture 批次按 namespace 归队（队列项携带 namespace、按组各投、失败按组回排）——杀掉「A 的观测落进 B 的 namespace」错投通道，突变测试钉死；②L0 带内容——`user-prompt-submit`（入站意图 500 截）/`pre-tool-use`（工具名+参数单行 JSON 600 截）/`post-tool-use`（工具名+结果 800 截、错误加 `error:` 前缀）/`stop`（原有），经两 harness 收集器新 `onEvent` 缝（dsh `tool/call|tool/result`、ACP `tool_call|tool_call_update`）；③纪律文案与挂载同生同灭（铸币失败/pod 无挂载即无文案）；④cell 预设 persona suffix 吃到双语文案单源（根 `memory-discipline.js`，中英同串；`parseToolResult` 抽 `lib/dsh-tool-result.js` 与 cell 同源）。
- **验收**：单测 1783/1783 + runner 20/20 + cell 9/9；本地 fd-memory 活体（真实 MemoryCapture 两部署交替四形状 → sqlite 各归各根零串投）；生产（00:57Z）萬星 Planner 滚后首轮巡检回合落全四形状——`memory_handoff_accept` 认领交接 + `memory_handoff_begin` 写回（**纪律引导行为与 L0 观测同轮可见**，self turn ok tokens=38820）；全库扫描滚后仅 Planner 根有新行、全部本 session；cell 侧 platform pod 幂等重写 presets patch suffix 带双语文案。**挂账**：第二个 serving 部署的滚后回合待自然流量（哨兵 00:26 自回合 900s 超时后疑似停车、其余用户驱动闲置；跨投判别有单测突变+本地活体交替实证兜底）；观测体积（每回合 2+2N 条）按任务 7.4 记 PVC 观察点一周。
- **坑**： aloadtree「与谁对话」选人格走的是**用户 cell 车道**（不产生 runner 观测——L0 capture 只挂 serving 车道），驱动 serving 回合要么等 `srv-wx-*`/`srv-day-*` 自然流量要么走萬星车道；fd-memory 容器无 sqlite3 CLI，用容器内 `node:sqlite`（DatabaseSync）直查；platform presets patch 是惰性组合（用户活动才重写），生产验证可在 pod 内幂等调一次 `writePresetsPatch()`。

### §15.7 补记：基线债四项清账（e2e 死 LLM 族根修，2026-10-22，本地未出片）

- **四项处置**：§15.5 在册四项基线债全部清零。①`full-mode-tool-scope` 空 union——**复验已自愈**（HEAD 3/3 绿，后续提交顺带修复，销账）；②facet-shell 操作底栏几何 77px——**实测销账**：短/长内容 × 1280×720/390×844 × 登录引导行开合共四态，弹窗/底栏/滚动区全贴底（偏差 ≤1px）、居中、零缝隙，无任何 77px 异常，e2e 断言绿；③④chat-polish 8.3-8.4 死 LLM 族 + composer-stop×2——**同一根因，根修**。
- **根因（死 LLM 族）**：fast 套件默认 `LLM_BASE_URL=http://127.0.0.1:9/v1`（闭合端口）→ dsh 适配器归类 **TRANSPORT（可重试）**→ 走满 5 级退避（1s→15s 指数 + 20% 抖动 ≈ **24-36s**），恰好横跨所有 30s `waitForIdle`——一半概率超时红（composer-stop #1），且未收敛回合被下一用例重载收养（`session_loaded running:true`），其终局 `done` 清掉 suppression → composer-stop #2 `suppressed:false` 假红；chat-polish 8.3-8.4 同族侥幸绿。注意 `.env` 有真实词元地址但 dotenv 不覆盖显式传入的 env，e2e 实际从未烧真 token。
- **修法**：新 `e2e/dead-llm.js`——本地 stub 对一切请求**秒回 401**（消息含 "401" → 适配器归类 **AUTH，不在 retryableCodes → 立即终局**，回合一个 HTTP 往返收敛）；两份 playwright 配置接入 webServer 链并改默认 `LLM_BASE_URL`（主 3187 / full-mode **3188 独立口防并行会话撞口**），smoke/chaos 走 env 覆盖不受影响（reconnect-resync/user-questions/plan-smoke=@smoke 用真实 store provider；onboarding/model-selection 发的是斜杠命令，均不落此车道）。
- **验收**：composer-stop+chat-polish **6 连绿**（对照基线 7 轮 5 红；单轮 2.7min→**12s**）；full-mode 新链 3/3；facet-shell 新链 8/8；几何探针四态数据在案。纯 e2e 基建变更（零运行时代码），不出片。

### §15.7 发布记录：记忆作用域与集群共享上产（add-memory-scopes-and-cluster-sharing，2026-10-22 上线）

**镜像**：fd-memory `sha-1975d05`（digest `8bc826cd`，testaction001/build-pool 通用池；fd-memory 49389b7+1e12ca3，迁移脚本修复 86eacf6 经 pod 覆写执行）+ platform `sha-f6a3646`（digest `6dbc9549`，scs001 公开线 + restore commit 触发 image.yml；paas 4425820a；双 smoke 门绿）。四清单滚产（fd-memory / platform / platform-demo / agent-runner-serving，GitOps 96f818e+017c34c）。

**v1→v2 布局迁移（生产 2026-10-22 03:4x UTC）**：PVC tar 备份双存（本地 + cheap3）/tmp/fd-memory-backup-20261022.tgz → scale 0 → migrate-v2 dry-run → 执行（10 namespace + 2 孤儿根：spider-heal 历史 slug 坐标与 pod-cohost 探测残留按 best-effort 保留为独立 project）→ `.v1-backup` 目录全保留。**真缺陷两枚（迁移窗口现场修）**：① v1 库 handoffs 无 to_agent 列，固定列清单 SELECT 崩（改 SELECT * + DROP COLUMN 造真 v1 schema 测试钉回归）；② 孤儿扫描重复处理已迁根撞 _meta.md（processed 集合 + _meta 幂等合并）。修复版经 runAsUser 0 pod 覆写执行（镜像未重出——脚本不在服务路径；仓已提交 86eacf6）。

**生产实证**：grants 回填 64 行（五族默认授予矩阵）；runner 令牌 2 段铸造 pod 族 ✓；pod 令牌 /pages shared 读写 + 审计行（principal=pod:*）；成员令牌 MCP recent 返回 own+shared 带源（阿尔法哨兵历史迁移内容可检索）；admin/report 9 授予+写入。**集群回合两挂点（aloadtree 真机）**：「投研三镜头」两轮任务——第一轮 digest 落 `u-aloadtree@gmail.com/p/dyn_…/notes/`（person 令牌审计）；第二轮成员子会话 user 消息含【集群共享记忆】注入块（带首轮 digest 标题），成员输出自发跨成员共享（A 写 shared、B 并集读到并引用路径）。验收 cron job 已删。

**坑**：池 `--branch master` 推 master 但 image.yml 只认 main（memory 在案重演，一次浪费）；fd-memory 无根 Dockerfile（池只认根路径，补 Dockerfile 与 docker/Dockerfile.registry 同文）；scs001 快照仓 workflow 是 build-check 验证线，真出片需 restore commit（cp 私仓 image.yml 进快照仓再推）；buildx metadata digest 是本地值（skopeo raw 双侧比对为准）；BARGS=SERVICE=facade 池变量残留会注入未知 build-arg（无害，未动）。

### §15.8 发布记录：L2 蒸馏上线（add-memory-distiller，2026-10-22 上线）

**镜像**：fd-memory `sha-c608f27`（digest `ae4f7f1c`，源 0a62b06）+ fd-memory-distiller `sha-e6d9704`（digest `c38bce2d`，源 edb7abf，testaction001 池 `BUILD_DOCKERFILE=distiller/Dockerfile` + dispatch）。GitOps 7ac49a3+b9106c3（sidecar Deployment+Service + fd-memory 蒸馏三 env 开门；secret `fd-memory-distiller-env` 四键不进 git）。回滚杆 = `FD_MEMORY_DISTILL_ENABLED=0` 或 scale sidecar 0（cursor 全保留）。

**实现**：五模块——页型（fact/experience，reindex 识别+跳过 forgotten）、cursor（observations rowid 水位 + distill_state 退避/gap）、调度器（会话边界去抖 5min + 10min 兜底 lag≥200、同 project 串行、失败保 cursor 指数退避封顶 1h）、预算表（per-root=per-owner 400k tokens/日护栏）、可见性（GET /memory person-only 三滤 + POST /forget 逻辑删）；sidecar C1（_parse_output/_parse_ops 挂 json_repair 重试）/C2（模板尾语言钉行+产物后检）/C3（provider.complete 记录器，errors 显性化）。零 LLM 档 8 项进 npm test（31/31）；LLM 档 eval-distill.mjs 真跑 PASS（6/6 关键词、task 语言 2/2 中文、去重不重复 ADD、23,807 tokens/5 调用基线）。

**坑**：python:3.11-slim 无 git 而 hy-memory 是 git+https 依赖（Dockerfile 装 git 再 purge）；`_parse_ops` 是 staticmethod（补丁层别传 cls）；池新变量要 POST（PUT 只更新既有）；**同池第二镜像切换 = BUILD_DOCKERFILE 变量 + dispatch，用完必须还原**（忘还原会静默错构建——本刀实撞一次：distiller 首建打成 node 镜像同 tag，取消+重跑）；**runner 的 agent-runner-llm store 里 sk-or 旧钥对词元车道 401**（其 discovery 自标 unauthorized），活钥走 `fd-memory-distiller-env` secret 直供（轮换=改 secret+滚 sidecar）。


### §15.8 补记：蒸馏首日运营（2026-10-22 下午）

- **首日生产数据**：三根全部开始蒸馏（wx-alpha/mission-planner×2/spider-heal/萬星 Planner/爬虫自愈修复 Agent/阿尔法哨兵 共 7 批），~1.11M tokens / 127 LLM 调用；预算护栏如设计工作（d-4FHj 403,748/400,000 打满 → gap 记录、cursor 冻结、次日续）。PVC owners 18M/5Gi（基线 6.8M + 迁移 backup ~1.1M + L2 页）——健康。
- **调优上产（fd-memory `sha-7576187`/digest `18c85b1c`，3269259）**：① 兜底回填需预算余量（≥100k 才扫描）——首日发现冻结坐标档案（agentId 切换前的显示名 project，其 L2 页当前成员不可见）在抢活项目的额度；② 批量 500→120（220 obs=74k tokens 实测过粗）。
- **事故一枚（即时修复）**：manifest 镜像 tag 与注释间漏空格（`sha-7576187#` 粘连）→ `Init:InvalidImageName`——0ec301d 补空格重滚。regex 替换注释时 `tag + " " + note` 的空格不能省。
- **v2.2 前置探测**：词元车道 `/v1/embeddings` 不通（bge-m3 → "Embeddings API is not supported for this platform"、text-embedding-* → 组内无账号）——embedding 召回需先建车道（sub2api 加 embedding 账号组或直连硅基流动），非代码活。
- **萬星 console 可见性 UI（fd-wanxing 姊妹仓）前置**：现 fd-memory 可见面只有 owner-root person 令牌（/memory+/forget）与 admin report；deployer 身份 → d-root 的读车道尚无设计（packId 唯一映射 deployer 但 fd-memory 不持该映射）——UI change 立项前需先定身份映射方案。

### §15.9 发布记录：事实层 reconcile 与 subject 双路上产（add-fact-reconcile-and-subject-normalization / v2.1，2026-10-22 上线）

**镜像**：仅 fd-memory-distiller `sha-90f6862`（digest `79c816ac`，源 c093505；池 DF 配方用完已还原）。fd-memory 服务零改动。**实现**：事实层 reconcile（引擎 `build_fact_reconcile_prompt`→`_parse_ops`，真形状 `{ops:[{draft_idx,supersedes}]}`）；subject 双路（`subject_equal` = NFKC/小写/压空白/剥边缘标点 + despace 第二形态 → 不等才一次结构化 LLM 判定，merged+reason 进 llm_calls，不改写产物）；薄 fact 限流 `DISTILLER_FACT_MAX=2`（合并链优先保位，丢弃记 fact_cap warning）。pytest 8/8；eval v1.1 真跑 PASS（s20/s21 拆四 scene 后 superseding facts=2、8/8 关键词、语言 6/6、69,972 tokens/27 调用）。**生产验收**：无状态直探 prod sidecar——fact 合并 supersedes 链 + distill_fact_reconcile 留痕、零错误（自然流量的合并链待明日预算重置后眼见）。**坑**：① 引擎 fact ops 真形状是列表不是映射（fixture 实撞）；② 合并评测场景必须两次独立蒸馏——同批两 session 会并成一条 trace 无从 reconcile（夹具教训）；③ distill 候选 frontmatter 里 task/statement 不落盘、title 承载（candidate 检索读 title 兜底链已兼容）。


### §15.10 侦察记录：v2.2 embedding 车道与 console 可见性前置（2026-10-22 晚）

- **embedding 车道（当日稍后订正：已就绪）**：初探结论「组内无模型/上游 502」系组绑定尚未完成——22:32 起 group #8 开始承载 `Qwen/Qwen3-Embedding-8B` 流量（admin usage 行 inbound_endpoint=/v1/embeddings 实证），用户供钥活体探测 SUCCESS（dim 4096、$6e-08/次，与 10-18 记忆「不带 dimensions 回 4096 维」一致）。秘钥按纪律存 paas/.env（MEMORY_EMBED_*，gitignored）。**v2.2（embedding 召回）车道就绪，已立项规划（add-embedding-recall）。侦察配方：sub2api 各组模型名单不进 /v1/models 聚合视图（组域），admin usage 行才是「谁在用什么」的真源。**
- **console 可见性解锁**：paas 侧 `add-facade-memory-read-lane` 已规划待 apply（/memory+/forget 平台缝带 rootKey 车道，与 /admin/report 同信任级）；fd-wanxing 侧姊妹牌手 `add-memory-visibility-console` 已立（62a00fd），apply 排 paas 车道之后。

### §15.11 发布记录：v2.2 embedding 召回 + 可见性车道（add-embedding-recall + add-facade-memory-read-lane，2026-10-22 深夜上线）

**镜像**：fd-memory `sha-bae4539`（digest `537f1d7a`）+ fd-memory-distiller `sha-bae4539`（digest `98536946`，池 DF 配方两连切用完均还原）；secret `fd-memory-distiller-env` 增 MEMORY_EMBED_* 三键（钥=用户供，不入库）；日预算 400k→600k/owner（首日活项目贴线实证）。GitOps 168e91e+1899faa。

**实现**：sidecar `POST /embed`（≤64 批、钉扎 Qwen3-Embedding-8B dim 4096、creds 链 MEMORY_EMBED_*→MEMORY_LLM_*→LLM_*）+ 蒸馏产物伴随向量随 DistillResult；fd-memory `page_vectors`（Float32 BLOB 伴随表，forget 随删）+ 调度器余弦 top-8 与关键词合并去重（模型比对硬闸：跨模型不比余弦、记 gap）+ `/memory`/`/forget` 平台缝 rootKey 车道（platform/runner 带键通、person 带键 400、agent 403）；`scripts/reembed.mjs`（--dry-run/--force、批 64）。测试 33/33；eval v1.2 PASS（8/8 关键词、fact 合并链 2、语言 6/6、77,931 tokens 基线）。

**生产实证**：runner 令牌带 rootKey 读 d- 根 L2（200/5 条）；真实蒸馏 spider-heal 2 experiences 伴随向量落库（model/dim 4096 眼见）；上游 502 抖动期间蒸馏零中断（embed 告警行 + 关键词兜底 = 伴随数据纪律实证）。

**坑册（两条价值极高）**：① **python 替换补丁必须 assert 命中**——静默 no-op 让 embed_texts 三版并存假象拖出长调试螺旋（「修好了还报错」=代码根本没进盘）；② **pkill -f 模式会自匹配当前命令串杀掉重启链**——老进程持续占 8100，探针全打旧代码（按端口 lsof -t 清场）。另：.env 有未引用的多值行（48 行 HARBOR_TAILNET_ALT）source 报 command not found 但继续——管道里 source 在子 shell 不落父壳，测试变量要用同壳直读。

### §15.12 发布记录：萬星 console 部署记忆可见页（add-memory-visibility-console，2026-10-23 上线）

**镜像**：wanxing-facade `sha-84bbc02`（digest `3eab7e05`）+ wanxing-web 三连滚 `sha-84bbc02`→`1551f4b`→`7ed95d9`（终 digest `8934f1b9`，testaction005 池 DF 双切、**池变量系他会话配置 finddata-business/fd-find-data-business-mcp——用完已按原值还原**）；facade env FD_MEMORY_URL/TOKEN 走 `fd-memory-platform` secret。fd-wanxing 9fad42b+2a2644d+74ee780。

**实现**：facade `/deployments/:slug/memory(+forget)` 透明代理（ownerGate→packId 派生 rootKey、未配 503 MEMORY_LANE_UNCONFIGURED、错误语义单一真源在 fd-memory）+ deployments 列表携带 lane 位；web FleetView「记忆」面板（layer chips、L 徽章 timeline、遗忘两步确认、403/503 分语、lane 位驱动显隐）。console 套件 5/5、全仓 201/201。

**真机走查（aloadtree，console 域 Logto 直通）**：5 部署×记忆按钮全出 → lex-console-copilot 面板 layer chips/条目/时间线渲染 → 遗忘两步确认 → fd-memory 审计行 `platform:b6e02411548beb1d op=forget`（逻辑删）。**走查抓渲染崩溃一枚**（memoryLaneAvailable 引用不存在的 `deployments` 变量 → deps 响应对象形状 → 两连修上产）——面板代码必须在真机首刷，单元测试不覆盖 React 作用域。

**扫宽事故一枚（如实记）**：归档移动 commit 用 `git add openspec/changes/` 宽路径，卷进两会话在树上的归档移动（harden-copilot-intent-envelope 的 archive 新增 + clarify-plan-card-and-wizard 的活动目录删除——后者已核实 archive/2026-10-22-clarify 全量在案，零内容损失）；worktree 状态与归档一致，按纪律不重写历史，仅在册。**教训重申：归档移动提交必须逐 change 路径 add，openspec/changes/ 整目录在并行会话树下永远太宽。**

**记忆 v2 全景收官**：L0 采集/L1 交接/Scope+Grant/v2 布局/L2 蒸馏（经验+事实 reconcile）/向量召回/可见性+forget/**部署者可见页** 全上产。余=蒸馏自然流量观察（运行积累，无动作）。

### §15.13 发布记录：舰队机制四刀（agent-fleet-core/report-lane/decision-lane/templates，2026-10-23 上线）

**出片**：公开仓线 scs001/platform-image-verify，快照 3734a10（paas HEAD d5f28cc8，四刀 af988287 + lint 8e9af2a2 + 适配器白名单 fd23700c + tsc 清零 d5f28cc8）；digest `sha256:cc967258…` ccr/hkccr relay OK 04:41；platform/platform-demo/facet 三清单滚 47d13ba，pod imageID==digest 三面相等。

**出片三坎（公开仓 CI 门序列显形）**：① Biome lint 25 错（我 5 + 存量 20——私仓出片线不跑 lint 所以本地全绿；两处「故意刷新触发」钩子依赖须 biome-ignore 注记在 hook 调用行上方）；② dsh 适配器闸——platform-serving-questions-bridge.js 漏登白名单（被 lint 债掩住的存量）；③ tsc --noEmit——vite build 不查类型，舰队面 5 类型债 + 他会 Sidebar 原生选路漏传 path 真 bug。**教训：公开仓才是最全门面，出片前本地先跑 npm run lint + typecheck。**

**并行会话历史重排一枚**：fd23700c 前身 07880e0 被 CRM 归档轮的重排吞掉（reflog 无痕、dangling 无匹配）——白名单行凭 lint-dsh-adapter 本地复跑重建；共享仓提交后 grep 工作树核对生效内容。

**生产活体（aloadtree，browser 会话）**：侧栏「舰队」眼见 → 建队 201 → 建岗（wire-assistant 每小时 {{fleetContext}} 模板）201 → 物化任务 job_…kmoi24 就绪 + cockpit 卡 on_duty 1/1 → **swap wire-assistant→facet-assistant taskId 逐字不变** → 全队暂停 paused/恢复 on_duty → 成员级暂停扛过全队循环 → escalate 浏览器上下文诚实 409（无 running turn 不乱归属）→ 解散 200 物化任务随删。**余（各刀 4.x）**：真 persona 回合内 report_status 上卡/CEO 注入含下级槽值/a2a 摘要/escalate 201→批→立即执行 prompt 含裁定（需真 LLM 轮次）+ 删 persona 待补岗全链 + 模板市场上架（种子铸造）。

### §15.13 补记：四刀真轮次验收闭环 + PACK_BASELINE_MCP 运维位（2026-10-23 深夜）

**真轮次全链（aloadtree，五证据逐字）**：①电商岗真火调 report_status→驾驶舱卡见 sales_week=309（source=self）；②换防 wire→macro-analyst 后 latestReport at/slots 逐字连续；③CEO 火会话注入逐字「【舰队巡视上下文】…### 电商部 - 本周销售额（$）: 309 - 摘要: 今日大促…」；④CEO 真回合 escalate→批准（by=aloadtree）→execute-now 回合 prompt 逐字含「裁定：批准——提高。批注：批准提高，注意回报率」→state=delivered（deliveredSessionId=CEO 任务会话）；⑤a2a 岗（mission-planner）真火 latest source=derived 非自报摘要。附：删 custom preset→探针岗 vacant（reason=target object no longer exists）→swap 补岗恢复全绿；走查舰队全部解散（可逆纪律）。

**关键运维位：PACK_BASELINE_MCP=fleet**。首火教训：fleet MCP 走 extensions DB 行进不了**聚焦层 keep 集**（聚焦 persona 只留 mcp.json 键∪PACK_BASELINE_MCP∪自身引用——模型在回合里 tool_search 找不到工具即此因）；解法=deployment env PACK_BASELINE_MCP=fleet（live set env + GitOps e5acfe7/990530e 双收敛；platform-demo 清单插入曾拆裂 LLM_API_KEY secretKeyRef 块，dry-run=client 必做）。DB 行保留双轨（standard 模式亦可见）。

**顺手抓真 bug 两枚**：①归档/解散舰队成员仍占唯一岗（facet-assistant 建岗 409）→ findPostByTarget JOIN fleets state!='archived'（paas 0030e1e8+单测，待下轮出片）；②/proc env 无 pgrep 时用 for /proc/N/environ 直读。

### §15.13 再补：真余清账轮（2026-10-23 深夜二）

**驳回腿逐字闭环**：内容部真回合 escalate→驳回（by=aloadtree，note=维持原计划）→**下一自然节奏火**送达 prompt 逐字「裁定：驳回。理由：维持原计划，周五发布」→delivered（区别于批准腿的 execute-now 即时通道，两通道均活体）。

**刀4 全链上产**：种子「公司式舰队」铸造上架 `aofNf6o2LR61lPK8IVVkJw` v1（fleet 段闸生产首过；pack agents 上限 3——种子收敛 CEO/开源/投资三真数据岗，助理转引用岗）+ curation category=fleet 列表眼见；**订阅≠安装**——subscribe 只回 manifest，安装由浏览器驱动 `/api/mypacks/install`（PackDetailDialog 同路）；from-template 201（missing=[]、出生全队暂停）→确认启动→on_duty 6/7 六任务就绪；导出-重装腿：导出白名单零运行时痕迹→成包→安装→from-template→骨架+节奏逐字一致→新舰队零报数。应用中心「舰队模板」卡随 79606b0 上产眼见。

**第二轮出片 sha-79606b0/digest f776b82**（占坑修复 0030e1e8 + 应用中心卡）：三面滚完 imageID 相等；**live 回归证明 facet-assistant 建岗 409→201**。走查舰队全解散（驳回验/公司式舰队/重装验 pack 下架卸载；种子包留市场在架）。

### §15.14 发布记录：provisioner 唯一岗校验（fix-fleet-provisioner-unique-post，2026-10-23 上线）

**根因**：fleet-core D8 的 persona/cluster 全局唯一岗只钉了建岗/换防两条写路径，实例化器（第三条建岗写路径）只查目标存在性不查在岗占用——导出-重装腿在原舰队未解散时静默建出第二岗，报数归属按 preset 定位唯一岗位直接出歧义；web 无任何 from-template 调用点，不变量必须钉在 API 层。

**修法**（paas 34b1f89f）：provisioner 对 persona/cluster 目标查 `findPostByTarget`（查询自身排除 archived）+ 本批 claimed 集合（模板内重复），a2a 豁免；冲突岗降级为**空 targetId 哨兵**（岗位照建、结构保留、换防可补岗），缺位与冲突互斥（死目标非任何人的在任者）；响应新增 `conflicts`（含占用方舰队/岗位名）；读面区分两种待补岗（对象已删 vs 实例化时唯一岗冲突），哨兵不给假标签。多用户同包 pack-preset 的克隆真解（第二用户实例化同模板）仍留 v2。

**出片**：公开仓线 scs001/platform-image-verify，快照 a747769（=paas HEAD 8f9d3ffd 单提交，workflows 修剪到只剩 image.yml——app-e2e/win-smoke 零触发）；digest `sha256:dff9387e…`，relay 09:16 OK 行，skopeo ccr 验 digest 后才 bump；platform/platform-demo/facet 三清单同步 sha-a747769（GitOps 0160ffa 双端推），ArgoCD hard refresh 后三面 pod imageID==digest 相等。

**生产验收（aloadtree 真会话四证据）**：①装回种子 aofNf6o2→活舰队占坑 company-ceo→from-template **201+conflicts[ceo→占坑-唯一岗验/外占CEO]**（不是静默双岗）；②哨兵岗 cockpit 读 vacant+「no incumbent assigned — uniqueness conflict at instantiation」+targetId=""→label null+任务照常物化（job_…3lpcem）；③company-ceo 全场恰一岗（唯一岗不变量）；④解散占方→swap 补岗 200→status paused（非 vacant）+**taskId 稳定**（物化任务原地换防）。对照腿：手动在岗 persona 建岗仍 409（三写路径同源）。

**顺手两账**：①上轮「走查舰队全解散」漏了一只**活着的公司式舰队**（fleet_…jq1ayt，CEO 整点空转烧了一夜 token）——本次解散，from-template 去重命中它返回 200 属 D5 正确行为；`findFleetByTemplate` 排除 archived，解散后可重实例化。②pod 内临时探针脚本用后即删纪律照旧。

**①（种子自然 cadence）已启动**：验收舰队直接转正观察载体（骨架完整、CEO 补岗后零报数史）——确认启动 active，on_duty 6/7（内容部 passive）：CEO 整点巡视（首火 10:00 京时）/电商部 10:00/开源·投资·助理明早 09:10-09:30/萬星席周一 11:00；首个有意义的跨部门 CEO 巡视=明早 ~09:30 后。每日约 29 回合走 aloadtree cell key。观察点：注入含下级槽值、开源部 CN pod 抓 GitHub 失败应如实报「未取得」、自发 escalate、token 消耗。

**余**：③萬星侧 cockpit 投影独立 change（等 ① 自然 cadence 证据）；provisioner 唯一岗的 persona 克隆真解留 v2。

### §15.15 发布记录：官方舰队模板库四包上架（add-fleet-template-library，2026-10-23）

**四包铸造上架**（通道 A：fd-prod secret `facet-secrets.FACET_INTERNAL_TOKEN` + `x-facet-user` aloadtree/creators；配方=一次性脚本 /tmp/mint-fleet-seeds.mjs 用后即删，manifest=种子+占位符补齐+`category:"fleet"`）：

| 种子 | pack id | v | 骨架 |
|---|---|---|---|
| 投研晨会舰队 | `YMSt-hRNiNWXrlLYC8PSiA` | 1 | chief/macro/sector 自带+risk 被动引用岗（facet-assistant） |
| 内容工厂舰队 | `tkHe8IHE0BuDYYIg5LglUw` | 1 | editor/planner/writer 自带+reviewer 被动引用岗（macro-analyst，实装时缺位 vacant） |
| 客服护航舰队 | `EMGW14N8voa1b36LSuTxxw` | 1 | 恰 3 岗满编（每 4h 高频） |
| 情报站舰队 | `56opYgliV9FYAmhmsDIJOw` | 1 | chief/tech/market 自带+existing-cluster 引用岗（缺位 vacant，演示降级） |

四包上架 manifest 与仓内种子逐字语义一致（占位符补齐+category 外零差异，脚本 diff ALL MATCH）；舰队类目 5 卡眼见。**agents≤3 上限真身=lib/pack-manifest.js:40 `maxAgents: 3`**（此前只知现象）；公司种子仓内文件曾带 4 agents 与已上架包分歧——守恒测试首跑抓出，已收敛 3+助理转 existing-persona 引用岗（`{{ASSIST_PERSONA}}` 占位）对齐上架现实。

**守恒测试**：`scripts/test-fleet-templates.mjs` 扩全库（遍历 `docs/fleet-templates/*.seed.json`：parseFleetTemplate 全过+agents↔pack-preset 1:1+自带 agents≤3+每 cadence 模板带 {{fleetContext}}），改坏成环实证红且指明文件。

**活体验收（aloadtree）**：投研全链=装 200→from-template 201（missing/conflicts 双空，风控被动岗活体）→start→run-now 原生火三卡全上真数据（宏观=滞胀交易真指标/行业=白酒+1.68%茅台 600519/chief 晨会点名四矛盾跨两下级报数原文+escalated=1）→拍板项真综合（引下级报数+时间戳）→choice 批准 build_defensive→execute-now→**delivered**。三安装腿降级精确落位（reviewer vacant/满编/cluster vacant），验收后解散；投研保留观察载体（工作日 3 回合/日）。

**验收撞出真 bug 两枚**：①**归岗幽灵岗**（已本地修待出片）：`server/routes/fleets.js` 报数+escalate 两处归岗候选集遍历 `listFleets()` 不过滤 archived——§15.14 swap 进已解散舰队的 facet-assistant 幽灵岗与投研风控岗撞歧义 409（风控真回合两次报数被拒、诚实未伪装）；修=候选集跳过 archived（0030e1e8 同族）+幽灵岗单测钉住（突变验证）；**出片后生产复验风控补报数**。②**聚焦面无 delegate_task**：fleet 聚焦人格只保留 escalate/report_status，成员间委托唤醒在聚焦模式走不通（chief 诚实拒绝编造并给三路替代）——被动岗「受委托唤醒」设计依赖此口，挂 v2（方案=PACK_BASELINE_MCP 增 delegation 或人格切 standard）。另注：聚焦人格+facet-market 断连会触发 list_mcp_resources 重试循环（26+ 步烧 token），行为面观察项。

**走查事故披露**：首轮宏观晨检消息因 ?preset 只切选人器未开新会话，误注入谦面助手 10:30 会话（把谦面助手包可见性改私有的那条）并跑了一轮——报数归岗仍按 preset 正确落宏观岗；该会话属测试号自用，内容无破坏。

**无镜像出片**（内容面+测试+两行路由修复）；路由修复随下轮列车。市场五卡在架，投研舰队 active 观察。

### §15.16 发布记录：岗位级模型 + 岗位身份注入同车（add-fleet-post-model 实施落地 / wire-content-fleet 承运归档，2026-10-23）

**列车**：快照 scs001/platform-image-verify `2d941ac`（paas 基线 `3e7e9a5f`；**7325d1fc 归岗幽灵岗修 + fe8b7ccd 模板库四包未含，随下一列车**）→ GHA 绿（smoke 门：容器起、/api/config 探过才推）→ hkccr/ccr 双侧 digest `841d521d` 一致（relay 手动补单 21s）→ GitOps `499158b` 滚 platform/platform-demo/facet 三面 → ArgoCD 硬刷新自动同步，rollout 全成；pod imageID↔构建 digest↔本地 md5（fleet-model.js `63fafd54`）三向一致。

**验收（真机）**：demo 三闸活性（roster 闸吐 13 真模型名单、形状闸指名）、`GET /api/fleets/:id/cadence` 只读契约路由活（姊妹 change）、`defaultModel` 写/读/清全回环；fleets.db 三列迁移 demo+prod 双证（活 cell `1da5` 13 舰队 44 岗数据完好；空 cell 惰性开库未触属预期）；prod 启动日志干净。persona 岗 happy-path 与解析链归位的回合级证据由十套 129/129 测试套覆盖，**aloadtree 首个真实模型声明岗回合为终验点**；验收后归档，change 在途。

**功能一句话**：岗位/舰队两级模型声明（`fleet_members.model/fallback_model` + `fleets.default_model`），每个 persona 回合按 [岗位首选→岗位兜底→舰队默认→cell 启动默认] 解析链归位（与 preset 同构，不沾上一回合残留）；声明失效选型时回落并留痕（blockers+usage 记实际模型），a2a/集群岗设模型 400 明拒；驾驶舱岗位卡显示生效模型（失效回落琥珀色）。

**§15.15 补记：幽灵岗修复出片全记录（2026-10-23 下午）**：①首滚 **sha-2d99a05/digest 655e0dcb 为陈树快照事故重演**——fd-build-snapshot 对本地源路径「标签 sha 读本地 HEAD、树却从 origin clone」，当时 origin（GitHub fd-craw-private）停在 3e7e9a5f 未含修复（我的 7325d1fc 尚未推送），镜像实为 post-model 内容；**判据=风控回合读容器源码自证无 Ghost-post guard**（agent 直读部署源码诊断生产，行为面金标）；台账既有纪律「出片必核 pool tree 含新文件」本次漏用，已补核。②重出 **sha-94bb331/digest f71dc49d**（源 3ecf3a03，快照树先验 Ghost-post guard×2 再出片）三面滚完 imageID 相等。③生产复验闭环：one-shot 绑定 preset 派发 facet-assistant→report_status→**投研风控岗 risk_flags=6 上卡**（归岗唯一命中，幽灵岗不再撞）。④**第三次发现：UI 追问 cron 会话不重绑原 preset**——在「风控官（派发唤醒）」会话里追问，回合以当值 CEO 人格（company-ceo preset）跑、报数落到活体公司 CEO 岗（patrol_notes 上卡/risk_flags 进 details）——cron 会话的 UI 续聊 preset 语义待定（挂 v2；绑定 preset 的正道=one-shot 派发或原节奏火）。⑤列车撞车实录：并行会话 13:11 已快照 3e7e9a5f 并 13:4x 滚 sha-2d941ac，本列超源滚动 94bb331 承运其全部内容。**教训固化：出片三核=run target 行+快照树含新代码+pod imageID；本地提交未推 origin 前严禁依赖 fd-build-snapshot 本地路径模式**。

### §15.17 发布记录：编排三刀同车（add-fleet-turn-events / add-fleet-architect-pack / add-turn-contract，2026-10-23 深夜）

**列车**：paas 基线 `97d5d608`（九套舰队回归 100/0）→ 公开快照线 scs001/platform-image-verify `45eb6f1`（restore 提交即出片 sha；**image-publish.yml 又被快照冲掉，本次旧 ref/dangling 取不回，用 paas 仓 image.yml 原样恢复**——恢复源第三通道）→ GHA 绿 → relay 手动补单 3s OK → skopeo 硬门 digest `dd960039` → GitOps `72a8471` 双清单滚 platform/platform-demo → ArgoCD 硬刷新 rollout 全成；pod imageID=`sha-45eb6f1`。

**验收（真机,活 cell 1da519d4/13 舰 44 岗）**：①O1 双路径生产实证——delegation 唤醒（回环真派 company-invest,自派拒绝场景顺带复验）落 `delegation ok model=deepseek-v4.1-flash`（无 sourceTag 归属走 persona 扫描）;22:00 CEO cron 火落 `cron failed error="503 Service temporarily unavailable" model=poolside/laguna-xs-2.1:free`,驾驶舱 roster `failing=1` 即时可见。②**post-model 终验闭环**：模型声明岗（公司式舰队 CEO）真实回合落地声明模型 `poolside/laguna-xs-2.1:free`（§15.16 挂账清账；回合因免费档上游 503 如实失败,与归位无关）。③架构师桥活体——cell 回环 `/api/fleet-architect` 名册（memberCount/openDecisions/failing）+ turns 过滤读面全字段;turn-contract 模块 in-pod 派生与保留位拒绝实证。④空 cell 惰性开库未触新表属预期（0 舰队,下次打开自动迁移）。

**功能一句话**：O1 回合事件（三路径收口 runCronJobTurn、errorKind 六类、200/岗滚动裁剪、驾驶舱失败维度与连续失败标记、双读端点）;架构师 pack（壹座 NL 编译面五工具:draft dry-run 校验+diff+token 成本预估、apply 重校验挡漂移、create 生而全队暂停;官方种子七纪律;mcp.example.json 注册,**节点 mcp.json 需手工加 fleet-architect 条目**）;turnRequest 契约（buildTurnRequest 纯派生单一定源、peer/event/blackboard 按 O3/O4/O5 去向指名拒绝、depth 界 1）。

**待办**：①errorKind 校准首例——上游 5xx/`api_error` 现落 `other`,应归 `model_upstream`（表驱动单点改,随下一列车）;②架构师种子铸造上架 + 活体 NL 建队全链验收;③节点 mcp.json 加 fleet-architect 条目（工具面激活,桥与事件面已活）。

### §15.16 补记：post-model 三窗终验 + 上游暗道名单（2026-10-23 深夜）

**终验（aloadtree CEO 岗，节奏窗实火三连）**：21:00 声明 `glm-5.3-flash` → 上游 404 错误体**点名该模型**（归位派发铁证）；22:00 声明 `poolside/laguna-xs-2.1:free` → 503 错误体点名（再次派发实证）；23:00 声明 `liquid/lfm-2.5-2.6b:free`（探针 200）→ 回合 clean 完成、CEO 按时报数。同一代码路径三窗，机制闭环；验毕已清模恢复默认继承。**归位归因同族修（04d50a88）真库差分实证**：cell 1da5 存在 4 个 company-ceo 岗行（3 archived 幽灵+1 活），守卫后 `fleetModelFor` 唯一归活岗并解析声明模型——7 个 persona 均有幽灵重复，该修为生产刚需非理论。

**上游暗道名单（roster 在册≠在服务，零花费探针实证）**：404 暗道=`deepseek-v4-pro`/`glm-5.3-flash`/`nvidia/nemotron-3-super-120b-a12b:free`；429=`gemma-4-26b`；503=`laguna-s`。在服务=`deepseek-v4.1-flash`(默认)/`cohere/north-mini-code:free`/`dots-studio/dots-3-note-preview:free`/`liquid/lfm-2.5-2.6b:free`。**写面三闸管不住这一类**（闸对 roster 声明，不对上游真值）——声明暗道模型=回合执行期失败按设计不兜底、等下个 cadence，可见性走 missing 状态；后续增量候选：写面探针/暗道黑名单/执行失败回落。dsh-profile 的 VOLCES_MODELS 列表与探针现实有两处漂移（glm-5.3-flash 在列但 404），修列表属 LLM 路由线不属本条。另：已有其他 cell 真实采用岗位模型（spawn 日志见 `cohere/north-mini-code:free`）。

### §15.18 发布记录：编排第二列车——第一波代数 + T1 工具岗（add-fleet-orchestration / add-tool-posts，2026-10-24 凌晨）

**列车**：paas `a344669e` → 快照 `5c6adf2` 出片绿（relay 长尾一轮）→ 双清单滚 → **真机验收逮住部署阻断缺陷**：dispatch 桥 `/api/fleets/dispatch` 未进 `isInternalFleetBridge` loopback 豁免（fleet-mcp 子进程派发必撞 Authentication required；路由自身凭据=服务端归属，同 report/escalate 模型）→ 修复 `5a0ae199` 重出快照 `8d0660d`（digest `ebd800ee`，image run 绿）→ 二次硬刷新落定（ArgoCD 首刷常不拾取，§15.17 同款）→ 双面滚完。镜像仓 CI workflow 两班皆红为快照仓既有状态（image-build-check/image 双绿为出片门），非本列回归。

**验收（活 cell,全链生产实证）**：①**O3 派发闭环**——CEO(在值 persona)dispatch→投资部,persona 回合 ok、任务带 origin.fleet depth=1+initiator(聚合回投);②**handoff 接棒**——投资部回合结束自动触发「接棒·开源部」manual 任务(prompt 含上游摘要原文、链位 2/8、每跳预算 10min),回合 ok,逐跳 O1 事件成链;③**T1 工具岗**——dispatch 到 websearch::web_search(确定性一次 MCP 调用):首回目标名错(`search`)如实 failed `unknown tool`,改对后 **ok 且 model 为空**(零 LLM 生产实证);④**errorKind 校准生效**——CEO 15:01 的 429 upstream 正确归 `model_upstream`(昨日 503 曾落 other);⑤**bundled 自激活**——cell extension_configs 出现 `fleet-architect origin=bundled enabled=1`(下次 profile patch 即全 persona 可见)。公司式舰队 orchestration 验收预置=supervisor+投资部→开源部 handoff 边+搜索工具岗(直写库,验收动作)。

**缺陷实录（验收逮住即修）**：①dispatch 桥 loopback 豁免缺失（阻断级,本班修复重出）;②turnRequest source 派生顺序——origin.fleet 抢先于 initiator,派发回合被标 `manual` 应为 `delegation`（initiator 优先已修入库 `§15.18 后续`,**随下一班列车**,非阻断——事件全记、归属正确,仅 source 标签偏差）;③websearch 工具名为 `web_search` 非 `search`（验收配置错,非代码）。

**功能一句话**：orchestration 声明段（edges×constraints,图校验：无环/链深/span,成员删连带清边,mode 读时展开 supervisor=隐式全对派发许可）+ dispatch_post 工具（五护栏,delegation 车道异步送达）+ handoff 完成触发（ok/failed 均如实转述,越界留痕）+ T1 工具岗（targetKind=tool,JSON 参数,零 token 确定性调用,cron/manual 双车道,预估器 tokens=0 分流）。

### §15.19 补记：舰队架构师 pack 上架（2026-10-24 凌晨,§15.17/18 待办③清账）

**铸造上架**（§15.15 通道 A 同配方）:manifest=种子+`category:"fleet"`+v1.0.0,本地 validatePackManifest 绿 → `POST https://facet.finddatatech.cloud/api/packs`（x-facet-token + x-facet-user aloadtree/creators;**发布端点真身=facet 域 `/api/packs`,非 platform/mcp 域——两域各 401 一次才定位,记此免三犯**）→ 200 `NoBBXkvxZnJNHlCrAwWp-w` v1。舰队类目 6 卡眼见(公司+四模板+架构师)。一次性脚本与内部凭据用后即删。

**待用户侧验收**(浏览器一眼):壹座 → 设置 → 功能集 → 安装「舰队架构师」→ 与架构师人格对话建一支测试舰队(工具面已 bundled 全 persona 活,包只差纪律人格;draft/apply 桥面生产已验)。

### §15.20 发布记录：编排第三列车——NL 编边 + fanout 裁决 + event 唤醒（add-fleet-architect-edges / add-fleet-fanout / add-fleet-event-wake，2026-10-24 凌晨）

**列车**：paas `b5492c0b`（十三套 153/0）→ 快照 `f0db53d`（image 绿）→ relay OK → skopeo 硬门 digest `641470f0` → GitOps `2ad15aa` 双面滚 → ArgoCD 二刷落定（首刷不拾取，三班同款）→ pod 模块/接线 in-pod 核验（bots.js 唤醒钩子/server.js fanout 块在位）。

**验收（活 cell,全链生产实证）**：①**NL 编边桥面**——架构师桥 draft 携带 handoff+fanout(judge)+event 三类边一次过校验（orchestration 视图回显）,apply edit 落库;②**派生修正**——dispatch 唤醒回合事件 `delegation/ok`（§15.18 曾标 manual,initiator 优先修正生产生效）;③**fanout+judge 全链**——dispatch→投资部(delegation/ok)→回合结束自动起扇出波（电商部/助理部两 manual 任务,initiator=`fleet:<id>:CEO`+initiatorPreset=company-ceo）→聚合器自动注入并起 **CEO 裁决回合**（会话留档「总裁办汇总·扇出第 1 波」,真实裁决还点破波 2 未完）;第二发派发实证「波随上游回合」（每上游回合一波,非自动重入——rounds 声明语义如 design 收敛）;④event 边——代码在位+draft 校验过,**真 bot 消息 E2E 待用户侧配置 bot 后补验**（bot-relay 仅出站,无入站模拟口,如实记）。验收后公司式舰队编排恢复观察态（supervisor+投资部→开源部 handoff）。

**调试实录（记两笔）**：①首查 fanout「未起」为**假阴性**——`GET /api/delegation/tasks` 按发起会话过滤,judge 合成 initiator 的任务不在列;直查引擎存储（cell `data/cron-store/jobs.json`）见两任务 done/running,initiator/preset 全对。教训：**判断「未发生」前先质疑探针的过滤面**。②kubectl logs 无 warn ≠ 无异常（supervisor 吞 stdout 教训重演）,本轮最终靠任务存储与会话留档定案。

**功能一句话**：NL 面编边（draft 虚拟终态图校验/draft-id 换真 id/未带段不清边/种子 v1.1 上架 version=2）;fanout 边（并行波+聚合三式,judge=delegation 聚合器原样复用,波随上游回合,depth 硬界）;event 边（bot 入站唤醒,source=event 转正,每岗每小时≤30,bot 自身回合照常双回合语义）。**六边齐型**（trigger/report/dispatch/handoff/fanout/event）,SOURCES 四值,保留位仅余 peer。

### §16.1 发布记录：服务自报工具面（add-self-reported-tool-surface 组 1，2026-10-24 上线）

**背景**：逐用户凭据服务（wire-build-mcp / wire-ops-mcp / wanxing-ops-mcp / paper-trading）HTTP 层 AuthGate 强制进站 Bearer、匿名一律 401 ⟹ registry 探针与 `POST /api/refresh` 永远探不到工具面，快照停在旧值；发布门把合法新工具名判 unresolved（wire-build-mcp 15→17 实录）。兜底已退化到 Mongo 直写（2026-10-20 wanxing-ops 实录）。需求底稿：两仓 `docs/registry-tool-snapshot-longterm.md`。

**本列车交付（registry fork，worktree `feat/self-reported-tool-surface`）**：
- `apply_tool_surface()` 共享写函数（快照 tool_list/num_tools + scope 行 + 控制台广播三写合一）——探针路径改为调用它，自报路由复用同一函数，防三面漂移；写回全部**字段级 `updated_fields`**（整卡写入会抹掉并发写字段与凭据）。
- 内部自报路由 `POST /api/surface-report/servers/{path}/tool-list`：path 绑定 Bearer token（registry 只存 sha256 hash，进 `_SERVER_RESPONSE_SECRET_FIELDS` 脱敏名单）；幂等（同值上报零写入）；404/403 不可区分。
- `surface_source=probe|self_report` 条目字段：self_report 条目巡检**跳过探活与工具抓取**（消周期 401 噪音与恒红假象），健康展示改 `last_surface_report_at` 自报时间戳口径。
- 仓自持烟测 `scripts/ci-smoke.sh`：registry-entrypoint 无 `SECRET_KEY` 即 fail-fast，通用构建池 boot 门裸跑必死；dummy key + 45s 存活判定。

**上线实录（两列车，第一列车撞回一个设计前提错误）**：
1. 第一列车 `sha-ee26ae5` 构建成功但**烟测门拦推**（SECRET_KEY 缺失）→ 加 ci-smoke.sh → `sha-b7fa92e` 过门 → GitOps `11c71df` 滚版成功 → **公网验收 404**。
2. 根因：`/api/internal/` 是 nginx **硬 404 前缀**（`location ^~ /api/internal/ { return 404; }`，lua 子请求专用）——设计文档只说「新路由须在公网面自带 Bearer 校验」，没注意前缀本身不可达。第二列车把路由移到 `/api/surface-report/`，nginx 三处 server 块加显式放行 location（**不走 `auth_request /validate`**——调用者是服务不是控制台会话，应用 token 闸才是门）→ `sha-e6a2cbb` → GitOps `7d71767`。
3. 验收：公网匿名 POST 返 **401 应用层响应**（路由在位）；`/api/servers` 25 条目全 `probe`、巡检零变化；`fd-build-channel` 判路公开仓额度耗尽 → 私有池 testaction004（repo 变量 BUILD_DOCKERFILE=docker/Dockerfile.registry），构建+烟测绿。

**生产镜像**：`ccr.ccs.tencentyun.com/yizuo/mcp-registry@sha256:d6d32d4dc3acab36426cd0fda82a41767992461fbd0e97059b181e4ddcc137a0`（真 sha f3828cb1，快照 e6a2cbb，digest 引用防 IfNotPresent 吃坏缓存）。

**回滚**：GitOps 行回上一 digest `c740d37a`；`surface_source` 字段与 hash 列留存无害（旧代码不读）。

**余项**（同 change，finddata 侧）：组 2 = wire-build-mcp 试点接入自报模块（借 15→17 现网缺口做真机验收）；组 3 = 三服务回填；组 4 = 文档收口（含发布门文案改指「重启服务/查 last_surface_report」）。

### §15.21 发布记录：驾驶舱编排面板（add-cockpit-orchestration-view，2026-10-24 凌晨）

**列车**：paas `823e581b` → 快照 `17c1d06`（image 绿）→ relay OK → digest `f556c77b` → GitOps `c1f1a98` 双面滚（ArgoCD 首刷即落）。

**验收**：dist 面板在包（FleetsPage chunk 含 `fleet-orchestration` testid）；cockpit API 的 orchestration 字段自 f0db53d 在产且单测钉住（orchestration 套件 cockpit 用例）；浏览器眼见为用户侧（公司式舰队现役编排=supervisor+投资部→开源部 handoff,打开舰队详情即见面板）。五语言 i18n（orch.edge 徽章词/phrase 短语词分离）。

**功能一句话**：驾驶舱只读编排面板——模式徽章+链深/每跳预算摘要+边列表六类语义渲染（fanout 显全目标与裁决岗,event 显信号源,岗位 ref→名,implicit 标记）;未声明不渲染。

**编排路线全景收束**：机制面（六边/四源/三层成员/NL 编译面,O1-O5）+ 产品面（驾驶舱边视图）均上产；余两件用户侧活——装架构师包眼见、真 bot 配置补 event E2E。

### §15.21 补记：浏览器真机眼见验收（2026-10-24 凌晨,aloadtree 生产账号)

**浏览器全链眼见**(browser-use IAB,真登录态):①登录 SSO 直达(会话在);②**侧栏会话痕迹四连**——「扇出·电商部」「扇出·助理部」「接棒·开源部」「公司式舰队·CEO(总裁办汇总)」全部上列表(§15.20 验收的会话级留档);③**编排面板眼见+截图存证**——公司式舰队详情:编排区呈现「主管模式/链深上限:8/每跳预算:10min」+接棒边「投资部→开源部·完成接棒」+隐式派发全对(56 条,每条带「隐式」标),同屏 health 徽章「失败: 2」「拍板等你 7 件」;④页面上下文直查 cockpit API 200,orchestration 完整回传(mode/edges×57/implicit)。

**两笔 UX 发现(记档不改)**:①**supervisor 隐式边全量展开太长**(8 岗=56 行,面板被淹没)——建议隐式边聚合为一行「supervisor:全员互可派发(56 对)」+显式边逐行,下一班顺手改;②**舰队卡点击切换详情不稳定**(三种定位器屡超时,坐标点击成功;情报站详情曾自动展开)——疑似卡组件事件/焦点问题,复现条件待查,不影响数据正确性(cockpit API 直查正常)。

### §15.22 发布记录：词汇双刀同车——员工框架改名 + 运营者框架 v2（rename-fleet-user-vocabulary，2026-10-24）

**列车**：paas `a360805f`（含未上产的过渡改名 76fdc926——用户单跳直达终词）→ 快照 `98f8e3a`（image 绿）→ relay OK → digest `6b2241c0` → GitOps `2b35ae8` 双面滚（二刷落定）。

**验收（浏览器真机，活用户会话）**：术语卡展开后 **17 词全见**——旧词列（报数/拍板/失联/待补/被动/换防/节奏/日报流/接棒）×现行词列（产出/审批/超时未报/空缺/待命/换人/定时运行/流转）双语对照 + 截图存证;结构视图 collapsible、产出/换人按钮、hints 悬浮全在;v2 词在 index locale chunk 在位。**意外收获：浏览器会话登的是另一用户 cell（3fdc7b8e），内有一支 active 的「柏讯内容舰队」——fd-wire 线已真实在生产使用舰队**（aloadtree cell 13 舰健在：2 active + 11 archived,零丢失;「列表只剩一舰」为不同用户视角,非数据事故）。

**功能一句话**：五语言运营者框架词汇（定时运行/产出×交付/流转）+ 术语卡（旧×现行九行对照桥）+ 隐式派发边聚合 56→1 行 + 组织树降级「结构视图」（collapsible,功能不删）。词汇三段（原词→未露面过渡→终词）收官,底账 §十五+补记。

### §16.2 发布记录：wire-build-mcp 试点接入自报（add-self-reported-tool-surface 组 2，2026-10-24 上线，三滚两 bug）

**交付（wire-build-mcp 仓，canonical gitee main）**：
- `wire_build_mcp/surface_report.py` 共用自报模块（组 3 三服务直接复用）：运行时枚举工具名 + `surface_version`（tool-surface.json sha256 前 12 位）→ POST `/api/surface-report/servers/<path>/tool-list`；有界重试 15s/1m/5m/30m×4 成功即停；失败不阻塞启动；无配置静默跳过（=现状）。`tool-surface.json` 进 wheel package-data。
- `/health` 增 `last_surface_report: ok|failed|not_configured`（not_configured 回退基线 body——无配置零行为变化）。
- 上牌：registry pod 内 exec（用户显式授权）跑 `issue_surface_token` 铸 path 绑定 token（hash+surface_source 字段级写条目）→ fd-prod Secret `wire-build-surface`（三键：token/entry-path/internal-url）→ 部署 envFrom 注入。

**三滚实录（教训都在里面）**：
1. `sha-e83fff0`（源 83a0a6b）滚版 → **新 pod Running 不 Ready、ProgressDeadlineExceeded**。日志抓到根因：`create_server()` 在 ASGI **构建期**调 `asyncio.create_task`——uvicorn 尚未起 loop，`no running event loop` 直接把服务打死。本地 59 测试全绿没抓到（pytest 循环常在）——**ASGI 生命周期类 bug 只有真部署暴露**。修：`ensure_started()` 首请求触发 + 一次性封口（未配置置 False）。
2. `sha-16475b4`（源 4c8c6dc）滚版成功 → 自报**启动失败**、`/health` 显 failed（恰是「registry 缩容演练」验收项的现实版：服务照常起、失败可见）→ **手动重报同参数 200 成功**，公网 `/api/servers` 回读 **tool_list=17、wire_artifact_dashboard_create / wire_artifact_doc_create 双双在册**——§16.1 挂的 15→17 快照缺口就此闭合，发布门 unresolved 判据消除。
3. 诊断期一次 `probe_test` 假工具误写（diag 调用走了真写面）→ 立即用真 17 工具清单手报覆盖修复；教训：**诊断性调用别走生产写路径**，diag 端点或 dry-run 旗属于组 4 补强。

**挂账（进组 4）**：① 启动自报 5 连击全败而手报同参成功——疑启动窗口内 DNS/网络就绪序，未定位；② `surface_source` 公网读 None——疑 `/api/servers` 响应投影未带新字段（写库在位，`update_server` 字段级写入）；③ pack 发布被 10/时/作者限流，窗后重发即终验发布门；④ `probe_test` 教训落地（diag 通道或 dry-run）。

**生产镜像**：`finddata-business/wire-build-mcp:sha-16475b4`（GitOps 23790ad）；Secret `wire-build-surface`（fd-prod）。**回滚**：滚回 sha-d596f84 + 删 envFrom（Secret 留存无害；registry 条目 hash/surface_source 留存无害，旧代码不读）。

### §15.22 补记：边图 v2 组件 + event 真-bot E2E(2026-10-24 上午)

**边图(add-cockpit-edge-graph,6b2250dd)**:FleetGraph 纯 SVG 组件(分层有向图/类型色贝塞尔边+箭头图例/定时与事件虚拟源节点/隐式许可不画边只显聚合条/回边曲线不参与分层),编排区图主位+文字列表保留;五语言。typecheck+回归 38/0,**浏览器眼见随下班车镜像**。

**event 真-bot E2E(6d576b90)**:真 Express+真 bots 模块+**真 webhook HTTP 面**——飞书形状入站消息全链:verify→parse→守卫→真 triggerFleetEventWake→引擎 manual 任务(origin.event+origin.fleet 双段、roster 映射、发送者入 brief)→runCronJobTurn 缝→**O1 落库 source=event**;无边缘 bot 消息零扰钉死(test-bots-event-wake 2/2)。**生产侧 E2E 受阻如实记**:bot 创建需 Logto 组 platform-admin,当前会话用户无此组——不擅改他人权限;机制链已由真-HTTP 面钉死,生产补验待管理员账号侧一次配置(配方:feishu 哑出站凭据即可,入站验签项可选)。另:浏览器侧验收舰队残留已归档清理。

### §15.23 发布记录：驾驶舱编排图（add-cockpit-edge-graph，2026-10-24 上午）

**列车**：paas `8165ef95` → 快照 `53e9cdc`（image 绿）→ relay OK → digest `baeb9f2c` → GitOps `96c34dc` 双面滚（二刷落定）。

**验收（浏览器真机）**：柏讯内容舰队（活用户 cell）声明一条 event 边后，编排区**分层有向图眼见**——事件源虚拟节点 bot:wire-ops → 巡线岗，类型色边+图例，未连岗照常为孤立节点；截图存证。**验收后已还原**（该舰队 orchestration 置 null——是别人生产在用的舰队，验收边不遗留）。深链 `/fleets/<id>` 直选舰队可用（列表点击切换的老问题绕开）。

### §15.23 补记：admin 账号 event 生产 E2E 闭环 + 网关路由缺陷入库（2026-10-24 上午）

**用户交付 admin 凭据后闭环**（aloadtree=Super Admin 侧 cell）：建 feishu bot（哑出站凭据配方验证可用）→ 建验收舰队+事件边 → **真 webhook 消息唤醒成功**——引擎任务 origin.event 双段齐、preset=intel-chief、回合经真实模型 **deepseek-v4.1-flash** 跑完，**O1 事件行 source=event/status=ok/model 落库**。两支 E2E 舰队与两只 bot 验后清理（归档/删除）。

**入库真缺陷（网关 bot 路由，待修）**：`gateway/bot-webhooks.js` 的 `ownerEmailOf` 用 `chat_sessions.owner LIMIT 1` 任取属主——**混合登录史的 cell**（该 cell 有 qq 邮箱旧会话+gmail 新会话）会把 webhook 路由到错误属主的 cell → 403。复现：aloadtree cell 建 bot 后公网 webhook 必 403；直连属主 cell 回环口 200。**修法方向**：bot 行落库时记录 owner email（创建者），resolve 优先按 bot 行属主；或 ownerEmailOf 取 chat_sessions 按 created_at DESC。E2E 验收以「直连属主 cell 回环 HTTP」完成（同一 HTTP 面，仅少一跳网关），公网路径待该缺陷修复后复验。

### §15.24 发布记录：网关 bot 路由属主修复（fix-gateway-bot-owner，2026-10-24 上午）

**列车**：paas `ff36d603` → 快照 `9403937`（image 绿）→ relay OK → digest `287cf7ee` → GitOps `7f5fea8` 双面滚（二刷落定）。

**修复**：`bots.owner_email` 列（迁移 101）+ 创建面写创建者邮箱 + 网关 resolve 行属主优先/存量会话推断回退。测试：gateway resolve 三态单测（行属主优先/存量回退/两无 404）+ 建号行值断言；回归 29/0。

**公网复验（缺陷闭环）**：admin 会话重建 bot+验收舰队+事件边（过程中两笔自纠：fleet 响应形状 fleet.id 取法、同名残留舰队排序）→ **公网 webhook POST（EdgeOne 全链）→ 200 → 网关路由到正确属主 cell → 引擎任务建（origin.event 齐）**——缺陷修复的判定性证据（修复前同路径必 403）。回合完成状态：模型回合 running 中（共享 runtime 队列排队，非路由问题;O1 行随完成落库,机制已由 harness+直连 cell 双路钉死）。复验残留清理随记录执行。

### §15.25 发布记录：产品线凭据无人值守续期（add-line-credential-renewal，2026-10-24 晚）

**列车**：paas `2b8cc9a9` → 快照 `f8f1505`（image run 40065765778 绿 3m59s）→ relay OK 13:26:34 → digest `sha256:e1e6daa1` 双等 → GitOps `d6767a1` 双清单滚（platform/platform-demo）→ ArgoCD 硬刷新 Synced Healthy，双 pod imageID==digest 三核过；pod `[db] applied migration v102` 实证。

**交付**：①铸币流 offline_access 落 refresh_token（迁移 102 `user_line_credentials.refresh_token`，投影 SELECT 不含新列）；②服务端续期模块 `server/line-token-renewal.js`（回合前 `runCronJobTurn` 收口 + 10min 巡检双触发、`Map<email|line>` 单飞、rotation 新值与新 ID token 同行原子落库、invalid_grant→stale 不清行）；③401 钩子 refresh-first（有链标 stale/无链保持清除旧 UX，`dsh-events.js` refresh-first 三分支）；④P2 交付=`dshUpdateMcp` Authorization diff→restart（忙时 250ms poller 回合边界排空，无人值守链路零 HMR 信任；纯 server 增删维持 HMR）。spike（真机 admin 会话）三问全绿：refresh_token 发放 ✓/rotation 宽松开启（旧值宽限窗口内重放仍 200）✓/不透明令牌+rotation 重锚定=持续刷新即续命 ✓；首连 consent_required 由既有 interactive 重试免屏吸收。测试：line-credentials 17/17 + line-token-renewal 8/8（新）+ fast e2e 537/0 + validate 绿。

**快照配方备忘**：make-public-snapshot 产物仍带 7 workflow 且无 image-publish.yml（scrubber 不修剪 .github 的老坑再现）——从快照仓 main（9403937）`gh api contents` 取回 image-publish.yml、修剪到只剩它，快照目录 `git init -b main` + 强推。fd-build-snapshot 直推被私有→公开泄露防护拒绝（该工具走 build-pool 私有池线；公开线仍走 make-public-snapshot）。**验收前置已完成（2026-10-24 05:43Z）**：playwright 走 mint 往返重连两线（与点「连接」等价的同一 URL），生产行 `hasRefresh=1`/43 字符不透明 rotator/stale=0/exp 全新；pod 日志 5→6→7 servers 实证 wire-ops/lex-ops 回归 patch——「未接入」的过期省略机理在生产反转（platform pod 未重启）；7 天观测（6.3，fleet_1792786329045_jchvsd）**自 2026-10-24 起算**；回报已落 wire 仓 `reports/2026-10-24-paas-line-credential-renewal-closure.md`（只落文件未提交，wire 仓在另一会话手中）。`test-wire-tool-risk` 快照漂移（wire 侧 `wire_artifact_*` 新工具）随本列车入库为已知存量，修复=`scripts/refresh-wire-tool-surface.mjs`。

### §15.26 发布记录：谦面双案上产（polish-facet-usability + add-facet-copilot，2026-10-24 深夜）

**列车**：paas `814b5ecf`（打磨 11/13）+ `a954a003`（副驾 6/9）+ `205d7369`（lint 修）——并行会话凭据续期列车快照 `f8f1505` 已含全部三提交（merge-base 实证），镜像免重出；relay OK 13:26:34 → digest `sha256:e1e6daa1`（skopeo 带 creds 实证）→ GitOps `a741089` facet.yaml 滚 `sha-f8f1505`（双推 gitee+github）→ ArgoCD 硬刷新 Synced → Recreate 滚动完成，pod imageID==digest 双向实证；in-pod 双标记：壳面新 bundle `/app/facet/web/dist/assets/index-B_PAoOUz.js` 含 pathGraph、Store 面 `copilot_pack` 在 `CopilotDock-BpIzDFps.js`（**备忘：壳面 SPA 真身在 `/app/facet/web/dist`，`/app/web/dist` 是 Store 面——in-pod 取证别再指错目录**）。

**真机验收（生产，aloadtree 会话）**：壳面五视图（intro/packs/详情弹窗/mine/curate）浅+暗全过、移动宽 390（packs+intro 纵向堆叠正常）、英文键化（mine/curate 全键化零混排）、RM 灭动效线上 CSS 实证（`prefers-reduced-motion:reduce` 全局 0.01ms）。副驾全链：`/agents?tab=market` 路由推导 iframe src=`/chat?embed=copilot&board=facet&preset=facet-assistant`；装前琥珀降级条 → pack v3 安装 → 自动聚焦（聚焦预设: 谦面助手）+ 上下文条「正在看: facet」；真机四问全过——概念（pack=技能+角色确定版本快照、订阅≠安装）/推荐（真调 facet_market_pack_browse、未上牌与卡片覆盖诚实告缺）/权限解释（ask_user_question 问询卡 + 403/404/清单三分类 + 真读包 mfaIAXHRVFQJaXPXyiAzKQ v4 + 只读边界声明）/安装引导（分步 CLI + agent 角色不落位边界 + 真 pack id）。pack v3 狗粮发布：真校验器对拍绿 → 代理通道 `publish_pack.py` 成功（qCEIutJzQd49jnDtV4qeqw version 3，六技能含四问向导面）。

**归档**：两 change tasks 全勾（polish 13/13、copilot 9/9），`openspec archive` 双双落地（2026-10-24-polish-facet-usability / 2026-10-24-add-facet-copilot），specs 全量 178/0。

### §16.3 补记：自报闭环兑现 + 发布门零人工实证（2026-10-24）

§16.2 挂账③销账：限流窗过后重发「柏讯 · 产物构建」→ **发布门零人工通过**（工具声明门读 registry 快照 17 工具，`wire_artifact_dashboard_create` / `wire_artifact_doc_create` 在册，不再 unresolved）→ pack `AjFHQ9tjiJp5GTYmBC2y8g` v1 上架，匿名市场可见（总数 70）。**「改代码→出片→滚版→快照自动对齐→发布过门」全链首次无人工介入跑通**——§16.1 立项要交付的那个状态。

配套：发布限流对 admin 组豁免已落地 paas `90fc7fe`（`isAdmin` 短路 + 三态钉测三连绿；内部维护者发官方目录不再骑 10/时公共配额）——随下一班 paas 列车生效，生效前现网限流仍按 10/时（本轮重发等窗通过）。
