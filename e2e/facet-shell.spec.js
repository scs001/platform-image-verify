// The facet shell smoke sentinel (fix-facet-packs-crash): the thin shell
// borrows 壹座 pack components verbatim and mounts NO router (facet-platform:
// "the shell SHALL add no router dependency"). This spec is the net that
// catches a host-side change — e.g. a routing hook creeping into a borrowed
// component (exactly what blanked production #/packs on 2026-10-11) — before
// it ships. Served by e2e/facet-shell-server.mjs (real facet service,
// anonymous face, one seeded public pack, src-built shell bundle).
import { expect, test } from "@playwright/test";

const base = `http://127.0.0.1:${process.env.E2E_FACET_SHELL_PORT || 3209}`;

test("all three shell views render without a routing provider", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // Pin zh-CN: the infra views' copy assertions below read Chinese strings
  // (the shell's locale store, same key the 壹座 suite uses).
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  // intro: the landing carries its CTAs and the footer ladder.
  await page.goto(`${base}/#/`);
  await expect(page.getByTestId("facet-tabs")).toBeVisible();
  await expect(page.getByTestId("intro-cta-packs")).toBeVisible();
  await expect(page.getByTestId("facet-footer")).toBeVisible();

  // packs: the borrowed 壹座 view must mount cleanly with no Router
  // ancestor — cards render, search is interactive.
  await page.goto(`${base}/#/packs`);
  await expect(page.locator('[data-testid^="pack-card-"]')).toHaveCount(1);
  await expect(page.getByTestId("pack-search-input")).toBeVisible();

  // Version history on the borrowed detail (add-facet-version-history): the
  // anonymous face reaches the seeded pack's version list — the route serves
  // public packs without a credential, and the shared disclosure lazy-loads.
  await page.locator('[data-testid^="pack-card-"]').first().click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail.getByTestId("pack-version-list")).toBeVisible();
  await detail.getByTestId("pack-version-list-toggle").click();
  await expect(detail.getByTestId("pack-version-list-row-1")).toBeVisible();

  // mcp: the catalog must mount with its narrative and both tabs
  // (add-facet-infra-pages). The shell server now wires the e2e registry stub,
  // so the servers tab carries real stub entries.
  await page.goto(`${base}/#/mcp`);
  await expect(page.getByTestId("infra-narrative")).toBeVisible();
  await expect(page.getByTestId("mcp-tab-servers")).toBeVisible();
  await expect(page.getByTestId("mcp-tab-skills")).toBeVisible();

  // Depth view: open the stub server's card — tool surface (names with
  // descriptions) and provenance render; the card list itself stays without
  // tool surfaces (lazy depth payload).
  const card = page.getByTestId("mcp-card-e2e-registry-mcp");
  await expect(card).toBeVisible();
  await card.click();
  const depth = page.getByTestId("mcp-depth-e2e-registry-mcp");
  await expect(depth).toBeVisible();
  await expect(page.getByTestId("mcp-tool-read")).toContainText("Read an entry.");
  await expect(page.getByTestId("mcp-depth-license")).toContainText("MIT");
  await expect(page.getByTestId("mcp-depth-provider")).toContainText("e2e-org");
  await page.getByTestId("mcp-depth-back").click();
  await expect(card).toBeVisible();

  // Skills catalog: provenance renders for the declared entry and the
  // honest not-declared mark for the bare one.
  await page.getByTestId("mcp-tab-skills").click();
  await expect(page.getByTestId("skills-catalog")).toBeVisible();
  await expect(page.getByTestId("skill-provenance-e2e-provenance-skill")).toContainText("https://github.com/example/e2e-skills");
  await expect(page.getByTestId("skill-provenance-e2e-bare-skill")).toContainText("未标注");

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ── Conditional views + data plane (add-facet-content-management) ────────────
// The shell layer is exercised with a whoami route-injection (the browser
// cannot present the proxy identity — that channel is server-to-server by
// design); the data plane below drives the REAL facet service with real
// forwarded identities over the internal token.

const INTERNAL_TOKEN = process.env.E2E_FACET_TOKEN || "e2e-facet-token";
const forwarded = (email, groups) => ({
  "x-facet-token": INTERNAL_TOKEN,
  "x-facet-user": Buffer.from(JSON.stringify({ email, groups })).toString("base64url"),
});

test("conditional tabs and views follow identity", async ({ page }) => {
  await page.route("**/api/whoami", (route) =>
    route.fulfill({
      json: { email: "ops@e2e.local", groups: ["creators", "admin"], creator: true, admin: true },
    }),
  );
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${base}/#/`);
  // anonymous regression already covered above; here the creator+admin sees
  // all five tabs.
  await expect(page.getByRole("button", { name: "My packs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Curation" })).toBeVisible();

  // #/mine renders the creator console.
  await page.goto(`${base}/#/mine`);
  await expect(page.getByTestId("facet-mine-view")).toBeVisible();
  await expect(page.getByTestId("facet-mine-publish")).toBeVisible();

  // …and its version history renders through the SHARED presentation
  // (add-facet-version-history): the mine route-injection stands in for the
  // identity-gated list; expanding the shared disclosure shows the row with
  // its note — the same component the public detail mounts.
  await page.route(/\/api\/packs\?author=me/, (route) =>
    route.fulfill({
      json: {
        total: 1,
        page: 1,
        pageSize: 100,
        packs: [
          {
            id: "mine-shared-ver",
            authorEmail: "ops@e2e.local",
            createdAt: Date.now(),
            version: 2,
            name: "作者面共享版本组件",
            description: "d",
            tags: [],
            publishedAt: Date.now(),
            visibility: "public",
            unlisted: false,
          },
        ],
      },
    }),
  );
  await page.route("**/api/packs/mine-shared-ver/versions", (route) =>
    route.fulfill({
      json: {
        versions: [
          { version: 2, publishedAt: Date.now(), authorEmail: "ops@e2e.local", notes: "v2 说明。" },
          { version: 1, publishedAt: Date.now() - 1000, authorEmail: "ops@e2e.local" },
        ],
      },
    }),
  );
  await page.reload();
  const shared = page.getByTestId("facet-mine-versions-mine-shared-ver");
  await expect(shared).toBeVisible();
  await shared.getByTestId("facet-mine-versions-mine-shared-ver-toggle").click();
  await expect(page.getByTestId("facet-mine-versions-mine-shared-ver-row-2")).toContainText("v2 说明。");

  // #/curate renders the board with the honest usage degradation (no
  // usage-source env on the shell server).
  await page.goto(`${base}/#/curate`);
  await expect(page.getByTestId("facet-curate-view")).toBeVisible();
  await expect(page.getByTestId("facet-curate-usage-degraded")).toBeVisible();

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

test("unauthorized deep links fall back to the intro landing", async ({ page }) => {
  await page.route("**/api/whoami", (route) => route.fulfill({ json: { email: null, groups: [] } }));
  await page.goto(`${base}/#/curate`);
  await expect(page.getByTestId("intro-cta-packs")).toBeVisible();
  await expect(page.getByRole("button", { name: "My packs" })).toHaveCount(0);
});

test("data plane: publish, curate, versions, visibility, unpublish with real forwarded identity", async ({ request }) => {
  const creator = forwarded("creator@e2e.local", ["creators"]);
  const admin = forwarded("ops@e2e.local", ["admin"]);

  // Publish from manifest (creator identity).
  const manifest = {
    name: "策展数据面冒烟",
    description: "add-facet-content-management sentinel",
    notes: "初版：数据面冒烟版本说明。",
    tags: ["shell-smoke"],
    category: "legal",
    skills: [{ name: "curate-smoke", description: "d", content: "# x" }],
    mcpServers: [],
    agents: [],
  };
  const pub = await request.post(`${base}/api/packs`, { headers: creator, data: { manifest } });
  expect(pub.ok()).toBeTruthy();
  const { id } = await pub.json();

  // Author-declared category rides the publish; stranger cannot feature.
  const listed = await request.get(`${base}/api/packs?category=legal`, { headers: creator });
  const cat = await listed.json();
  expect(cat.packs.some((p) => p.id === id && p.category === "legal")).toBeTruthy();
  const denied = await request.put(`${base}/api/packs/${id}/curation`, {
    headers: creator,
    data: { featured: true },
  });
  expect(denied.status()).toBe(403);

  // Admin curates: category + featured; the market listing reflects both.
  const cur = await request.put(`${base}/api/packs/${id}/curation`, {
    headers: admin,
    data: { category: "daas", featured: true },
  });
  expect(cur.ok()).toBeTruthy();
  const after = await request.get(`${base}/api/packs`, { headers: admin });
  const row = (await after.json()).packs.find((p) => p.id === id);
  expect(row.category).toBe("daas");
  expect(row.featured).toBe(true);

  // Author-only surfaces: version history and visibility flip. The version
  // note rides the immutable manifest and surfaces inline in the list
  // (add-facet-version-history, task 1.3's data-plane leg).
  const versions = await request.get(`${base}/api/packs/${id}/versions`, { headers: creator });
  expect(versions.ok()).toBeTruthy();
  const vrows = (await versions.json()).versions;
  expect(vrows.length).toBe(1);
  expect(vrows[0].notes).toBe("初版：数据面冒烟版本说明。");
  const vdoc = await request.get(`${base}/api/packs/${id}/versions/1`, { headers: creator });
  expect((await vdoc.json()).manifest.notes).toBe("初版：数据面冒烟版本说明。");
  const vis = await request.put(`${base}/api/packs/${id}/visibility`, {
    headers: creator,
    data: { visibility: "private" },
  });
  expect(vis.ok()).toBeTruthy();

  // Private: gone for a stranger, present for the author (author=me filter).
  const stranger = await request.get(`${base}/api/packs?author=me`, { headers: forwarded("x@e2e.local", []) });
  expect((await stranger.json()).packs.some((p) => p.id === id)).toBeFalsy();
  const mine = await request.get(`${base}/api/packs?author=me`, { headers: creator });
  expect((await mine.json()).packs.some((p) => p.id === id)).toBeTruthy();

  // Usage proxy: admin session required; anonymous gets 401.
  const usage = await request.get(`${base}/api/ops/pack-usage`);
  expect(usage.status()).toBe(401);

  // Unpublish (author) hides it from the anonymous market.
  const un = await request.post(`${base}/api/packs/${id}/unpublish`, { headers: creator });
  expect(un.ok()).toBeTruthy();
  const anonList = await request.get(`${base}/api/packs`);
  expect((await anonList.json()).packs.some((p) => p.id === id)).toBeFalsy();
});
