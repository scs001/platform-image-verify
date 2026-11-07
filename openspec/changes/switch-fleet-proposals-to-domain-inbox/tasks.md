# 任务：switch-fleet-proposals-to-domain-inbox

> 依赖：law-bench `add-domain-first-workbench`（C5）已验收（2026-11-08）。本 change 在 paas 根。
> 先取证再改代码：§1 不完成，不得动出口函数。

## 1. 取证（先钉事实）

- [x] 1.1 定位提案岗今天的**全部**提交出口：生产里草案从哪条路径进柏讯动作审批队列（MCP 工具 / HTTP 客户端 / 岗位脚本），列出每个调用点文件与函数；把结论写进 `design.md` 的「切换点」一节（覆盖「不止一个调用点」的情形）
- [ ] 1.2 记录切换前基线：一轮真跑后柏讯队列新增的本体类提案条数（判据 D5 的对照左值）

## 2. 客户端

- [ ] 2.1 `bench proposal` 客户端单函数命令式（目标 URL / 凭据 / 域 key 全来自 env，`transport=` 注入缝，超时与异常分类：400-缺依据 / 400-词汇表 / 403-跨域 / 401-凭据 / 5xx / 超时）
- [ ] 2.2 token 脱敏（对端回显、异常消息、报告三处零明文；沿 `bench_pull/client.py` 同款 min-length 守卫）
- [ ] 2.3 缺凭据/缺域 key：启动不崩，本轮失败并报明 env 名；不退化到任何缺省域

## 3. 切换

- [ ] 3.1 出口函数目标改为域提案箱；身份行按 D2 组装（`source/kind/external_key/evidence/submitted_by`），去掉动作提案的目标账号字段
- [ ] 3.2 岗位配置新增 `BENCH_PROPOSAL_DOMAIN`（与岗位 `target` 同源），`deploy/README.md` 补三个 env
- [ ] 3.3 柏讯侧本体类提案写入关停；客户侧域动作语义零变化
- [ ] 3.4 本轮报告字段：每条一条结果（新增 / 幂等命中 / 失败 + 对端语义），失败项标明草案仍保留

## 4. 测试

- [ ] 4.1 契约测试（注入 transport）：一条成功、四类错误（缺依据 / 出表 kind / 跨域 / 凭据）、幂等命中、超时
- [ ] 4.2 纪律测试：被驳回后同依据不再自动重试、换依据可重提
- [ ] 4.3 报告测试：失败不得渲染为成功；token 零出现
- [ ] 4.4 全量既有测试零回归

## 5. 收口

- [ ] 5.1 `openspec validate switch-fleet-proposals-to-domain-inbox --strict` 绿
- [ ] 5.2 一轮真跑两侧对照：知验台域提案箱 +N 且控制台可见；柏讯队列本体类 +0（与 1.2 基线比）
- [ ] 5.3 真确认一跳：域负责人在 `/d/{key}/inbox` 确认一条舰队草案 → `knowledge_units` 出现该键 + `authoring_events` 一行（复用 C5 验收 §5.3 的判据）
