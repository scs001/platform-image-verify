import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// AgentsPage = the agent builder hub (add-agent-builder-hub): four areas —
// Build (default), Supply, Creations, Tuning. The active tab is reflected in
// ?tab=... and round-trips on reload. Legacy deep links canonicalize:
// ?tab=agents → Creations, ?tab=market → Supply (SURFACE_SLUG_ALIASES, the
// hub's central legacy map). The Apps tab is retired — its entries live in
// the app center; the legacy ?tab=apps deep link falls back to the first
// visible tab.

test.describe("agents page hub areas", () => {
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
});
