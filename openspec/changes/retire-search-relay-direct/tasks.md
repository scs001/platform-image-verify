# retire-search-relay-direct — 任务清单

> 承接 search-relay-via-ciyuan 3.3（观察起点 2026-10-15）。到期判据双门缺一不退：
> ①车道稳定（reachable=true、breakerOpen 长期 false、无回退事故）；②`upstream.fallbacks`
> 长期为 0（或仅演练产生）。**复检时点：2026-10-22 前后。**

- [x] 1.1 复检判据：stats 面板 + relay 日志（reachable/breakerOpen/fallbacks）+ 中途
       是否已有 platform 出片（2.1 面板行在产则跳过该项）
       实证（2026-10-21，cheap/fd-prod `search-relay-8ccf955c7-cnfbt`，port-forward 4597 直打 `/v1/stats`）：
       **双门全过，可退役。** ①`mode=ciyuan reachable=true breakerOpen=false`；pod 自 10-15 07:32 启动
       `upstream=ciyuan-lane, 1 standby serpapi key(s)` 起连续运行 6.69 天 **0 重启**（内存计数器覆盖整个观察窗）。
       ②`fallbacks=4 / laneFailures=3`——日志时间戳证明 4 笔 `route=direct-fallback` **全部落在 10-15 07:35:41–51**
       （即 3.2 验收演练：account 37 置不可调度→3 连败→breaker OPEN 60s→冷备接管 4 笔），**此后 6.7 天零回退、零新增
       车道失败**；窗口内路由分布 12 lane / 4 direct-fallback（后者全演练），`errors.upstream=0 poolDry=0`。
       ③面板行已在产：生产 facet（platform:sha-02082df）前端产物含 `upstreamFallbacks`/`upstreamLaneDown` 键与
       「冷备接管 {{count}} 次」文案——该项跳过。坑：本机 18099 被他会话 Python 占着（IPv4），kubectl 绑 IPv6 同口导致
       curl 打错进程「Empty reply」，换口即可。
- [ ] 2.1 代码删除：直连路径 + serpapi 池与 breaker 直连分支（services/search-relay/）
- [ ] 2.2 面板 keys 段隐藏（WebSearchSection.tsx）；embed 脚本 keys 形状收敛
- [ ] 2.3 单测收敛 + 出片滚产（fd-build-channel 判路 → 快照池）+ configmap/secret 重嵌
       （keys.json 只留车道凭据）
- [ ] 2.4 台账 + 主 spec 同步（web-search 退役段并入）
- [ ] 3.1 生产验收：启动日志无 standby 行；普通搜索 200（route=lane）；BYOK 三态不变；
       车道故障路径返回明确错误
