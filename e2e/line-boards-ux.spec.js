import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Line-boards UX sentinels (openspec: fix-line-boards-ux, task 3.1).
//
// The 2026-11-02 user audit: 谦面/柏讯 boards "too simple, violate the
// interaction paradigm, cannot go back to the app center". Root causes pinned
// here against a mocked facet board in the NEW adapter shape (blocks carry
// `tab`, metric keys are snake_case):
//   - tabs sync via replaceState: clicking tabs never pushes history, so one
//     browser back leaves the board for /apps;
//   - the page header carries an explicit 返回应用中心 control;
//   - the tab↔block contract fills 谦面's two historically-empty tabs;
//   - metric labels localize (no raw weeklyActivePacks-style keys in DOM);
//   - `under_construction` renders the neutral card, not the red failure one.

async function enableBoards(page) {
  await page.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.lineBoardsEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
}

const ORIGIN = "https://facet.finddatatech.cloud";

function facetBoard() {
  return {
    line: "facet",
    title: "谦面",
    originUrl: ORIGIN,
    connected: true,
    blocks: [
      { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", data: { my_packs: 2, published_versions: 3 }, href: `${ORIGIN}/#/mine` },
      {
        id: "my_packs",
        type: "list",
        tab: "my-packs",
        title: "我的包",
        href: `${ORIGIN}/#/mine`,
        data: [{ id: "pk-one", title: "台账助手", subtitle: "进货出货台账", badges: ["v3", "公开"] }],
      },
      {
        id: "recent_events",
        type: "timeline",
        tab: "overview",
        title: "最近事件",
        data: [{ id: "pk-one:3", text: "台账助手 · v3", created_at: "2026-11-01T10:00:00Z" }],
      },
      { id: "publish_history", type: "timeline", tab: "publish-history", title: "发布记录", data: [], error: "under_construction", href: `${ORIGIN}/#/mine` },
    ],
  };
}

test("tabs match blocks by contract, localize metric labels, and never pollute the back path", async ({
  page,
}) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/facet", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(facetBoard()) }));

  // Enter the board the way the app center does: /apps → card → 看板.
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  await page.goto("/boards/facet");
  await expect(page.getByTestId("board-facet")).toBeVisible({ timeout: 15000 });

  // Overview tab: real counts under localized labels — the raw snake_case
  // keys must not appear as display copy.
  await expect(page.getByTestId("block-overview_metrics")).toBeVisible();
  await expect(page.getByTestId("block-overview_metrics")).toContainText("My packs");
  await expect(page.getByTestId("block-overview_metrics")).not.toContainText("my_packs");
  await expect(page.getByTestId("block-recent_events")).toBeVisible();

  // The historically-empty tab now carries its block (the hyphen/underscore
  // substring bug made this tab render nothing).
  await page.getByTestId("board-tab-my-packs").click();
  await expect(page.getByTestId("block-my_packs")).toBeVisible();
  await expect(page.getByTestId("block-my_packs")).toContainText("台账助手");
  // And the other tabs' blocks are gone from this tab.
  await expect(page.getByTestId("block-overview_metrics")).toHaveCount(0);

  // Three tab clicks pushed ZERO history entries: one back leaves the board
  // for the page the user came from (/apps), not unwinds tabs one by one.
  await page.goBack();
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 10000 });

  // The header's explicit return control works from a fresh board visit.
  await page.goto("/boards/facet");
  await expect(page.getByTestId("board-facet")).toBeVisible();
  await page.getByTestId("board-back").click();
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 10000 });
});

test("under_construction renders the neutral card, not the red failure chrome", async ({ page }) => {
  await pinLocaleEn(page);
  await enableBoards(page);
  await page.route("**/api/boards/facet", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(facetBoard()) }));
  await page.goto("/boards/facet");
  await page.getByTestId("board-tab-publish-history").click();

  await expect(page.getByTestId("block-publish_history-construction")).toBeVisible();
  await expect(page.getByTestId("block-publish_history-construction")).toContainText("Under construction");
  // Not the destructive error styling.
  await expect(page.getByTestId("block-publish_history-error")).toHaveCount(0);
});
