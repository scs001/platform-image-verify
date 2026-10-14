# single-source-desktop-runtime — Tasks

> 前置：`unify-dsh-generation` 已合并落地（矩阵单行 manifest + prune.json + boot 门允许缺席机制在产）。

## 1. predist 矩阵安装步

- [x] 1.1 新脚本 `scripts/install-dsh-matrix.mjs`：staging `npm ci`（源 dsh-matrix manifest+lock+.npmrc）→ 按 prune.json 剪枝 → 平铺树并入 app node_modules（不覆盖已存在顶层包）→ **再对 app 树应用同一份 prune.json**（第 4 步，实测补：不覆盖纪律使 app 树自带的未剪枝闭包存活，不剪则收益为零）
- [x] 1.2 `hoist-dsh-runtime.mjs` 退役（删除；"嵌套→顶层"语义在 0.2.0 平铺布局下已消失，幂等并入纪律由 1.1 承接）
- [x] 1.3 predist 序列接线：install-dsh-matrix 替换原 hoist 位置；verify-bundle 增断言（包内 dsh 版本 = 矩阵意图条目）
- [x] 1.4 electron-builder.js：删嵌套树拷贝行与 files 列表的 nested 声明行

## 2. 根 manifest 瘦身

- [x] 2.1 删除 30 行运行时承重行，保留 9 行直接 import 包（dsh-sdk-client / dsh-sdk-jsonrpc-server / dsh-tools / dsh-scope / dsh-session / dsh-system-prompt / dsh-llm / schemastery / cordis；盘点含 dsh-llm——原稿漏了它，实测 import 面含），版本跟矩阵意图条目
- [x] 2.2 根 lock 重生成；干净安装（临时树 `npm ci --omit=dev`）exit 0、`npm run typecheck` 绿
- [x] 2.3 删行后 predist 全量冒烟：隐式承重盘点（被删 30 行在干净瘦身树中 0 缺失——全由传递闭包供给，无需升格补行）；`npm run predist` 幂等绿；40/40 bridge/profile 单测 + 149/149 runner/cell 单测 + 16/16 dsh 合同绿

## 3. 验收

- [ ] 3.1 win-install-smoke 全跑（硬门，GHA：公开仓 release 出包后 dispatch）
- [ ] 3.2 mac dmg 构建 + 首启冒烟（dsh 子进程起、模型名册、一次工具调用回合）
- [x] 3.3 镜像复核（本地实证）：app 树经共享 prune.json 剪枝后 @deepseek-ai 面 290 包/219MB → 233 包/33MB（-186MB）；剪后树 boot 实证（`probe-stream-channel --tree .` 热跑 HEALTHY：12 帧、首 delta +633ms、settled yes）；Dockerfile 增 `prune.mjs --tree /app`（镜像 boot 冒烟由 image-build-check 的 /api/ready 硬门在 GHA 复核）
- [x] 3.4 桌面包体积落账（本地）：dsh 载荷 219MB → 33MB（-186MB，= libreoffice-kit 148MB + dsh 自家 UI 38MB）；**最终 dmg/exe 体积以 GHA release 构建为准**（原稿 ~516→~324MB 的差值归因订正：删行不减体积，剪枝才减）

## 4. 文档

- [x] 4.1 dsh-matrix/README.md 增"桌面同源"一节（predist 路线 = 镜像路线共享 manifest 与 prune 名单）
- [x] 4.2 压缩诉求延续 → 已开独立 explore 记录（`notes/desktop-runtime-download-explore.md`，不在本 change 实施）
