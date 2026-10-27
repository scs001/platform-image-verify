# 任务：add-browser-use-lane

## 1. 车道条目与供给门

- [ ] 1.1 `platform.bundle.json` 增 `playwright` 条目（`@playwright/mcp` 钉版、headless、bundled+locked 口径照 chatwoot/websearch 先例注释）；`mcp.example.json` 样例同步扶正为带启用说明的注释块
- [ ] 1.2 `dsh-profile.js` `writeMcpPatch` 供给门扩展：`BROWSER_RUNTIME_PATH`（文件存在）→ local、`BROWSER_CDP_ENDPOINT` → remote、`BROWSER_LANE=off` 或双缺席 → 整条省略 + info 日志（requiresEnv 省略族同族语义与日志格式）
- [ ] 1.3 单测/合同级验证：三种供给形态各自的 patch 形状（local 含 launch 配置、remote 含 endpoint、absent 无条目）+ off 压制双供给；挂进既有 dsh-profile 测试族

## 2. 镜像与部署

- [ ] 2.1 Dockerfile 浏览器层（依赖层后 + `BROWSER_RUNTIME_PATH` 注入同一 RUN）；`fd-build-channel` 核对构建额度口径后选择通道出片
- [ ] 2.2 镜像冒烟扩「headless launch + 导航」断言；冒烟失败=镜像不 GREEN
- [ ] 2.3 `.env.example` 增 `BROWSER_LANE`/`BROWSER_CDP_ENDPOINT`/`BROWSER_RUNTIME_PATH` 三旋钮说明（含远程端点信任警告）；DEPLOY.md 车道段

## 3. 能力实证

- [ ] 3.1 cell 内真操作实证：生产走查账号 cell（滚版后）agent 完成「导航→读取标题→截图」全链，工具渲染链眼见（tool_start/update/end 事件名 `mcp__playwright__*`）
- [ ] 3.2 per-cell 共享语义实证：会话 A 登录态在会话 B（同 cell）复现；另一用户 cell 零泄漏（台账 D4 口径）
- [ ] 3.3 缺席形态实证：临时部署无 runtime 无端点 → patch 无条目、工具清单无 browser 工具、其余一切正常

## 4. 文档与收口

- [ ] 4.1 CLAUDE.md 车道段 + AGENTS.md 运维口径（含 fd 出片通道记录）；台账 registry-maintenance §记档（体积、版本钉、通道）
- [ ] 4.2 桌面 opt-in 文档（mcp.example.json 注释块文字定稿）；可视窗二期候选记挂账
- [ ] 4.3 A2 替换预案挂账：port-dsh-0.2.1 任务尾挂「官方 bundle 经 plugin-supply 替换 mcp 直连条目 + 工具引用点普查」
