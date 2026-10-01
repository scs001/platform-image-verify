## 1. dsh-matrix 清单与 lock（design D1–D4）

- [x] 1.1 建 `dsh-matrix/package.json`（意图钉版：dsh / dsh-base / dsh-sdk-jsonrpc-server / dsh-sdk-protocol 全部 0.1.1-rc.2；cordis-plugin-group 直接依赖；cordis-plugin-hmr 直接依赖 + overrides 钉 1.0.16）与 `dsh-matrix/.npmrc`（不含 legacy-peer-deps）；在目录内生成 lock。验证：lock 生成无错；若 peer 冲突暴露，按 D4 裁决（protocol 备选 0.0.1-rc.5 全树统一）并把"为什么"写进 manifest 注释
- [x] 1.2 用 lock 在 scratch 目录做一次干净 `npm ci`。验证：18 个仅 peer 可达的插件包全部落盘（点名抽查 dsh-sandbox、dsh-workflow、dsh-atomic-write）；cordis-plugin-hmr 解析为 1.0.16；sdk-protocol 全树仅一个版本。lock 为生成物，此后不手编辑（同 skills.ts 惯例）

## 2. 启动硬门（design D5、spec 第 3 条需求）

- [x] 2.1 实现纯 JS 校验模块 `lib/dsh-matrix-verify.js`（零 dsh import）：读 lock、遍历安装树顶层包、产出 {extra, missing, mismatch} 偏差报告。验证：对 scratch 正常树返回空报告；人为删一个包/改一个版本能各自报对类目
- [x] 2.2 接入 `server.js` 启动早期：有偏差且未设 `DSH_MATRIX_OVERRIDE=1` → 打印包级 diff 后退出；设了 → 打印 diff + 逃生口标记放行；矩阵安装根不存在 → 跳过。验证：本地开发机正常启动（跳过路径）+ 篡改树的两个分支行为
- [x] 2.3 同款接入 `agent-runner/index.js`。验证：runner 本地启动不受影响，篡改分支复用 2.1 模块行为
- [x] 2.4 新增 e2e `dsh-matrix-lock.spec.js`（沿用 per-spec DSH_HOME 模式）：篡改 scratch 树 → 拒启且日志含包级 diff；设逃生口 → 放行且日志含标记；无矩阵 → 跳过启动。三场景全绿

## 3. Dockerfile 切换（design D1、spec 第 1/2 条需求）

- [x] 3.1 重写 dsh 安装层：COPY dsh-matrix，单次 `npm ci --prefix /opt/dsh`（union 树）；/opt/dsh-home/profiles/platform 保留四个 scaffold 文件、node_modules 改软链 → /opt/dsh/node_modules；删除 28 行手写钉版与过时注释（hmr/peer 知识迁至 manifest 注释）。验证：docker build 成功
- [ ] 3.2 本地起镜像冒烟：boot + sdk-client initialize 握手 + presets/permissions RPC 探针（沿用 post-deploy probe 脚本模式）。验证：握手成功、preset 组合经软链正常解析、名册投影与切换前一致
- [ ] 3.3 镜像内容物核对：/opt/dsh 实际树逐包对齐 lock；原两树不再各存一套 @deepseek-ai 版本。验证：`npm ls --prefix /opt/dsh`（或等价遍历）零 extraneous/missing

## 4. writer 参数化与 compose.js 收编（design D6）

- [x] 4.1 dsh-profile.js 各 writer（presets/permissions/mcp/skills/chart-bind patch、credentials）改为接受显式目标 profile 路径；模块内现有调用点传 DSH_HOME 派生值，行为不变。验证：本地 boot + 一次模型切换 + 一次预设切换照常（重启路径不回归）
- [x] 4.2 `agent-runner/compose.js` 删除镜像格式代码，改 import 这些 writer（传自己的 homeRoot）；删除"formats mirrored / drift risk accepted"注释块。验证：对同一角色描述符，改造前后物化的 home 逐文件一致（diff 验证）
- [ ] 4.3 回归：custom-presets、pack-agent-scoping、focus-overlay、agent-presets 四个 e2e 全绿

## 5. 发布链（design D7 / Migration Plan）

- [ ] 5.1 推 staging（cheap1 runner + 沙箱 cell）：验证 agent-runner 角色组合与共享运行时两条路径（runner 对外 A2A 一轮对话 + cell 内一次 preset 切换），硬门日志行出现且通过
- [ ] 5.2 fd-prod 常规窗口上线 + post-deploy probe；确认硬门通过日志与会话/任务冒烟全绿。回滚预案：回滚镜像 tag（旧镜像无硬门，天然兼容）
