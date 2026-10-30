## 1. 规格与决策

- [ ] 1.1 拍板三项未决（公开面名单 / `publicFacing` 是否显式声明 / chat 注入是否裁剪版）并写入 design；验证：design §7 三项均有结论
- [ ] 1.2 spec delta 落三处（agent-fleet-core：B1+B6；pack-authoring：B3；agent-runner：B5），MODIFIED 段带全场景；验证：`npx openspec validate fix-external-team-chat-lane --strict` 绿

## 2. B1 注入缝与派发寻址

- [ ] 2.1 chat 车道起轮点接注入：归因到本队 persona 成员时注入本队上下文（成员 ref/title/目标 + 编导边），未归属不注入；验证：单测（归因成立→注入含本队成员；不成立→prompt 原样）
- [ ] 2.2 注入段复用任务车道渲染器（`applyFleetContext` 同源），chat 版裁剪任务语义（只留名单+可派发目标）；验证：注入段不含报数/拍板等任务语义
- [ ] 2.3 `POST /api/fleets/dispatch` 的 `to` 支持 ref/title（本队内解析，member id 兼容；歧义 400 列候选；跨队 400）；验证：单测（ref 命中/标题命中/歧义/跨队）
- [ ] 2.4 端到端：生产对话里前台拿到名单后派发成功、目标岗位起轮、`/api/fleets/:id/turns` 出现本队回合（走查复测：Q2 三问链）——验证：turns 从 0 变为非 0

## 3. B3 工具面收敛

- [ ] 3.1 manifest 增 `publicFacing` 声明（校验：不与既有键冲突、仅布尔）；验证：schema 单测
- [ ] 3.2 `publicFacing` 下 persona 聚焦只留公开面 + 关工作区文件工具；未声明 pack 零变化；验证：单测（聚焦名单差异）+ 既有官方种子聚焦日志无变化
- [ ] 3.3 对外产品介绍 pack 声明 `publicFacing: true` 并重铸上架；验证：生产日志显示聚焦名单已收敛（无 wire-ops/lex-ops 等）

## 4. B5 推理痕迹剥离

- [ ] 4.1 `stripReasoningLeak` 提为共享工具，web 文本输出路径接入（剥空回兜底）；验证：单测（闭合/未闭合/剥空三例）
- [ ] 4.2 复测访客侧不可见 `<thinking>`；验证：web chat 文本 delta 无推理痕迹

## 5. B6 首启排队

- [ ] 5.1 chat 车道 pack persona 首启走有界等待（默认 120 秒可配），耗尽才结构化错误；验证：单测（等待窗内成功、耗尽报错）

## 6. 收尾

- [ ] 6.1 走查实录补复测结论（B2 已修；B4 归 B3；B6 降级为慢）；验证：文档更新
- [ ] 6.2 主 spec 同步 + `openspec validate --specs` 绿 + 归档；验证：validate --specs 无 delta 残留
- [ ] 6.3 台账/memory 更新；验证：memory 索引行含本变更要点
