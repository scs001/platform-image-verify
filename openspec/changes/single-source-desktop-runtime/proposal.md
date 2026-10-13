# single-source-desktop-runtime

## Why

`unify-dsh-generation` 把全平台 dsh 统一到 0.2.0-rc.2 后，桌面包面临过渡性膨胀：根 `package.json` 仍保留 41 行 dsh 运行时行（历史上为桌面承重），0.2.0 全家族硬依赖使桌面闭包从"漏装 peer 的残缺 56MB"涨到 ~516MB。同时服务器镜像 `/app/node_modules` 里这 41 行运行时行是纯死重（`DSH_BIN` 已钉 `/opt/dsh`，只为桌面存在，~50MB）。

根因是"桌面的 dsh 运行时来源"从未单源化：桌面靠根 manifest 的行 + 嵌套树 hoist 拼出闭包，与 dsh-matrix 各自为政。0.2.0 全家族硬依赖化（嵌套树语义消失）正好是重建这条通路的时机——桌面与服务器从同一份矩阵 manifest 取运行时，版本真相收敛为一处。

## What Changes

1. **根 manifest 瘦身**：`package.json` 的 41 行 dsh 行收敛为 8 行平台真实 import 包（dsh-sdk-client、dsh-sdk-jsonrpc-server、dsh-tools、dsh-scope、dsh-session、dsh-system-prompt、schemastery、cordis——以实际 import 盘点为准），版本跟矩阵意图条目。
2. **桌面 predist 矩阵安装**：`predist` 新增一步从 dsh-matrix manifest `npm ci` 出运行时闭包、按剪枝名单（prune.json，与镜像共享）剪枝后并入 app `node_modules`。
3. **hoist 改源**：`scripts/hoist-dsh-runtime.mjs` 的源从"dsh 嵌套树"（0.2.0 硬依赖化后语义消失）改为"矩阵安装的平铺树"；`electron-builder.js` 的嵌套树拷贝行同步调整。
4. **服务器镜像顺带瘦身**：`/app/node_modules` 不再携带运行时行（-~50MB），零额外动作。

## Capabilities

### New Capabilities
（无）

### Modified Capabilities
- `installer-distribution`: 打包闭包来源重塑——从"根 manifest + 嵌套树 hoist"改为"dsh-matrix manifest 单源 + 剪枝名单共享"（requirement 重塑走 REMOVED+ADDED）。
- `dsh-version-matrix`: 新增"应用树 dsh 运行时单源化"约束——根 manifest 只声明平台直接 import 的 dsh 包，运行时闭包只从矩阵来。

## Impact

- 前置依赖：`unify-dsh-generation` 落地（矩阵 manifest 形状与剪枝机制是其产物）。
- 桌面包 dsh 载荷：~516MB（unify 后过渡态）→ ~324MB（剪后闭包）；远期首启下载方案另立 explore，不在本 change。
- 验收面：win-install-smoke 全跑（历史 nested hoist 正是为修 Windows 打包断——v1.3.2/1.3.3 `Cannot find package 'cordis-plugin-group'` 教训在册）。
- 时序自由：与多 agents 功能无依赖，可在 unify 落地后任意窗口执行。
