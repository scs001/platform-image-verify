import { test, expect } from "@playwright/test";
import { openSettings } from "./helpers.js";

// Settings → Plugins (openspec: add-dsh-plugin-supply). The UI contract of the
// whitelisted dsh bundle roster: rows render from the `plugins` WS snapshot,
// management-protected rows stay untoggleable with their badge, a toggle shows
// the applying state until the `plugins_changed` pulse lands, and a live turn
// grays every switch out.
//
// The roster is driven through the e2e store seam — the same seam chat-store
// specs use. The WIRE contract (real plugins/list + persisted toggle against a
// supplied bundle) is pinned by dsh-contracts ⑱, not here.
//
// The fixture id must NOT be a real bundle. dsh-profile-template declares
// `@platform/supply-probe-bundle` in its bundles list, so the child's own
// plugins/list now returns that row (with `error.code: "operation-error"` in
// this layout, where the sample package is not resolvable) — injecting a row
// under the same id raced that snapshot and the real row won, which is what
// turned these UI assertions red. A synthetic id cannot collide.

const SAMPLE = {
  id: "@e2e/roster-fixture",
  name: "@e2e/roster-fixture",
  version: "0.0.1",
  description: "Sample dsh bundle proving the platform plugin-supply chain.",
  enabled: true,
  installed: true,
  optional: false,
  removable: true,
};

const BASE_ROW = {
  id: "@deepseek-ai/dsh-base",
  name: "@deepseek-ai/dsh-base",
  enabled: true,
  installed: false,
  optional: false,
  removable: false,
  readOnlyReason: "management-required",
};

const FAILED_ROW = {
  id: "@example/broken-bundle",
  name: "@example/broken-bundle",
  enabled: false,
  installed: true,
  optional: false,
  removable: true,
  error: { code: "not-bundle", message: "no dsh bundle patch found" },
};

async function applyRoster(page, bundles, available = true) {
  await page.evaluate(
    ({ bundles, available }) => window.__chatStore.getState().apply({ type: "plugins", bundles, available }),
    { bundles, available },
  );
}

test.beforeEach(async ({ page }) => {
  await openSettings(page, "plugins");
  // The section sends its own `list_plugins` when the socket connects; the
  // REAL roster lands a beat later and would overwrite an injected one
  // mid-assertion (observed: the injected rows vanish between expects).
  // Wait for that first real answer, then every test injects on top of it.
  await page
    .waitForFunction(() => window.__chatStore?.getState().pluginsAvailable === true, null, { timeout: 20000 })
    .catch(() => {});
});

test("roster renders rows with protection and failure metadata", async ({ page }) => {
  await applyRoster(page, [BASE_ROW, SAMPLE, FAILED_ROW]);

  await expect(page.getByTestId("plugins-list")).toBeVisible();
  const sampleRow = page.getByTestId(`plugin-row-${SAMPLE.id}`);
  await expect(sampleRow).toBeVisible();
  await expect(sampleRow).toContainText(SAMPLE.description);
  await expect(sampleRow.getByTestId(`plugin-toggle-${SAMPLE.id}`)).toBeEnabled();

  // Management-protected: badge visible, switch untoggleable.
  const baseRow = page.getByTestId(`plugin-row-${BASE_ROW.id}`);
  await expect(baseRow).toBeVisible();
  await expect(baseRow).toContainText("Required by management");
  await expect(baseRow.getByTestId(`plugin-toggle-${BASE_ROW.id}`)).toBeDisabled();

  // A bundle that failed to resolve carries its reason and cannot be enabled.
  const failedRow = page.getByTestId(`plugin-row-${FAILED_ROW.id}`);
  await expect(failedRow).toContainText("no dsh bundle patch found");
  await expect(failedRow.getByTestId(`plugin-toggle-${FAILED_ROW.id}`)).toBeDisabled();
});

// The "Applying…" transient itself is NOT assertable against the live server:
// this fixture id is not a real bundle, so dsh answers `set_enabled failed:
// operation-error` within milliseconds and the marker retires off the error
// signal before any assertion can see it (that speed is the fixed behaviour —
// the marker used to stick forever). What IS worth pinning is the invariant
// that made the old bug user-visible: the marker always retires, by EITHER
// path, and it never freezes the rest of the pane.
test("the applying state retires when the roster pulse lands", async ({ page }) => {
  await applyRoster(page, [SAMPLE]);
  const toggle = page.getByTestId(`plugin-toggle-${SAMPLE.id}`);
  await expect(toggle).toBeEnabled();

  await toggle.click();
  // The server's own completion signal: a fresh roster with the new state.
  await page.evaluate(
    ({ bundles }) => window.__chatStore.getState().apply({ type: "plugins_changed", bundles }),
    { bundles: [{ ...SAMPLE, enabled: false }] },
  );
  await expect(page.getByTestId(`plugin-row-${SAMPLE.id}`)).not.toContainText("Applying…", { timeout: 10_000 });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
});

test("a rejected toggle retires the applying state instead of freezing the pane", async ({ page }) => {
  // A rejected toggle never broadcasts `plugins_changed` (ws.js sends only
  // `{type:"error"}`), so without an error-keyed clear the row would sit on
  // 「Applying…」forever — and because `disabled` treats `pending !== null` as
  // global, every other switch in the pane would be dead until remount.
  await applyRoster(page, [SAMPLE, { ...SAMPLE, id: "@e2e/second-row", name: "@e2e/second-row" }]);
  const toggle = page.getByTestId(`plugin-toggle-${SAMPLE.id}`);
  await expect(toggle).toBeEnabled();

  await toggle.click();
  await page.evaluate(() =>
    window.__chatStore.getState().apply({ type: "error", message: "plugins/set_enabled failed: operation-error" }),
  );

  // Idle again, and the sibling row is still operable.
  await expect(page.getByTestId(`plugin-row-${SAMPLE.id}`)).not.toContainText("Applying…", { timeout: 10_000 });
  await expect(toggle).toBeEnabled();
  await expect(page.getByTestId("plugin-toggle-@e2e/second-row")).toBeEnabled();
});

test("a live turn grays every switch out", async ({ page }) => {
  await applyRoster(page, [SAMPLE]);
  await page.evaluate(() => window.__chatStore.setState({ isStreaming: true }));

  await expect(page.getByTestId("plugins-streaming-hint")).toBeVisible();
  await expect(page.getByTestId(`plugin-toggle-${SAMPLE.id}`)).toBeDisabled();

  await page.evaluate(() => window.__chatStore.setState({ isStreaming: false }));
  await expect(page.getByTestId(`plugin-toggle-${SAMPLE.id}`)).toBeEnabled();
});

test("an empty roster states that nothing is supplied", async ({ page }) => {
  await applyRoster(page, []);
  await expect(page.getByTestId("plugins-empty")).toBeVisible();
});
