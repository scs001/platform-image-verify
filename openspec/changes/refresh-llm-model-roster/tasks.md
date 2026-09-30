# Tasks — refresh-llm-model-roster

Design.md deliberately skipped: single-module roster refresh + one dedup line + test updates; none of the design.md inclusion criteria apply (no cross-cutting change, no new dependency, no data model or migration complexity, no open technical decisions).

## 1. Roster refresh (dsh-profile.js)

- [x] 1.1 Replace `VOLCES_MODELS` (22 entries) with the 13 probe-verified ids below, in this order; keep `deepseek/deepseek-v4.1-flash` first (dshModels[0] fallback default). Verify with `node -e "import('./dsh-profile.js').then(m=>m.effortLevels && 0); const l=(await import('./dsh-profile.js'))"` or a quick `VOLCES_MODELS` count + head assertion via a scratch import.
  1. `deepseek/deepseek-v4.1-flash` — DeepSeek V4.1 Flash, 128k/32768, reasoning (agreed rehearsal lane)
  2. `deepseek-v4-pro` — DeepSeek V4 Pro, 128k/32768, reasoning (probe-flapped 2026-09-30; comment it)
  3. `glm-5.3-flash` — GLM 5.3 Flash, 128k/32768 (only glm the account group serves)
  4. `cohere/north-mini-code:free`
  5. `dots-studio/dots-3-note-preview:free`
  6. `liquid/lfm-2.5-2.6b:free`
  7. `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
  8. `nvidia/nemotron-3-super-120b-a12b:free`
  9. `nvidia/nemotron-3-ultra-550b-a55b:free`
  10. `nvidia/nemotron-3.5-lightning:free`
  11. `poolside/laguna-s-2.1:free`
  12. `google/gemma-4-26b-a4b-it:free` (rate-limited at probe time; comment it)
  13. `poolside/laguna-xs-2.1:free` (rate-limited at probe time; comment it)
  Free-pool entries: contextWindow 128000, maxTokens 8192, no reasoningEfforts.
- [x] 1.2 Rewrite the `VOLCES_MODELS` header comment: probe method (1-token chat probe per id against `/v1/models` output, 2026-09-30), why mimo×6 / glm-5.3/5.2/5.1 / bare `deepseek-v4.1-flash` / `kimi-k2.6` / nex free / content-safety are excluded, and that `deepseek/deepseek-v4.1-flash`'s prefix is part of the id (bare id is a different, unauthorized route). Remove the stale 2026-09-02/09-25 narrative.
- [x] 1.3 Keep `declaredEfforts()` predicates working for the new ids (deepseek family keeps efforts; everything else `false`). Verify: no roster id outside the deepseek families gets a truthy efforts map.

## 2. Merged-list dedup (server/agent-session.js)

- [x] 2.1 In `getAvailableModels()`, dedupe by model id with first-occurrence-wins before returning. Verify with a unit-level check: fabricate `ctx.dshModels` with a duplicate id across two providers, assert one entry. (Logic check via fabricated loop + syntax check passed here; real-path integration verified in 4.1's dev boot — env route + finddata both list the same 13 ids, so the dropdown showing 13 rows proves the dedup live.)

## 3. Tests

- [x] 3.1 Update `e2e/model-selection.spec.js`: replace the FROZEN set (`deepseek-v4-pro-0813`, `deepseek-v4-flash-0731`, `glm-5.2`) with ids guaranteed absent from the new roster (e.g. `kimi-k2.6`, `glm-5.2`, `deepseek-v4-flash-0731`) and fix any other roster-derived assertions. Run the spec locally (`e2e` harness with smoke provider override per playwright-harness-quirks) and confirm green. (FROZEN switch-targets now come from the new roster; the list_models test asserts 13 ids + deepseek head + dead ids absent + no cross-provider duplicates; 6/6 passed, 2026-09-30.)

## 4. Dev data files

- [x] 4.1 Update gitignored `llm-providers.json` (provider `finddata`): models array = same 13 entries (ids + display names + 128k/32768 for the top three, 8192 for free pool). Verify file parses and `npm run dev` boot shows 13 models in the dropdown without duplicates (env route + user provider overlap deduped). (Verified via isolated boot on :3101, real repo stores, temp DSH_HOME: list_models → 13 unique, deepseek head, efforts present; also fixed dev's deepseek entry from maxTokens 8192 → 32768.)
- [ ] 4.2 Update `llm-default.json` → `{ providerId: "finddata", modelId: "deepseek/deepseek-v4.1-flash" }` and `.env` `DEFAULT_MODEL=deepseek/deepseek-v4.1-flash`. Verify: fresh dev boot, model chip shows DeepSeek V4.1 Flash; a one-shot chat replies (live probe, same lane as rehearsals). (Pointers SET and boot verified — dsh spawned provider=volces model=deepseek/deepseek-v4.1-flash, /api/llm/default agrees. Live chat BLOCKED: the gateway's account group no longer authorizes `deepseek/deepseek-v4.1-flash` — 404 model_not_found on both the public token gateway and prod's in-cluster 32080 route, re-checked ×2 each. Awaiting user decision: fix gateway account group vs switch default lane.)

## 5. Prod rollout (apply phase)

- [ ] 5.1 Commit + push → Jenkins `platform` job (PROD node, one executor; watch for the known builder-image race on first build). Deploy normally (roster change ships in code; no config map change needed).
- [ ] 5.2 Update prod `/data/llm-providers.json` (finddata-token models array → same 13 entries; backup first per ops convention). Hot-reload via `POST /api/models/refresh` (admin) or rely on the settings-file Chokidar watch; verify `/api/llm/providers` and `/api/llm/default` reflect 13 models + deepseek default, model chip in UI agrees, and one live chat turn succeeds. Record sha + Jenkins build in the deploy doc entry.
