# add-facet-copilot — Tasks

## 1. 入口与预设注入

- [x] 1.1 `CopilotDock` 路由上下文扩展：`/agents?tab=market` 推导 `line=facet`（design D1）；`scripts/test-copilot-presets.mjs` 扩展用例
- [x] 1.2 Market tab 无助手降级：`PackMarketView` 顶部提示条（谦面助手未安装 → 指向市场条目安装；已安装不渲染）五语键
- [x] 1.3 e2e：`e2e/copilot-dock.spec.js` 扩展——market tab 打开 dock 注入 `facet-assistant` 聚焦预设、上下文条显示谦面助手、无助手时降级文案

## 2. pack 上下文注入（只读）

- [x] 2.1 `PackDetailDialog` 生命周期 emitter（打开/关闭/切换 pack）；`CopilotDock` postMessage 追加 `pack` 字段；`ChatPage` embed 上下文条渲染当前 pack（D2）
- [x] 2.2 只读边界断言：embed 侧无页面操作 handler；写意图仅经 propose_action（e2e 断言：详情弹窗开着时提问「帮我订阅这个包」→ 回合中出现动作提议卡而非直接订阅）

## 3. 谦面助手 pack v2

- [x] 3.1 技能面四类问题打磨（概念/推荐/权限解释/安装引导，D4 事实锚定）；manifest 合形状判定（allowTools 非空、无写工具）
- [ ] 3.2 真机对答走查：四类问题各一轮实测（需生产助手实例——随 4.1 发布后在真机做）

## 4. 收口

- [ ] 4.1 pack v2 市场发布（狗粮）；全部既有 e2e 不倒退
- [ ] 4.2 出片：`fd-build-channel` 判路 → paas 标准线 → 真机验收（market tab 向导全链 + 无助手降级 + 动作提议卡）→ 归档
