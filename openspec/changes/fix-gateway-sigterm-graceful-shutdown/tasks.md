# Tasks — fix-gateway-sigterm-graceful-shutdown

## 1. Fix + local proof

- [ ] 1.1 `gateway/index.js`: hoist `packRegistry` to module-scope `let` (assign in the pack-mode branch, drop `const`); wrap `shareRegistry.close()` and `packRegistry.close()` in isolated try/catch with an error log; fix the two mis-indented handler lines
- [ ] 1.2 Local boot check: boot the gateway (CELL_GATEWAY_SECRET, temp CELL_DATA_ROOT, free port) → SIGTERM → exit 0, `stopping 0 cell(s)` logged, no ReferenceError (the discovery recipe, now green)
- [ ] 1.3 Mode sanity: boot with `FACET_BASE_URL` set (facet-proxy mode) → SIGTERM → still exits cleanly through the null-guarded branch

## 2. Regression coverage

- [ ] 2.1 `scripts/test-cell-gateway.mjs`: after the existing subtests, SIGTERM the booted gateway — assert exit code 0, the cell-stop log line, and no unhandled-rejection text in captured logs
- [ ] 2.2 Run the file in a clean git worktree (shared-tree churn makes cell-dependent verdicts unreliable in the main tree); full `node --test scripts/test-cell-gateway.mjs` green there; own-file also green in main tree
- [ ] 2.3 Remove the worktree and any stray gateway/cell test processes afterward (test-cleanup discipline)

## 3. Release + live verification

- [ ] 3.1 Commit (gateway/index.js + test + change artifacts) and push; wait for the `image` GHA run to succeed
- [ ] 3.2 fd-infra-deploy double bump: `platform.yaml` + `platform-demo.yaml` → new sha tag (also carries 07cb7f7's mobile fix to demo); push gitee; wait ArgoCD Synced and both deployments rolled
- [ ] 3.3 Verify: replaced pod's termination shows the graceful path (no `packRegistry` ReferenceError, exit 0); new pods `/healthz` 200; ops board remains `all nominal`
- [ ] 3.4 `openspec validate fix-gateway-sigterm-graceful-shutdown --strict` green before archive; archive after burn-in per usual gate
