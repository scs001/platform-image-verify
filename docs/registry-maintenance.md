# mcp-gateway-registry 维护文档（谦面组件）

> 归属：**谦面（facet）**的自有组件（paas ADR-0015「registry 是谦面组件而非外部依赖」）。
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
| registry-1 | `public.ecr.aws/p3v1o3c6/registry:1.30.0` | **上游预构建** | 控制台 SPA + `/api/*` 路由（服务注册/目录/审计面） |
| auth-server-1 | `mcp-auth-server:wire-20261005` | **本地 fork 构建**（`docker/Dockerfile.auth`） | `/validate` 鉴权、自签 JWT、Logto IAM、egress PAT 注入、wire 双 patch |
| mcpgw-server-1 | `public.ecr.aws/p3v1o3c6/mcpgw:latest` | 上游预构建 | nginx 转发 hop（`/mcp-proxy/{server}`） |
| mcp-mongodb / mcp-openbao | — | 官方镜像 | 审计流（`audit_events`，逐工具调用记录）/ 密钥 |

- **流量链**：公网 443（雷池 WAF safeline-tengine）→ 宿主 Caddy（:8080 每域一块）→ 各后端；mcp 域经 auth-server 的 mcp-proxy hop 进各 MCP server
- **注册的 server（6）**：fd-open-data-mcp(62 工具)/fd-daas-mcp(161)/**fd-find-data-business-mcp(24)**/fd-cn-report(44)/law-bench(52)/AI Registry tools

## 2. 消费方（谁离不开它）

1. **壹座 MCP 市场**：paas `registry-bridge.js` 经 `MARKET_REGISTRY_URL+TOKEN` 拉全局快照（TTL 300s）→ extension-store / agent catalog
2. **pack deploy / agent-runner**：部署台账与取活（萬星运行面）
3. **萬星门面**：A2A 对外服务的内部侧依赖
4. **柏讯 wire 门面**（新增，wire-platform-v1）：`wire.finddatatech.cloud/mcp` 反代 registry 的 business-mcp 条目；audit 流=按行计量的数据源（`rows_returned`，2026-10-05 起 business-mcp 每响应带戳）

## 3. fork 谱系现状（2026-10-05 清理后）

```
gitee main（=部署谱系，权威）
  01a25cb  10-03 Logto groups/scope 重映射补丁（曾只在 cheap-1 本地，已推回）
  80babe54 wire patch ①：per-user 长命 key（wgk-）
  d7c9f4b0 wire patch ②：转发前 sub2api 额度预检
  ef16fbeb ①+② 接线（惰性默认）
  f1d8caf  测试适配到 main 裁剪谱系
logto-support（旧 Logto 集成线，已被 main 方案取代——勿再发展，仅存档）
```

- cheap-1 `/opt/mcp-gateway-registry` = main 检出 + **未提交的本地部署定制**（compose env、nginx conf——这是常态，升级时 `git stash → pull → stash pop`）
- main 是**裁剪快照**：`registry/secrets/` 包被删、`registry.main` 不可 import、tests 仅 5 文件——在 main 上跑完整 app 前需回补（追平上游时一并处理）

## 4. wire 双 patch（为什么、是什么）

**为什么自己造**：上游（截至 2026-10-04 的 1.32.0）没有「用户自铸、长命、可吊销的入站 API key」。最接近的 1.28.0 `MCP_TOKEN_*_TTL_HOURS` 是有寿上限 JWT（无吊销、scope 铸造时快照），不满足 B2B 客户机器客户端需要（token 过期=全线 401 误报的头号来源，萬星线已实证）。

| patch | 文件 | 功能 | 部署状态 |
|---|---|---|---|
| ① per-user 长命 key | `registry/api/patch_key_routes.py` + `registry/services/patch_key_service.py` + `registry/schemas/patch_key.py` + auth_server 校验路径 | `wgk-` 前缀 256-bit key，sha256 哈希存 Mongo `patch_keys`；`POST/GET/DELETE /api/patch-keys` 自助铸/列/吊销；无自动过期；吊销下次调用即 401；scope 每次现算（改组映射对存量 key 即时生效）；明文不落日志 | **校验半边已部署**（auth-server:wire-20261005，惰性——零 key 时与旧行为逐字节一致）；**铸造半边未部署**（跑在 registry-1，见 §5） |
| ② 额度预检 | `auth_server/preflight_quota.py` | mcp-proxy 转发前查 sub2api：充足放行/不足 402/计费面不可达 strict 503 fail-closed（`PREFLIGHT_MODE=postpaid` 降级放行）；调用者→sub2api 账户映射 `SUB2API_CALLER_MAP`；30s 结果缓存 | **已部署未开启**（`PREFLIGHT_ENABLED=false`，灰度开关） |

开关/配置见 patch 头注与 `paas/docs/registry-fork-patches/README.md` 登记条目。

## 5. 债：registry-1 容器没带我们的代码

- registry-1 跑**上游 1.30.0 预构建镜像**；fork 基线是 v1.29.0+96 → 用 fork 重建该容器=生产降级，已明确不做
- 后果：patch ① 的**铸造 API 不在生产**→ 客户 wgk-key 通道无法激活（auth-server 已认识 wgk-，但无处铸造）
- 受阻的下游：wire-platform-v1 仅剩两项收口——3.2 尾巴（wire 入口最小 scope，需客户 key）+ 4.4（预检 402 开启联调）

**计划（建议作为独立 change，在 paas 立项）**：
1. fork 追平上游 **1.32.0**（2026-10-04 发布：generic gateway、backend identity、tool-level security、forward-proxy egress——1.30→1.32 变化大，追平时评估 Logto 集成与裁剪面的回归）
2. 重放 wire 双 patch（cherry-pick，冲突预期在 auth_server/server.py）
3. 重建 registry 容器镜像（fork `Dockerfile`），与 auth-server 同法灰度换镜像
4. 开 `PATCH_KEY_AUTH_ENABLED` 铸造面 + 配 `SUB2API_CALLER_MAP` → 开 `PREFLIGHT_ENABLED` 灰度
5. 回收：wire-platform-v1 的 3.2/4.4 勾选 → 该 change 可归档

## 6. 运维速查

- **版本**：registry 1.30.0（控制台横幅提示 1.32.0 可用）；auth-server=fork `wire-20261005`
- **回滚**：compose 里 auth-server 镜像行换回 `mcp-auth-server:logto`（备份 `docker-compose.prebuilt.yml.bak-wire-img`）；`docker compose -f docker-compose.prebuilt.yml -p mcp-gateway-registry up --no-deps --no-build -d auth-server`（**必须带 `--no-deps --no-build`**，否则 compose 会试图拉 alpine/python 基础镜像超时）
- **构建 auth-server**：cheap-1 上 `cd /opt/mcp-gateway-registry && docker build -f docker/Dockerfile.auth -t mcp-auth-server:<tag> .`
- **令牌**：控制台「Get JWT Token」= 自签 JWT，`MCP_TOKEN_MAX_TTL_HOURS=168` 硬上限；**过期=四个 server 全 401 的头号误报源**（先查 token 年龄）；只读诊断可在 cheap-1 用 `.env` 的 SECRET_KEY 现场签 10 分钟 token
- **鉴权矩阵**：`/api/servers` 吃 Bearer JWT；`/api/tools/*`、`POST /api/servers/register|remove`、`PATCH /api/servers/{path}` 要控制台会话 cookie + `X-CSRF-Token`（`GET /api/auth/csrf-token` 取）；**PATCH /api/servers/{path} 是 JSON Merge Patch，改描述等单字段的安全通道**
- **审计**：`mcp-mongodb` 的 `audit_events`（MCPServerAccessRecord：identity/server/tool/response/IP）——柏讯计量的数据源
- **已知问题（2026-10-05）**：公网 `/fd-open-data-mcp` 条目路由坏（405 + upstream `chengsi.mesh...:30899` mesh 502 + unhealthy）——开放 open-data 入口自身故障，待修；chengsi 权威 pod 会话撞顶已 restart（复发需查 reaping 与网关健康探测漏会话）
- **Jenkins 旁路**：cheap-3 Jenkins 若构建相关镜像 401，查 `/var/jenkins_home/.docker/config.json`（uid 1000、无 passwd 条目；hkccr+Harbor 双 auth 需以 root config 拷入）

## 7. 维护归属（为什么在 paas）

- ADR-0015 定性：谦面的核心能力（MCP 目录、运行时分发）归屋谦面——**管理面、UI、补丁面在 paas 维护**
- patch 台账（`paas/docs/registry-fork-patches/`）+ 本文档随 paas 仓走；fork 源码在 gitee 独立仓（软件不重写，继续 OSS+fork 补丁模式）
- 萬星：不改其「运行面从 registry 取活」关系；萬星门面对 registry 的依赖不变
- 柏讯：只经 env 可重指的 HTTP 契约消费（`REGISTRY_URL` 等），registry 的任何变更对 wire 是外部依赖版本变化
