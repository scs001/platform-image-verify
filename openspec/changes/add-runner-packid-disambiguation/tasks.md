# Tasks: add-runner-packid-disambiguation

## 1. 实现

- [x] 1.1 `fleet_members.pack_id` additive ALTER + createMember INSERT/VALUES + PLAIN_COLUMNS
- [x] 1.2 PATCH 面收 packId（校验 ≤64 非空或 null）+ memberView 透出
- [x] 1.3 物化穿线：reconcile materializedSpec/specDrift + cron addJob/updateJob + task-engine
  saveTasks/createManualTask
- [x] 1.4 `runnerEntryFor({ packId })`：多命中按 `/packs/<packId>/` 过滤；调用侧传 `job.packId`

## 2. 测试

- [x] 2.1 test-fleet-carrier：钉中（双包同名+packId 精确命中、无 fail-open）
- [x] 2.2 test-fleet-carrier：未声明/钉不中 → 维持 runner-ambiguous
- [x] 2.3 全量回归 + lint

## 3. 出片与验收

- [ ] 3.1 公开门双绿 → 池出片 → relay/ccr → GitOps bump（bump 前核祖先）
- [ ] 3.2 真机验收：取证舰队成员 PATCH packId（reception 同名 3 包选其一）→ carrier=runner →
  命中该包部署的远端执行器 carrier=remote
- [ ] 3.3 台账 §15.121 续九 + 双分支收正 + 归档（主 spec 同步律）
