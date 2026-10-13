# Tasks: add-opening-gates

## 1. 实现

- [x] 1.1 packs.js：`PACK_ACCESS_MODE` 档位（默认 closed）——publish/deploy 两门共用
  `mayPublish` 判定；closed 档拒绝文案逐字节不变
- [x] 1.2 packs.js：部署水位线闸——新增 child 才闸（在役 pack 升级跳过）；按选址序找
  第一个余量 ≥ `FLEET_CAPACITY_WATERLINE_MB`（默认 512）的 runner；全不过线 503
  `FLEET_AT_CAPACITY` 指名 runner/余量/水位；board 不可达降级开
- [x] 1.3 facet/index.js：whoami 加 `accessMode`
- [x] 1.4 测试：新套件 test-opening-gates.mjs（closed 拒绝文案逐字节/deploy 门同；
  open 档非 creator 发布+部署通过；水位线：新增拒绝+升级豁免+过线放行+降级开）；
  既有套件（test-pack-marketplace/test-deploy-lock/test-deploy-roster-gate/
  test-agent-serving）回归零漂移
- [x] 1.5 本地门：相关套件全绿 + lint 改动文件零新增

## 2. 部署（标准 law-ai 快照线）

- [ ] 2.1 提交 paas → 快照推 law-ai（含并行会话已部署提交 ef49207/98d76ec 的祖先
  关系已验）→ GHA → relay → ccr manifest 实证
- [ ] 2.2 滚 platform + facet 两清单（runner 三清单不动——本片不改 runner 面）→
  gitee+github 双推 → ArgoCD → pod 起新镜像

## 3. 生产实证

- [ ] 3.1 whoami `accessMode:"closed"`（默认档可见）
- [ ] 3.2 部署通行无回归（真实或探针部署一次，closed 档行为不变）
- [ ] 3.3 水位线数学对照 board 实值（余量计算=budget_mb_limit−budget_mb）
- [ ] 3.4 （可选）临时置 open 档实证非 creator 发布路径，验毕即恢复 closed

## 4. 收尾

- [ ] 4.1 openspec 归档（validate --specs 先行）
- [ ] 4.2 roadmap M4⑤ 行更新（开放前置两件 ✅；余=合规项+开门动作本身）
- [ ] 4.3 DEPLOY.md 追记开关用法（拧开关配方）；记忆落盘+MEMORY.md 索引
