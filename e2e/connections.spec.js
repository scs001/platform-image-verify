// connections.spec.js — settings-connect-center acceptance: the aggregated
// /api/connections projection, the connections section surface, and the
// retired websearch deep link resolving into it.

import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

test.describe("GET /api/connections", () => {
  test("projects every connection with state only — no credential material", async ({ request }) => {
    const res = await request.get("/api/connections");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.connections)).toBeTruthy();

    const ids = body.connections.map((c) => c.id);
    // One entry per connect card / line row, plus search.
    for (const id of [
      "registry",
      "facet-market",
      "connector",
      "line-wire-customer",
      "line-lex",
      "ciyuan-account",
      "paper-trading",
      "search",
    ]) {
      expect(ids).toContain(id);
    }

    // Fresh hermetic store: nothing connected yet. Whitelist projection: the
    // four state fields only (search additionally carries userKey/shared).
    for (const c of body.connections) {
      expect(["connected", "stale", "disconnected", "not-configured"]).toContain(c.state);
      if (c.id !== "search") {
        expect(Object.keys(c).sort()).toEqual(["id", "name", "reason", "state"]);
      }
    }
    // No credential material anywhere in the payload, at any nesting.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/sk-|fdt_|oct_|Bearer\s|eyJ[A-Za-z0-9_-]{10,}/);
  });
});

test.describe("connections section", () => {
  test("renders glossary and every connect card; panel deep link highlights", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/connections");
    await expect(page.getByTestId("settings-section-connections")).toBeVisible();

    // Brand quick-reference: collapsed by default, expands in place.
    const glossary = page.getByTestId("connections-glossary");
    await expect(glossary).toBeVisible();
    await expect(glossary.getByTestId("connections-glossary").locator("dl")).toBeHidden();
    await glossary.locator("summary").click();
    await expect(glossary.locator("dl")).toBeVisible();

    // The connect cards moved here from the extensions market tab.
    await expect(page.getByTestId("registry-connect-panel")).toBeVisible();
    await expect(page.getByTestId("search-service-card")).toBeVisible();

    // Panel deep link scrolls to and marks the search card.
    await page.goto("/settings/connections?panel=search");
    await expect(page.getByTestId("search-service-card")).toBeVisible();
    const anchor = page.locator("[data-panel='search']");
    await expect(anchor).toHaveAttribute("data-panel-active", "true");

    // Unknown panel degrades gracefully.
    await page.goto("/settings/connections?panel=nonsense");
    await expect(page.getByTestId("settings-section-connections")).toBeVisible();
    await expect(page.locator("[data-panel-active='true']")).toHaveCount(0);
  });

  test("retired /settings/websearch redirects to the connections search panel", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/websearch");
    await expect(page).toHaveURL(/\/settings\/connections\?panel=search$/);
    await expect(page.getByTestId("search-service-card")).toBeVisible();
    // The BYOK zone moved verbatim (same testids as the former section).
    await expect(page.getByTestId("websearch-byok")).toBeVisible();
  });

  test("market tab is a pure shelf — no connect cards", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/mcp?tab=market");
    await expect(page.getByTestId("mcp-market-section")).toBeVisible();
    await expect(page.getByTestId("registry-connect-panel")).toHaveCount(0);
    await expect(page.getByTestId("connector-connect-panel")).toHaveCount(0);
  });
});
