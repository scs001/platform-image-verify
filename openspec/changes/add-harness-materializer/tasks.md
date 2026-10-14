## 1. 物化器（agent-runner/compose-acp.js）

- [x] 1.1 `materializeAcpWorkspace({ homeRoot, agentKey, entry, skillContents })`：
  `<homeRoot>/ws/<agentKey>/` 落 `CLAUDE.md`（persona+与 dsh preset 同文 serving 后缀）、
  `.claude/skills/<name>/SKILL.md`（name=路径末段，同 dsh 规则）、uid 守卫复用
  `ensureHomeOwnership`、workspace 声明 → `data/`+quota；返回
  `{ workspace, dataDir, dataQuotaMb, unmapped: [...] }`。验证：新单测
  `scripts/test-harness-materialize.mjs` 首例（三件落盘 + persona 文本与
  compose.js preset 行逐字对照）绿。
- [x] 1.2 幂等与纪律：重物化覆写 CLAUDE.md/skills、`data/` 存活（写入标记文件后重物化仍在）；
  未知 harness 名（布局表外）返回裸工作区 + `unmapped` 指名 persona/skills/mcp。验证：单测
  两例绿。
- [x] 1.3 MCP 解析：`acpMcpServers(names, registryClient, token)` → ACP 形状数组
  `{name, url, headers:{Authorization}}`（与 `mcpEntry` 同源纪律：同 URL 来源、同 token）。
  验证：单测断言形状与 Authorization 头。

## 2. 接线（adapter + manager）

- [x] 2.1 `harness/acp.js`：`session/new` 透传 `spawnSpec.acpMcpServers ?? []`（resume 不带）；
  spawnSpec 形状注释同步。验证：test-harness-adapter 新例——fake ACP agent 回显收到的
  mcpServers（形状+headers 断言）绿；既有 18 例零回归。
- [x] 2.2 `harness/registry.js`：create() 的 ACP 分支把 `spawnSpec.acpMcpServers` 传进
  adapter spawnSpec；不改 dsh 分支。验证：现有 registry 相关单测绿 + lint 绿。
- [x] 2.3 `manager.js #spawnChild`：按 `harnessRegistry.kindOf(harnessName)` 分派——dsh 路径
  **逐字节不动**（既有分支保持）；acp 路径改调 1.1 物化器，spawnSpec 变
  `{cwd: workspace, env: workspaceChildEnv(spec, scrubbedChildEnv(...)), model, acpMcpServers}`，
  不再 build DSH_HOME/patchPaths/presetId；`unmapped` 非空 → 一条 warn。验证：单测
  （manager 级 fake registry）断言 acp spawn 的 cwd 指向 ws、无 DSH_HOME 目录生成。
- [x] 2.4 凭据矩阵：billing_key_ref → fetch 成功后 spawn env 覆写 `ANTHROPIC_API_KEY`
  （失败 warn 降 runner key，与 dsh 同文）；`secret_refs` 非空 → 组合期抛
  `HARNESS_SECRETS_UNSUPPORTED`（指名 secret+harness，与 fetch 失败可区分）；`mcpTools`
  非空 → warn 降级开放。验证：单测三例（覆写/拒绝/降级）绿。

## 3. 回归与合同

- [x] 3.1 全量单测 `node --test --test-concurrency=1 scripts/test-*.mjs` 全绿（基线 1306，
  允许只增不减）；重点盯 test-agent-serving / test-dsh-pod-adapter / test-harness-adapter
  三家零失败。
- [x] 3.2 `openspec validate add-harness-materializer` 过；lint（adapter-boundary 名单）过——
  compose-acp.js 不得 import `@deepseek-ai/*`。

## 4. 出片与生产验证

- [ ] 4.1 `fd-build-channel` 判路 → 按逐步命令出 runner 镜像（GHA→hkccr→relay→ccr 纪律；
  出片前 `git status` 核净）→ 滚 runner-serving。验证：pod 新 sha 眼见 +
  `/api/ready` 绿。
- [ ] 4.2 in-pod 真 E2E（切片③探针模式）：部署带 persona+2 skills+1 MCP 引用的
  acp-claude-code 探针包——CLAUDE.md/`.claude/skills` 落盘眼见、A2A 回合答复体现
  persona、session/new 带 MCP 被接受（或按风险预案降级并如实记账）。
- [ ] 4.3 计费归属实证：billing_key_ref 部署的回合在词元管理面记到 deployer key 名下；
  secrets 声明部署被拒的错误文本眼见。双 harness 探针复跑 dsh 侧同绿（零回归证明）。
- [ ] 4.4 残留清理 + 台账：探针 registry 条目下架/禁用、runner children 复核；
  `docs/registry-maintenance.md` §9 发布记录补行。
