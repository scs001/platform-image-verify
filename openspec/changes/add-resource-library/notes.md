# add-resource-library — implementation notes

Recorded during `/opsx:apply` (2026-09-27). Complements `tasks.md`; the
checkboxes there are the source of truth for what is done.

## Findings that changed the plan (all folded into the code and specs)

1. **The broadcast payload collided with the WS discriminator.** The first cut
   sent `{ action, id, type: "chart" }` under the event name `resources_changed`
   — in one JSON object, `type` would be overwritten by the resource's own type
   and clients could never identify the event. The field is now
   `resourceType`, and `ctx.broadcast` takes the whole message object (the
   `documents_status` shape), which the unit test asserts explicitly.
   The spec text already said `resourceType`.
2. **`app-navigation` had drifted from the code.** The canonical tab set in the
   main spec listed five tabs; the shipped sidebar also has **Tasks** (added by
   the cron change, which recorded no spec delta). Since this change edits that
   exact requirement, the delta now restates the real set including Tasks —
   otherwise archiving it would have cemented a spec that omits a live tab.
   Flagged here because it is scope the user did not ask for, taken only to keep
   the spec honest.
3. **Seeding had to move after `runLegacyMigrations()`.** On a fresh database
   the legacy import lands messages *after* the boot phase where
   `documents.initStore` runs; seeding there would set the one-shot marker and
   permanently skip imported history. `resources.initStore` therefore sits after
   the migrate/catalog/cron `Promise.all` in `server.js`.
4. **Server-generated error text is not localizable, so clients map codes.**
   `saveResource` throws a `ResourceSaveError` carrying the server's `code`
   (`invalid_path`, `file_not_found`, `file_too_large`, `db_unavailable`,
   `store_failed`); the web drawer and the mini program map it to their own
   localized strings and fall back to the server text for unknown codes. Without
   this, an English UI showed a Chinese server message (caught by an e2e run).
5. **Stored names keep their original characters.** The first sanitizer
   collapsed everything outside `\w` — `报表.csv` became `_.csv`. It now strips
   only control characters, path separators and leading dots (dotfiles are
   refused by the serving route), caps the length from the front so the
   extension survives, and keeps the untrimmed basename as the title.

## Verification inventory

| Layer | What it covers |
| --- | --- |
| `scripts/test-resources-capture.mjs` (15) | extraction contract (valid/malformed/multiple/CRLF/non-object), title derivation, capture through `recordMessage` with provenance, hash idempotence, user turns never capture, cron call shape, list filters (incl. LIKE-wildcard escaping), seeding once + no resurrection + `force` |
| `scripts/test-resources-store.mjs` (15) | migration surface (unique hash index), accessors, save (copy + metadata + source deletion survivable), dedupe, absolute-inside-root accepted / outside refused, traversal + NUL + symlink escapes, 404/413, no partial bytes, session-title snapshot, remove drops bytes, rename keeps identity |
| `scripts/test-resources-api.mjs` (7) | HTTP contract: page shape, save → list round trip, repeat save, machine-readable refusal codes, inline chart payloads, rename/delete + broadcasts |
| `scripts/test-file-serving.mjs` (13, +2) | the third root: serving, disposition, traversal/absolute/symlink rejection |
| `scripts/test-cell-containment.mjs` | a real cell (AUTH_MODE=forward_auth): resource save lands under `PLATFORM_DATA_DIR`, CWD stays clean, `/api/resources` answers **401** without identity (the auth gate is inherited, not re-implemented) |
| `e2e/resources-page.spec.js` (6) | empty state, both card kinds, live chart canvas, filter/search, file preview from the stored copy, rename persisting across reload, delete removing row + bytes, jump present/absent by session existence, live update via the broadcast without reload |
| `e2e/resources-save.spec.js` (2) | drawer save from a chat link → card in the library → stored copy survives the source file → dedupe message → localized missing-source error; uploads (root=uploads) offer no save action |
| Existing suites | `npm run test:unit` 314/314; `nav-routes`/`i18n`/`nav-persistence`/`sidebar-collapse`/`attachment-preview`/`chat-chart-rendering` all green after the nav and preview-store changes |

## Mini-program devtools walkthrough (8.1–8.3) — DONE 2026-09-27

Environment: a hermetic local cell on `:3100` (no LLM: session + resources +
workspace files seeded directly, MP identity pre-bound to `o-WALK-1`, mock
`code2session` on `:4601`), simulator pointed at it by setting
`platform.baseUrl` storage in the WeChat devtools. Native dialogs (action sheet,
modal) cannot be clicked by the automation, so they were replaced by **test
doubles** (`wx.showActionSheet` / `wx.showModal` patched to answer) while every
business path — REST, WS, download, chip save, rename, delete — ran for real.
Evidence below is from WXML-class assertions, network logs, and screenshots.

| Spec scenario | Result |
| --- | --- |
| History group `🗂 我的资源` with count, one tap deep | ✅ `grp-sec-title 我的资源` + `grp-sec-count`; entry `打开资源库 ›` navigates to `pages/resources/index` |
| Page lists both kinds; charts render live | ✅ 4 cards, 2 canvases with a real bar chart drawn (`res-card`/`md-chart-canvas`), 图表/文件 chips |
| Per-type actions | ✅ exact composition: chart = 回到会话/重命名/删除; previewable file = 预览/转发/回到会话/重命名/删除; **unpreviewable (notes.md) = no 预览, 转发 present** |
| Rename round trip | ✅ modal `重命名`/`editable:true` → toast 已重命名 → card title persisted across reload (and via REST) |
| Delete round trip | ✅ modal `删除资源` → toast 已删除 → REST total 5→4 **and the stored bytes directory went 3→2** |
| Jump back to source | ✅ 回到会话 → route becomes `pages/chat/index` |
| Live count while the surface is on screen | ✅ drawer open at 4; a REST delete (broadcasts `resources_changed`) moved the visible count to 3 with no reopen |
| Chip for a workspace file link | ✅ two `file-chip` elements; sheet items for an unpreviewable file = `["转发到聊天","存入资源"]` |
| Chip save + saved state | ✅ sheet pick 存入资源 → toast 已存入资源 → `class="file-chip file-chip-saved"` `📄 notes.md · 已存入` → library gained `file manual notes.md` |
| Non-file links keep clipboard | ✅ `示例站点` renders as `md-link` (not a chip); tap → toast 链接已复制 and `wx.getClipboardData` = `https://example.com` |
| Document preview | ✅ trace: loading 打开中… → `downloadFile` 200 → `openDocument(fileType=pdf)` → **open-ok** (native viewer) |
| Forward | ⚠️ API invoked correctly (`shareFileMessage({filePath: temp, fileName: 'report.pdf'})`) but the simulator refuses: `shareFileMessage:fail can only be invoked by user TAP gesture` — synthetic automation taps are not user gestures. Needs a real-device/体验版 pass; the code path is a direct tap handler (page) and a sheet-tap handler (chip), both legitimate user gestures in a real client. |
| Storage reachability with auth | ✅ `wx.downloadFile` with the bearer header returned 200, 193 bytes, `Content-Disposition: inline; filename*=UTF-8''report.pdf` |

Platform facts recorded (SDK 3.17.3 in the devtools):
`wx.canIUse('shareFileMessage') === true` → the forward action is offered;
`openDocument` opens PDFs; `wx.downloadFile` has no observed ceiling below the
20MB cap (a 193B pdf was used; the cap remains the server-side knob).
Also learned: **`data-testid` does not survive into the MP WXML** (Taro strips
it; only `data-sid` remains) — MP assertions must use classes, which every new
surface provides (`file-chip`, `file-chip-saved`, `res-card`, `res-*`).

Fixture caveats (not product behavior): the seeded resources used random content
hashes, so the boot-time seeding pass produced a second row for the same chart
option (real captures dedupe by hash — unit-tested); and switching to a session
with no dsh counterpart can bounce the client back to the welcome, which is the
probe-then-resume path, unrelated to the library.

## Open items (see tasks.md)

- **8.4**: uploaded **0.6.0** (`upload --project miniapp/dist --upload-version
  0.6.0`, confirmed, package 1,014,881 bytes). Console resubmission (提审) is the
  user's step in mp.weixin.qq.com; the self-test path is: history drawer →
  我的资源 → preview a file, and a chat link → chip → 存入资源.
- **9.2 live probe / 9.4 release** need a deployed cell; the standard pipeline is
  Jenkins (`platform` job) → Harbor → GitOps tag bump → ArgoCD, then the mini
  program after (cell-first ordering keeps the older client's 404-hide working).