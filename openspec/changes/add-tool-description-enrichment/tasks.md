## 1. Overlay 生成（平台侧）

- [x] 1.1 `dsh-profile.js` patch 写出序列增 tool-description overlay 生成：读注释层 canonical brief + per-owner 开关 + publicFacing 判定，写出 `{server+leaf → brief, source, updatedAt}`；验证：单测覆盖有注释/无注释/publicFacing/开关关四态的生成结果
- [x] 1.2 追加/替换策略实现（上游有→追加、上游空→替换、拼接超长截断保上游）；验证：单测三策略用例 + 截断快照标注断言
- [x] 1.3 工具面快照增 `enriched` 计数与 `enrichment_source`，名字集合与校验结果零变化；验证：闭包闸增强开关两情形同结果断言（含 `surface_source` 既有字段不回归）

## 2. Overlay 消费（dsh 运行时）

- [x] 2.1 `dsh-mcp-client` 在 `tools/list` 消费点旁应用 overlay（与 tool-filter 同读法），旧 runtime 忽略 overlay 文件；验证：dsh 版本矩阵登记 + 忽略行为测试
- [x] 2.2 discovery 索引同源：`server/tool-discovery.js` 索引描述取同一 overlay，名字/server/leaf/参数摘要零变化；验证：单测「索引=模型面」断言 + 搜索身份不变断言
- [ ] 2.3 【discovery 同源由构造保证（注册时改写→schema 事件自带），哨兵已断言索引面；真机 parked 会话注记随走查】会话中途注释更新不侵入进行中回合（overlay 随组装再生）；验证：组装再生测试 + parked 会话行为注记

## 3. 开关与边界

- [x] 3.1 per-owner 开关接偏好面（默认开，关闭即 overlay 不生成）；验证：开关切换前后模型面逐字节对比断言
- [x] 3.2 platform 内置工具零增强；验证：内置工具清单与 overlay 条目交集为空断言
- [x] 3.3 被删 server 不复活（publicFacing 删除语义不受增强影响）；验证：publicFacing 生效面枚举对照断言 —— 2026-11-04 `scripts/test-tool-description-overlay.mjs` 增「publicFacing deleted-server revival guard」测：悬空 overlay 条目不能复活被删 server（装饰只发生在注册时、被删 server 永不注册）+ 生效面枚举逐字节对照；11/11 绿

## 4. 真机走查与出片

- [ ] 4.1 真机 A/B：同一任务增强开/关对比（工具调用成功率、token 增量、描述长度）；验证：数据入台账，劣化即翻 D2 默认的单点预案演练一遍
- [x] 4.2 「无 canonical」原状分支回归（② 未上/无注释环境全路径走原状）；验证：真机 grep overlay 空 + 回合行为零差异记录 —— 2026-11-04 生产活体（platform pod，sha-1d3ebf6）：23 个带 tool-filter 的 cell 分裂 7 带 overlay / 16 无；无 overlay 归因两态如实——mcpTools=[] 空面 cell（无可增强→写空即清件）+ 420a3344 profile 陈旧（组装时间 2026-10-26，早于增强上产 11-01/注释落库 11-02，按 D1「下个组装周期生效」parked 未重组装，仓内 wire-build-mcp 17 叶 brief 在、随时生效）；无 overlay cell 即「回合行为零差异」活体本尊（消费端读不到文件=改前路径逐字节）
- [x] 4.3 出片走查 + 台账；验证：生产 sha 面上眼见快照 enriched 字段与索引一致性 —— 2026-11-04 生产眼见（platform pod）：4 cell `meta.enriched == 实际条目数` 全等（6/6/6/**594**，594 台=1da519d4 多 server 面filesystem/github/eco-mcp-fetch/eco-mcp-time/facet-market-mcp…）；抽 eco-mcp-fetch__fetch 对账仓内 `market-annotations.json` `annotation.tools.fetch.canonical.brief` **逐字节相等**、source 标注 `finddata-supply-annotations`（bundled 面标 `catalog`）——快照与索引一致
