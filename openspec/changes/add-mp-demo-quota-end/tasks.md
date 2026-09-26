# Tasks: add-mp-demo-quota-end

## 1. Server signal (server/ws.js)

- [ ] 1.1 Add `code: "demo_limit"` to `DEMO_LIMIT_REPLY` and `code: "sandbox_limit"` to `SANDBOX_LIMIT_REPLY`; keep messages unchanged
- [ ] 1.2 Attach `budgetLeft` (remaining after this prompt) to `user_echo` for connections under a budget — gateway shape: per-cell remaining for demo-group identities; sandbox shape: per-connection remaining; absent when no budget applies
- [ ] 1.3 Surface the error `code` and `user_echo.budgetLeft` in the WS contract types (`packages/core/src/types/ws.ts`) as optional fields

## 2. Core store (packages/core)

- [ ] 2.1 Add `demoExhausted: { shape: "cell" | "connection"; message: string } | null` and `demoBudgetLeft: number | null` to the chat store
- [ ] 2.2 In `case "error"`: route `demo_limit`/`sandbox_limit` codes to set `demoExhausted` (bypassing `chatErrorSink`) and clear `pendingConfig`; in `case "user_echo"`: store `budgetLeft` and clear `demoExhausted`

## 3. Mini-program end state (miniapp/src)

- [ ] 3.1 Wire `setChatErrorSink` to a toast in the MP runtime wiring (app.tsx or lib/runtime boot)
- [ ] 3.2 `DemoQuotaCard` component per D4: block-card pattern at the transcript foot, two shapes with their primary actions (`goLogin` / `runtime.reconnectNow()`), dismissible
- [ ] 3.3 Chat page: restore the rejected prompt to the draft when `demoExhausted` arrives and the draft is empty; render the card at the transcript foot
- [ ] 3.4 Demo line shows 「剩 N 条」 when `demoBudgetLeft` is a number (体验模式 and 演示环境 variants); keeps current copy otherwise

## 4. Tests and verification

- [ ] 4.1 Core store test (or e2e seam): `demo_limit` error sets `demoExhausted` shape cell without touching the error sink; `user_echo.budgetLeft` updates the count and clears exhaustion
- [ ] 4.2 Sandbox-path e2e/manual probe: cap a sandbox connection (MP_DEMO_MSG_LIMIT=2 against a local pod), verify the card renders, the draft is restored, reconnect clears it, and a fresh budget accepts a new prompt
- [ ] 4.3 Gateway-shape manual probe (demo-group identity): per-cell exhaustion shows the bind-upgrade card; the 体验模式 line counts down
- [ ] 4.4 Typecheck + weapp build + wechatide screenshot of both card shapes over the local sandbox pod
