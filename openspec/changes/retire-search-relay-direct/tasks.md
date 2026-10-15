# retire-search-relay-direct — 任务清单

> 承接 search-relay-via-ciyuan 3.3（观察起点 2026-10-15）。到期判据双门缺一不退：
> ①车道稳定（reachable=true、breakerOpen 长期 false、无回退事故）；②`upstream.fallbacks`
> 长期为 0（或仅演练产生）。**复检时点：2026-10-22 前后。**

- [ ] 1.1 复检判据：stats 面板 + relay 日志（reachable/breakerOpen/fallbacks）+ 中途
       是否已有 platform 出片（2.1 面板行在产则跳过该项）
- [ ] 2.1 代码删除：直连路径 + serpapi 池与 breaker 直连分支（services/search-relay/）
- [ ] 2.2 面板 keys 段隐藏（WebSearchSection.tsx）；embed 脚本 keys 形状收敛
- [ ] 2.3 单测收敛 + 出片滚产（fd-build-channel 判路 → 快照池）+ configmap/secret 重嵌
       （keys.json 只留车道凭据）
- [ ] 2.4 台账 + 主 spec 同步（web-search 退役段并入）
- [ ] 3.1 生产验收：启动日志无 standby 行；普通搜索 200（route=lane）；BYOK 三态不变；
       车道故障路径返回明确错误
