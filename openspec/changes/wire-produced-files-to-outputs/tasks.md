# Tasks: wire-produced-files-to-outputs

## 1. The rule gains the three production fixes

- [x] 1.1 Segment splitting gains `\n` (`SEGMENT_SPLIT_RE` → `/&&|\|\||[;|\n]/`) in `packages/core/src/lib/file-tool-paths.ts`; a `tar` line after a redirected line becomes its own segment. Pinned case: the verbatim production command `… | sort > /tmp/doclist.txt\ntar -czf workspace-docs.tar.gz -T /tmp/doclist.txt…` yields `workspace-docs.tar.gz` (plus the `/tmp` redirect target).
- [x] 1.2 Redirect targets are admitted only when path-shaped (`pathTokens` filter); `print("… -> ", out)`-class pseudo-redirects can no longer mint a candidate. Pinned case: the production heredoc command emits no `", out)\nwith zipfile…` candidate.
- [x] 1.3 A segment containing a heredoc marker (`<<`) is exempt from redirect scanning (heredoc bodies are not shell syntax); its archive-shaped tokens are still scannable under 1.4.
- [x] 1.4 A script-runner segment (verb `python3`/`python`/`node` after prefix unwrapping) contributes archive-extension tokens found in the segment text (command line, `-c` body, heredoc body). Pinned case: the production heredoc command yields `markdown-docs.zip`.
- [x] 1.5 `scripts/test-produced-files.mjs` gains the three production commands as pinned cases plus the regression corpus (multi-line with `&&` across lines, heredoc containing `->` and `=>`, `python3 -c` reading a csv yields nothing, `node -e` writing an archive yields it, prefix-unwrapped `sudo python3`, no-archive heredoc yields nothing). All 13 existing tests stay green.

## 2. The library captures produced files automatically

- [x] 2.1 `resources.js`: the gate → hash → store → insert body of `saveFile` is extracted into an internal function taking `source`; the HTTP route passes `source:"manual"` unchanged (route behavior identical — existing tests green).
- [x] 2.2 New `captureFilesFromTurn({ sessionId, messageId, sessionTitle, blocks, workspaceRoot, createdAt })` next to `captureFromMessage`: iterates tool blocks through `producedFilePaths` (imported from core TS per design; boot-time self-check asserts the import with a known vector and logs loudly on failure), gates each candidate through the internal function with `source:"auto"`, catches everything (never throws), returns the created/refreshed summaries.
- [x] 2.3 `chat-history.js` mirror funnel calls `captureFilesFromTurn` beside the chart capture (workspaceRoot already in scope), inside the same never-fail guard. A capture failure logs `[resources] file capture failed …` and the message record is unaffected.
- [x] 2.4 Unit tests: same-hash capture refreshes `last_seen_at` and inserts nothing; changed bytes insert a new row; candidate outside the workspace root (`/tmp/...`) is refused; oversize candidate is skipped; missing file is skipped; capture throwing does not fail the mirror (fault-injected gate).

## 3. Web surfaces confirm the end-to-end chain

- [x] 3.1 e2e (`e2e/artifact-delivery.spec.js` or a sibling): a multi-line shell command producing a tar.gz surfaces the archive chip (1.1 through the strip).
- [x] 3.2 e2e: a heredoc-style command producing a zip surfaces the zip chip, and no chip titled with code text appears (1.2–1.4 through the strip).
- [x] 3.3 e2e: after a turn produces a file, the Outputs page lists it without any manual save — delivered as a LIVE-gated e2e (`live-functional.spec.js`, `LIVE_SMOKE=1`): a real turn redirects into a workspace file, the Outputs panel lists it, the auto row is cleaned up. Pivoted from a fast-suite case: the fast suite has no server-capture entry (no e2e API channel exists and none was to be invented); the capture core and funnel wiring are pinned by unit tests (scripts/test-file-capture.mjs, 8/8) instead.
- [x] 3.4 The strip's existing scenarios stay green (read-only turn no strip; vanished file not shown) — the redirect filter shrinks candidates only for pseudo-redirects.

## 4. Backfill for the affected cell

- [x] 4.1 `scripts/backfill-workspace-resources.mjs --cell <id>`: lists the cell's workspace tree, runs the same rule-independent gate (containment, realpath, cap) and capture core for every file, `source:"auto"` with empty provenance; idempotent by content hash; dry-run flag printing what would be captured.
- [ ] 4.2 Run once against cell `1da519d4c1c0bf89` after the roll (staging recipe: `/tmp/rt` symlink + `/data` shared mount); verify `markdown-docs.zip`, `workspace-docs.tar.gz`, and the `docs/`/`markdown-docs/` trees appear in Outputs; verify a second run inserts nothing.

## 5. Gates

- [x] 5.1 `npm run lint` clean on touched files (biome: 10 files, 0 issues); typecheck: web+miniapp green with the parallel session's web/src files stashed (exit=0; their three packs-surface errors reproduce with this change fully applied and are not this change's); `npm run test:unit` 1390/1390 (includes the expanded rule tests 20/20, contract 1/1, file-capture 8/8).
- [x] 5.2 Rule replays: (1) tar multi-line `["/tmp/doclist.txt"]` → `["/tmp/doclist.txt","workspace-docs.tar.gz"]`; (2) python heredoc `[code-text garbage]` → `["markdown-docs.zip"]`; (3) pure reader stays `[]`.
- [x] 5.3 `git status` audited: this change's files are packages/core/src/lib/file-tool-paths.ts, resources.js, chat-history.js, server/file-tool-paths-server.js (new), scripts/{test-produced-files,test-file-tool-paths-contract,test-file-capture,backfill-workspace-resources}.mjs (one new), e2e/{artifact-delivery,live-functional}.spec.js, and openspec/changes/wire-produced-files-to-outputs/. The remaining working-tree files (web/src packs surface, locales, facet/web, e2e/facet-shell, trace.db) belong to the parallel session — reproduced present before this session's edits.
- [ ] 5.4 In-pod production verification after roll: produced file in a live turn appears in Outputs; the affected cell's backfilled files render in the Outputs Files panel; opening `markdown-docs.zip` from Outputs downloads real bytes (PK magic).
