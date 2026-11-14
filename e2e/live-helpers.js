// Live-service test helpers.
//
// The `live` Playwright project targets the *deployed* public entry
// (https://platform.finddatatech.cloud by default) instead of a locally-launched
// `node server.js`. The old default pointed at an internal NodePort that has
// since gone dark, and keeping it made every live run fail as if the product
// were broken (2026-11-14). These tests are read-only: they assert the deployed app
// boots, routes resolve, the WS connects, and the embedded panels mount -
// without writing chat history, uploading documents, or spending LLM tokens
// (the @live-smoke chat-turn is gated behind LIVE_SMOKE=1).
//
// Re-exports the navigation helpers from helpers.js so the live suite uses the
// exact same contract (status-text "Connected", testids) as the local suite.

export const LIVE_SERVICE_URL =
  process.env.LIVE_SERVICE_URL || "https://platform.finddatatech.cloud";

// Truthy when the @live-smoke chat-turn should run (spends one LLM token).
// Read lazily so a `LIVE_SMOKE=1` set on the playwright CLI is honored.
export function liveSmokeEnabled() {
  return process.env.LIVE_SMOKE === "1" || process.env.LIVE_SMOKE === "true";
}

// Skip guard for the @live-smoke test. Use inside the test body so the test is
// reported as skipped (not absent) when LIVE_SMOKE is unset.
//
//   test("live chat-turn @live-smoke", async ({ page }) => {
//     test.skip(!liveSmokeEnabled(), "set LIVE_SMOKE=1 to run the live chat-turn");
//     ...
//   });
export { gotoChat, gotoDashboard, gotoDocuments, pinLocaleEn } from "./helpers.js";
