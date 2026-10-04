# Tasks — fix-ops-console-board-alarms

## 1. Gateway: anonymous /api/ready

- [x] 1.1 `gateway/index.js`: register `GET /api/ready` next to `/healthz` with the identical payload (`{ok, uptimeMs, cells}`); no identity resolution, no cell routing — must answer during an IdP outage
- [x] 1.2 Local check: boot the gateway module (or route table stub) and assert anonymous `/api/ready` → 200 JSON, `/healthz` unchanged
- [ ] 1.3 Commit + release via GHA→TCR, then GitOps double bump (`fd-infra-deploy` `platform.yaml` + `platform-demo.yaml` → new sha tag), wait for ArgoCD Synced
- [ ] 1.4 Verify live: `curl http://100.64.0.12:31870/api/ready` → 200 (was 401); `:31871/api/ready` still 200

## 2. Console: drift de-Jenkinsed + truthful ages + legend

- [x] 2.1 `services/ops-console/index.js`: add main-guard (poll boot + `server.listen` behind `import.meta.url === pathToFileURL(process.argv[1]).href`); export pure helpers (`computeDrift`, new `storeLastOk`) for tests — file stays single-file, zero deps
- [x] 2.2 `computeDrift(runningTag, argocd)` (Jenkins input removed): delete `newer-build-not-rolled` / `cluster-out-of-sync-and-stale`; states = `in-agreement` (Synced), `cluster-out-of-sync` (OutOfSync), `unknown` (no facts); deployments outside the ArgoCD app (search-relay) render drift `n/a`
- [x] 2.3 Card render: drop the `build →` step from per-deployment chains (image → gitops → pods → probe); Jenkins card unchanged (display-only: queue, history, last build); `overallStatus` exempts `n/a` from warnings
- [x] 2.4 `storeLastOk(source)`: newest-first scan for the first snapshot without `__error`; `renderFleetOverview` degraded line shows `last ok <true age>` or `never succeeded` — never the failed write's own timestamp
- [x] 2.5 Five-state legend under the agent-fleet header (one dim line, copy from design D5-note): serving = turn in flight · resident = warm & idle · starting/draining/paused · warm = no live process (re-warms on demand)
- [ ] 2.6 Unit tests `scripts/test-ops-console-board.mjs` (joins `npm run test:unit`): drift matrix (synced + differing fallback tag → in-agreement; OutOfSync → flagged; no argocd → n/a), `storeLastOk` (error-after-success, never-succeeded), legend present in rendered fleet section (temp SQLite DB + stub snapshots); run full `test:unit` green

## 3. Cluster config (Secret keys)

- [ ] 3.1 Patch `ops-console-secrets`: `FLEET_BOARD_URL` `http://fleet-observer:3200` → `http://100.64.0.12:31881` (NodePort, not Service port 3200); add `PROBE_SEARCH_RELAY_URL` = `http://10.43.104.254:4597/healthz`; `kubectl -n fd-prod rollout restart deploy/ops-console`
- [ ] 3.2 Verify: fleet overview renders live observer data (states/turns/wake rows populated, no `board read failed`); search-relay card probe ok · ms

## 4. Console code deploy + board acceptance

- [ ] 4.1 Re-embed updated `index.js` into `ops-console-code` ConfigMap in `fd-infra-deploy/all-services/prod/ops-console.yaml`, push gitee, ArgoCD sync, `kubectl -n fd-prod rollout restart deploy/ops-console` (subPath never hot-updates)
- [ ] 4.2 Acceptance screenshot of the board: platform probe ok, platform + platform-demo cards `in-agreement`, badge `all nominal` (0 incidents / 0 warnings), fleet overview live, legend visible, search-relay probe ok — attach to change
- [ ] 4.3 Regression check: fleet section + billing still render; `/api/board.json` returns `cards[].drift` in the new shape (no `built` field participating)

## 5. Close-out

- [ ] 5.1 Probe residual check per test-cleanup discipline (no stray console/dsh test processes)
- [ ] 5.2 `openspec validate fix-ops-console-board-alarms --strict` green; archive after burn-in per usual gate (sync specs before archive)
