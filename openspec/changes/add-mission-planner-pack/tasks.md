# tasks — add-mission-planner-pack

## 1. pack 内容与脚本

- [ ] 1.1 `scripts/mission-planner-pack.mjs`：persona + 四技能正文（protocol/planning/execution/reporting，规范见 design D2）+ buildManifest 导出 + publish/deploy 主流程（spider-heal 同型），验证：manifest 过 validatePackManifest + 正文断言单测

## 2. 单测

- [ ] 2.1 `scripts/test-mission-planner-pack.mjs`：技能正文断言（五 kind/幂等键句式/search_agents 纪律/窗口纪律/通知纪律）+ serving 契约形状（rhythm/budget/a2a），验证：node --test 绿

## 3. 上线（与 ① 同窗）

- [ ] 3.1 fd-wanxing 镜像出片（scs001 fd-wanxing-images 线）→ GitOps 滚 facade + env（MISSION_PLANNER_SLUG/WANXING_PUBLIC_BASE_URL），验证：生产 /api/wanxing/v1/console/missions 可达且 plannerConfigured=true
- [ ] 3.2 planner pack 发布+部署（facet 内网通道；secrets 省略=保留），验证：runner 在役 planner、registry 条目 enabled
- [ ] 3.3 生产真 mission e2e（auto 模式：一句话目标→计划→执行→报告），验证：状态链全绿 + spent 记账 + 面板可见报告

## 4. 收尾

- [ ] 4.1 路线图/记忆回写，验证：文档在册
