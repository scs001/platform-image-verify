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
    kpiSlots: [],
    cadence: over.cadence ?? null,
    sortKey: over.sortKey ?? 0,
    createdAt: 0,
    updatedAt: 0,
    taskId: over.taskId ?? null,
    status: over.status ?? "on_duty",
    statusReason: over.statusReason ?? "",
    evidence: over.evidence ?? { lastRunAt: null, nextRunAt: null, staleWindowMs: null },
  };
}

const DEMO_DETAIL = {
  fleet: { id: FLEET_ID, name: "Demo Fleet", state: "active", createdAt: 0, updatedAt: 0 },
  members: [
    memberFixture("ceo", { title: "CEO", status: "on_duty", statusReason: "recent execution within tolerance" }),
    memberFixture("ops", { title: "Ops", parentId: "ceo", status: "missing", statusReason: "no execution for over the tolerance window (6h)", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "x", enabled: true } }),
    memberFixture("shop", { title: "Shop", parentId: "ceo", status: "vacant", statusReason: "target object no longer exists", cadence: { cron: "0 9 * * *", tz: null, promptTemplate: "x", enabled: true } }),
    memberFixture("assist", { title: "Assist", parentId: "ceo", status: "passive", statusReason: "no cadence" }),
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
    await page.route(`**/api/fleets/${FLEET_ID}`, (route) =>
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

    // Evidence rides on the badge title (the "why missing" hover).
    await expect(tree.getByTestId("member-status-ops")).toHaveAttribute("title", /tolerance window/);
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
    await page.route(`**/api/fleets/${FLEET_ID}`, (route) =>
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
