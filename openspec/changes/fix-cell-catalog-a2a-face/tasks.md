# Tasks: fix-cell-catalog-a2a-face

## 1. registry-bridge：facet 源补拉 agents

- [x] 1.1 `doFacetRefresh` 追加 best-effort agents 拉取（`fetchAllPages("/api/agents")` + 既有 `mapAgent` → `agentSnapshot`）；失败单独 warn 保 last-good，不拖累 mcp/skills 刷新；`REGISTRY_URL` 为空走同一降级分支 → 实施修正一处：`fetchAllPages` 返回 `{items}` 非裸数组（测试当场抓出）
- [x] 1.2 广播签名保持只看 `{mcpServers, skills}`（agents 不进 market_changed）；init 告警文案更新（agents 腿仍读 registry）；biome/typecheck 过
- [x] 2.1 `test-supply-catalog-yizuo.mjs`：facet 渠道补 registry agents 断言——填充 + a2a 条目 url 形态 + agents 独立降级（失败不拖累 mcp/skills、保 last-good）+ agents 变化不广播；env 恢复 `REGISTRY_URL` 设入（agents 腿的合法 base）→ 10/10
- [x] 2.2 全量相关套件回归（registry-bridge / supply-catalog / catalog* / pack-install-fetch）绿 → **46/46**

## 3. 出片与上产

- [ ] 3.1 提交（只 add 本单文件）+ 双推 + 快照闸出片（**永远 `--init`，push 前查 toplevel**——§15.138 续三配方）；恢复镜像 workflows；CI 绿
- [ ] 3.2 relay → ccr 硬门 → GitOps 双清单 bump（注意并发会话的镜像 home 现状，回滚路径写注释）→ ArgoCD 滚版 → 双 pod imageID 全等

## 4. 真机验证（O8 4.3/4.4 的解锁判据）

- [ ] 4.1 cell `/api/catalog` a2a 条目复活（a2a-mode>0）；既有 vacant 岗复活（formation.members servingPath 非空）
- [ ] 4.2 正路径召唤：部署验证舰队挂 `pack-demo-fingpt` a2a 岗（registry enabled + 本平台 facet 台账唯一行）→ dryRun `summonable` 非空且 ref=`packId:agentId`、onBehalfOf=deployedBy；执行级邀请一次如实（待答即如实）；验证舰队用后即清
- [ ] 4.3 走查单 2.6 执行半边 + O8 4.3/4.4 回填勾选；O9 行改「已解除」

## 5. 收口

- [ ] 5.1 `openspec validate --strict` 两单全绿 → 归档 `fix-cell-catalog-a2a-face` 与 `fix-zhiyu-summon-serving-face` 入 specs；台账续记
