#!/usr/bin/env node
// ── E2E flake budget (2026-11-13) ────────────────────────────────────────────
//
// The fast e2e lane is a shared-session, load-sensitive suite. It is NOT
// deterministic: measured 2026-11-13 across four full runs (two CI, two local),
// every run ended with 5-6 reds and no two runs agreed on WHICH ones —
// pack-usage / copilot-dock / onboarding / delegation / session-open /
// registry-connect / plugins-supply / websearch all took turns, and every one of
// them passes when its file runs alone.
//
// 2026-11-14: focus-overlay and pack-agent-scoping left both the list AND the
// rotation above. Their red was not a flake at all — it was a preset roster that
// never reached the child (fix-catalog-preset-roster-convergence: restart
// colliding, no spawn budget, the restart window read as "no agent modes",
// declines eating the failure budget, a dropped initializeTimeoutMs, and no way
// to name who held the child).
//
// The last hole was outside that change and worth naming here because it decided
// a dozen reds: a DELEGATION turn whose prompt failed left its collector in
// `sessionCollectors` + `taskTurnRegistry` for the full 10-minute turn timeout,
// and both are inputs to `runtimeBusy()` — so the whole cell counted as busy and
// every deferred restart (MCP patch, credential, catalog roster) was blocked.
// Runs measured before/after that one catch-block fix, same tree, same suite:
// 9 red / 693 green / 33.9m (focus-overlay, pack-agent-scoping, onboarding and
// both session-solution tests inside the blackout) → 3 red / 715 green / 27.9m
// with every preset test green. `describeRuntimeBusy()` is what named it; keep
// that log line when trimming anything here.
//
// delegation.spec.js came OFF the list on the same evidence: it was the spec
// whose failed turn leaked, so its own second test waited behind the first one's
// stuck collector. After the release-on-failure fix: full lane 715/3 with both
// its tests green, then three consecutive runs of the whole blackout cluster
// (delegation + focus-overlay + onboarding + pack-agent-scoping +
// session-solution) at 29/29 — 4.8m, 4.8m, 5.9m. If it goes red again, read
// `describeRuntimeBusy()` first; the retry budgets are rarely the answer.
//
// The 3 left in run seven: auth-catalog ×2 (in this list) and
// resources-binding:265. Measured properly afterwards (six independent runs of
// the whole file, 2026-11-14): 4 green / 2 red — NOT load. The tick log this
// investigation added to `chart-refresh.js` says why: the timer runs, the
// freshness gate answers `skipped_fresh`, so the series is never re-read and the
// page's period count stays at the armed value. The gate asks `data_stats` for a
// fingerprint (`last_fetch|latest_date|rows`); the spec's fake changed the
// SERIES but not the STATS, so whether the test passed depended on whether an
// earlier test in the same file had already stored that fingerprint.
// Fixed test-side. The mechanism is worth remembering because it is a FIXTURE
// lying about the source, not a product defect:
//   - `e2e/fake-mcp.js` now derives `rows`/`latest_date` from the series it
//     serves (an explicit `stats` block still overrides, for a spec that needs a
//     lying source) — a real source's coverage moves when its data does;
//   - the spec appends the extra period AFTER the page is open and after its
//     `before` snapshot, so the assertion no longer depends on whether the
//     on-open read got there first;
//   - two further reds surfaced once the file ran deterministically, both
//     harness teardown races rather than page behaviour: a `route.fetch()`
//     response disposed when the page closed mid-flight, and `storedResource()`
//     sampling the store during the empty window of a list refetch. Both now
//     wait or yield instead of throwing.
// Result: 11 consecutive green whole-file runs (runs 8–18, 13–21 s each). The
// product-side alternative — force-read every N skips, so a lying `data_stats`
// cannot park a binding forever — stays open as its own change: a wrong
// `data_stats` from a real source is still unfalsifiable from inside a binding.
// voice:152 stays OUT of this list on purpose: it fails standalone (the speak
// button reads "playing" 10s after a 0.4s fixture) because this host's headless
// Chromium has no advancing audio clock — a real environment limit, documented
// at the assertion, not a flake to be blessed.
//
// A gate that is red every run carries no information: the red you must not
// ignore looks exactly like the five you must. So this step keeps the lane
// ENFORCED (the step above it is `continue-on-error`, and this step fails the
// job) but judges it against two signals instead of a binary:
//
//   1. a red in a spec file that is NOT on the known-flake list → instant fail.
//      A regression in an otherwise-green spec is exactly what the old binary
//      gate was for, and this keeps it.
//   2. more reds than FLAKE_BUDGET → fail. The measured band is 5-6; a real
//      regression on this suite shows up as a burst (one shared cause, many
//      specs), so 8 leaves room for the band and none for a burst.
//
// Usage: node scripts/check-e2e-budget.mjs <playwright-json-report>
// Exit 0 = within budget (names still printed). Exit 1 = regression.

import { readFileSync } from "node:fs";

// Measured over five full runs on 2026-11-13: 4, 5, 6, 6, 8 reds. The band is
// wide because it tracks runner load, not the code. 10 keeps a little headroom
// above the observed maximum while staying far below what one shared cause
// produces on a 748-test suite (the case this backstop is for).
//
// The band and this gate are measured in CI's caliber: the job runs with
// `retries: CI ? 2 : 0` (playwright.config.js), so a red here has failed THREE
// times. A local run (retries 0) reports every first-attempt flake and therefore
// a higher number from the same tree — measured 2026-11-13: 6 locally, 3 in CI.
// Do not recalibrate the budget against a local run, and do not conclude "CI
// will go red" from a local count.
const FLAKE_BUDGET = 10;

// Spec files observed to fail under load and pass alone. Adding a file here is a
// decision to tolerate its reds; the count still has to stay inside the budget.
//
// Three files came OFF this list on 2026-11-13 (packs, registry-connect,
// websearch). They were not flakes: they were victims of a state leak, and the
// leak is now fixed at its source — the active agent preset is deployment-global
// and a pack-role focus narrows the MCP surface to three servers, so every file
// after packs.spec read a profile without websearch (see the e2e/helpers.js
// switchPreset comment). Evidence: two full local runs after the fix, 6 and 5
// reds, in both cases ZERO of the 137 spec files ended with a narrowed profile
// (it was 6/137), packs/registry-connect/websearch green in both, and the
// public CI run 43423955544 reddened only fleets / plugins-supply /
// session-navigation-streaming / session-open. If one of these three reds again,
// put it back AND read the leak first — the file that fails is usually not the
// file that caused it.
// Playwright reports `spec.file` relative to the configured testDir, i.e.
// "websearch.spec.js" — never "websearch.spec.js". Comparing repo-relative
// paths (the first version did) marks EVERY file as unknown, so the gate fails
// on a clean band and says nothing about regressions. Normalise to basenames.
const baseName = (file) => String(file ?? "").split("/").pop();

// Removed 2026-11-14 (fix-catalog-preset-roster-convergence 4.2): the roster
// these two waited 90s for now converges. Evidence — full fast lane 713 passed /
// 3 failed with both files GREEN (`/tmp/full-run-5.log`), and the narrowed pair
// `delegation + focus-overlay` 8/8 while the delegation turn was live. They go
// back on this list only with a fresh round of evidence, never as a default.
const KNOWN_FLAKY = new Set([
  "auth-catalog.spec.js", // spawns its own server; 12/12 three times standalone 2026-11-13
  "copilot-dock.spec.js",
  "fleet-ops-canvas.spec.js", // canvas paint/embed frames: green 4× standalone 2026-11-13
  "fleets.spec.js", // already named as flaky in ci.yml ("session-open, fleets pass on retry")
  "onboarding.spec.js",
  "pack-usage.spec.js",
  "plugins-supply.spec.js",
  "session-navigation-streaming.spec.js",
  "session-open.spec.js",
]);

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/check-e2e-budget.mjs <playwright-json-report>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  // No report = the run never reached the reporter (build/webserver failure).
  // That is a real failure, not a flake: say so instead of passing quietly.
  console.error(`✗ no readable e2e report at ${file}: ${err.message}`);
  console.error("  (the lane did not get far enough to produce one — treat as failure)");
  process.exit(1);
}

// Playwright's JSON reporter puts the suite tree under .suites; walk it and
// collect specs whose last result is not ok, without depending on the (stable
// but deep) config/suite nesting for anything else.
const failed = [];
const walk = (suite, trail) => {
  const path_ = suite.file ? [suite.file] : trail;
  for (const spec of suite.specs ?? []) {
    const bad = (spec.tests ?? []).some((t) =>
      (t.results ?? []).some((r) => r.status !== "passed" && r.status !== "skipped"),
    );
    if (bad) failed.push({ file: spec.file ?? path_[0] ?? "(unknown)", title: spec.title });
  }
  for (const child of suite.suites ?? []) walk(child, path_);
};
for (const s of report.suites ?? []) walk(s, []);

const stats = report.stats ?? {};
const unexpected = Array.isArray(failed) && failed.length ? failed.length : (stats.unexpected ?? 0);

if (unexpected === 0) {
  console.log(`✓ e2e lane clean (${stats.expected ?? "?"} passed)`);
  process.exit(0);
}

console.log(`e2e reds this run: ${unexpected} (budget ${FLAKE_BUDGET})`);
for (const f of failed) console.log(`  · ${f.file} — ${f.title}`);

const unknown = [...new Set(failed.map((f) => baseName(f.file)))].filter((f) => !KNOWN_FLAKY.has(f));
if (unknown.length) {
  console.error(`\n✗ red in spec file(s) with no flake history: ${unknown.join(", ")}`);
  console.error("  A green spec does not go red from load alone. Treat as a regression");
  console.error("  until the file is shown to pass standalone 3× on this commit.");
  process.exit(1);
}

if (unexpected > FLAKE_BUDGET) {
  console.error(`\n✗ ${unexpected} reds exceed the measured flake band (${FLAKE_BUDGET}).`);
  console.error("  A band that size means one shared cause, not nine independent flakes.");
  process.exit(1);
}

console.log("\n✓ all reds are in files with flake history, and inside the budget.");
console.log("  Named above so they are still visible; fix the file, then remove it from");
console.log("  KNOWN_FLAKY in scripts/check-e2e-budget.mjs.");
