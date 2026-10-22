import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// AgentsPage: two sub-tabs (Experts, Packs). Default is Experts; the active
// tab is reflected in ?tab=... and round-trips on reload. Packs hosts the
// pack marketplace (moved out of Settings) and only exists on deployments
// that report it (simplify-ia-non-technical). simplify-chat-and-agents-ia
// retired the Apps tab — its entries live in the app center, and the legacy
// ?tab=apps deep link falls back to the first visible tab.

test.describe("agents page sub-tabs", () => {
  test("default tab is Agents", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-agents")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agents-section")).toBeVisible();
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
    await expect(page.getByTestId("agents-tab-agents")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agents-tab-apps")).toHaveCount(0);
  });

  test("deep-link via ?tab=agents", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-agents")).toHaveAttribute("aria-selected", "true");
  });

  test("Experts tab embeds the custom-preset management surface", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    // 我的专家 — the preset surface (add-custom-presets) lives under the grid.
    await expect(page.getByTestId("custom-presets-page")).toBeVisible();
    await expect(page.getByTestId("preset-create")).toBeVisible();
  });

  test("deep-link via ?tab=market shows the marketplace", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=market");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-market")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("packs-page")).toBeVisible();
  });

  test("retired Settings sections redirect into the page", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/presets");
    await expect(page).toHaveURL(/\/agents\?tab=agents$/);
    await expect(page.getByTestId("agents-tab-agents")).toHaveAttribute("aria-selected", "true");

    await page.goto("/settings/packs");
    await expect(page).toHaveURL(/\/agents\?tab=market$/);
    await expect(page.getByTestId("agents-tab-market")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("packs-page")).toBeVisible();
  });
});
