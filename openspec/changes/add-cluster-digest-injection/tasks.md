# add-cluster-digest-injection — Tasks

## 1. fd-memory 平台缝 digest 读面

- [x] 1.1 `http.ts` 新增 `GET /digest`（鉴权同 /pages：person 自家 root、platform/runner 带 rootKey、agent 拒）：q 参数召回 `hybridCandidates`（进程内 sidecar embed 链 + 30s abort，失败关键词降级记 model_note）→ open handoffs → `renderDigest`；参数钳制 k≤8 / budget≤2000
- [x] 1.2 单测：权限矩阵三族 / embed 降级不失败 / 参数钳制 / 忘与过期条目不出现（渲染器既有测兜底，这里测端到端组装）

## 2. paas 集群 hook ① 切换

- [x] 2.1 `server/cluster-memory.js` 增 `readDigest(clusterId, q, {k, budget})`（5s 超时，env `CELL_MEMORY_DIGEST_K/BUDGET` 默认 5/1500）；`server/cron-runner.js` hook ① 改三档阶梯：digest → /pages 标题列表（现状路径不动）→ 无块，各档 warn 一行，开关关闭零发起
- [x] 2.2 单测：三档降级路径（digest 5xx/超时、/pages 失败、全失败）+ 开关归零字节等同（既有 cluster-memory/cron 测试扩展）

## 3. 网格定默认（接 add-continuation-eval 5.2）

- [x] 3.1 eval-continue digest 臂 k∈{3,5}×budget∈{800,1500} 4 组全 12 场景，重推导度主指标定终值；差异 <0.2 分维持 5/1500；结果入 continue-baseline + 回填 add-continuation-eval tasks 5.2 勾销——四组 re 3.33/2.83/3.50/3.17、fs 2.83/2.33/2.92/2.92，组间差不大于跑次方差（同参数自差 0.6 在案），无可分者，维持 5/1500

## 4. 出片与真机验收

- [ ] 4.1 双端出片（fd-build-channel 判路；GHA→hkccr→relay→ccr 标准线）+ GitOps 滚产（fd-memory / platform 两清单）
- [ ] 4.2 真机验收：下一轮集群回合成员 prompt 含 digest 块眼见（会话留档）+ 降级演练（断 digest 面一轮看回退标题与 warn 行）+ 恢复
- [ ] 4.3 台账 §15.31 回填（上线记录 + 网格终值 + 观察项起点：认领率 8% 基线与 digest 引用前轮内容的首例）
