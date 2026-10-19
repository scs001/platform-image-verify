# MCP 工具面治理 · 交接文档

> 日期：2026-10-20（终版）
> 交接范围：paas 侧两个 OpenSpec change
> - A = `openspec/changes/pack-tool-declaration-gate/`（发布门）
> - B = `openspec/changes/full-mode-tool-scope/`（full 模式收敛）
> 对应需求方：finddata 仓 `openspec/changes/pack-tool-declaration-backfill/`（34 个 pack 的回填与重发）

---

## 0. 一句话结论

**A 与 B 的代码与测试都已完成：A 可直接按 `warn` 上线；B 可随 flag 默认 off 上产，等回填完成后打开 `FULL_MODE_TOOL_SCOPE=on`。**

两个 change **都未归档**，因为剩余任务全部是生产 rollout 或跨仓验收，不是代码缺口：
- A：`warn` 观察一周、回填后切 `enforce`、预检脚本的**实际验收**（脚本已写，等作者仓重生成的 manifest）。
- B：`fd-prod` 打开 flag 后的探针测量与观察、guard 拒绝文案指引（与「不改 bridge」的非目标冲突，需产品决策）、一个独立的 e2e 配置（`FULL_MODE_TOOL_SCOPE=on` 的 server）。

`openspec archive pack-tool-declaration-gate` 已实测：拒绝归档并列出 3 个未完成任务；没有用 `--yes` 强推。

---

## 1. A（发布门）已完成

### 1.1 代码

| 位置 | 内容 |
|---|---|
| `lib/pack-manifest.js` | 形状层接受 `fullSurface` / `fullSurfaceReason`；与 `allowTools` 互斥；`fullSurface` 必须为 `true`；理由非空且 ≤500 字符；理由不得脱离标记单独出现。**「两者皆无」在形状层仍然合法**（安装兼容）。 |
| `lib/publish-tool-gate.js` | `namedMcpTools()`、`toolFaceErrors()`、`toolClosureErrors()`：抽取 `mcp__<server>__<tool>`、要求每个引用二选一、断言点名工具落在 `allowTools` 内（`fullSurface` 豁免）。 |
| `gateway/packs.js` | `collectPublishVerdict` 在结构门之后接入工具面门；`PACK_TOOL_FACE_GATE=off|warn|enforce`，默认 `warn`，逐请求读取；enforce 返回 400 且带 `toolFace: true`；warn 记录 `[publish-tool-face-gate] warn-only pack='...'`。既有名字门语义不变。 |
| `web/src/components/packs/PackDetailDialog.tsx` | 每个 MCP 引用披露「声明 N / 全量 M 工具」；`fullSurface` 显示全量 + 理由；旧版本显示「全量 M 工具（未声明）」。只读版本 manifest + catalog `tool_list`。 |
| `web/src/components/packs/PackDraftsView.tsx` | 草稿可「未选工具」保存；未选工具时提供「标为全量 + 填理由」开关；发布前本地预检，缺工具面时拦截并点名 server。 |
| `web/src/lib/packs-api.ts` | `PackManifestMcp` 增加 `fullSurface` / `fullSurfaceReason`。 |
| 5 个 locale | `packs.detail.toolFace*` 7 键 + `packs.editor.tools*` 4 键。 |
| `scripts/preflight-pack-tool-gate.mjs` | **新增**：回填前预检脚本（见 §3.3）。 |

### 1.2 测试证据

```bash
node --test scripts/test-pack-cell.mjs scripts/test-publish-tool-gate.mjs \
           scripts/test-pack-validate.mjs scripts/test-pack-marketplace.mjs
# → 60 tests, 60 pass

npx playwright test e2e/packs.spec.js -g "discloses" --project=fast          # 1 passed
npx playwright test e2e/packs.spec.js -g "full-surface marker|resource declarations|tool allowlists" --project=fast
# → 3 passed

npm run check:locales   # 5 locales OK
npm run typecheck       # tsc --noEmit 通过
```

### 1.3 A 未完成项（运营/跨仓，不是代码）

- 5.1 `warn` 模式上线观察一周，收集违规面。
- 5.2 作者仓回填完成后切 `enforce`。
- 2.5 预检脚本的**实际验收**：脚本已写好，等作者仓重生成 34 份 manifest 后跑出「13 个 server 无 UNRESOLVED」的报告。

### 1.4 上线顺序与回滚

```
A1 shape 先上  →  A2 门以 warn 上线  →  作者仓回填 + 分波次重发  →  切 enforce
```

- 回滚：`PACK_TOOL_FACE_GATE=off`（逐请求读取，无需重启）。
- 安装兼容：旧 manifest（无声明）仍可安装；新 manifest 在旧 cell 上也能装（未知键被容忍），旧 cell 按全量运行。

---

## 2. B（full 模式收敛）已完成

### 2.1 数据层（`db.js`）

- 迁移 33：`ALTER TABLE user_presets ADD COLUMN mcp_tools TEXT DEFAULT '{}'`。
- 覆盖偏好：`getFullSurfaceServers()` / `setFullSurfaceServers()`；键 `user_preferences.toolScope.fullSurface`，JSON 数组；空数组删键；损坏值读作空。
- 自建预设：`USER_PRESET_COLS` 增加 `mcp_tools AS mcpTools`；`hydrateUserPreset` 容错解析；`createUserPreset` / `updateUserPreset` 接受并持久化 `mcpTools`。

### 2.2 推导与合成

- `lib/full-mode-tool-scope.js`（新）：
  - `deriveFullModeToolScope(installedPacks, fullSurfaceServers = [])`：并集；未声明 / `fullSurface` / 空或畸形声明 → 该 server 不过滤；**绝不产出 `{server: []}`**；无收窄 → `null`。
  - `customPresetToolScope(mcpServers, declaredTools, fullModeUnion, fullSurfaceServers = [])`：声明 → 精确集合；未声明 → 继承并集；覆盖 → 移除；未引用不加入。
- `dsh-profile.js`：`fullModeToolScopeEnabled()`、`readFullSurfaceOverrides()`、`fullModeToolInputs()`（DB 读失败 fail-open）；full 分支并集；custom 分支声明/回落；pack 分支删除被覆盖 server；写入改为 `writeToolFilterPatch(scope.mcpTools)`。

### 2.3 API 与 UI

- `server/routes/misc.js`：`GET/PUT /api/mcp-tool-scope`（body `{fullSurface: string[]}`；503/400 约定沿用偏好路由）。
- `web/src/components/extensions/McpInstalledView.tsx`：每个 server 一个「完整工具面」开关，挂载时 GET、变更时 PUT；testid `mcp-full-surface-toggle-<server>`；文案 `extensions.mcp.fullSurface` / `fullSurfaceHint`（5 语言）。
- `web/src/lib/presets-api.ts`：`CustomPreset.mcpTools` / `CustomPresetInput.mcpTools`。
- `server/routes/custom-presets.js`：`validatePresetBody` 校验 `mcpTools`（对象、server 键、≤64 个 `[A-Za-z0-9._-]{1,128}` leaf、去重、只保留被引用 server）。
- `web/src/pages/CustomPresetsPage.tsx`：每个已选 server 的工具 chips（catalog `toolList`，拒绝自由输入）；保存时只带非空项；testid `preset-mcp-tools-toggle-<server>` / `preset-mcp-tool-<server>-<tool>`。

### 2.4 测试证据

```bash
node --test scripts/test-full-mode-tool-scope.mjs              # 8 tests
node --test scripts/test-full-mode-tool-scope-integration.mjs # 6 tests（真实合成 + 临时 DB/DSH home）
# 覆盖：flag off 逐字节等价、双 pack 并集、未声明安全阀、覆盖删除、卸载后键消失、
#       自建预设声明/继承（含 catalog + roster 刷新）

node --test scripts/test-full-mode-tool-scope.mjs scripts/test-full-mode-tool-scope-integration.mjs \
  scripts/test-focus-overlay.mjs scripts/test-custom-presets.mjs \
  scripts/test-pack-cell.mjs scripts/test-publish-tool-gate.mjs \
  scripts/test-pack-validate.mjs scripts/test-pack-marketplace.mjs
# → 100 tests, 100 pass

npx playwright test e2e/custom-presets.spec.js e2e/extensions.spec.js --project=fast
# → 26 passed（B3/B4 界面改动无回归）
```

### 2.5 B 未完成项

- **2.5 guard 文案指引**：任务要求 `platform-tool-scope.js` 的拒绝文案包含「设置→MCP」指引，但需求书把该文件列为非目标（「不改 bridge」）。两者冲突，需要产品决策；当前未改。
- **4.3 e2e**：需要给 e2e 单独起一个 `FULL_MODE_TOOL_SCOPE=on` 的 server（现有 webServer 在测试前启动、env 固定），建议新增独立 Playwright 配置覆盖三条：full 模式并集、覆盖恢复、自建预设收窄。现有 `pack-agent-scoping.spec.js` 在 flag off 下继续断言 `{mcpTools:{}}`，与默认行为一致。
- **5.x rollout**：fd-prod 打开 flag、`probe-pack-scope.mjs` 前后对比、token 差写入 `measurements.md`、观察一周后翻默认值。

---

## 3. 跨仓 / 运营待办

### 3.1 作者仓回填（共同前置）

- 34 份 manifest 重生成、分波次重发（wire 19 先发）。
- 已知需要 `fullSurface` 的例外：`lex-contract-review-cn` 的 law-bench 间接引用。

### 3.2 名字门首次开启的风险

回填会让 95 条原本「跳过名字门」的引用第一次进入校验。`probeMcpToolNames` **不带凭据**，探不到就是 UNRESOLVED 拒发，不是「工具不存在」。处置：先跑预检、刷新快照。

### 3.3 预检脚本（已写）

```bash
REGISTRY_URL=https://<registry> node scripts/preflight-pack-tool-gate.mjs \
  ~/finddata/docs/*-presets/pack-manifests
```

输出：每个 server 的 `snapshot=N declared=N missing=... probe=...`；退出码 1 表示有工具面违规或 UNRESOLVED。快照滞后先 `POST /api/refresh/<path>` 再复跑。

---

## 4. 关键设计决策与不变量（改代码时不要破坏）

1. **覆盖 = 删键，不是枚举全量。** 运行时 guard 只收窄 map 里出现的 server。
2. **未声明 = 全量。** 无 `allowTools`、空/畸形、`fullSurface` → 该 server 不过滤；绝不产出 `{server: []}`。
3. **失败 open。** DB 读失败、偏好损坏 → `null`（不过滤）。
4. **只在合成时刻计算。** 并集不落盘。
5. **优先级：用户覆盖 > 聚焦 pack 的 allowTools > full 模式并集 > 不过滤。**
6. **flag off 逐字节等价。** full 与 custom 分支都返回 `mcpTools: null`，写出 `{ "mcpTools": {} }`。
7. **自建预设的 `mcpTools` 也受 flag 控制**（保守选择，符合 B5 的等价承诺）。若希望「声明了工具的自建预设即使 flag off 也收窄」，需单独讨论——会改变 off 的等价性。

---

## 5. 生产风险与已知坑

| 风险 | 说明 / 处置 |
|---|---|
| 95 条引用首次进名字门 | 先跑 §3.3 预检；快照滞后先刷新；探针失败是 UNRESOLVED 拒发。 |
| 快照滞后 | 例：fd-text-core 2026-10-19 新增 gov 工具。刷新走 registry `POST /api/refresh/<path>`。 |
| 老 cell 安装新 manifest | `fullSurface` 是未知键但校验器不拒；旧 cell 按全量运行（安全阀）。 |
| 作者为绕门全标 `fullSurface` | 理由必填 + 详情页展示；作者仓构建报告单列全量引用。 |
| 并集导致 prompt cache 失效 | 只在合成时刻变化，不是每轮。 |
| e2e 前端不更新 | 改 web 后必须 `npm run web:build:e2e`。 |
| 测试语言 | `e2e/packs.spec.js` 实际是 zh-CN，断言用中文文案。 |
| 技能名/工具名字符集 | 技能名 `[A-Za-z0-9._-]{1,64}`；工具 leaf `[A-Za-z0-9._-]{1,128}`。 |
| 自建预设测试需刷新 roster | `resolvePersona` 依赖 catalog + 生成的 preset defs；测试里要 `catalog.refresh()` + `writeCatalogAgentPresets()`（生产由路由的 `syncCatalogAgentPresets` 完成）。 |

---

## 6. 改动文件清单

### A
- `lib/pack-manifest.js`
- `lib/publish-tool-gate.js`
- `gateway/packs.js`
- `scripts/test-pack-cell.mjs`
- `scripts/test-publish-tool-gate.mjs`
- `scripts/test-pack-validate.mjs`
- `scripts/preflight-pack-tool-gate.mjs`（新）
- `web/src/lib/packs-api.ts`
- `web/src/components/packs/PackDetailDialog.tsx`
- `web/src/components/packs/PackDraftsView.tsx`
- `web/src/locales/{en,zh-CN,ja,es,fr}/common.json`
- `e2e/packs.spec.js`
- `openspec/changes/pack-tool-declaration-gate/tasks.md`

### B
- `db.js`（迁移 33、偏好 helper、预设 `mcpTools` CRUD）
- `lib/full-mode-tool-scope.js`（新）
- `scripts/test-full-mode-tool-scope.mjs`（新）
- `scripts/test-full-mode-tool-scope-integration.mjs`（新）
- `dsh-profile.js`
- `server/routes/misc.js`
- `server/routes/custom-presets.js`
- `web/src/lib/presets-api.ts`
- `web/src/components/extensions/McpInstalledView.tsx`
- `web/src/pages/CustomPresetsPage.tsx`
- `web/src/locales/{en,zh-CN,ja,es,fr}/common.json`
- `openspec/changes/full-mode-tool-scope/specs/pack-agent-scoping/spec.md`
- `openspec/changes/full-mode-tool-scope/tasks.md`

---

## 7. 归档状态

- `openspec archive pack-tool-declaration-gate` 已实测：**拒绝**，报 `archive_tasks_incomplete`（3 个未完成任务：2.5、5.1、5.2）。
- 没有用 `--yes` 强推：这三项是运营/跨仓验收，强行归档会把「未上线验证」写成「已完成」。
- B 未尝试归档：2.5、4.3、5.x 未完成。
- 建议归档时机：A 的 warn 窗口结束并切 enforce 后；B 的 flag 在 fd-prod 打开并观察一周后。

---

## 8. 给需求方的下一步

1. **A 可以先上 warn**，不依赖 B、也不依赖回填完成。观察 `[publish-tool-face-gate] warn-only` 日志得到真实违规面。
2. **作者仓回填是共同前置**：A 切 enforce、B 打开 flag、预检验收都等它。
3. **B 可以随 flag off 上产**（当前代码即此状态）。回填完成后按 §3.3 预检 → 打开 `FULL_MODE_TOOL_SCOPE=on` → 用 `probe-pack-scope.mjs` 记录前后 roster 与 token 差 → 观察一周再考虑翻默认值。
4. 需要补的两项非阻塞决策：guard 文案是否加「设置→MCP」指引（与不改 bridge 冲突）；是否新建 `FULL_MODE_TOOL_SCOPE=on` 的 e2e 项目覆盖 4.3。
