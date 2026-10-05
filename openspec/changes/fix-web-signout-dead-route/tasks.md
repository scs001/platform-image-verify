# Tasks: fix-web-signout-dead-route

## 1. Cell env contract

- [x] 1.1 In `gateway/spawner.js` cell env block, add `AUTH_LOGOUT_PATH: "/api/auth/logout"` and `AUTH_LOGIN_PATH: "/auth/login"` with a comment stating the invariant (cells live behind the gateway; the gateway owns the auth entry/exit routes; revisit if an `/oauth2/*` edge ever returns). Verify: env lines present; `node --check gateway/spawner.js` clean.
- [x] 1.2 Unit-check the contract if the env construction is importable without spawning (assert the override beats the forward-auth default); if not importable, record the deliberate skip in this task note. Verify: `npm run test:unit` (or the specific script) green, or skip note present. Note: env construction is closure-internal (not importable), so used the established stub-dump harness — new `scripts/test-cell-auth-paths.mjs` boots the real registry against an env-dumping stub and asserts both paths, including that a gateway-level stale `/oauth2/sign_out` env loses to the spawner's values. Green in 1.3s.

## 2. Regression safety

- [x] 2.1 Run existing auth e2e (`npx playwright test e2e/auth-catalog.spec.js --project=fast`) — forward_auth default assertions must stay green. Verify: suite passes with no modifications to those assertions. Note: suite 12/12 green after fixing a PRE-EXISTING stale assertion (line 280 authenticated /api/auth/me lacked the adminGroups field added in 083889a; 90cff68's assertion catch-up missed it — stash-verified the failure predates this change).
- [x] 2.2 Confirm single-process behavior is untouched: boot a dev server with `AUTH_MODE=forward_auth` and no override, `GET /api/auth/me` still reports `/oauth2/sign_out`. Verify: curl output matches the default.

## 3. Deploy + live verification (fd-prod)

- [ ] 3.1 Ship via the standard line (TCR image + GitOps `platform.yaml` needs no change — env is code-side) and roll the gateway pod. Verify: new image sha live in `kubectl get deploy platform -n fd-prod`.
- [ ] 3.2 Browser chain on 壹座: sign in → Settings → Account → 退出登录 → land logged out on the site root with `paas_session` cleared. Verify: cookie inspector / second `/api/auth/me` call unauthenticated.
- [ ] 3.3 SSO session really dead: after sign-out, open the site again and walk login — the Logto hosted page shows the credential form (no silent bounce-back). Verify: manual browser observation, screenshot in change notes.
- [ ] 3.4 Cross-check 谦面 and 萬星 still behave as before (facet sign-out unchanged; wanxing console untouched by this deploy). Verify: quick smoke of facet sign-out only.
