import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// AgentsPage = the agent builder hub (add-agent-builder-hub): four areas —
// Build (default), Supply, Creations, Tuning. The active tab is reflected in
// ?tab=... and round-trips on reload. Legacy deep links canonicalize:
// ?tab=agents → Creations, ?tab=market → Supply (SURFACE_SLUG_ALIASES, the
// hub's central legacy map). The Apps tab is retired — its entries live in
// the app center; the legacy ?tab=apps deep link falls back to the first
// visible tab.

// W2 teardown (0eb48a0d0) retired the /agents four-zone hub (AgentsPage →
// AgentMarketPage) but never synced this spec — every assertion on
// agents-page testids has been dead since. Marked fixme rather than deleted
// until the hub spec is rewritten against AgentMarketPage (separate batch).
test.describe("agents page hub areas", () => {
  test.skip(true, "W2 retired the /agents hub this spec asserts on (0eb48a0d0); rewrite against AgentMarketPage");
  test("default area is Build", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-build")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("build-section")).toBeVisible();
    await expect(page.getByTestId("build-studio-btn")).toBeVisible();
  });

  test("the Apps tab is retired: no tab, no section, legacy deep link falls back", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-apps")).toHaveCount(0);
    await expect(page.getByTestId("apps-section")).toHaveCount(0);

    // The legacy deep link falls back to the first visible tab, no error.
    await page.goto("/agents?tab=apps");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-build")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agents-tab-apps")).toHaveCount(0);
  });

  test("deep-link via ?tab=creations, and its legacy alias ?tab=agents", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=creations");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-creations")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("creations-section")).toBeVisible();

    await page.goto("/agents?tab=agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-creations")).toHaveAttribute("aria-selected", "true");
  });

  test("Creations area embeds the custom-preset management surface", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=creations");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    // 我的专家 — the preset surface (add-custom-presets) lives under the grid.
    await expect(page.getByTestId("custom-presets-page")).toBeVisible();
    await expect(page.getByTestId("preset-create")).toBeVisible();
  });

  test("deep-link via ?tab=market (legacy) shows the supply area with the marketplace cabinet", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=market");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-supply")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("supply-section")).toBeVisible();
    await expect(page.getByTestId("packs-page")).toBeVisible();
  });

  test("supply cabinets: skills and MCP reuse the Settings section components", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=supply");
    await expect(page.getByTestId("supply-section")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("supply-cabinet-skills").click();
    await expect(page.getByTestId("supply-skills")).toBeVisible();
    await expect(page.getByTestId("extensions-page")).toBeVisible();
    await page.getByTestId("supply-cabinet-mcp").click();
    await expect(page.getByTestId("supply-mcp")).toBeVisible();
  });

  test("tuning area hosts candidates review and the persona placeholder", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=tuning");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-tuning")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("tuning-section")).toBeVisible();
    await expect(page.getByTestId("tuning-persona-placeholder")).toBeVisible();
  });

  test("retired Settings sections redirect into the hub", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/presets");
    await expect(page).toHaveURL(/\/agents\?tab=agents$/);
    await expect(page.getByTestId("agents-tab-creations")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("custom-presets-page")).toBeVisible();

    await page.goto("/settings/packs");
    await expect(page).toHaveURL(/\/agents\?tab=market$/);
    await expect(page.getByTestId("agents-tab-supply")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("packs-page")).toBeVisible();
  });

  test("Settings alias does not fork: the same extension component serves both homes", async ({ page }) => {
    await pinLocaleEn(page);
    // The Settings MCP section keeps working…
    await page.goto("/settings/mcp");
    await expect(page.getByTestId("extensions-page")).toBeVisible({ timeout: 15000 });
    // …and the supply MCP cabinet mounts the same component (same testid,
    // same state source) — two entries, one component, no fork.
    await page.goto("/agents?tab=supply");
    await expect(page.getByTestId("supply-section")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("supply-cabinet-mcp").click();
    await expect(page.getByTestId("extensions-page")).toBeVisible();
    await expect(page.getByTestId("extensions-page")).toHaveAttribute("data-extensions-type", "mcp");
  });
});

test.skip("8.1 back-link (facet-host studio flow; 壹座 /studio retired to redirect — assert moved with the page)", async ({ page }) => {
  await pinLocaleEn(page);
  // Seed a candidate WITH a source doc id (the studio proposal path) and one
  // WITHOUT (the cell MCP path — honest absence, no chip) directly via the API.
  const base = { description: "8.1 back-link leg", body: "1. 读取上期口径。\n2. 与本期对齐。\n3. 差异单独列示（回链验证腿）。", evidence: { source: "turn e2e#1", solved: "口径漂移", boundary: "周报" } };
  const linked = await page.request.post("/api/skill-evolution/propose", { data: { ...base, name: `doclink-${Date.now()}`, sourceDocId: "bp_e2e_backlink_probe" } });
  const bare = await page.request.post("/api/skill-evolution/propose", { data: { ...base, name: `nodoc-${Date.now()}` } });
  const linkedId = (await linked.json()).candidate.id;
  const bareId = (await bare.json()).candidate.id;
  await page.goto("/agents?tab=tuning");
  await expect(page.getByTestId(`skill-candidate-source-doc-${linkedId}`)).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId(`skill-candidate-source-doc-${bareId}`)).toHaveCount(0);
  // The chip is a real route into the workspace.
  await page.getByTestId(`skill-candidate-source-doc-${linkedId}`).click();
  await expect(page).toHaveURL(/\/studio\?doc=bp_e2e_backlink_probe$/);
  // Cleanup: reject both so the review face stays clean for the next run.
  for (const id of [linkedId, bareId]) {
    await page.request.post(`/api/skill-evolution/candidates/${id}/reject`, { data: { reason: "e2e cleanup" } });
  }
});

// ── /packs install face (add-supply-studio-migration 5.2 fix) ────────────────
// facet studio's deployTeam deep link lands on /packs?deployCastPack=<id> —
// the route must exist (previously the catch-all bounced it to /chat) and
// render the pack marketplace surface with the market tab active. This is a
// mount check: the detail dialog's API fan-out is covered by pack specs.
test.describe("packs install face", () => {
  test("/packs mounts the marketplace page instead of falling to chat, deep link param rides", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/packs?deployCastPack=cast_probe_pack");
    await expect(page).toHaveURL(/\/packs\?deployCastPack=cast_probe_pack$/);
    await expect(page.getByTestId("packs-page")).toBeVisible();
    await expect(page.getByTestId("packs-tabs")).toContainText("Market");
    // Not the chat catch-all: no composer.
    await expect(page.locator("textarea[data-testid='composer-input']")).toHaveCount(0);
  });

  test("/packs without params still mounts (direct navigation)", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/packs");
    await expect(page.getByTestId("packs-page")).toBeVisible();
  });
});
