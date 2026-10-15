# Tasks: add-desktop-fleet-runner

## 1. runner 监听 host 配置化（云端零变化）

- [x] 1.1 `agent-runner/config.js`：加 `host: env.AGENT_RUNNER_HOST || "0.0.0.0"`
- [x] 1.2 `agent-runner/index.js` ops listen 与 `agent-runner/manager.js` agent listen
      改用 config host（manager 需把 host 传入 listener 创建处）
- [x] 1.3 既有 runner 测试全绿（宿主行为零变化断言）

## 2. supervisor 插件描述符

- [x] 2.1 `supervisor/descriptors.js`：新增 `agent-runner-js`（optional、
      enabled=`WANXING_PLUGIN_ENABLED==="1"`、healthPath `/health`、端口
      `AGENT_RUNNER_PORT||8790`、桌面 env 全套注入：DSH_BIN/AGENT_RUNNER_HOME/
      POD_MODE=1/HOST=127.0.0.1/FLEET_ID=机位 id/DEFAULT_ID=cloud-default/
      AGENT_SERVING_REGISTRY_URL/TOKEN 透传）
- [x] 2.2 确认 Supervisor 对 disabled/optional 语义无需改动（start 跳过、降级不挡）

## 3. 机位 id 种子

- [x] 3.1 `electron/bootstrap/first-run.js`：idempotent 种子
      `WANXING_PLUGIN_RUNNER_ID=desktop-<8hex>`
- [x] 3.2 descriptors 从 agentEnv 读该 id 拼 FLEET_ID

## 4. Preferences 舰队设置区

- [x] 4.1 `electron/preferences/`（renderer+ipc）：萬星舰队区——开关、registry URL、
      token（掩码显示）；白名单通道沿用 `settings:get-visible`/`settings:set-field`
- [x] 4.2 保存写 settings.json 原子写；开关项提示「重启应用生效」
- [x] 4.3 registry URL 为空时开关保存给出前置校验提示

## 5. 测试

- [x] 5.1 `scripts/test-desktop-fleet-runner.mjs`：五测（默认禁用/启用注入/host 两态/
      种子幂等/分片哨兵排除 untagged）
- [x] 5.2 全量 Node 测试道（`node scripts/test-*.mjs` 相关子集）绿

## 6. 验收探针（真回合）

- [x] 6.1 `scripts/probe-desktop-fleet-runner.mjs`：stub registry+桌面 env 起 runner →
      tagged 条目拉起 → A2A message/send 真回合（rehearsal LLM 配方）→ 断言
- [x] 6.2 探针含退出 drain 断言（无孤儿 dsh 进程）

## 7. 收尾

- [x] 7.1 docs：`docs/wanxing-desktop-fleet-plugin-explore.md` 切片①打勾落账
- [x] 7.2 openspec validate 全绿；实施中发现的偏差回写 design
