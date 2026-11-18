import { expect, test } from "@playwright/test";
import { cardBox, findFloor, labels, openCard, openPart, planRibs, primary, shot } from "./auto-ribs-box";

/**
 * Auto ribs planned by the engine: the card's plan goes to `lime-slice serve`'s /api/ribs routes (the desktop's
 * rib_plan_start, rib_plan_poll and rib_plan_cancel over the same `lime_sim_bridge::ribs` jobs). The modeler is mocked,
 * as in e2e/model-auto-ribs.spec.ts, so only the planner is real.
 *   lime-slice serve --port 43218
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test --workers=1 model-auto-ribs-real
 *
 * Bound a run with Playwright's own timeout, never with a shell `timeout` around `npx playwright`.
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(180_000);

// An engine built before the rib routes answers 404: then there is no planner to reach.
test.beforeAll(async ({ request }) => {
  const res = await request.post(`${api}/api/ribs/poll`, { data: { id: 0 } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  test.skip(res.status() === 404 || typeof body.error !== "string" || !/not in this session/.test(body.error), "this engine has no rib planner routes");
});

test("the engine plans the floor of a shelled box live, and the plan applies as one Auto ribs row", async ({ page }) => {
  await openPart(page, { api: api! });
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(page.locator("#autoRibsWallLine")).toHaveText("1 face · 8,816 mm² · wall 2 mm");
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#autoRibsSourceNote")).toBeHidden();
  await expect(page.locator("#autoRibsGain")).toHaveText(/× less at its worst point$/);
  await expect(page.locator("#autoRibsCompare li")).toHaveCount(3);
  // Every rib stands on the floor's face (z = 2), lifted off the mid-surface the engine plans on (z = 1).
  const ribs = await planRibs(page);
  expect(ribs.length).toBeGreaterThan(0);
  for (const rib of ribs) for (const p of rib.points) expect(Math.abs(p[2] - 2), `rib point ${p} on the floor`).toBeLessThan(0.01);
  await shot(page, "real-result.png");
  await primary(page).click();
  await expect(labels(page).last()).toHaveText("Auto ribs");
  await expect(page.locator("#autoRibsAppliedLine")).toHaveText(/^Added /);
  await primary(page).click();
  await expect(cardBox(page)).toBeHidden();
});
