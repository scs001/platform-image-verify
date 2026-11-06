# Evidence: fix-zhiyu-fleet-bridge-route-order

> 执行日 2026-11-07 · 仓 `paas` · 本地 apply 阶段（**未出片、未上产**）。

## 1. 装配契约与回归基线

### 1.1 `registerZhiyuRoutes(app, …)` 全仓调用点 —— **10 处**（立案时窄 grep 只看到 5 处，apply 时更正）

| # | 文件:行 | 类型 | 是否依赖内联 404 兜底 |
|---|---|---|---|
| 1 | `gateway/index.js:866` | 生产 | **本次改为 defer** |
| 2 | `scripts/test-zhiyu-im-bridge.mjs:34` | 测试 | 是（默认 false 保持） |
| 3 | `scripts/test-zhiyu-e2e-chain.mjs:34` | 测试 | 是 |
| 4 | `scripts/test-zhiyu-billing.mjs:31` | 测试 | 是 |
| 5 | `scripts/test-zhiyu-room-memory.mjs:57` | 测试 | 是 |
| 6 | `scripts/test-zhiyu-notify.mjs:21` | 测试 | 是 |
| 7 | `scripts/test-zhiyu-duty.mjs:33` | 测试 | 是 |
| 8 | `scripts/test-zhiyu-router.mjs:37` | 测试 | 是 |
| 9 | `scripts/test-zhiyu-rooms.mjs:21` | 测试 | 是（:70/:111/:162 有 404 断言） |
| 10 | `scripts/test-zhiyu-widget.mjs:28` | 测试 | 是（:104/:273 有 404 断言） |

→ 只改生产 #1；9 套测试零改动。这也是 D1 选「可选 `deferNotFound` 默认 false」而非「直接删内联兜底」的硬依据。

### 1.2 装配边界（按 apply 时当前文件重核，行号较立案时有位移）

```
gateway/index.js:866  const zhiyu = registerZhiyuRoutes(app, { …, deferNotFound: true })
gateway/zhiyu/index.js:1241ish  registerZhiyuImBridge(app, …)   ← 在兜底之前，正常
gateway/index.js:889  registerFleetRoomBridge(app, { store: zhiyu.store, … })
gateway/index.js:918  zhiyu.registerNotFound()                 ← 新增，最后一个 zhiyu 注册
gateway/index.js:1126 app.use(async (req,res) => …dispatchToCell)  ← cell 代理全局兜底
```

`awk` 扫描 889~1126 之间**无任何 `/api/zhiyu/*` 路由注册**，确认收尾调用点完备（D4）。

### 1.3 修复前基线

- `node --test scripts/test-fleet-room-bridge.mjs` → **6/6 绿**（桥业务逻辑套件全绿，却测不到装配顺序——正是事故成因）。
- 生产四端点 404 的四路交叉实证（公网 curl / 浏览器同域 fetch / pod 内 :3100 直连 / 本地最小 Express 复现）见 `optimize-zhiyu-behavior-walkthrough/evidence.md` §3.5。
- **判据纪律**：以上「测试绿」不得当作「端点可达」；可达性须由 3.x 的装配顺序测试与出片后真机复验证明。

## 2. 实现（2.x）

| 文件 | 改动 |
|---|---|
| `gateway/zhiyu/index.js` | 函数签名新增 `deferNotFound = false`（带注释说明生产为何要 defer）；把内联 `app.all(/^\/api\/zhiyu(\/.*)?$/, …404)` 抽成 `const registerNotFound = () => {…}`；`if (!deferNotFound) registerNotFound();`；返回对象新增 `registerNotFound` |
| `gateway/index.js` | `registerZhiyuRoutes(app, {…})` 传 `deferNotFound: true`；在 `registerFleetRoomBridge` 块之后、cell 代理之前调用 `zhiyu.registerNotFound()`，带注释钉住顺序约束 |
| `gateway/fleet-room-bridge.js` / `gateway/zhiyu/store.js` / `gateway/zhiyu/im-bridge.js` | **零改动**（`git diff --name-only -- gateway/ scripts/` 仅两个预期文件） |

`registerNotFound()` 函数体只做 404，无鉴权、无代理（D2 已核）。

## 3. 装配顺序集成测试（3.x）

新增 `scripts/test-zhiyu-route-assembly.mjs`，同一 `express()` 按生产顺序装配，临时 SQLite `dataRoot`、固定 `resolveUser`、含一支自有团队的 `sampleFleets` stub、会记命中数的 cell 代理 stub。

```
node --test scripts/test-zhiyu-route-assembly.mjs   → 5/5 PASS

✔ production assembly: four fleet-bridge endpoints are reachable
✔ production assembly: ownership gate still rejects foreign fleets indistinguishably
✔ production assembly: unmatched /api/zhiyu/* still 404s and never reaches the cell proxy
✔ regression gate: moving the 404 guard before the bridge makes endpoints unreachable
✔ default assembly: inline 404 guard is unchanged when deferNotFound is omitted
```

覆盖 3.2（GET/POST/DELETE subscriptions + dryRun summon 均非 404；合法订阅 201、回读 1 行、DELETE 200；非自有团队与陌生人同形 404）、3.3（未匹配路径 404 且 cell 代理命中数 0）、3.4（**负例**：故意把兜底提前，四条端点全部回 404，复现缺陷形状）、3.5（对照组：不传 `deferNotFound` 时内联兜底仍在）。

**过程中抓到并修正一处测试自身缺陷**：初版把 cell 代理 stub 挂在 `registerNotFound()` 之前，未匹配路径先落到 599。这正是 D4「兜底必须在 cell 代理之前」的约束，把 stub 移到收尾之后即 5/5 绿——测试本身因此也验证了这条装配纪律。

### 3.6 全量回归

```
node --test <13 个 zhiyu 套件，含既有 12 + 新增 1>   → 81/81 PASS, 0 fail
```

其中 10 个 `registerZhiyuRoutes` 既有调用方套件全绿，证明默认内联兜底逐字节未变。

## 4. 本地门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（`tsc --noEmit`） | 绿 |
| `npx biome check gateway/index.js gateway/zhiyu/index.js scripts/test-zhiyu-route-assembly.mjs` | 绿（初版 1 个 `noUnusedFunctionParameters` 警告已修：`req` → `_req`） |
| `npm run lint`（全仓） | **7 errors / 3 warnings**，落点全在 `facet/preview-sandbox.js`、`facet/studio.js`、`facet/web/src/StudioView.tsx`、`scripts/lib/test-fleet-promotion.mjs`、`scripts/studio-store-migrate.mjs`、`scripts/test-facet-studio.mjs` —— 并发会话在途改动，**与本次三个文件无关**；触碰文件单独 biome 0 error |
| `openspec validate fix-zhiyu-fleet-bridge-route-order --strict` | `Change … is valid`，EXIT=0 |

## 5. 未执行（需用户拍板）

- **4.3 出片 / 4.4 真机复验 / 4.5 tick 观察 / 4.6 回填走查单 / 5.1 O0 解除 / 5.2 归档** 全部未做。出片是生产动作，且依赖源提交 + 镜像构建 + GitOps 滚版（GH Actions 计费墙期间需走 cheap-3 旁路）；在本轮「apply」授权范围内只完成了本地代码与测试。
- 因此 `optimize-zhiyu-behavior-walkthrough` 的 O0 **仍为 P0 未解除**，该单 12/23 状态不变；本单任务 4.3–4.6、5.1–5.2 保持未勾，零假绿。

## 6. 结论

本地部分**已完整闭环**：三处代码改动 + 新增防回归闸 + 81 测试绿 + typecheck/biome/validate 绿。修复在**代码层**成立，但生产端点可达性尚未实证——必须出片后按 `optimize-zhiyu-behavior-walkthrough` 2.4/2.6 判据复验才能标 O0 已解除。
