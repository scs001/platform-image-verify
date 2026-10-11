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

  // mcp: the catalog must mount. In the playwright chain the facet service
  // inherits MARKET_REGISTRY_URL (the e2e stub), so cards render; standalone
  // (no registry) the honest empty state shows. Either branch proves the
  // view rendered — and in both cases no page error is tolerated below.
  await page.goto(`${base}/#/mcp`);
  await expect(
    page
      .getByText("来自注册处的 MCP 服务目录")
      .or(page.getByText("当前身份下没有可见的 MCP 服务")),
  ).toBeVisible();

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
