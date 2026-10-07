# add-ecosystem-bridge — Tasks

## 1. 切片 A：入向精选管线

- [x] 1.1 fd-1.32 代理兼容性核查：结论=传输/协议层兼容（SDK 双传输+浮动下限 `mcp>=1.9.3`、线上 wire 真回合+401 探针实证）、stdio server 包 HTTP 壳（1.4 决议）、逐 server 走既有探测机器，已记 `docs/registry-fork-patches/2026-10-07-ecosystem-bridge-compat-audit.md`
- [x] 1.2 审校 runbook + checklist 落 `docs/ecosystem-curation.md`（安全/许可证/质量三轴、AGPL 拦截、egress 决议模板、来源标记规范），评审通过为完成
- [x] 1.3 首批白名单定稿：按许可证调研报告（进行中）在 10-15 server / 30-50 技能上限内裁剪，产出含许可证列的清单文档，逐条过 checklist（台账 `docs/ecosystem-curation-ledger.md`：12 server + ~40 技能三源；台面轴已过，入库轴绑 1.4/1.5）
- [ ] 1.4 首批 server 托管上线：每 server 独立容器（cheap 节点，tailnet NodePort）+ 逐个 egress 白名单 + 注册处注册 + 健康探测，容器环境凭据扫描为零平台凭据（探针脚本验证）
- [ ] 1.5 首批生态技能入库：走注册处技能目录渠道，条目带来源仓库+许可证+生态标记；壹座 Store 单装实测 + pack 引用实测各一条
- [ ] 1.6 首个官方功能集发布：开源技能+开源 MCP+自家数据 MCP+persona 组配（vertical-packs 配方），端到端验过（装进 cell 真回合）

## 2. 切片 B：出向 CLI 与市场端点

- [x] 2.1 CLI targets 扩展：zcode / codex / gemini-cli 三个 target 的技能目录约定实现 + `--project` 语义对齐，`facet install --target <t>` 每家实测落盘正确
- [x] 2.2 `facet connect` 粘贴流：打开铸造页 → 粘贴 wgk- → 网关验活 → 本地 0600 存键 → `--clear` 清除；死键/吊销键拒收带原因，单测覆盖
- [x] 2.3 持键写 MCP 配置：install 时对 MCP 引用征得同意写各 target 原生 MCP 配置（端点+Authorization 头），输出所写文件清单；无键时行为与 v1 完全一致（回归）
- [x] 2.4 device flow 升级位：CLI connect 命令保留设备授权分支（谱系侧未暴露时自动回落粘贴流），含回落路径单测
- [x] 2.5 marketplace.json 端点：facet 生成 Claude 插件市场格式清单（仅公开精选、MCP 只做连接指引、≤1h 缓存头）；生产探针全绿 2026-10-07（200/8 packs/plugin.json+README 可取/缓存头/max-age=3600），真机 `/plugin marketplace add` 走查留使用侧验收
- [ ] 2.6 CLI 发版：`@finddatatechnology/facet` 新版本发布 npm，五 target + connect 冒烟（tags 一次发齐）

## 3. 切片 C：计费收口与社区准入

- [ ] 3.1 wire 线 sub2api 入账管道：**代码+测试+演练+部署 2026-10-07（fd-wire api/web sha-4bd707c 上线）**（归属修正：改动落 fd-wire 而非 fork——`fd_wire_api/metering/driver.py` 周期 poll→settle 驱动挂 lifespan，8/8 单测 + 495 全量回归绿；闭月语义修正：settle 只结已关闭月，月内靠预检+预警，防整月幂等键固化吞增量）；**余部署+真回合记账实证**（fd-wire 部署配 REGISTRY_MONGO_URI + SUB2API_ADMIN_KEY 后首月 rollover 观察）
- [x] 3.2 账本硬停：账本路径降级时按硬停上限拒入（fail-closed），演练脚本实证「降级不放行无计量调用」（`fd-wire/scripts/drill_metering_hardstop.py` 四轮全绿：闭月入账恰一次/当月只计量/降级零丢失零落账/恢复幂等重放；预检侧 402/503 已活链实证 2026-10-05）
- [ ] 3.3 key 月度免费额度：**代码+测试完成 2026-10-07（fork 分支 fd-call-grant，两 commit）**——每**属主**月度池（名下全键共享，防 20 键×5k 滥用乘法；spec 措辞已按此理解）、仅 tools/call 计数、402 GRANT_EXHAUSTED/503 GRANT_UNAVAILABLE fail-closed、`GET /api/patch-keys` 带 {month,used,limit}、CALL_GRANT_* env 默认惰性；23/23 单测绿、auth-server 套零回归（基线 8F/13E 预存在）；**余部署开闸（env）+ 活链实测**
- [ ] 3.4 community 组与付费档：**代码+IAM 落产 2026-10-07**——fork：IDP_USER_GROUP_DEFAULTS（干净 miss 才发默认组、显式空记录抑制、库故障 fail-closed）+ CALL_GRANT_TIER_SERVERS 档位门（402 TIER_REQUIRED 先于 scope 403）；prod IAM：`mcp-community-read` scope 已插（fd-open-data-mcp+fd-cn-report，groups=[community]，备份在 cheap-1 /tmp）、law-bench 维持 legal 组=付费档；**余部署 env（DEFAULTS=community、TIER_SERVERS=law-bench:paid）+ community 键实测（升降档=组分配免重铸）**
- [ ] 3.5 Logto 公开注册开放 + 自助铸键面走通：注册→验活→community 键可读公开数据 server，全程零运营介入（真浏览器走查）

## 4. 切片 D：出向文档与收尾

- [x] 4.1 各 harness 接入指南：claude-code / cursor / zcode / codex / gemini-cli 五篇（发现→connect→install→验证），每篇含一条可复制的端到端命令序列
- [x] 4.2 A2A 车道对外示例：萬星 Agent 服务的 A2A 调用文档 + 最小 curl/SDK 示例（docs/ecosystem/a2a.md：agent 列表/card/message/send、幂等头、错误面、双车道选型表；计费维持 ADR-0014 双轨不并轨）
- [x] 4.3 ADR-0017 追记：入向生态互操作触发的兼容性核查结论与 MCP 语义冻结条款的复核结果，落 ADR 修订（2026-10-07 修订节：冻结面比假设窄——SDK 传输栈浮动、注册处 API 冻结；谱系不变、出局规则在谱系台账）
- [x] 4.4 探针与观测：`scripts/probe-ecosystem-bridge.mjs` 部署后生产全绿 2026-10-07（sha-fc636d9）

## 5. 悬置（探查回收后归位）

- [ ] 5.1 OAuth 发现定档：**已定档 v1（小补丁档，2026-10-07 探针，详见 design.md Open Questions）**——余实现三件：①激活 live registry auth provider 使 well-known 路由活（配置+部署，fd 线）；②DCR shim（registration_endpoint 自有端点代理静态 Logto app，限速）；③修 401 双 WWW-Authenticate 头；完成判据=真机 Claude Code 零输入连 fd-open-data-mcp 全链通
