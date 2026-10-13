# single-source-desktop-runtime — Tasks

> 前置：`unify-dsh-generation` 已合并落地（矩阵单行 manifest + prune.json + boot 门允许缺席机制在产）。

## 1. predist 矩阵安装步

- [ ] 1.1 新脚本 `scripts/install-dsh-matrix.mjs`：staging `npm ci`（源 dsh-matrix manifest+lock+.npmrc）→ 按 prune.json 剪枝 → 平铺树并入 app node_modules（不覆盖已存在顶层包）
- [ ] 1.2 `hoist-dsh-runtime.mjs` 改源：嵌套树（0.2.0 后空置）→ staging 矩阵树；幂等语义保留
- [ ] 1.3 predist 序列接线：install-dsh-matrix 替换原 hoist 位置；verify-bundle 增断言（包内 dsh 版本 = 矩阵意图条目）
- [ ] 1.4 electron-builder.js：删嵌套树拷贝行（42-43）与 files 列表的 nested 声明行

## 2. 根 manifest 瘦身

- [ ] 2.1 删除 33 行运行时承重行，保留 8 行直接 import 包（dsh-sdk-client / dsh-sdk-jsonrpc-server / dsh-tools / dsh-scope / dsh-session / dsh-system-prompt / schemastery / cordis），版本跟矩阵意图条目
- [ ] 2.2 根 lock 重生成；本地 `npm ci` + `npm run web:build` 通过
- [ ] 2.3 删行后 predist 全量冒烟：发现隐式承重包即升格补行并落账（design D1 判据）

## 3. 验收

- [ ] 3.1 win-install-smoke 全跑（硬门）
- [ ] 3.2 mac dmg 构建 + 首启冒烟（dsh 子进程起、模型名册、一次工具调用回合）
- [ ] 3.3 镜像复核：/app/node_modules @deepseek-ai 面缩至 8 包（~5MB）、boot 冒烟绿、镜像体积落账
- [ ] 3.4 桌面包体积落账：dsh 载荷 ~516MB → ~324MB（剪后闭包）

## 4. 文档

- [ ] 4.1 dsh-matrix/README.md 增"桌面同源"一节（predist 路线 = 镜像路线共享 manifest 与 prune 名单）
- [ ] 4.2 若压缩诉求延续：开"桌面首启下载运行时"独立 explore 的提案记录（不在本 change 实施）
