import { test, expect } from "@playwright/test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pinLocaleEn, spawnTestServer } from "./helpers.js";

// Fleets surface (openspec: agent-fleet-core 3.x + 2.4):
//   - nav reachability + the org-tree board renders from a stubbed detail with
//     every derived badge (on_duty/missing/vacant/passive) and evidence
//   - the composer (编队器) walks three-post creation with correct payloads,
//     including the dense-cadence confirm gate
//   - the real auth-off server answers /api/fleets read+write
//   - a spawned forward-auth server enforces ownership (403 cross-owner, 401
//     anonymous)

// ── shared fixtures ──────────────────────────────────────────────────────────

const FLEET_ID = "fleet_demo";

function memberFixture(id, over = {}) {
  return {
    id,
    fleetId: FLEET_ID,
    title: over.title ?? id,
    parentId: over.parentId ?? null,
    target: over.target ?? { kind: "persona", id: "p1", label: "甲" },
    kpiSlots: over.kpiSlots ?? [],
    cadence: over.cadence ?? null,
    sortKey: over.sortKey ?? 0,
    createdAt: 0,
    updatedAt: 0,
    taskId: over.taskId ?? null,
    status: over.status ?? "on_duty",
    statusReason: over.statusReason ?? "",
    evidence: over.evidence ?? { lastRunAt: null, nextRunAt: null, staleWindowMs: null, latestReportAt: null, hitWindow: null },
    latestReport: over.latestReport ?? null,
    reportTimeline: over.reportTimeline ?? [],
  };
}

const SHOP_REPORT = {
  id: "r_shop_2",
  at: 1790000000000,
  summary: "Big promo day",
  source: "self",
  sessionId: "cron-shop",
  slots: [
    { key: "sales_week", label: "Sales", unit: "$", value: 309, note: "+1%", trend: { direction: "up", deltaValue: 29 } },
  ],
  undeclaredKeys: [],
  metricsAll: { sales_week: { value: 309 } },
  blockers: [],
};

const DEMO_DETAIL = {
  fleet: { id: FLEET_ID, name: "Demo Fleet", state: "active", createdAt: 0, updatedAt: 0 },
  members: [
    memberFixture("ceo", { title: "CEO", status: "on_duty", statusReason: "recent execution within tolerance" }),
    memberFixture("ops", {
      title: "Ops",
      parentId: "ceo",
      status: "missing",
      statusReason: "no report for over the tolerance window (6h)",
      evidence: { lastRunAt: new Date().toISOString(), nextRunAt: null, staleWindowMs: 21600000, latestReportAt: 1, hitWindow: "report" },
      cadence: { cron: "0 * * * *", tz: null, promptTemplate: "x", enabled: true },
    }),
    memberFixture("shop", {
      title: "Shop",
      parentId: "ceo",
      status: "vacant",
      statusReason: "target object no longer exists",
      cadence: { cron: "0 9 * * *", tz: null, promptTemplate: "x", enabled: true },
      kpiSlots: [{ key: "sales_week", label: "Sales", unit: "$" }],
      latestReport: SHOP_REPORT,
      reportTimeline: [
        { id: "r_shop_2", at: 1790000000000, summary: "Big promo day", metrics: { sales_week: { value: 309 } }, blockers: [], resources: [], source: "self", sessionId: "cron-shop" },
        { id: "r_shop_1", at: 1789900000000, summary: "Slow week", metrics: { sales_week: { value: 280 } }, blockers: [], resources: [], source: "self", sessionId: "cron-shop" },
      ],
    }),
    memberFixture("assist", {
      title: "Assist",
      parentId: "ceo",
      target: { kind: "a2a", id: "remote", label: "Remote" },
      status: "passive",
      statusReason: "no cadence",
      latestReport: { id: "r_a2a", at: 1790000100000, summary: "remote turn ok", source: "derived", sessionId: "cron-a2a", slots: [], undeclaredKeys: [], metricsAll: {}, blockers: [] },
    }),
  ],
  statusCounts: { on_duty: 1, missing: 1, vacant: 1, passive: 1 },
};

// ── board render (stubbed API) ───────────────────────────────────────────────

test.describe("fleets board", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Demo Fleet", state: "active", memberCount: 4, statusCounts: DEMO_DETAIL.statusCounts }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(DEMO_DETAIL) }),
    );
  });

  test("nav item reaches the fleets page", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("nav-fleets")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-fleets").click();
    await expect(page.getByTestId("fleets-page")).toBeVisible();
  });

  test("org tree renders depth-ordered posts with derived badges", async ({ page }) => {
    await page.goto("/fleets");
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("fleet-card-fleet_demo")).toBeVisible();

    const tree = page.getByTestId("fleets-tree");
    await expect(tree.getByTestId("member-card-ceo")).toBeVisible();
    await expect(tree.getByTestId("member-status-ceo")).toHaveText("On duty");
    await expect(tree.getByTestId("member-status-ops")).toHaveText("Missing");
    await expect(tree.getByTestId("member-status-shop")).toHaveText("Vacant");
    await expect(tree.getByTestId("member-status-assist")).toHaveText("Passive");

    // Depth indentation: children of the CEO sit 20px deeper than the CEO.
    const lefts = await tree.evaluate((el) => {
      const ids = ["ceo", "ops", "shop", "assist"];
      return ids.map((id) => el.querySelector(`[data-testid="member-card-${id}"]`)?.getBoundingClientRect().left ?? -1);
    });
    expect(lefts[1] - lefts[0]).toBeGreaterThan(10);
    expect(lefts[2] - lefts[0]).toBeGreaterThan(10);
    expect(lefts[3] - lefts[0]).toBeGreaterThan(10);

    // Evidence rides on the badge title (the "why missing" hover) — the dual
    // window names which one fired.
    await expect(tree.getByTestId("member-status-ops")).toHaveAttribute("title", /no report for over the tolerance window/);

    // Report lane: KPI slot chip with value + system trend, summary line, and
    // the a2a execution-summary badge.
    const slotChip = tree.getByTestId("kpi-slot-shop-sales_week");
    await expect(slotChip).toBeVisible();
    await expect(slotChip).toContainText("309");
    await expect(slotChip.locator(".text-success, .text-destructive")).toContainText("↑+29");
    await expect(tree.getByTestId("member-summary-shop")).toContainText("Big promo day");
    await expect(tree.getByTestId("member-derived-badge-assist")).toContainText("not self-reported");

    // The report drawer: latest block + timeline rows + session jump link.
    await page.getByTestId("member-report-drawer-shop").click();
    const drawer = page.getByTestId("report-drawer-latest");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Big promo day");
    await expect(page.getByTestId("report-row-r_shop_2")).toContainText("309");
    await expect(page.getByTestId("report-row-r_shop_1")).toContainText("Slow week");
    await expect(page.getByTestId("report-row-r_shop_2").getByRole("button", { name: "Source session" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });
});

// ── composer walkthrough (stubbed API) ───────────────────────────────────────

test.describe("fleet composer", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
  });

  test("creates a fleet and three posts with dense-cadence confirm", async ({ page }) => {
    const created = { fleet: null, members: [] };
    let memberCount = 0;
    await page.route("**/api/fleets", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ fleets: created.fleet ? [{ id: created.fleet.id, name: created.fleet.name, state: "active", memberCount }] : [] }),
        });
      }
      const body = route.request().postDataJSON();
      created.fleet = { id: FLEET_ID, name: body.name, state: "active" };
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ fleet: created.fleet }) });
    });
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleet: created.fleet, members: created.members, statusCounts: {} }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/members`, async (route) => {
      const body = route.request().postDataJSON();
      if (
        body.cadence?.cron === "*/5 * * * *" &&
        body.confirmed !== true
      ) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "cadence fires more often than every 10 minutes", code: "cadence_confirmation_required" }),
        });
      }
      memberCount += 1;
      const m = memberFixture(`m${memberCount}`, {
        title: body.title,
        target: { kind: body.targetKind, id: body.targetId, label: body.targetId },
        cadence: body.cadence ?? null,
        parentId: body.parentId ?? null,
        status: body.cadence ? "on_duty" : "passive",
      });
      created.members.push(m);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ member: m, reconcile: {} }) });
    });
    await page.route("**/api/catalog", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          agents: [
            { id: "persona-ecom", mode: "chat", name: "Ecom Agent" },
            { id: "persona-ops", mode: "chat", name: "Ops Agent" },
            { id: "remote-svc", mode: "a2a", name: "Remote Service" },
          ],
        }),
      }),
    );
    await page.route("**/api/clusters/mine", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ clusters: [{ clusterId: "dyn_ops", name: "Ops Cluster" }] }) }),
    );

    await page.goto("/fleets");
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });

    // Create the fleet.
    await page.getByTestId("fleet-create").click();
    await page.getByTestId("fleet-name-input").fill("内容工作室");
    await page.getByTestId("fleet-create-submit").click();
    await expect(page.getByTestId("fleet-detail")).toContainText("内容工作室", { timeout: 10000 });

    // Post 1: CEO persona, hourly cadence.
    await page.getByTestId("member-create").click();
    await page.getByTestId("member-title-input").fill("CEO");
    await page.getByTestId("member-kind-select").selectOption("persona");
    await page.getByTestId("member-target-select").selectOption("persona-ops");
    await page.getByTestId("member-cadence-mode").selectOption("hourly");
    await page.getByTestId("member-cadence-prompt").fill("巡视全队并汇总。");
    await page.getByTestId("member-create-submit").click();
    await expect(page.getByTestId("member-create-submit")).toBeHidden({ timeout: 10000 });

    // Post 2: passive cluster post under the CEO.
    await page.getByTestId("member-create").click();
    await page.getByTestId("member-title-input").fill("集群岗");
    await page.getByTestId("member-kind-select").selectOption("cluster");
    await page.getByTestId("member-target-select").selectOption("dyn_ops");
    await page.getByTestId("member-parent-select").selectOption("m1");
    await page.getByTestId("member-create-submit").click();
    await expect(page.getByTestId("member-create-submit")).toBeHidden({ timeout: 10000 });

    // Post 3: dense custom cron (*/5) — the gate fires, confirm re-posts.
    await page.getByTestId("member-create").click();
    await page.getByTestId("member-title-input").fill("高频哨兵");
    await page.getByTestId("member-kind-select").selectOption("a2a");
    await page.getByTestId("member-target-select").selectOption("remote-svc");
    await page.getByTestId("member-cadence-mode").selectOption("custom");
    await page.getByTestId("member-cadence-cron").fill("*/5 * * * *");
    await page.getByTestId("member-cadence-prompt").fill("哨兵巡检");
    await page.getByTestId("member-create-submit").click();
    await expect(page.getByTestId("dense-confirm")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("dense-confirm-submit").click();
    await expect(page.getByTestId("dense-confirm")).toBeHidden({ timeout: 10000 });

    // Payloads landed as the spec pins them.
    expect(created.members).toHaveLength(3);
    expect(created.members[0].title).toBe("CEO");
    expect(created.members[0].target.kind).toBe("persona");
    expect(created.members[0].cadence.cron).toBe("0 * * * *");
    expect(created.members[1].target.kind).toBe("cluster");
    expect(created.members[1].parentId).toBe("m1");
    expect(created.members[1].cadence).toBeNull();
    expect(created.members[2].cadence.cron).toBe("*/5 * * * *");
  });
});

// ── cockpit aggregate view (agent-fleet-templates) ───────────────────────────

test.describe("fleet cockpit", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Demo Fleet", state: "paused", memberCount: 1, openDecisions: 1 }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          fleet: {
            id: FLEET_ID, name: "Demo Fleet", state: "paused",
            sourceTemplate: { packId: "pack_tpl", version: "1.0.0" },
          },
          members: [
            memberFixture("ceo", { title: "CEO", status: "on_duty", kpiSlots: [{ key: "sales_week", label: "Sales" }], latestReport: SHOP_REPORT }),
            memberFixture("shop", { title: "Shop", parentId: "ceo", status: "missing" }),
          ],
          statusCounts: { on_duty: 1, missing: 1 },
          decisions: [
            { id: "d1", question: "Publish early?", severity: "high", state: "open", submittedAt: 1790000000000, options: [], memberTitle: "Shop" },
          ],
          openDecisions: 1,
          stream: [
            { memberId: "shop", title: "Shop", status: "missing", latestReport: null },
            { memberId: "ceo", title: "CEO", status: "on_duty", latestReport: SHOP_REPORT },
          ],
          health: { onDuty: 1, paused: 0, missing: 1, vacant: 0, passive: 0, total: 2 },
          template: { packId: "pack_tpl", instantiatedVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true },
        }),
      }),
    );
  });

  test("await-start banner, decision banner, health chips, stream, newer notice", async ({ page }) => {
    await page.goto("/fleets");
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });
    // The paused template fleet shows the start banner, not the plain resume.
    await expect(page.getByTestId("fleet-await-start")).toBeVisible();
    await expect(page.getByTestId("fleet-start")).toBeVisible();
    await expect(page.getByTestId("fleet-decision-banner")).toContainText("1 awaiting you");
    await expect(page.getByTestId("fleet-decision-banner")).toContainText("Publish early?");
    await expect(page.getByTestId("fleet-health")).toContainText("on duty: 1");
    await expect(page.getByTestId("fleet-health")).toContainText("missing: 1");
    await expect(page.getByTestId("fleet-template-newer")).toContainText("2.0.0");
    // Stream: the missing post sits first; the reporting post shows its summary.
    await expect(page.getByTestId("fleet-stream")).toBeVisible();
    const rows = page.getByTestId("fleet-stream").locator("[data-testid^='stream-']");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("data-testid", "stream-shop");
    await expect(page.getByTestId("stream-ceo")).toContainText("Big promo day");
  });
});

// ── decision queue drawer (agent-fleet-decision-lane) ───────────────────────

test.describe("fleet decision queue", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    const open = [
      {
        id: "d1",
        fleetId: FLEET_ID,
        memberId: "shop",
        memberTitle: "Shop",
        memberDeleted: false,
        pendingDelivery: false,
        question: "Publish the video early?",
        options: [
          { value: "now", label: "Publish now" },
          { value: "fri", label: "Publish Friday" },
        ],
        severity: "high",
        suggestedDeadline: "within 48h",
        recommendation: "fri",
        state: "open",
        resolution: null,
        sourceSessionId: "sess-src",
        submittedAt: 1790000000000,
        resolvedAt: null,
        deliveredAt: null,
      },
    ];
    let current = open;
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Demo Fleet", state: "active", memberCount: 1, openDecisions: current.filter((d) => d.state === "open").length }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          fleet: { id: FLEET_ID, name: "Demo Fleet", state: "active", createdAt: 0, updatedAt: 0 },
          members: [memberFixture("shop", { title: "Shop" })],
          statusCounts: { passive: 1 },
          openDecisions: current.filter((d) => d.state === "open").length,
        }),
      }),
    );
    await page.route(new RegExp(`/api/fleets/${FLEET_ID}/decisions`), (route) => {
      if (route.request().method() === "GET") {
        const all = new URL(route.request().url()).searchParams.get("state") === "all";
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            decisions: all ? current : current.filter((d) => d.state === "open"),
            openCount: current.filter((d) => d.state === "open").length,
            decisionPolicy: { expiryHours: 72, dailyCapPerMember: 10 },
          }),
        });
      }
      const url = route.request().url();
      const approve = url.endsWith("/approve");
      current = current.map((d) =>
        d.id === "d1"
          ? {
              ...d,
              state: approve ? "approved" : d.state,
              pendingDelivery: approve,
              resolution: approve ? { kind: "approve", choice: "fri", note: null, by: "owner@test", at: 1790000001000 } : null,
            }
          : d,
      );
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision: current[0] }) });
    });
  });

  test("badge opens the queue; approve flips the item to awaiting delivery", async ({ page }) => {
    await page.goto("/fleets");
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("decisions-open")).toContainText("1 awaiting you");
    await page.getByTestId("decisions-open").click();

    const item = page.getByTestId("decision-d1");
    await expect(item).toBeVisible();
    await expect(page.getByTestId("decision-question-d1")).toContainText("Publish the video early?");
    await expect(item).toContainText("high");
    await expect(item).toContainText("within 48h");

    await page.getByTestId("decision-choice-d1").selectOption("fri");
    await page.getByTestId("decision-approve-d1").click();
    // The open-only view drops the decided item (the to-do is done); flip to
    // the all-views to see the approved state.
    await page.getByTestId("decisions-show-all").check();
    await expect(page.getByTestId("decision-resolution-d1")).toContainText("Publish Friday", { timeout: 10000 });
    await expect(page.getByTestId("decision-d1")).toContainText("awaiting delivery");
    await expect(page.getByTestId("decision-execute-d1")).toBeVisible();
  });
});

// ── real server, auth-off (the shared webServer) ─────────────────────────────

test.describe("fleets REST on the auth-off server", () => {
  test("read+write round-trip", async ({ request }) => {
    const list = await request.get("/api/fleets");
    expect(list.ok()).toBeTruthy();
    const before = (await list.json()).fleets ?? [];

    const created = await request.post("/api/fleets", { data: { name: "e2e 临时舰队" } });
    expect(created.status()).toBe(201);
    const { fleet } = await created.json();
    expect(fleet.state).toBe("active");

    const detail = await request.get(`/api/fleets/${fleet.id}`);
    expect(detail.ok()).toBeTruthy();
    expect((await detail.json()).members).toEqual([]);

    // Cleanup: dissolve keeps the row but flips state.
    const gone = await request.delete(`/api/fleets/${fleet.id}`);
    expect(gone.ok()).toBeTruthy();
    expect((await gone.json()).fleet.state).toBe("archived");
    expect(((await (await request.get("/api/fleets")).json()).fleets ?? []).length).toBe(before.length + 1);
  });
});

// ── spawned forward-auth server: ownership semantics ────────────────────────

test.describe("fleets ownership under forward auth", () => {
  test.describe.configure({ timeout: 120_000 });

  let BASE;
  let server;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-fleets-auth-"));

  test.beforeAll(async () => {
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    BASE = `http://127.0.0.1:${port}`;
    server = spawnTestServer({
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        AUTH_MODE: "forward_auth",
        CATALOG_REFRESH_SECS: "0",
        CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
        DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
        SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
        DB_PATH: path.join(tmpRoot, "app.db"),
        CRON_STORAGE_PATH: tmpRoot,
        DSH_HOME: path.join(tmpRoot, "dsh-home"),
        DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
      },
      storeRoot: tmpRoot,
    });
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      try {
        const r = await fetch(`${BASE}/api/auth/me`);
        if (r.status === 401 || r.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  test.afterAll(async () => {
    await server?.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("anonymous is 401; bob owns his fleet; the admin cannot write it", async () => {
    const BOB = { "x-forwarded-email": "bob@corp.com", "x-forwarded-groups": "users" };
    const ADMIN = { "x-forwarded-email": "admin@corp.com", "x-forwarded-groups": "admin" };

    const anon = await fetch(`${BASE}/api/fleets`);
    expect(anon.status).toBe(401);

    const created = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "content-type": "application/json", ...BOB },
      body: JSON.stringify({ name: "Bob's fleet" }),
    });
    expect(created.status).toBe(201);
    const { fleet } = await created.json();

    const mine = await fetch(`${BASE}/api/fleets`, { headers: BOB });
    expect(mine.ok).toBeTruthy();
    expect((await mine.json()).fleets.some((f) => f.id === fleet.id)).toBe(true);

    const cross = await fetch(`${BASE}/api/fleets/${fleet.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...ADMIN },
      body: JSON.stringify({ state: "paused" }),
    });
    expect(cross.status).toBe(403);

    const detail = await fetch(`${BASE}/api/fleets/${fleet.id}`, { headers: BOB });
    expect(detail.ok).toBeTruthy();
    expect((await detail.json()).fleet.state).toBe("active");
  });
});
