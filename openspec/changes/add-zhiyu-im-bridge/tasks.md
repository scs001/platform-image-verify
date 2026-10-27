## 1. Binding model & management REST

- [ ] 1.1 `bots.zhiRoomId` migration (guarded ALTER) + store helpers (get/set/unset scoped to the bot's owner). Verify: idempotent migration + store unit tests pass.
- [ ] 1.2 `gateway/zhiyu/im-bridge.js`: GET/PUT/DELETE `/api/zhiyu/im-bridge/bots/:botId/room`, owner-only with 404-shaped invisibility. Verify: the three binding scenarios in the spec pass.
- [ ] 1.3 Audit rows on every binding change (who, when, which room). Verify: audit lines present for PUT and DELETE.

## 2. Cell-side inbound (IM → room)

- [ ] 2.1 `server/zhiyu-im-bridge.js`: pre-hook on the bots.js inbound path — bound bot routes to the bridge (no agent-turn), unbound goes unchanged through the legacy session path. Verify: both spec scenarios pass.
- [ ] 2.2 Sender seats: `im_<12 hex of sha1(chatKey:imUserId)>` as ref, `senderName` as display, member meta `im:{platform,chatKey,senderName}`. Verify: the same sender reuses one seat (suite test).
- [ ] 2.3 Appending the human row triggers the EXISTING humanMessageHook — no router changes. Verify: room router processes an IM guest message exactly like a web guest message.

## 3. Gateway-side output subscription face

- [ ] 3.1 Read-only, bot-scoped event subscription for the cell's forwarder (`after=<seq>` replay), gated to the binding's room. Verify: cross-room subscription is refused (403).
- [ ] 3.2 Kind filter: `kind=agent` rows + room_ended/budget_exhausted/needs_you only; meta.im rows never included. Verify: the bridge's own messages never come back.

## 4. Cell-side delivery pipeline

- [ ] 4.1 Outbound sendText per platform with seat attribution on the first chunk and honest splitting at the platform's practical cap. Verify: long answers arrive as ordered chunks.
- [ ] 4.2 Per-bot last-sent sequence cursor persisted so restarts never duplicate a send. Verify: restart produces zero duplicates.
- [ ] 4.3 Outbound bucket 60/min per bot; failures are logged, retried once, and then surfaced as an honest room event. Verify: scenarios pass.

## 5. Visitor continuity & billing

- [ ] 5.1 scopeSeed=`room:<roomId>:<senderRef>` lands in dispatch (agent turns from IM see the same visitor-scope shape as web guests). Verify: lane receives it (suite assertion).
- [ ] 5.2 Answers triggered by IM guests settle into the seat's deployment billing key with the `-guest` usage-id suffix. Verify: settlement row carries the suffix.

## 6. Bots surface (UI)

- [ ] 6.1 Add the "房间挂接 (room binding)" field on the bot edit card: shows current binding, saves a roomId, unbinds cleanly. Verify: owner can do all three from the panel.
- [ ] 6.2 Locales: zh-CN/en proper, es/fr/ja placeholders per repo discipline. Verify: check-locales passes for all five.

## 7. Tests & regression

- [ ] 7.1 `scripts/test-zhiyu-im-bridge*.mjs` suite green + all existing zhiyu suites still green. Verify: `node --test scripts/test-zhiyu-* scripts/test-zhiyu-im-bridge*`.
- [ ] 7.2 Full-unit regression shows zero new reds (parallel-session artifacts excluded and proven again at the clean commit); web typecheck/biome/locale parity/build all green.

## 8. Release & walkthrough

- [ ] 8.1 Snapshot build → four-manifest roll (digests identical); `ZHIYU_IM_BRIDGE_*` gates stay off until verified, then enabled in ConfigMap with a pod restart.
- [ ] 8.2 Production walkthrough on a real Telegram test group: group message lands in room, room answer returns to group, unbind restores the legacy path; walkthrough notes land in the ledger.
- [ ] 8.3 `openspec validate add-zhiyu-im-bridge --strict` passes with zero errors; §15 ledger + memory updated.

## 9. Follow-ups (NOT this change)

- [ ] 9.1 IM-native @-for-agents (Telegram @bot semantics vs. plain-text parsing) — apply-time decision.
- [ ] 9.2 Guest display refresh when an IM user renames.
- [ ] 9.3 External A2A seats (3B) as the next change.
