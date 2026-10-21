# Tasks: chat-interaction-round2

## 1. 规格对账验证（零代码）

- [ ] 1.1 验证 live model/set 行为：桥能力声明含 `model/set`（0.2.0）+ 实测流中切模型不产生 pendingConfig 禁发窗、发送保持可用——证据注记回本 change
- [ ] 1.2 回归确认 ControlStrip pending 语义仅 effort/workspace 触发（现有 e2e/单测过一遍，不新增机制）

## 2. 外装技能更新流（server）

- [ ] 2.1 preview 只读端点：按已装技能 `(source, slug)` server 端重新拉取上游 + 路径集合/sha256 三桶 diff（新增/变更/删除）+ 整体 hash 对比；不写库不物化；复用安装链既有拉取超时/体积上限
- [ ] 2.2 确认更新复用既有 install/replace 写路径：DB 行 + `skill-materialize` 物化树替换 + 热重载；provenance（originUrl/上游版本透传）刷新；失败保持快照（stale-on-failure）
- [ ] 2.3 单测：diff 三桶正确性 / 上游 404·网络失败回退 / 非本路径 owned 的名字不可被更新触碰（沿用 install 冲突语义）

## 3. UI

- [ ] 3.1 已装技能列表外装条目加「更新」入口 → 差异预览弹窗（per-file 摘要 + 整体 hash + 「未经审校」标保持）→ 确认/取消；无角标无自动提示
- [ ] 3.2 五语 i18n（zh-CN/en 及其余三语）+ 组件测试

## 4. 探针与收口

- [ ] 4.1 生产跑 todo_write 采纳 SQL（30 天窗口 + 总量对照），结果记入本条注记；近零（<1% 会话出现）→ 开独立 nudge 提案，否则关闭该挂账
- [ ] 4.2 e2e 技能更新流（preview→confirm→热重载活体）+ `openspec validate` 绿 + 归档准备（提交只 stage 显式路径）
