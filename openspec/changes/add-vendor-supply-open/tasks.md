# add-vendor-supply-open · tasks

## 1. 供应商身份类（vendor-identity）

- [ ] 1.1 落表迁移：`vendor_profiles`（主体名大小写不敏感唯一索引、公开署名、联系凭据、配额档、收益归属字段）、`vendor_members`（绑定+角色）、`vendor_audit`；跑 migration 幂等测试通过
- [ ] 1.2 供应商主体注册/档案/绑定 REST 面（gateway 路由），注册即得+409 名称冲突+缺字段如实拒；单测覆盖 spec 三 Requirement 全部 scenario
- [ ] 1.3 资格判定改造：`gateway/packs.js:1039-1045` 单点改为 `isCreator || open || hasActiveVendorBinding`；回归既有 creators/closed/open 判定原有测试全绿（无 vendor 绑定走原路）
- [ ] 1.4 档案更新审计：变更字段级留痕；单测断言审计行内容（操作者/时间/字段）

## 2. 供方上牌闸（vendor-server-onboarding）

- [ ] 2.1 `vendor_onboarding` 状态机表与路由族（提交/状态查/撤回/重提）；submitted→in-review→onboarded|rejected(axis) 流转单测全绿
- [ ] 2.2 准入审查器：主体/材料/许可证/配额四轴逐项评，拒绝带轴落台账；单测覆盖「材料不全」「配额过闸」两 scenario
- [ ] 2.3 selfcheck 执行器：协议握手+工具列举+商业集闭包比对（复用 `registry-bridge` 工具面语义），独立超时预算与一次重试；用 fake MCP server 测试「闭包超集被挡」「声明完好通过」
- [ ] 2.4 registry 写入适配：平台凭据 register+toggle，供应商无任何直写端点；registry 不可用时挂起在途单+如实降级（不产生假在册）；集成测试过了
- [ ] 2.5 双形接入分岔：vendor-hosted（reach 端点+出站姿态材料）与 platform-hosted（egress posture 容器模式）落实步；两形各一条端到端测试
- [ ] 2.6 供应商可见面：名下 server 状态列表 API（状态与台账一致）；被拒单带轴呈现
- [ ] 2.7 上牌的 server 可被 pack 以 `registryName` 引用：发布门+安装链回归（既有四闸语义逐字节一致），记观察项：发布层 local-binding 豁免 vs 安装层硬拒的断层

## 3. 市场作者开放与署名（pack-marketplace delta）

- [ ] 3.1 发布归属声明参数：网关校验绑定后取档案公开署名投影进条目；manifest 拒绝可读写的署名声明字段；单测覆盖「归属进条目/无权署名拒/无声明不署名」
- [ ] 3.2 条目呈现署名取档案当前值（不缓存文本，只存绑定 id）；档案改名后条目呈现随之更新（测试断言）
- [ ] 3.3 发布门对 vendor 同轨证明：rate limiter/manifest 校验/闭包闸在 vendor 发布者身上跑既有测试全集，拒绝分类与 creators 一致

## 4. spec 裁决与收尾

- [ ] 4.1 `ecosystem-curation` delta 内容与条款落地核对：匿名提交面无、vendor 提交仍过审、mirror shelf 语义不污染；相关单测/断言到位
- [ ] 4.2 registry fork 侧受控通道启用（外部依赖：cheap-8 部署窗），改动清单入 `docs/registry-maintenance.md` 台账，遵守 `registry-lineage` 纪律
- [ ] 4.3 `openspec validate add-vendor-supply-open --strict` 全绿；验收口径走查：非内部供应商账号仅经公开入口完成 登记→上牌→铸造→上架→被引用安装 全链，每闸失败路径如实分类
