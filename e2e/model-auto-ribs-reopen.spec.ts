import { expect, test } from "@playwright/test";
import { cardBox, labels, openBox, shot, withRibs } from "./auto-ribs-box";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body } from "./model-tree-mock";
import { REOPEN_FREQUENCY, plannedProject } from "./ribs-plan-reopen";

/**
 * A History row made by ribs_plan (two load cases, a frequency goal), applied through the MCP stand-in, reopens
 * on the Auto ribs card with both cases and that goal. The part is the synthetic open box.
 */
test("a ribs_plan row reopens with both load cases and the frequency goal", async ({ page }) => {
  test.setTimeout(120_000);
  const file = await plannedProject();
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.addInitScript(() => {
    (globalThis as { __limeRibPlanFake?: unknown }).__limeRibPlanFake = { tickMs: 0 };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const part = openBox();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: part.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: () => part,
    apply(request, parent) {
      const op = request.op as Body;
      if (op.kind !== "group") return parent;
      return withRibs(parent, op);
    },
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "ribs-reopen.lime", mimeType: "application/json", buffer: file });
  await expect(page.locator("#objectList .obj").first()).toBeAttached({ timeout: 20_000 });
  await page.locator("#tabModel").click();
  await expect(labels(page).last()).toHaveText("Auto ribs", { timeout: 20_000 });
  await page.locator("#modelHistoryTree .mh-row").last().hover();
  await page.locator("#modelHistoryTree .mh-row").last().locator(".mh-edit").click();
  await expect(cardBox(page)).toBeVisible();
  await expect(page.locator("#autoRibsHowMuch")).toHaveJSProperty("open", true);
  await expect(page.locator("[data-measure=frequency]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#autoRibsStiffer")).toHaveValue(String(REOPEN_FREQUENCY));
  await expect(page.locator("#autoRibsCases")).toBeVisible();
  const names = page.locator("[data-case-field=name]");
  await expect(names).toHaveCount(2);
  await expect(names.nth(0)).toHaveValue("spread");
  await expect(names.nth(1)).toHaveValue("point");
  const weights = page.locator("[data-case-field=weight]");
  await expect(weights.nth(0)).toHaveValue("1");
  await expect(weights.nth(1)).toHaveValue("2");
  await names.nth(1).scrollIntoViewIfNeeded();
  await shot(page, "ribs-plan-reopen.png");
});
