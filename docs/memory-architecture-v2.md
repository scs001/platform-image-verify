# 记忆架构 v2（壹座 × 谦面 × 萬星 多 agents 记忆面）

> **状态**：2026-10-22 方向经用户拍板（ADR-0030），实施经三个 change（§12）。本文接替
> `docs/memory-and-stats-plane-explore.md`（10-19 底稿）成为记忆面的长期真源；底稿保留为历史
> 与 D1-D6 决策的出处。统计面不在本文（见底稿 S1-S5 与 fd-wanxing `add-stats-plane-v1`）。
> as-built 底座：archive `2026-10-22-add-fleet-memory-v1` + `2026-10-21-add-memory-federation-v1`，
> 主 spec `fleet-memory`（8 需求）/ `memory-federation`（4）/ `agent-runner`（记忆 1 条）。
> 领域词汇：CONTEXT.md「工作记忆」「交接」。

## 1. 目标与非目标

**目标**：一个能支撑「上百 agents 长期编排运行」的记忆系统——agent 跨会话延续任务状态、集群成员之间共享事实与交接、部署者看得见自己 agent 记得什么；并且每一层都能独立迭代（换引擎、加索引、加共享模式）而不推倒重来。

**非目标**：替换 fd-memory 底座；把记忆系统放进 LLM 调用热路径（memory-proxy 式拦截）；任何跨 owner 可见性；在 L0/L1 引入 LLM；现在就做 HA。

## 2. 现状（2026-10-22 as-built 一页）

- **四切片全上产**（10-19）：本地 stock ai-memory 试点 → fd-memory（cheap 集群单实例 + PVC 5Gi，NodePort 31899）→ 消耗统计（fd-wanxing）→ 联邦（/hook + cell 挂载 `u/<owner>`）。
- **fd-memory**：TS 1186 行 src + 12 单测 + e2e；路由 `/capture` `/hook` `/mcp` `/admin/mint` `/admin/reindex`；MCP 8 工具（handoff begin/list/accept/cancel、query、recent、read_page、write_page）；令牌四族 deployment|person|runner|platform；OKF markdown 真源 + SQLite（pages / pages_fts trigram / observations / handoffs / hook_dedupe）；脱敏四类 + BIDI；git 快照可选。
- **规模**：生产 serving agent 6 个、cell 1 个、首个记忆生产部署 spider-heal。「上百」是愿景——骨架按愿景，第一刀按现状落。
- **多 agent 缺口**：namespace 恒 `d/<packId>/<agentId>` → 根 `d-<packId>--<agentId>` 每 agent 一根；令牌恰一个 namespace；fleet pod 路径不挂记忆（`manager.js:1472-1474`）；cell 集群回合的 persona 成员共用 `u/<owner>` 单 project、无结构无归因。
- **两个 P0**：
  - P0-1 `agent-runner/memory-capture.js` 单 `#namespace`（38 行），`flush` 把整队事件打到最后一次 observe 的 namespace（63 行）——多部署共 manager 下的错投，跨 owner 泄漏通道。
  - P0-2 `manager.js:946` 观测 summary 仅 `"${kind} turn ${outcome} tokens=N (Nms)"`——L0 无内容，任何引擎接上都是空转；设计本意（v1 design D6）含工具调用摘要。
- **其他偏差**：pod persona 注入纪律文案却无工具；`cell-memory.js` 返回的 `discipline` 无消费者（`dsh-profile.js:968-969` 只取 mcpEntry）；agentId 用显示名（中文/空格；改名＝换 namespace）。

## 3. 原则

1. **底座自有，引擎开源**——隔离与授权是商业面；抽取与调和借开源（ADR-0030 D1/D2）。
2. **真源是 markdown，索引可重建**——任何引擎/索引变更都能用「删页 + reindex」回滚。
3. **零 LLM 热路径，LLM 在后台且限额**——采集与交接即时廉价，蒸馏异步批处理、按 owner 预算。
4. **共享是声明出来的**——Scope + Grant 是数据；读写分解；默认私有。
5. **永不覆盖，只 supersede；全链溯源**——每条蒸馏产物可下钻回 L0/L1 证据。
6. **没有评测不迭代**——真实转录 fixture + 三指标进 CI。

## 4. 架构骨架

```
  +-- 消费契约 (版本化, 稳定) ----------------------------------------------------+
  |  MCP 工具面 (dsh / ACP / cell agents)      capture API (manager 代采, /hook 本地节点) |
  |  admin & visibility API (萬星 console: 部署者看自己的 scope; 铸币; reindex)          |
  +------------------------------------------+------------------------------------+
                                             |
  +-- 底座 fd-memory (自有, 保持小) -----------+------------------------------------+
  |  Scope: agent | pack | owner | (v3) restricted                                     |
  |  Grant: (principal, scope, mode r|rw)    <- 权限是数据                            |
  |  Token: principal 身份 (deployment | pod | person | runner | platform)             |
  |  Store-root: 按 owner 物理隔离 (不变)                                              |
  |  真源 OKF markdown 页型: session | observation | handoff | note                     |
  |                         + fact | experience | profile (sources/supersedes/expires)  |
  |  派生索引: FTS5 (有) + 向量 (词元 /v1/embeddings, 脱敏后) + 时态/溯源表             |
  |  审计: 每次写 = principal / 时间 / scope                                            |
  +------------------------------------------+------------------------------------+
                                             |
  +-- 引擎缝 (可插拔, 后台, 限额) --------------+------------------------------------+
  |  Distiller 契约 (§9): in=(scope, cursor 后的 L0+L1, 候选既有事实) out=fact/experience 页 |
  |  #1 Hy-Memory working 抽取器 (无状态 sidecar, 词元 LLM 车道)                        |
  |  #2 mem0 单遍抽取  #3 自研启发式  (远) graphiti 时态图  (备) TencentDB memory-core   |
  |  预算: 每 owner 日 token 预算 + 批 + 去抖; 计费真源 sub2api                         |
  +-----------------------------------------------------------------------------------+
  +-- 评测 (进 CI) --------------------------------------------------------------------+
  |  脱敏真实转录 fixture + 交接召回率 | 接续成功率 | 事实 QA                            |
  +-----------------------------------------------------------------------------------+
```

## 5. 分层模型

```
  层   内容              写者                 读者                  LLM   纪律
  L0   观测 observation  manager 代采 / hook  Distiller, 人工排障    无    只追加; 脱敏前置
  L1   交接 handoff      agent (MCP)          同 scope 的 agent      无    typed, claim-once
       笔记 note         agent (MCP)          同 scope               无    可 supersede
  L2   事实 fact         Distiller            agent (query/recent)   有    statement+subject+details 原文
       经验 experience   Distiller            agent                  有    task/search_keys/solution/boundary/confidence
  L3   画像 profile      evolve (v4)          spawn 注入 persona     有    周期性, 可回滚
```

L0 观测形状（v2.0 起）：`{session, agent, event: turn_start|tool_call|tool_result|turn_end, tool_name?, args_digest?, result_digest?, intent_digest?, outcome?, tokens?, ms?}`，各 digest 截断上限进 env，入库前过 sanitize。来源：manager 从 dsh 事件流（`dsh-events` 已有 tool/result 双形状解析）与 ACP 回合缝组装；本地节点经 /hook 维持上游形状。

## 6. 作用域与授权

**Scope 种类与磁盘落位（v2 布局，镜像人根 `u-<user>` 的"一根多 project"形状）**

```
  owners/<owner-root>/                          物理隔离单元 (不变)
    wiki/
      shared/                                   scope pack  —— 集群/pod 共享
      <agentId>/                                scope agent —— 成员私有
      <agentId>/...
    db/memory.sqlite                            一库, project 列分区 (人根已如此)

  namespaceParts (v2):
    d/<packId>            -> root d-<packId>, project shared        (pack 令牌)
    d/<packId>/<agentId>  -> root d-<packId>, project <agentId>     (成员令牌)
    u/<user>[/p/<proj>]   -> root u-<user>,   project <proj>|default (不变)
```

`<packId>` 必须按部署者唯一（v1 既有暴露：若为市场级 id 则两部署者同 pack 撞根）——v2.0 任务里核实并钉死。

**Grant**

```
  tokens(id, kind, principal, ...)                       <- 令牌 = 身份
  grants(token_id, scope_kind, scope_ref, mode)          <- 权限 = 数据

  默认授予 (铸币时写入):
    deployment (成员)   agent:<pack>/<agent> rw   + pack:<pack> rw
    pod                 pack:<pack> rw
    person              owner:<user> rw
    runner              capture-only 任意 d/     (不变)
    platform            仅铸币                   (不变)
  v3: restricted scope = 显式 ACL 行 (subject: agent|role|user), allow-only
```

**MCP 不变量与增量**：线协议仍不带 namespace 参数；工具新增可选 `target: "own" | "shared"`（相对选择器，非 namespace 名）；读工具（query/recent/handoff_list）默认 own + shared 并集，每条结果带 `source`；写工具（write_page/handoff_begin）默认 own，`target: shared` 写共享；pod 令牌无 own，默认即 shared。`memory_handoff_begin` 到 shared 可带 `to_agent`，即 agent→agent 交接；accept 仍 claim-once。

**令牌族映射**：deployment（成员，manager 代铸，不变）/ **pod（新）**：manager 在 `#spawnPod` 为整 pod 代铸，挂进共享 MCP patch / person（cell，不变）/ runner / platform。pod 成员私有分区等 per-member MCP patch（dsh/ACP 侧能力）后补——那时成员令牌替换 pod 令牌即可，Grant 不动。

**审计**：`writes(ts, principal, scope, page_rel, op)` 表；console 可查。

**迁移**：既有 `owners/d-<pack>--<agent>/wiki/default/*` → `owners/d-<pack>/wiki/<agent>/*`，`reindex` 重建；tokens 表加 grants 并为既有令牌回填默认授予。生产数据自 10-19 起，量极小。

## 7. 采集缝

- **manager 代采**（MCP-only harness 有记忆的唯一原因，保留）：修 P0-1（按 namespace 分队或事件自带 namespace）；观测形状升级（§5）；pod 路径按成员归因（pod 内按 memberKey 映射到 agent scope）。
- **pod 挂载**：`#spawnPod` 代铸 pod 令牌 → `dshMemoryMount` 一行进 `mcp.patch.yml`（与 `mcpRows` union 同处）；纪律文案与工具同时在场。
- **cell**：`cellMemoryMount` 的 `discipline` 接到 persona；集群回合（`server/cron-runner.js runClusterTurn`）两挂点——成员解析后（≈373 行）读 `owner` 下 cluster project 的 shared 注入上下文；digest 落盘前（≈492/536 行）把 digest 写回 shared。pack 声明式集群与动态集群（`dyn_`）同样处理，动态集群用 clusterId 当 project。
- **/hook**：不变。

## 8. 检索

- v2.0：FTS5 trigram（有）+ own/shared 并集 + source 标签。
- v2.2：词元 `POST /v1/embeddings`（`Qwen/Qwen3-Embedding-8B`，`dimensions=1024`，复用 chat 鉴权/账本）→ SQLite 向量列；混合 = FTS + 向量 + RRF（k=60）；**脱敏前置**（上游教训：embedding 路径曾发未脱敏全文）；`expires_at` 到期降级/剔除；`forget` 显式 API。
- 结果契约：每条带 `source`（own|shared）、`layer`（L0-L3）、`sources[]`（溯源）、`confidence`。

## 9. 引擎缝（Distiller 契约）

```
  输入  DistillRequest {
          scope,                       -- 哪个 agent/pack
          cursor,                      -- 上次处理到的 observation/page 游标
          items: [observation|handoff|note 页],   -- 自 cursor 起
          candidates: [既有 fact/experience 页]   -- 由底座按 subject/search_keys 检索
        }
  输出  DistillResult {
          facts: [{statement, subject, files[], details(原文直取, <=4000), sources[], supersedes[], confidence, expires_at?}],
          experiences: [{task, search_keys[], solution, boundary_envs, confidence, sources[], supersedes[]}],
          cursor_next, llm_calls, tokens
        }
  纪律  幂等 (cursor 单调; 同 cursor 重跑产出等价); 永不删页, 只写新页 + supersedes;
        每 owner 日预算 (tokens) 超限即停; 失败不阻塞 L0/L1; 产物带 generated.by=engine:<name>/<ver>
```

- **#1 Hy-Memory working**：`hy_memory.coding.extractor.CodingMemoryExtractor(llm_provider).extract(messages, history_messages, ...)` → `(CodingMemoryDraft[], WorkingFactDraft[])`；reconcile 用 `build_experience_reconcile_prompt()` + `_parse_ops` 对我方 candidates 出 ADD/UPDATE/DELETE/SKIP → 映射为 supersedes。sidecar = Python 容器，词元车道 DeepSeek 端点，每会话 3-4 次 LLM 调用（中文 working 提示约 1 万字）。专训 30B-A3B 可选（Apache-2.0；FP8/GGUF Q4 18GB）。
- **#2 mem0 单遍**：成本最低的备选；**#3 自研启发式**：工具调用频次/文件触达统计，零 LLM 兜底；**（远）graphiti**：实体关系与双时态，法条 KG 线复用；**（备）TencentDB memory-core**：按 owner instanceId 跑其 L1/L2 管线（25 万行，S1 不过门才考虑）。

## 10. 评测

- fixture：spider-heal 与集群回合的脱敏真实转录（20 段起），随 change 入 `fd-memory/fixtures/eval/`。
- 指标：**交接召回率**（下一会话 handoff_list 能否拿到正确交接）、**接续成功率**（给定 handoff 后新会话是否不重推导，LLM-judge + 人工抽样）、**事实 QA 正确率**（对转录出题，按 L2 查答）。
- 跑分器：自建最小 harness；方法论借 Supermemory MemoryBench / mem0 memory-benchmarks（可换 provider）与 CMB（编码 agent 长程记忆，仅论文）。
- 门：引擎/检索/脱敏变更必跑；分数进 change 的 verify 任务。

## 11. 可见性（萬星 console）

部署者可读自己 owner 根下所有 scope（v2.1）；按 scope / 层 / 时间筛；可手动 forget 一页；审计表可查。agent 默认不读 owner 级（Q3），v3 经 pack manifest 声明开放只读。

## 12. 演进路线

| 阶段 | 内容 | 门 |
|---|---|---|
| **v2.0** `fix-memory-capture-p0` + `add-memory-scopes-and-cluster-sharing` | P0-1/P0-2；agentId=metadata.agentId；Scope/Grant；v2 布局 + 迁移；pod 令牌与挂载；`target`；集群回合两挂点；cell 纪律接上；审计表；评测 v0（交接召回率） | Spike S2 定观测形状 |
| **v2.1** `add-memory-distiller` | Distiller 契约 + Hy-Memory sidecar + fact/experience 页型 + supersede + 每 owner 预算 + console 可见性 | Spike S1 过门 |
| **v2.2** | 词元向量列 + 混合检索 + expires/forget | v2.1 评测基线 |
| **v3** | restricted ACL、manifest 声明 owner 只读、审计 UI、HA（副本 + 共享 PV 或真源 git 远端）| 规模到了 |
| **v4** | L3 画像/schema evolve；spawn 注入 top-k 共享事实到 persona | v2.2 评测证明 L2 有效 |

## 13. Spike 清单（硬上限）

- **S1（2 天）**：Hy-Memory `CodingMemoryExtractor` 跑 20 段真实转录（词元 DeepSeek）——抽取质量、每会话成本、中文、`subject` 覆盖判定稳定性。产出一页裁决；不过门启 S3。
- **S2（1 天）**：manager 从 dsh 事件流能看到什么（工具名/参数/结果各多少字）——定 L0 形状与脱敏点。
- **S3（可选）**：TencentDB memory-core 按 owner instanceId 当备选引擎。

## 14. 未决问题

- `<packId>` 唯一性（按部署者 vs 市场级）——v2.0 核实。
- pod 成员私有分区依赖 per-member MCP patch（dsh/ACP 侧）——时间点。
- Distiller 触发策略：会话结束即触发 vs 定时批——成本数据出来再定。
- HA 形态：副本 + 共享 PV，还是把真源推 git 远端、副本各自 reindex。
- 动态集群（`dyn_`）的共享记忆保留期（随集群终止清理？）。

## 附录 A：尽调证据（2026-10-22）

**TencentDB-Agent-Memory**（Node≥22，MIT，29.7k★/70 commits 可见窗口 08-15→10-21，~25 万行）：team 之上无租户；`IsolationContext` 查询过滤「字段缺省＝不收窄」（`MemoryCore/src/core/store/isolation.ts:27-45`）；唯一物理边界是 instanceId（`db-name.ts:1-9`，请求头 `x-tdai-service-id`）；`system_admin` 全知（`metadata-service.ts:1246`）；网关单枚共享 Bearer（`server.ts:1317`），proxy 鉴权可选（`accessKeys.ts:1-8`）；**全仓唯一测试 `MemoryPanel/tests/useResizable.test.ts`，`npm test` 指向不存在的 vitest 配置**；9 月修过资产水平越权（5017e2b）；L1 抽取 1 发 ~18KB + 去重 1 发 ~12KB 中文系统提示，L2/L3 再各发；DSH 支持 proxy-only（`agent-adapters/dsh.ts`）；`sqlite-vec 0.1.7-alpha.2`；遥测全 opt-in。可借：按 owner instanceId 的 L1/L2 管线 + `/v3` REST + 本地 embeddinggemma。

**Hy-Memory**（Python，Apache-2.0，1.1k★，公开史 10-15 起 63 commits，`hy_memory` 77.5k 行 + tests 100 文件）：`CodingMemoryExtractor.extract()` 纯函数不碰存储（`coding/extractor.py:785-816`）；schema `coding/types.py`（经验 :32-140，事实 :181-276）；价值门槛是提示词逻辑（:92-117，含负结果）；`details` 原文直取不信 LLM（:983-1007）；每 write 3-4 次 LLM；提示词双语自动路由（:842-850）；lite 模式对 working 零产出；`python -m hy_memory.server` 仅单机壳；30B-A3B Apache-2.0、vLLM v0.31+、GGUF Q4 18.2GB、官方自报仅领先通用强模型 1-2 分；CMB 无代码；无遥测。

**赛道横评**：有多 agent 共享原语的三家——MemOS MemCube（`writable_cube_ids`/`readable_cube_ids`）、Letta shared blocks（attach，但 V1 server 已退役）、ai-memory（项目共享 + 私有 typed handoff）。无一家同时是多租户底座与好引擎。可换 provider 的开源跑分器：Supermemory MemoryBench、mem0 memory-benchmarks。强项目共性八条：金字塔分层、全链溯源、时态版本化、衰减与遗忘、显式共享 + 读写分解、零 LLM 写路径 + 后台蒸馏、工具轨迹符号压缩、多用户归因审计。

## 附录 B：与 v1 主 spec 的关系（供 change 写 delta 时对照）

- `fleet-memory`「记忆按 namespace 寻址且跨 owner 永不共库」→ MODIFIED：namespace 语义细化为 Scope，跨 owner 不变。
- 「令牌两族且每请求鉴权」→ MODIFIED：令牌四族 + pod 族；授权经 Grant。
- 「MCP 工具面按 namespace 收窄」→ MODIFIED：按 Grant 收窄；`target` 相对选择器；线协议仍无 namespace。
- 「零 LLM 边界」→ MODIFIED：L0/L1 零 LLM 不变；L2 经 Distiller 且限额（v2.1 承运）。
- 「存储为 OKF 兼容真源且派生索引可重建」→ 不变；新增页型（v2.1）与向量列（v2.2）为 ADDED。
- `agent-runner`「部署 agent 的工作记忆经平台缝代采与挂载」→ MODIFIED：观测形状、pod 挂载、错投修复。
- 新能力：`memory-distiller`（v2.1）、`memory-visibility`（console，v2.1）。
