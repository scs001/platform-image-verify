# Tasks — add-deploy-agent-selection

## 1. 载荷与语义

- [ ] 1.1 `gateway/packs.js` deploy 路由：`agents` 载荷校验（非空字符串数组/无重复/⊆ servingIds，
  400 指名），解析 `deployIds`（缺省=servingIds）
- [ ] 1.2 绑定生命周期收缩：billingKeys unknown-agent 拒收集合、kept 收集、「必须有键」准入门
  改用 deployIds；secrets 显式 null 面向 serving-but-unselected 拒收指名；非 serving 清洗保持
  servingIds
- [ ] 1.3 `lib/agent-serving.js` deployToRegistry：`onlyAgents` 参数过滤 serving 列表（缺省 null
  = 不过滤）

## 2. 测试

- [ ] 2.1 test-agent-serving.mjs：双 serving agent manifest 的子集部署（registry 只收到选中项、
  pack_deployments 只记选中项、响应只列选中项）
- [ ] 2.2 坏选择拒收：非 serving id / 重复 / 空数组 / 非数组——400 指名，registry 零调用
- [ ] 2.3 计费生命周期收缩：未选中 agent 无键也能部署选中集；面向未选中 agent 的粘键/null
  解绑被拒（billing-linked harness）
- [ ] 2.4 缺省全量回归：不传 agents 的路径与旧断言全绿（既有套件跑通即证）

## 3. 上线

- [ ] 3.1 本地全量单测绿（含既有 agent-serving 套件）
- [ ] 3.2 镜像出片+GitOps 三面滚动（platform/platform-demo/facet）
- [ ] 3.3 生产实证：subset 部署真 pack 只上选中 agent（可与 fd-wanxing 向导实证合并做）
