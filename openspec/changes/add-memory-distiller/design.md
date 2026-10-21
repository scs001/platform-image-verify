# Design — add-memory-distiller

## S1 Spike 裁决（2026-10-22）

**裁决：过门（附 3 条集成条件）。** Hy-Memory `CodingMemoryExtractor`（scene=working）+
`build_experience_reconcile_prompt()` / `CodingMemoryReconciler._parse_ops()` 可作 fd-memory L2 蒸馏引擎 #1。
核心判据——多 agent 共享去重（同一问题第二个 agent 再问，引擎 UPDATE/SKIP 既有经验而非重复 ADD）——两遍全过；
成本约 7.5k tokens/会话，远低于 40k 门槛；琐碎会话 0 经验；JSON 经 json_repair 后 0 硬失败。
不过门备选（mem0 / TencentDB memory-core）**不启动**；S3 **不启动**。

### 设置（与 proposal 的偏离须知）

| 项 | 取值 |
|---|---|
| 引擎 | Hy-Memory `main`（depth-50 clone，2026-10-22）；只 import `coding.extractor` / `coding.reconciler` / `coding.types` / `agent.llm_provider` / `config` / `pipelines.base`，无 Chroma/Kuzu |
| LLM | 词元车道 `deepseek-v4.1-flash`（推理模型，usage 含 reasoning_tokens），base `…/v1`，temperature 不传，timeout 120s，provider 内重试 2 |
| 抽取 / reconcile | `max_tokens` 6000 / 2000；`scene="working"`；中文输入自动路由 `EXTRACT_PROMPT_ZH` / `RECONCILE_PROMPT_ZH` |
| 测试集 | **12 段合成会话**（用户 10-22 明示无真实转录可用，偏离 proposal「20 段真实转录」）：A 余额 3 / B 消耗表 3 / C 集群 3 / D 交接 2 / 琐碎对照 1，全部取材 as-built 真实事件（台账），dsh 形状（assistant.tool_calls + role=tool），每段 7-10 条消息、2-5 次工具调用 |
| 候选 | 无 embedding 召回：候选 = 指定来源会话沉淀进池的**全量**经验（≤8），同一候选集喂每条 draft；落池规则镜像 `_execute`（越权 target 丢弃、未处理 draft 兜底 ADD） |
| 跑法 | 2 遍独立（候选池每遍从空起），抽取并行 4、reconcile 按会话顺序串行 |
| 产出 | `/tmp/memory-survey/s1/{fixtures.py, run_s1.py, s1_results.json, s1_run.log}`；持久副本 `paas/.zcode/memory-s1/`（不入库） |

### 数据（两遍）

| 门 | 判据 | 遍 1 | 遍 2 | 结果 |
|---|---|---|---|---|
| G1 琐碎负例 | 0 经验 | 0 | 0 | **PASS**（fact 两遍都写了 1 条薄记录，见发现 8） |
| G2 生产率 | A/B/C 9 段 ≥7 产经验 | 7/9 | 9/9 | **PASS**（遍 1 的 2 段缺失是解析/超时损失，非价值判断，见发现 5/6）；D 弧线 2/2、2/2 |
| G3 关键词命中 | expected_experience 组 ≥70% | 24/31 = 0.774 | 28/31 = 0.903 | **PASS** 均值 0.839；fact 关键词 0.826 / 1.0 |
| G4 subject 稳定性 | 跨遍记录 | 7/9 可比对逐字相等（77.8%） | | INFO（见发现 3） |
| G5 reconcile | s11 多 agent 去重 SKIP/UPDATE；s10 跨域不误改 | s11 `UPDATE→exp_s10_0`；s10 ADD、A 条目零改写 | 同 | **PASS** 两遍 |
| G6 成本 | ≤40k tokens/会话 | max 10,702 / mean 7,212 | max 10,200 / mean 7,776 | **PASS**；两遍合计 173,944 tokens / 38 次调用；reasoning 占 ~17% / ~14% |
| G7 解析 | json_repair 后 100% | 原生 16/17 + 1 可修 | 原生 20/20 | **PASS** 硬失败 0（见发现 5） |
| G8 中文 | 记录 | task 55.6% / solution 66.7% / fact 100% | task 54.5% / solution 72.7% / fact 100% | INFO（见发现 4） |
| G9 调用稳定 | 记录 | s08 网关 4 连超时整段丢 | s08 超时 1 次后重试成功 | INFO（见发现 6） |

reconcile 观察（soft，不进门禁）：s05 `UPDATE→exp_s04_0`（修复覆盖诊断，两遍一致）；s02 遍 2 `UPDATE→exp_s01_0`（复验流程并入诊断经验）；s03/s06/s08/s09 ADD（判「任务不同」，理由文本准确）。

### 发现

1. **多 agent 共享去重成立（核心判据）。** s11（agent-handoff-2）重问 TCR 100-tag 上限，候选含 s10（agent-handoff-1）沉淀的经验 + A 弧线 3 条余额经验，两遍均判 `UPDATE→exp_s10_0`，理由原话：「已有 exp_s10_0 描述同一 TCR tag 配额超限清理任务；新 draft 更新了具体仓库为 fd-infra/gateway……按规则用新 draft 替换」。无重复 ADD。
2. **跨域判别成立。** s10 面对 3 条余额/403 候选判 ADD，理由原话：「现有 candidates 分别涉及 API 充值后网关/部署复验和集群恢复后 403 排查，均与镜像仓库 tag 配额超限清理不是同一任务；无重复或可更新目标」。无跨域 UPDATE/DELETE。
3. **subject 作硬键：机器标识符稳，中文自由短语漂。** 文件路径 / 主机 / 邮箱 / registry 路径类 subject 两遍逐字相等（`platform-test@findmail.com`、`web/src/pages/UsageTable.tsx`、`hkccr.ccs.tencentyun.com/paas/agent` 等 7/7）；中文名词短语漂移 2 例（`cheap-2 deploy/agent-api` vs `cheap-2 上的 deploy/agent-api (namespace serving)`；`console 消耗表` vs `wanxing/console:v2 消耗表`）——同一实体、不同措辞，精确相等闸门会把它们当两个主体。与 Hy-Memory 自己把 `HY_FACT_SUBJECT_GATE` 默认关闭的理由一致。**含义**：我方 fact 覆盖判定不能只靠 subject 相等，要「subject 规范化 + 语义/LLM 判定」双路。
4. **中文：fact 稳、experience 漂。** fact statement 两遍 100% 中文；experience 的 `task` 仅 ~55%、`solution` ~70% 中文——zh 提示词下模型仍常整条输出英文（s01/s05/s06/s08/s09）。`task` 是检索主键，英文 task 对中文查询有跨语惩罚。**集成条件 C2**。
5. **解析：原生 36/37，1 例可修。** 遍 1 s02 模型在 JSON 字符串里多写了一个未转义引号（`'"'`），`json.loads` + 首尾花括号兜底均失败，`json_repair` 可完整修复；但 **抽取器本体没挂 json_repair**，原生路径该会话整段丢失（0 经验 0 事实）。**集成条件 C1**。
6. **调用失败被引擎静默吞掉。** `CodingMemoryExtractor.extract()` 捕获 LLM 异常后返回 `([], [])`，cache=None 时无任何记录——从调用方看与「没东西值得记」无法区分。遍 1 s08 网关 4 连超时（provider 2 次 × harness 外层未触发，因异常已被吞）即如此丢失；遍 2 同会话重试 1 次后 13s 成功，说明是网关抖动非提示词问题。**集成条件 C3**。
7. **成本比 proposal 预估低。** proposal 估「每会话 3-4 次调用、中文提示约 1 万字」；实测抽取 1 次（~5.5k tokens）+ 有候选时 reconcile 1 次（~4k），fact reconcile 未跑（S1 只判经验层）。推理模型 reasoning_tokens 计入 completion，占 ~15%。
8. **价值门槛只管经验层，事实层总会写。** 琐碎会话（打招呼 + 一次 `date`）两遍 0 经验，但各写 1 条薄 fact——这是抽取器契约（「ALWAYS write the fact … only greetings and pure chatter get null」），不是缺陷。**含义**：L2 事实层的量要靠我方 cursor / 去抖 / 预算控制，不能指望引擎过滤。
9. **抽取质量样例。** s01 把「零花费探针分型（max_tokens=4 或 /v1/models）→ 403 带码查 sub2api 余额 → `--all` 对照同池账号」整套含命令的流程抽成一条可复用 solution，boundary_envs 钉了端点/模型/env 名/脚本；s05 UPDATE 覆盖 s04 诊断（修复替代诊断、不留历史）符合经验层语义。关键词真漏项都是具体标识符被泛化（`49242b5`、`A-only`），solution 仍保留了方法。

### 过门附带的 3 条集成条件

- **C1 解析层挂 json_repair**：sidecar 不直接用 `extract()` 的返回，而是拿原文经 `json_repair` 后再喂 `_parse_output` / `_parse_ops`（或在 fork 契约层补一行）。
- **C2 `task` / `search_keys` 语言钉**：提示词补「task/search_keys 用与会话相同的语言」一行，或 sidecar 后处理检测非 CJK 时翻译；评测 v1 加「task 语言 = 会话语言」断言。
- **C3 调用失败显性化**：sidecar 注入 cache（走 `_store_coding_log`）或包住 `llm_provider.complete` 记录每次调用，`DistillResult` 上报 `llm_calls / errors`，让「没抽到」与「调用失败」在我方账目里分开；失败会话保留 cursor 不前进。

### S1 未覆盖（apply 阶段或评测 v1 补）

- 真实转录（合成集可控但偏理想，真 dsh 事件里工具输出更长更脏，`tool_result_max_bytes=2048` 截断的影响未量）。
- 事实层 reconcile（`WorkingFactReconciler`）只抽未判覆盖；subject 规范化方案（发现 3）在 apply 时定。
- embedding 召回候选（S1 喂全量 ≤8 条；真系统 top-3 by task+search_keys）——漏召回会把该 UPDATE 的判成 ADD，属 fd-memory 检索层责任。
- 并发 4 下网关 1/24 丢失率是否随并发升高（发现 6）。

## 其余设计决策

待 S1 过门后、apply 前按 proposal「What Changes」逐项展开（Distiller 契约形状、页型、sidecar 边界、预算表、可见性）。
