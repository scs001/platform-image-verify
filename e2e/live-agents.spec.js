import { test, expect } from "@playwright/test";

test("live: /agents renders without white screen", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  const resp = await page.goto("https://platform.finddatatech.cloud/agents?tab=agents", { waitUntil: "domcontentloaded", timeout: 45000 });
  console.log("HTTP:", resp?.status());
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  console.log("body length:", bodyText.length);
  console.log("body preview:", JSON.stringify(bodyText.slice(0, 200)));
  console.log("errors:", JSON.stringify(errors.slice(0, 5), null, 1));

  expect(bodyText.length, "page body is empty (white screen)").toBeGreaterThan(50);
  const fatal = errors.filter((e) => !/Failed to load resource|401|404/i.test(e));
  expect(fatal, "runtime errors:\n" + fatal.join("\n")).toHaveLength(0);
});
