# Fix Fleet Round Discipline

## Summary

Fleet 当前存在"双触发"问题：被动岗的定时器每次 tick 都会无条件派发新回合，即使上一回合仍在执行中；同时前端 cockpit 把"有回合在跑"渲染为"此岗正在执行"，无法区分"正常工作中"和"排队中等执行"。这导致被动岗在落后时出现重复 `turnRequest`，且用户无法从 cockpit 看到真实队列深度。

## Problem Statement

1. **Timer 无门控**：`fleet-event-wake.js` 的 `ready` handler 在每个 passive 岗的 timer tick 都调用 `turnRequest`，不检查是否已有未完成回合。当岗落后 2 个节拍时，会一次性派发 2 个回合请求，造成重复执行和工具调用风暴。

2. **前端误判"繁忙"**：`memberView` 在 `fleets.js` 中把 `latestTurn` 存在且未归并的岗标为 `busy`，这反映的是"正在执行"而非"队列中有积压"。用户看到的"繁忙"徽标在 timer 并发时闪烁，但不知道真实排队数。

3. **无退避机制**：上一回合失败后，timer 在下一个 cadence 立即重试，不区分首次失败和连续失败。失败岗会快速消耗 token 和工具配额。

## Proposed Fix

### F1 — Gate turn requests in `fleet-event-wake.js`

- 在 `ready` handler 进入 `turnRequest` 之前，检查该 member 是否已有未完成回合：
  - 新增一个 `pendingTurns` `Set<string>` 跟踪已派发但未收到 `step/end` 的 memberId。
  - `turnRequest` 前：`pendingTurns.has(m.id)` → 跳过并打 skip 日志。
  - `turnRequest` 的 `.finally()`：`pendingTurns.delete(m.id)`。
- 同时，在 `fleet-reports.js` 的 `memberView` 中增加 `queueDepth` 字段（当前 `pendingTurns.size` 对应值）。

### F2 — Surface queue depth in cockpit

- `server/routes/fleets.js` 的 `GET /:id/cockpit` 接口已经在 `members` 数组中返回 `memberView`。F1 新增的 `queueDepth` 字段会自动流入 cockpit JSON。
- `web/src/pages/FleetPage.tsx` 的岗位卡在 `status === "busy"` 时改为显示"排队中 + 数字"徽标（区分于正常工作的脉冲动画）。

### F3 — Backpressure-aware timer (v1)

- 在 `fleet-event-wake.js` 中，当上一回合以 `failed` 状态结束时：
  - 计算 `backoffUntil = now + cadenceMs * 2`。
  - 在 `ready` handler 中跳过 `backoffUntil > now` 的 member。
  - 连续失败 3 次后，backoff 因子提升到 `cadenceMs * 4`（线性增长，有上限）。
- 成功回合后重置 backoff 计数。

## Files to Modify

| File | Change |
|------|--------|
| `server/fleet-event-wake.js` | F1: pendingTurns set + gate; F3: backpressure backoff |
| `server/fleet-reports.js` | F1: queueDepth in memberView |
| `server/routes/fleets.js` | No change (cockpit already returns memberView verbatim) |
| `web/src/pages/FleetPage.tsx` | F2: queue depth badge |
| `web/src/api/fleets-api.ts` | F2: queueDepth in MemberView type |
| `openspec/specs/agent-fleet-cockpit/spec.md` | Append scenario for queue depth display |

## Risk Assessment

- **Backward compatible**: All changes are additive. The cockpit JSON gains one field (`queueDepth`), the API contract for existing fields is unchanged.
- **Performance**: `pendingTurns` is an in-memory Set — O(1) check per tick, no DB round-trip.
- **Rollback**: Revert `fleet-event-wake.js` changes; cockpit falls back to existing busy indicator.

## Acceptance Criteria

- [ ] AC1: 被动岗落后 2 个节拍时，只派发 1 个回合请求（而非 2 个）。
- [ ] AC2: 回合执行期间 timer tick 不重复派发。
- [ ] AC3: 回合失败后，下一 tick 至少等待 2× cadence。
- [ ] AC4: cockpit 岗位卡在排队中时显示"排队中 N"徽标。
- [ ] AC5: 连续失败 3 次的岗，backoff 提升到 4× cadence。
