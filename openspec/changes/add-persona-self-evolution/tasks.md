## 1. 候选与提议

- [ ] 1.1 新表 `persona_candidates` 迁移（v+1：id/target(kind+ref)/amended_persona/evidence/status/eval_report/created_at）+ 候选 store CRUD；验证：迁移跑通 + CRUD 单测
- [ ] 1.2 工具 `persona_amend` 注册（无执行语义，证据校验：来源回合可溯才落候选）+ per-owner 日预算门 + 同任务 debounce + 候选 store 上限；验证：单测覆盖落候选/无证据拒/预算拒/debounce 拒/越界拒（技能/工具/模型字段）/他人资产拒六例
- [ ] 1.3 修订文本过既有注入类闸；验证：注入样例候选保持候选态并标注未过闸

## 2. 评测门

- [ ] 2.1 persona 臂装配器（臂 A=现行 persona / 臂 B=修订 persona，同场景任务、同模型同温、隔离 scratch root、臂名对 judge 匿名），复用 `memory-eval` harness 挂点；验证：臂隔离与匿名单测（沿技能臂同款断言）
- [ ] 2.2 门判定（修订臂不劣于对照臂且差异可解释→过门；平局/劣化/judge 不可用→保持候选态标「未评测」）；验证：三态单测
- [ ] 2.3 评测报告存档（臂 transcript + judge 判词随候选可查）；验证：报告读取 API 断言

## 3. 晋升分流与生效节奏

- [ ] 3.1 自建预设路径：人接受→既有 custom_presets CRUD 物化 + lineage 审计（旧文本可溯可回退）；验证：物化单测 + lineage 读取断言
- [ ] 3.2 pack persona 路径：人接受→既有 fork 管线开 fork 草稿进我的创作，pack 本体零变化；验证：fork 草稿产出断言 + pack 版本不可变断言
- [ ] 3.3 驳回即终结留审计；验证：驳回后再晋升被拒断言
- [ ] 3.4 生效节奏：物化后进行中/parked 会话 persona 不变，新铸会话读修订文本；验证：双会话对照测试（parked 会话 persona 逐字节不变断言）

## 4. 评审面与真机

- [ ] 4.1 构建器调优区 persona 修订分区填实（列表/评测报告/接受/驳回/分流去向说明），i18n 五语言；验证：组件测试 + 五语言完整性门 + 空态契约与 hub 对表
- [ ] 4.2 真机走查全链：真实回合→persona_amend（证据齐）→跑 A/B→过门→接受→新铸会话 persona 生效；验证：走查记录入台账
- [ ] 4.3 成本核对：一次 A/B 的 token 账目入台账（与 `add-skill-self-evolution` 4.4 同班核，共用 judge-lane 车道）；验证：账目行落台账
- [ ] 4.4 防中毒复检：注入样例候选在真机全链被闸住且候选态如实标注；验证：走查记录
