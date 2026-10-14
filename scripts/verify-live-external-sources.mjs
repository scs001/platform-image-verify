// fd-prod acceptance smoke for add-external-skill-sources (2026-10-15).
// Logs in through Logto with the .env test account, opens the extensions
// market, switches to the external-source shelf tab, runs one real aggregated
// search against both upstream markets, and asserts the visible contract:
// per-source groups, provenance marks (license three-state + not-reviewed),
// no install affordance, and a working entry detail dialog.
//
//   node scripts/verify-live-external-sources.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";

function dotenv(key) {
  const m = readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD not set in .env");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

// The platform /login page is a shell: the real form lives on the Logto
// domain, reached through the sso-login link (which also carries rd +
// ui_locales). Clicking it is part of the flow, not an extra.
async function fillLogtoForm(page, timeoutMs = 30_000) {
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: timeoutMs });
  await page.getByTestId("sso-login").click();
  const identifier = page.locator('input[name="identifier"]');
  await identifier.waitFor({ state: "visible", timeout: timeoutMs });
  await identifier.fill(EMAIL);
  await page.locator('input[type="submit"], button:has-text("Sign in"), button:has-text("登录")').first().click();
  const password = page.locator('input[name="password"]');
  await password.waitFor({ state: "visible", timeout: timeoutMs });
  await password.fill(PASSWORD);
  await password.press("Enter");
}

const browser = await chromium.launch();
const page = await browser.newPage();
const apiCalls = [];
page.on("response", async (r) => {
  if (r.url().includes("/api/extensions/external")) {
    let body = "";
    let sources = null;
    try {
      body = await r.text();
      // Record the payload's group ids — the response is far too large for a
      // substring check once both sources return their full page of entries.
      const doc = JSON.parse(body);
      if (Array.isArray(doc.groups)) sources = doc.groups.map((g) => g.source);
    } catch { /* non-JSON or gone */ }
    apiCalls.push({ status: r.status(), url: r.url().replace(/^https:\/\/[^/]+/, ""), body: body.slice(0, 400), sources });
  }
});

try {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await fillLogtoForm(page);
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });
  console.log("[smoke] logged in →", page.url());

  await page.goto(`${PLATFORM}/settings/mcp`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("extensions-page").waitFor({ state: "visible", timeout: 30_000 });

  const tab = page.getByTestId("extensions-tab-external");
  ok("external tab visible by default (no flag)", (await tab.count()) === 1);
  await tab.click();

  const shelf = page.getByTestId("external-source-shelf");
  await shelf.waitFor({ state: "visible", timeout: 20_000 });
  ok("shelf renders", true);

  await page.getByTestId("external-source-search").fill("pdf");
  await page.getByRole("button", { name: /^搜索$|^Search$/i }).click();

  // Real upstream aggregation takes a moment (two markets + snapshot cache).
  await page.getByTestId("external-group-skillhub").waitFor({ state: "visible", timeout: 60_000 });
  const smitheryVisible = await page
    .getByTestId("external-group-smithery")
    .waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  ok("both source groups render", smitheryVisible);

  const shelfHtml = await shelf.innerHTML();
  ok("not-reviewed mark present", /未经本平台审校|not reviewed/i.test(shelfHtml));
  ok("license three-state chip present", /许可证|License:/i.test(shelfHtml));
  ok("no install affordance on the shelf", !/>\s*(安装|Install)\s*</.test(shelfHtml));

  // First skillhub card → detail dialog.
  const firstCard = page
    .getByTestId("external-group-skillhub")
    .locator('[data-testid^="external-entry-skillhub-"]')
    .first();
  const cardCount = await firstCard.count();
  ok("skillhub group has at least one entry", cardCount > 0);
  if (cardCount > 0) {
    await firstCard.click();
    const dialog = page.getByTestId("external-entry-detail");
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    ok("entry detail dialog opens", true);
    const hasUpstream = (await dialog.getByRole("link", { name: /open upstream|打开上游/i }).count()) > 0;
    ok("upstream link renders in detail", hasUpstream);
    if (process.env.DUMP_TEXT) {
      console.log("[smoke] dialog text:\n---\n" + (await dialog.innerText()) + "\n---");
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {
      console.log("[smoke] WARN: dialog still visible after Escape");
    });
  }

  console.log("\n[smoke] external API calls observed:");
  for (const c of apiCalls) console.log(`  ${c.status} ${c.url}\n    ${c.body.slice(0, 220)}`);
  ok("search API returned 200", apiCalls.some((c) => c.status === 200 && c.url.includes("/search")));
  const searchCall = apiCalls.find((c) => c.url.includes("/search") && c.status === 200);
  const payloadSources = searchCall?.sources ?? [];
  ok(
    "search payload carries both sources",
    payloadSources.includes("skillhub") && payloadSources.includes("smithery"),
    `groups=[${payloadSources.join(", ")}]`,
  );

  // Snapshot-time facts, so a bad screenshot can never be misread as a pass
  // (or a good one as a fail): the URL, what the viewport actually holds, and
  // the shelf's own text.
  console.log(`[smoke] at-screenshot url: ${page.url()}`);
  console.log(`[smoke] at-screenshot shelf visible: ${await shelf.isVisible().catch(() => false)}`);
  if (process.env.DUMP_TEXT) {
    const text = (await shelf.innerText()).replace(/\n{2,}/g, "\n").slice(0, 1200);
    console.log("[smoke] shelf text (head):\n---\n" + text + "\n---");
    const dialogOpen = await page.getByTestId("external-entry-detail").count();
    console.log(`[smoke] at-screenshot detail dialog count: ${dialogOpen}`);
  }
  await page.screenshot({ path: "/tmp/external-shelf-prod.png", fullPage: false });
  console.log("[smoke] screenshot → /tmp/external-shelf-prod.png");
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
