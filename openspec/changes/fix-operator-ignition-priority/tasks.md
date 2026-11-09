## 1. Spec 对齐

- [ ] 1.1 应用 `specs/worker-pool/spec.md` 的 MODIFIED Requirement，覆盖 `openspec/specs/worker-pool/spec.md` 中「人的唤醒在人满时仍有通道」那条——验证：`openspec validate fix-operator-ignition-priority --strict` 通过，且归档后 `grep -c "由主槽串行链按"` 在正式 spec 里为 0
- [ ] 1.2 确认正式 spec 里不再出现「由串行链自行保证排队优先级」的表述，且新增的「排序不扩大容量」「两个标记不可互替」两条在正文可检索——验证：`grep -n "SHALL NOT 互相替代\|SHALL NOT 扩大" openspec/specs/worker-pool/spec.md` 两条都有命中

## 2. 验收锁定（测试已存在，本次确认为验收依据）

- [ ] 2.1 三条用例在 CI 侧可独立运行且全绿——验证：`node --test scripts/test-worker-pool.mjs` 输出 15/15 通过，其中含 `outranks a waiting cadence fire`、`keep FIFO order`、`does not widen the human-only extra slot` 三条
- [ ] 2.2 反向确认：把排序开关的读取改成恒 false 后，第 1 条用例必须转红（证明用例不是恒真）——验证：临时改动后运行该文件，`QUEUE_HUMAN_PRIORITY=1 … outranks` 用例失败；改动随即还原
- [ ] 2.3 Scenario 与用例逐条对位核对：`池激活时点火越过排队` ↔ 2.1 第 1 条；`排序不扩大容量` ↔ 2.1 第 3 条；`cap 0 休眠逐字节一致` ↔ 既有 cap 0 用例——验证：评审时逐条指出对应测试名

## 3. 文档一致性

- [ ] 3.1 `.env.example` 与 `DEPLOY.md` 对 `QUEUE_HUMAN_PRIORITY` 的描述与 spec 一致（尤其「排序不是容量授权」这句）——验证：两处均含该约束的表述，且与 spec 措辞不冲突
- [ ] 3.2 确认 `WORKER_POOL_DEBUG` 的登记位置在「事故逃生阀」节而非普通配置节——验证：`grep -n "WORKER_POOL_DEBUG" .env.example DEPLOY.md` 命中逃生阀段落

## 4. 收口

- [ ] 4.1 全量相关测试零回归——验证：`node --test scripts/test-worker-pool.mjs scripts/test-queue-staleness.mjs scripts/test-fleet-context-pressure.mjs` 全绿
- [ ] 4.2 `openspec validate fix-operator-ignition-priority --strict` 通过后归档——验证：`openspec archive fix-operator-ignition-priority --yes --strict` 成功，`openspec list` 中该 change 消失且 spec 文件已更新

## 5. 待裁决（不阻塞归档，但需记录结论）

- [ ] 5.1 裁决「`run now` 打在既有 cadence 任务上是否应获得额外槽」，并把结论写进本 change 的 `design.md` Open Questions——验证：结论以一句话形式落在文档里；若裁决为「授予」，另开 change 扩容量语义，不在本 change 内实施
