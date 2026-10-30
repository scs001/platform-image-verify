import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Fleet hub faces (openspec: agent-teams-overview + agent-teams-management).
//   - /fleets defaults to the cross-team overview: summary strip + cards, the
//     abnormal team sorts first (spec: 异常上浮与排序沉睡)
//   - ?view=manage: inline rename round-trips through PATCH /:id
//   - batch with one archived fleet → per-item receipt, partial failure named
//   - /fleets/:id deep link lands in the cockpit, never in a switch state;
//     returning to /fleets shows the overview again

const ABNORMAL = "fleet_abnormal";
const OK = "fleet_ok";
const BUSY = "fleet_busy";
const PAUSED = "fleet_paused";

const roster = [
  { id: OK, name: "OK Team", state: "active", memberCount: 3, openDecisions: 1, defaultModel: null, statusCounts: { on_duty: 3 }, spend: { windows: { "24h": { runs: 5, turns: 5 } } } },
  { id: ABNORMAL, name: "Sick Team", state: "active", memberCount: 2, openDecisions: 0, defaultModel: null, statusCounts: { on_duty: 1, missing: 1 }, spend: { windows: { "24h": { runs: 2, turns: 2 } } } },
  { id: PAUSED, name: "Paused Team", state: "paused", memberCount: 1, openDecisions: 0, defaultModel: null, statusCounts: {}, spend: { windows: { "24h": { runs: 0, turns: 0 } } } },
];

const overview = {
  v: 1,
  sampledAt: Date.now(),
  fleets: [
    { id: OK, counts: { onDuty: 3, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0, total: 3 }, openDecisions: { count: 1, top: [{ question: "Renew the vendor contract?", severity: "high", memberTitle: "Ops" }] } },
    { id: ABNORMAL, counts: { onDuty: 1, paused: 0, missing: 1, vacant: 0, passive: 0, failing: 0, total: 2 }, openDecisions: { count: 0, top: [] } },
    { id: PAUSED, counts: { onDuty: 0, paused: 1, missing: 0, vacant: 0, passive: 0, failing: 0, total: 1 }, openDecisions: { count: 0, top: [] } },
  ],
};

const board = {
  v: 1,
  sampledAt: Date.now(),
  fleets: [
    { id: OK, openDecisions: 1, failing: 0, lastActivityAt: Date.now() - 60_000, spend: { windows: { "24h": { runs: 5, turns: 5 } } } },
    { id: ABNORMAL, openDecisions: 0, failing: 0, lastActivityAt: Date.now() - 600_000, spend: { windows: { "24h": { runs: 2, turns: 2 } } } },
    { id: PAUSED, openDecisions: 0, failing: 0, lastActivityAt: null, spend: { windows: { "24h": { runs: 0, turns: 0 } } } },
  ],
};

const cockpit = (id, name) => ({
  fleet: { id, name, state: "active", createdAt: 0, updatedAt: 0 },
  members: [],
  statusCounts: { on_duty: 1 },
  openDecisions: 0,
  decisions: [],
  health: { failing: 0, missing: 0, vacant: 0, paused: 0 },
  orchestration: null,
  stream: [],
  edgeTraffic: [],
  template: null,
});

test.describe("fleet hub", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ fleets: roster }) });
      }
      return route.fulfill({ status: 405, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/fleets/overview", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(overview) }),
    );
    await page.route("**/api/fleets/owner/board", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(board) }),
    );
    for (const [id, name] of [[OK, "OK Team"], [ABNORMAL, "Sick Team"], [PAUSED, "Paused Team"], [BUSY, "Busy Team"]]) {
      await page.route(`**/api/fleets/${id}/cockpit`, (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(cockpit(id, name)) }),
      );
      await page.route(`**/api/fleets/${id}/runs**`, (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
      );
    }
    await page.route("**/api/fleets/batch", (route) => {
      const body = route.request().postDataJSON();
      // Fixture: PAUSED is terminal-blocked for resume — the receipt must name it.
      const results = body.ids.map((id) =>
        id === PAUSED && body.action !== "pause"
          ? { id, ok: false, error: "This fleet is archived — archived is terminal" }
          : { id, ok: true, state: body.action === "pause" ? "paused" : body.action === "resume" ? "active" : "archived" },
      );
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ action: body.action, results, summary: { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } }),
      });
    });
  });

  test("overview is the default face: summary strip + abnormal-first cards", async ({ page }) => {
    await page.goto("/fleets");
    await expect(page.getByTestId("teams-overview")).toBeVisible();
    await expect(page.getByTestId("teams-summary-strip")).toContainText("3 teams");
    await expect(page.getByTestId("teams-summary-abnormal")).toContainText("1 abnormal");
    // The sick team's card leads (missing post = abnormal), OK Team second.
    const firstCard = page.getByTestId("teams-cards").locator("button").first();
    await expect(firstCard).toHaveAttribute("data-testid", `teams-card-${ABNORMAL}`);
    await expect(page.getByTestId(`teams-card-states-${ABNORMAL}`)).toContainText("missing 1");
    // Cards navigate to the cockpit.
    await page.getByTestId(`teams-card-${OK}`).click();
    await expect(page.getByTestId("fleet-detail")).toContainText("OK Team");
  });

  test("manage face: inline rename round-trips through PATCH", async ({ page }) => {
    let patched = null;
    await page.route(`**/api/fleets/${BUSY}`, (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
    await page.route(`**/api/fleets/${OK}`, async (route) => {
      if (route.request().method() === "PATCH") {
        patched = route.request().postDataJSON();
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ fleet: { ...roster[0], ...patched } }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
    });
    await page.goto("/fleets?view=manage");
    await expect(page.getByTestId("teams-manage-table")).toBeVisible();
    // The switch stays visible on the manage face — it is the way back to the
    // overview (the spec only demands it hide in the cockpit).
    await page.getByTestId(`teams-row-name-${OK}`).click();
    await page.getByTestId(`teams-row-name-input-${OK}`).fill("Renamed Team");
    await page.getByTestId(`teams-row-name-input-${OK}`).press("Enter");
    await expect.poll(() => patched).toBeTruthy();
    expect(patched).toEqual({ name: "Renamed Team" });
  });

  test("batch with a terminal-blocked fleet: per-item receipt names the failure", async ({ page }) => {
    await page.goto("/fleets?view=manage");
    await expect(page.getByTestId("teams-manage-table")).toBeVisible();
    // Select OK (resumes fine) and PAUSED (fixture: resume is refused).
    await page.getByTestId(`teams-row-check-${OK}`).check();
    await page.getByTestId(`teams-row-check-${PAUSED}`).check();
    await page.getByTestId("teams-batch-resume").click();
    const receipt = page.getByTestId("teams-batch-receipt");
    await expect(receipt).toContainText("1 succeeded / 1 failed");
    await expect(receipt.getByTestId("teams-batch-receipt-failure")).toContainText("Paused Team");
    await expect(receipt.getByTestId("teams-batch-receipt-failure")).toContainText("terminal");
  });

  test("deep link lands in the cockpit; returning to /fleets shows the overview", async ({ page }) => {
    await page.goto(`/fleets/${OK}`);
    await expect(page.getByTestId("fleet-detail")).toContainText("OK Team");
    await expect(page.getByTestId("teams-view-switch")).toBeHidden();
    await page.goto("/fleets");
    await expect(page.getByTestId("teams-overview")).toBeVisible();
  });
});

function _pollFor(get) {
  return new Promise((resolve) => {
    const tick = () => {
      const v = get();
      if (v) return resolve(v);
      setTimeout(tick, 50);
    };
    tick();
  });
}
