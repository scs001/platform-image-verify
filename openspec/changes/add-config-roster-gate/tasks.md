## 1. 实现

- [ ] 1.1 configWriteCore：model 段记 `modelRequested`；GET entry 后、PUT 前插 roster 门（entry.runner_id??默认行→boardNow→modelChoiceError；400 MODEL_NOT_IN_ROSTER）

## 2. 测试

- [ ] 2.1 test-agent-serving.mjs 配置面增例（env 设还+板桩）：lane 过+不在册→400 无 PUT；在册→200；null 清不走门；板断→照写（降级开放）；既有配置面用例零回归
- [ ] 2.2 全量关联回归（agent-serving/deploy-lock/deploy-roster-gate/fleet-report/scheduler）

## 3. 部署与生产验证

- [ ] 3.1 law-ai platform-images 线出片 → ccr 实证 → GitOps 滚 facet 面
- [ ] 3.2 生产复证：wx-alpha model 清 null（回默认在册模型）→ 真回合正常应答；负路径 model 写不在册 → 400 MODEL_NOT_IN_ROSTER
- [ ] 3.3 复扫全条目 effective_model × 花名册：零不在册

## 4. 收尾

- [ ] 4.1 案例卡注记（配置面闭环+现患清零；余采集器项）+ openspec 归档 + 记忆
