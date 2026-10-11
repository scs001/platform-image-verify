# tasks — add-mission-planner-pack

## 1. pack 内容与脚本

- [x] 1.1 `scripts/mission-planner-pack.mjs`：persona + 四技能正文（protocol/planning/execution/reporting，规范见 design D2）+ buildManifest 导出 + publish/deploy 主流程（spider-heal 同型），验证：manifest 过 validatePackManifest + 正文断言单测

## 2. 单测

- [x] 2.1 `scripts/test-mission-planner-pack.mjs`：技能正文断言（五 kind/幂等键句式/search_agents 纪律/窗口纪律/通知纪律）+ serving 契约形状（rhythm/budget/a2a），验证：node --test 绿

## 3. 上线（与 ① 同窗）

- [x] 3.1 fd-wanxing 镜像出片（scs001 线：snapshot 8d819f3）→ GitOps 滚 facade+web + env；坑：writeback 基址必须指萬星域（platform 网关未路由 console/missions，已修 dd0ff04），验证：plannerConfigured=true 实证
- [x] 3.2 planner pack 发布+部署（i262i0TUwtF9WSLeX12COw v1，billing=运营键；deploy 需 billingKeys——复用 deployment_keys 里运营号真 sub2api 键），验证：runner serving packs-i262i0tuwtf9wslex12cow-mission-planner :8801
- [ ] 3.3 生产真 mission e2e（auto 模式：一句话目标→计划→执行→报告），验证：状态链全绿 + spent 记账 + 面板可见报告

## 4. 收尾

- [ ] 4.1 路线图/记忆回写，验证：文档在册
