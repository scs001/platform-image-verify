// Smoke: /agents must render without a runtime crash (white screen guard).
import { test, expect } from "@playwright/test";

test("@smoke agents page renders (no white screen)", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto("/agents?tab=agents", { waitUntil: "networkidle" });

  // The page shell must be present (the crash unmounts the whole tree)
  await expect(page.getByRole("tab", { name: /专家|Experts/i })).toBeVisible({ timeout: 15000 });

  // The agents section must mount
  await expect(page.locator('[data-testid="agents-section"]')).toBeVisible({ timeout: 15000 });

  // No uncaught runtime errors
  const fatal = errors.filter((e) => !/Failed to load resource|401|404/i.test(e));
  expect(fatal, "runtime errors:\n" + fatal.join("\n")).toHaveLength(0);
});
