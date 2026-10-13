# single-source-desktop-runtime — Design

## 前置与现状

依赖 `unify-dsh-generation` 落地：矩阵 manifest 已是单行统一代、prune.json 与 boot 门允许缺席机制已建立。本 change 把"桌面的运行时来源"接到同一源头，并顺带让服务器镜像应用树瘦身。

现状机制（将被替换）：

- 根 `package.json` 41 行 dsh 行 = 桌面闭包供给（桌面上无 `DSH_BIN`，app 树即运行时；`dsh-profile.js` 的 RUNTIME_NODE_MODULES 回退 `APP_NODE_MODULES`）。
- `scripts/hoist-dsh-runtime.mjs`：把 dsh **嵌套树**（`node_modules/@deepseek-ai/dsh/node_modules`）拷到顶层——历史上 electron-builder 的静态依赖走会丢动态加载组件（v1.3.2/1.3.3 win 事故）。
- `electron-builder.js:42-43`：显式拷贝嵌套树 `node_modules/@deepseek-ai/dsh/node_modules/**`。
- 0.2.0 后两个前提俱变：全家族硬依赖使嵌套树近乎空置（npm 顶层平铺），hoist 的"嵌套→顶层"语义失效。

## D1 — 根 manifest 瘦身（41 → 8）

保留行 = 平台代码直接 import 的包（2026-10-14 盘点，grep 全仓非 node_modules 的 `from "@deepseek-ai/`）：

| 包 | import 面 |
|---|---|
| dsh-sdk-client | HarnessClient ×6、TransportClosedError |
| dsh-sdk-jsonrpc-server | HarnessSdkJsonRpcServer（a2a serving） |
| dsh-tools | defineTool ×3（桥插件） |
| dsh-scope | createScope、scopeOf |
| dsh-session | SessionId |
| dsh-system-prompt | 默认导出 |
| schemastery | ×4 |
| cordis | ×1 |

版本全部跟矩阵意图条目同代（0.2.0-rc.2 及后续跳版同步）。删除的 33 行是运行时承重行——其职能整体移交矩阵安装步骤。风险点：某行若被间接解析依赖隐式承重（如 pnpm-workspace/cordis patch 引用名），实现时以"删行后 predist 全量 win/mac 冒烟"兜底。

## D2 — predist 矩阵安装步（新）

`predist` 序列（现有：fetch-build-icon → build-node → hoist-dsh-runtime → verify-bundle）插入替换：

1. `npm ci --prefix <staging>`（staging = 构建临时目录，源 = dsh-matrix manifest+lock+.npmrc）——与 Dockerfile 的 /opt/dsh 安装完全同构。
2. 按 `dsh-matrix/prune.json` 剪枝（与镜像共享名单，不建副本）。
3. 并入 app `node_modules`：staging 平铺树逐包拷入顶层（替代旧 hoist 的嵌套→顶层拷贝；`hoist-dsh-runtime.mjs` 改源为此 staging 树，幂等语义保留——已存在的顶层包不覆盖，npm 已验证的解析优先）。
4. `verify-bundle.js` 增断言：包内 `@deepseek-ai/dsh` 存在且版本 = 矩阵意图条目。

electron-builder.js 的嵌套树拷贝行（42-43）删除；`files` 列表的 `node_modules/@deepseek-ai/dsh/node_modules/**` 行同步删（0.2.0 后该目录空置，显式声明反成误导）。瘦身排除规则（`!node_modules/**/{*.md,...}`）沿用。

## D3 — 桌面运行时解析不变式

`dsh-profile.js` 的 `RUNTIME_NODE_MODULES` 推导不变：无 `DSH_BIN` 时回退 `APP_NODE_MODULES`——桌面 app 树在 predist 后含矩阵闭包，桥插件链接（`PROFILE_BRIDGE_PACKAGES`）继续从同一棵树取，realpath 单例约束（2026-10-09 Symbol 事故的修复）自然保持。`Links point at the app's own copies` 的既有合同语义不变。

## D4 — 镜像顺带瘦身

根 manifest 删 33 行后，Dockerfile 的根安装层（`npm ci --omit=dev`）自然不再装运行时闭包，`/app/node_modules` 的 @deepseek-ai 面缩到 8 包（~5MB）；`/opt/dsh` 路线零变化。无 Dockerfile 改动需求——除一处复核：根安装行的 `--legacy-peer-deps` 已在 unify 摘除，本 change 后根树连"两代并存"的形态都消失，ESM 解析面更简单。

## D5 — 验收门

- `win-install-smoke` 全跑（Windows 打包历史四轮修复的教训：builder 闭包走丢是高发区；本 change 改的就是闭包来源）。
- mac dmg 构建 + 首启冒烟（dsh 子进程起、模型名册投影、一次工具调用回合）。
- 镜像侧：构建后 `du` 复核 /app/node_modules @deepseek-ai 面缩量（预期 ~5MB）；boot 冒烟不变绿即回退。
- verify-bundle 新断言进 predist 必跑。

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 删行伤及隐式承重 | predist 全量冒烟兜底；发现即把该包升格为"直接 import 盘点"补行（有明确判据） |
| Windows builder 闭包走丢复发 | win-install-smoke 是硬门；hoist 幂等语义保留 |
| staging 并入与 npm 顶层冲突 | 沿用 hoist 的"不覆盖已存在顶层包"纪律；verify-bundle 版本断言卡漂移 |

回滚线：根 manifest revert（41 行形态是 git 历史，一个 revert 即回）；predist 步独立成脚本可单独禁用。
