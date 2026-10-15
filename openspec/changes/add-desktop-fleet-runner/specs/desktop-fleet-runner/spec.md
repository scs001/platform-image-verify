# desktop-fleet-runner — Spec Delta

## ADDED Requirements

### Requirement: 萬星插件预装禁用

桌面发行版 SHALL 预装 agent-runner 的全部运行代码，且默认禁用：未启用时 supervisor
不启动任何 runner 进程。启用 SHALL 经 Preferences 设置开关持久化到 settings.json，
并在应用重启后生效。

#### Scenario: 默认安装不启 runner

- **WHEN** 应用以默认设置启动
- **THEN** supervisor 将 `agent-runner-js` 标记为 disabled，不派生任何 runner 进程

#### Scenario: 开关启用后 runner 起来

- **WHEN** 用户在 Preferences 打开萬星舰队开关、保存并重启应用
- **THEN** supervisor 启动 `agent-runner-js` 且其健康探针转绿

#### Scenario: 插件失败不挡主应用

- **WHEN** runner 进程启动失败或持续不健康
- **THEN** supervisor 将其标记 unhealthy 并记录，主应用（对话 cell）照常可用

### Requirement: 机位身份独占

启用萬星插件时，桌面 runner SHALL 以持久化的独占机位 id 运行：id 首次生成后存
settings.json，此后每次启用沿用。runner 的默认分片 id SHALL 显式设为与机位 id 不同
的值，使桌面只拉取 descriptor 显式 tagged 给该机位 id 的部署条目。

#### Scenario: 云端 untagged 条目不上桌面

- **WHEN** registry 持有无 `runner_id` 标记的条目（云端默认机位的分片）且桌面 runner
  轮询
- **THEN** 桌面不托管这些条目

#### Scenario: tagged 条目被桌面拉起

- **WHEN** registry 持有 `runner_id` 等于桌面机位 id 的条目且桌面 runner 轮询
- **THEN** 桌面托管该条目并按部署描述符起 runtime

#### Scenario: 机位 id 跨重启稳定

- **WHEN** 插件停用后再启用
- **THEN** runner 沿用同一机位 id，其名下条目不换归属

### Requirement: 桌面机位对云端调度隐形

桌面 runner SHALL 可配置向 fleet observer 上行遥测（`runner_stats` 携带
`desktop: true` 自报）；未配置上行时对 board 彻底不可见。云端调度控制循环 SHALL
在一切控制决策中排除桌面机位：其心跳过期不触发条目重派（关 app ≠ 机位死亡），
其被 board 剪除不触发孤儿回收（条目等待回归），其永不作为重派或自动选址的
目标机位。监控可见性与调度控制权分离——board 能看见桌面机位，控制循环不能动它。

#### Scenario: 关闭应用不触发重派

- **WHEN** 桌面 runner 离线（应用退出）超过云端 stale 阈值且云端存在健康 runner
- **THEN** 该机位名下的 registry 条目不被修改，仍指向桌面机位等待回归

#### Scenario: 上行自报使调度排除生效

- **WHEN** 桌面 runner 上行 `runner_stats`（payload 含 `desktop: true`）且其 id
  不带 desktop- 前缀（自定义机位名）
- **THEN** 该机位不出现在调度循环的健康目标集合中，自动选址永不落在它上面

#### Scenario: 机位被 board 剪除后条目仍等待

- **WHEN** 桌面机位长期离线被 observer 从 board 剪除，其名下条目仍 tagged 该机位
- **THEN** 孤儿回收不接管这些条目（即便机位在机群表有登记行且已过宽限窗）

### Requirement: 桌面监听收紧到回环

桌面 runner 的 ops 监听与每个托管 agent 的 A2A 监听 SHALL 绑定 127.0.0.1；host 绑定
SHALL 可经配置注入，云端部署不注入时保持既有 0.0.0.0 行为零变化。

#### Scenario: 桌面全监听回环

- **WHEN** runner 以桌面环境配置启动
- **THEN** ops 端口与全部 agent A2A 端口仅接受回环连接

#### Scenario: 云端零变化

- **WHEN** runner 以不注入 host 配置的既有环境启动
- **THEN** 监听地址与改动前逐字节一致（0.0.0.0）

### Requirement: 生命周期跟随应用

桌面 runner 的进程生命周期 SHALL 隶属应用会话：应用退出时有序 drain 全部 runtime
children 后退出；runner 异常退出时由 supervisor 按退避序列自动重启。

#### Scenario: 退出时排空

- **WHEN** 用户退出应用（supervisor 有序停机）
- **THEN** 全部 runtime children 被停止后 runner 进程退出，无孤儿进程

### Requirement: 桌面默认 pod 密度

桌面 runner SHALL 默认启用 pod 共宿模式（同 pack 的 serving agents 共享一个 runtime
进程），warm-zone 预算与逐出照常生效。

#### Scenario: 同 pack 双 agent 共宿

- **WHEN** 同一 pack 的两个 serving agents 部署到桌面机位
- **THEN** 二者共享一个 pod runtime 进程，各自持有独立监听端口
