# MCP Registry 上架指南（谦面公开 server → 官方 Registry）

> 面向：运维/发布执行者。本文讲**怎么把谦面的公开 MCP server 挂到官方 MCP Registry**，
> 以及为什么只有一条发布路径。
> 相关文档：[marketplace-landscape.md](marketplace-landscape.md)（全景调研与事实核对表）、
> [universal-keyless-mcp-auth.md](universal-keyless-mcp-auth.md)（免键车道）、
> [client-matrix.md](client-matrix.md)（六客户端能力矩阵）。
> Change：`openspec/changes/add-marketplace-projection-fanout`。

## 1. 这条通道是什么

官方 MCP Registry（`registry.modelcontextprotocol.io`）是社区驱动的 MCP server 目录，
**只托管元数据、不托管产物**，免费公开。用户在主流客户端里搜得到、加得上，就是我们想要的
**零摩擦发现入口**；真要 7×24 常驻就跑萬星。

我们的做法是**再挂一个投影头**，不加第二套规则：

```
registry-bridge 快照（enabled server）
   ↓  facet/mcp-catalog.js  visibleTo(entry, null)   ← 唯一可见性规则
公开 server（groups = []）
   ↓  facet/mcp-registry-json.js  projectServerJson
GET /api/mcp-registry.json   →   { servers: [server.json…] }
   ↓  scripts/publish-mcp-registry.mjs
<out>/<ns>__<server>/server.json
   ↓  mcp-publisher publish（GitHub Actions OIDC）
registry.modelcontextprotocol.io
```

## 2. 端点（facet 侧，已实现）

| 路由 | 形态 | 缓存 |
|---|---|---|
| `GET /api/mcp-registry.json` | `{ "servers": [ … ] }` 全集 | `public, max-age=3600` |
| `GET /api/mcp-registry/<server>.json` | 单条；不可投影/不可见 → 404（探测不给信息） | 同上 |

拒写时两侧都答 **503 + `code: PROJECT_REJECTED`**（响亮失败，不是静默部分产出）。

## 3. `server.json` 形状与逐字段来源

schema：**`2025-12-11`**（`$schema` 常量集中在 `facet/mcp-registry-json.js` 的 `SERVER_JSON_SCHEMA`，
schema 一变只改这一处）。

| 字段 | 来源 | 缺失时 |
|---|---|---|
| `$schema` | 常量 | — |
| `name` | `io.github.FindDataTechnology/<entry.name>` | 无 name → 跳过 |
| `description` | `entry.description` + 尾部漏斗文案 | 空 → **跳过该条** |
| `version` | **无来源 → 固定 `0.0.1` 占位** | — |
| `remotes[0].type` | 固定 `streamable-http` | — |
| `remotes[0].url` | `entry.configTemplate.url` | 空 → 跳过该条 |
| `remotes[0].headers` | **一律省略** | — |
| `title` | `entry.displayName`（与 name 不同时） | 省略 |
| `repository` / `websiteUrl` | **省略**（server 条目无 `repositoryUrl`，那是 skill 才有的） | — |

### `version` 为什么是 `0.0.1`

`registry-bridge.js` 的 `mapServer` **不产出任何版本语义**，而官方 schema 必填 `version`。
三个选项里我们选第三个：

1. 伪造 `1.0.0` → 假装有版本管理，升级时说不清；
2. 挪用 `packs.db` 的 pack 版本 → 那是**功能集**的版本，不是 server 的；
3. **固定 `0.0.1` 占位 + 文档写明无版本语义** ← 当前的诚实做法。

真正的语义化版本要等 registry 侧（或我们的 bridge）有 server 版本概念，届时改这一处常量即可。

### 为什么 `remotes[].headers` 整块不写

`configTemplate.headers` 里是字面量占位符 `Authorization: "Bearer <your_token>"`——
**不是真凭据**，`CREDENTIAL_RE` 也不会命中它。但仍然一律不写：免键端点的鉴权走
OAuth discovery，静态 header 塞进去只会让没有凭据的客户端**装成坏的**。

## 4. 认证与 namespace —— 只有一条正路

| 方式 | 拿到的 namespace | 结论 |
|---|---|---|
| `mcp-publisher login github`（设备流） | **仅个人** `io.github.<你的用户名>/*` | ❌ **不能用**（见下） |
| **GitHub Actions OIDC** | **组织** `io.github.<org>/*` | ✅ **唯一免费正路** |
| `login github --token <PAT>`（Owner + `read:org`） | 组织 | 备选，需造长期 PAT |
| `login dns` / `login http` | 自有域名 `cloud.finddatatech/*` | 后续品牌升级（§7） |

**硬约束（官方 Warning + registry issue #1468）**：交互式 `login github` 走 GitHub App token，
**读不到组织成员关系**，registry 只会授予个人 namespace。所以本地手工登录**发不到**
`io.github.FindDataTechnology/*`——它不会报错，只会静默发到**另一个 namespace**，
这是最坏的失败形态。

→ 因此 CI 化不是省事选项，是**组织 namespace 的唯一免费正路**。

## 5. 上架流程

### 5.1 一次性准备（人工，每个执行者一次）

1. 执行者账号必须是 **`FindDataTechnology` 组织 Owner**（OIDC 按组织角色授权，不按名字）；
2. GitHub 仓 Settings → Environments 建 `mcp-registry` 环境（workflow 已引用，可加审批门）；
3. 确认 `facet` 服务可匿名访问 `/api/mcp-registry.json`。

### 5.2 dry-run（先验，不写也不发）

```bash
node scripts/publish-mcp-registry.mjs --facet-url https://facet.finddatatech.cloud --dry-run
```

输出逐个 server 的目标 URL + 整批校验结论。workflow 的 `dry-run` job 每次跑这条
（含每周一定时），**投影回归会在 CI 变红，而不是让发布列表悄悄变陈旧**。

### 5.3 发布

```bash
gh workflow run mcp-registry-publish -f confirm=publish \
  -f facet_url=https://facet.finddatatech.cloud
```

workflow：`dry-run` → `publish`（`permissions: id-token: write` → `mcp-publisher login github-oidc`
→ 逐 server `mcp-publisher publish`）。首次发布即认领组织 namespace，其后是更新。

### 5.4 验证

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.FindDataTechnology" | head -c 800
```

> **当前状态（2026-10-31 上产）**：投影路由已随镜像 `sha-e8ab24c`（digest `5bdcab7b`）
> 滚到 fd-prod/facet，`GET https://facet.finddatatech.cloud/api/mcp-registry.json` 实测 **200**。
> 首轮返回 21 条，其中 7 条端点为集群内网（见 §6「端点公网可达」），已加闸丢弃后重出。
> `mcp-publisher publish` 本身仍未执行——它需要组织 Owner 的 GitHub OIDC，
> 是运营窗动作（`gh workflow run mcp-registry-publish -f confirm=publish`）。

## 6. 发布前核对门（每次发布都要过）

| 门 | 判据 | 由谁保证 |
|---|---|---|
| 发布源是公开投影 | 只消费 `/api/mcp-registry.json`（groups=[] 的 server），不读私有源码仓 | 脚本只接受 facet URL |
| 零凭据形状 | 整份序列化产出跑 `CREDENTIAL_RE`，命中即整批 `PROJECT_REJECTED` | `facet/mcp-registry-json.js` |
| 无 headers 块 | `remotes[].headers` 恒缺席；脚本二次校验 | 投影器 + 脚本 `validateDoc` |
| **端点公网可达** | `remotes[].url` 必须 https 且非内网（`mesh.finddata.cn` / `cheapN` / RFC1918 / loopback / `.local` / `.internal`） | 投影器 `isPubliclyReachable`（运行时丢弃该条）+ 脚本 `validateDoc` 二次拒（整批不发布） |
| 形状合法 | 必填 `name`/`description`/`version` + `remotes[]`；name 反向 DNS 恰好一个 `/` | 脚本 `validateDoc`（整批，不部分发布） |
| last-good | 暂存目录构建 → 全过才原子替换；失败保留上一份 | 照抄 `export-marketplace-repo.mjs` |

### 为什么「端点公网可达」是硬门（2026-10-31 上产实测）

投影首次上产时暴露：registry 里有 **7 个 server 的 `configTemplate.url` 是集群内网地址**
（`http://cheap6.mesh.finddata.cn:31893/mcp` 一类）。直接投出去有两条后果，任一都不可接受：

1. **对陌生人是一条死链**——公共 Registry 的读者在公网上解析不到 `.mesh.finddata.cn`，
   也到不了 `cheapN` 节点端口；
2. **永久泄漏内网拓扑**——Registry 是公开目录，收录后主机名与端口布局就留在那儿了，
   和「公开即不可撤回」叠加。

所以这类条目**不投影**（运行时 `isPubliclyReachable()` 返回 false → 该条跳过并记原因，
其余照出），发布脚本再拒一次（整批不发布）。修法不是在投影层"改写成公网域名"——
那会凭空造出一个我们没验证过的地址；正确修法是把该 server 的注册地址改成公网网关
（`https://mcp.finddatatech.cloud/<server>/mcp`），这是 registry 侧的运营动作。

## 7. 后续品牌升级路径：`cloud.finddatatech/*`

域名验证命名可以让 server 叫 `cloud.finddatatech/<server>`，比 GitHub 组织名更像品牌，
但要多一次性的 DNS（或 HTTP）证明。**本变更不实现，只记录路径**：

```bash
mcp-publisher login dns --domain finddatatech.cloud --private-key key.pem
# apex 加 TXT（注意：落在 apex，不是 selector）：
#   finddatatech.cloud. IN TXT "v=MCPv1; k=ed25519; p=<PUBLIC_KEY>"
```

三个实操坑（已核）：TXT 必须在 **apex**；Ed25519 需 **OpenSSL 3**（macOS 自带 LibreSSL 会失败，
换 ECDSA P-384 可绕）；轮换必须先删旧 TXT 再发新的。

## 8. 三条诚实边界

1. **官方 Registry 仍在冻结/预览期**（v0.1 API freeze，v1 未 GA）。我们按 `2025-12-11` 实现，
   官方可能 breaking change 甚至数据重置——所以 `$schema` 与字段映射集中在一处，变动时一处改。
2. **公开即不可撤回**。一旦被 registry 收录、被客户端缓存/安装，改靠 unlist 与通知，
   **用户已安装的副本收不回**。发布前那几个核对门就是为这一刻准备的。
3. **投影不反映写状态**。投影只读快照；registry 侧停用/改可见性在**下一个刷新周期**（≤1h 缓存
   + bridge TTL）生效，不是瞬时。

## 9. 排错

| 现象 | 根因 | 处置 |
|---|---|---|
| 端点 503 + `PROJECT_REJECTED` | 某个 server 的 description 等字段里有凭据形状串 | 按上游发布闸查该 pack；**不要**临时放宽 `CREDENTIAL_RE` |
| 发布成功但 registry 搜不到 | 发到了个人 namespace（用了交互式 login） | 改用 workflow 的 OIDC job，核对 `name` 前缀 |
| `mcp-publisher publish` 403 | 执行者不是组织 Owner / 未开 `id-token: write` | 见 §5.1 |
| dry-run 报 `name 不是反向 DNS 形` | server 名带非法字符（含额外 `/`、空格） | 在 registry 侧改名，投影器不放宽 |
| registry 列表少了一台 server | 该 server 有 required groups（非公开），或 description/url 缺失 | 预期行为（design C2/C3），不是 bug |
