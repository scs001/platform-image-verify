## 1. Overlay 生成（平台侧）

- [ ] 1.1 `dsh-profile.js` patch 写出序列增 tool-description overlay 生成：读注释层 canonical brief + per-owner 开关 + publicFacing 判定，写出 `{server+leaf → brief, source, updatedAt}`；验证：单测覆盖有注释/无注释/publicFacing/开关关四态的生成结果
- [ ] 1.2 追加/替换策略实现（上游有→追加、上游空→替换、拼接超长截断保上游）；验证：单测三策略用例 + 截断快照标注断言
- [ ] 1.3 工具面快照增 `enriched` 计数与 `enrichment_source`，名字集合与校验结果零变化；验证：闭包闸增强开关两情形同结果断言（含 `surface_source` 既有字段不回归）

## 2. Overlay 消费（dsh 运行时）

- [ ] 2.1 `dsh-mcp-client` 在 `tools/list` 消费点旁应用 overlay（与 tool-filter 同读法），旧 runtime 忽略 overlay 文件；验证：dsh 版本矩阵登记 + 忽略行为测试
- [ ] 2.2 discovery 索引同源：`server/tool-discovery.js` 索引描述取同一 overlay，名字/server/leaf/参数摘要零变化；验证：单测「索引=模型面」断言 + 搜索身份不变断言
- [ ] 2.3 会话中途注释更新不侵入进行中回合（overlay 随组装再生）；验证：组装再生测试 + parked 会话行为注记

## 3. 开关与边界

- [ ] 3.1 per-owner 开关接偏好面（默认开，关闭即 overlay 不生成）；验证：开关切换前后模型面逐字节对比断言
- [ ] 3.2 platform 内置工具零增强；验证：内置工具清单与 overlay 条目交集为空断言
- [ ] 3.3 被删 server 不复活（publicFacing 删除语义不受增强影响）；验证：publicFacing 生效面枚举对照断言

## 4. 真机走查与出片

- [ ] 4.1 真机 A/B：同一任务增强开/关对比（工具调用成功率、token 增量、描述长度）；验证：数据入台账，劣化即翻 D2 默认的单点预案演练一遍
- [ ] 4.2 「无 canonical」原状分支回归（② 未上/无注释环境全路径走原状）；验证：真机 grep overlay 空 + 回合行为零差异记录
- [ ] 4.3 出片走查 + 台账；验证：生产 sha 面上眼见快照 enriched 字段与索引一致性
