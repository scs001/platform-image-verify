# Tasks: add-unified-memory-and-outputs

## 1. fd-memory：reference / tier / tags 模型 + digest 名份规则

- [x] 1.1 fd-memory 新增 `reference` 页型（title/summary/tags/tier/source_ref 五元组；不存正文；参与 FTS/向量/supersede/forgotten 语义），补 `db.js`/`capture`/`write_page` 走通；`npm test` 全绿并新增页型场景
- [x] 1.2 tier 三级模型与晋级/降级规则落地 fd-memory 侧（信号与人/AI 手势位写主；降级仅 supersede 链）；新增单测覆盖 draft→stable→canonical 与降级
- [x] 1.3 digest 渲染加 reference 名份引用与 tier 优先；预算内 citation-by-name；`memory-eval` 加一场 tier/citation 场景并保持既有 PASS 绿
- [x] 1.4 visibility 读面扩 tier/tags 筛选与列表镜像字段；agent 调用拒语义单测，person/rootKey 语义不变
- [ ] 1.5 打标支线进蒸馏调度（tags/tier 候选「AI 提议」+ per-owner 日预算门 + correction note 回灌词表），部署后 budget 摘要有 usage_logs 归因；出 sha 镜像并按既有 GitOps 落产

## 2. paas 服务端：写面与镜像

- [ ] 2.1 资源库表加层 tier/tags 镜像列（存量初始 draft；未配置记忆服务时空零值），迁移幂等；新列单测/手工清单
- [ ] 2.2 手势写面（记住/标为正典/改 tag）落成服务端路由：写真源→同步镜像→错误结构化；未配置记忆服务时灰态走降级句
- [ ] 2.3 save/capture 自动落 reference 页（source_ref 回库存行）；未配置时静默跳过不阻塞入仓；回归既有 resource-library-ui 行为

## 3. paas web：成果页升级 + 记忆面板

- [ ] 3.1 成果页三层层收纳 + tier 徽章 + tags 列与筛选（AI 提议/人类确认徽位区分），默认 off-by-default 或灰度旗；i18n 五语言
- [ ] 3.2 三手势交互（记住/钉正典/改 tag 弹窗接受-修改-删除 AI 提议），降语反馈不乱态；i18n
- [ ] 3.3 「记忆」面板页（owner u/）——筛选 + 列表 + reference 同源名份 + forget 确认流；空态/无命中态就既有样式族

## 4. 萬星接入

- [ ] 4.1 萬星 console 部署者记忆浏览入口（fleet/agent 直进 d/ 经 platform lane），筛选语义与壹座同族
- [ ] 4.2 fleet deliverable 同款 tier/tags 镜像与徽章；打标与晋级复用同一 reference 页语义
- [ ] 4.3 facade/智语回合同一 digest 读缝接线（游客不注入；登入主户同预算同降级）；真机顶走 logged-in 与 guest 两路验收

## 5. 文档与验收

- [ ] 5.1 ADR-0030 `docs/memory-architecture-v2.md` 修订 v2.1（缝统一+分类分级收编）；CONTEXT.md 词条补 reference/tier/tags
- [ ] 5.2 部署文档预算分表更新（每源 digest 配额+tier 优先说明）
- [ ] 5.3 开箱体检与镜像/真源一致采样脚本（单写纪律校验）
- [ ] 5.4 真机走查四场景：成果页三层收纳 + 手势修正；digest canonical 优先可见；记忆面板 owner 数据一致；facade guest 不注入
- [ ] 5.5 统收益/台账（registry-maintenance）与 archive 回填
