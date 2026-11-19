import { expect, test } from "@playwright/test";
import { caseOutcomes } from "../src/auto-ribs-plan.ts";
import { caseResultLines, loadRequest, type PanelLoadCase } from "../src/auto-ribs.ts";
import type { StudyLoad } from "../src/sim/study.ts";
import { findFloor, openCard, openPart, primary, shot } from "./auto-ribs-box";

/**
 * Two named load cases on the synthetic box. The panel and the browser stand-in share loadRequest and caseOutcomes,
 * so the factors on screen are the stand-in's for the request the panel sent. caseOutcomes is not the planner.
 */
test("two load cases with different weights show each factor, equal to the stand-in on that request", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page, { stress: true });
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await page.locator("#autoRibsHoldLoad > summary").click();
  await expect(page.locator("#autoRibsLoad")).toBeVisible();
  await expect(page.locator("#autoRibsCases")).toBeHidden();
  await page.locator("#autoRibsLoad").screenshot({ path: "test-results/auto-ribs/one-load-fieldset.png" });
  await shot(page, "10-one-load.png");

  await page.locator("#autoRibsAddCase").click();
  await expect(page.locator("#autoRibsCases fieldset")).toHaveCount(2);
  await expect(page.locator("#autoRibsLoad")).toBeHidden();
  // Removing back to one case is today's single load again.
  await page.locator("[data-case-remove='1']").click();
  await expect(page.locator("#autoRibsLoad")).toBeVisible();
  await expect(page.locator("#autoRibsCases")).toBeHidden();
  await expect(page.locator("#autoRibsCases fieldset")).toHaveCount(0);

  await page.locator("#autoRibsAddCase").click();
  const name = (index: number) => page.locator(`[data-case-field="name"][data-case="${index}"]`);
  const weight = (index: number) => page.locator(`[data-case-field="weight"][data-case="${index}"]`);
  await name(0).fill("spread");
  await name(0).press("Tab");
  await name(1).fill("point");
  await weight(1).fill("4");
  await weight(1).press("Tab");
  // Each case's load is picked the way today's one load is: on the floor, so the wall can carry it.
  for (const index of [0, 1]) {
    await page.locator(`[data-case-pick="${index}"]`).click();
    await page.mouse.click(floor.x, floor.y);
    await page.locator(`[data-case-pick="${index}"]`).click();
  }
  await expect(page.locator("#autoRibsNotOnWall li")).toHaveCount(0, { timeout: 20_000 });

  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#autoRibsGain")).toHaveText(/× stiffer$/);
  const lines = page.locator("#autoRibsCaseLines li");
  await expect(lines).toHaveCount(2);
  const shown = await lines.allTextContents();

  const read = await page.evaluate(() => {
    const bag = (globalThis as unknown as { __limeAutoRibs: { body(): { caseWeights?: number[]; request: { loadCases: unknown[] } } | null; plan(): { stiffnessFactor: number; bare: { maxDeflectionMm: number }; caseFactors?: number[]; caseDeflectionMm?: { bare: number; ribbed: number }[] } | null; card(): { loads: StudyLoad[]; cases?: PanelLoadCase[] } } }).__limeAutoRibs;
    return { body: bag.body(), plan: bag.plan(), card: bag.card() };
  });
  const asked = loadRequest(read.card.loads, read.card.cases);
  expect(read.body?.caseWeights, "the plan body carries the same weights the request builder produces").toEqual(asked.caseWeights);
  expect(read.body?.caseWeights).toEqual([1, 4]);
  expect(read.body?.request.loadCases).toHaveLength(2);
  const outcomes = caseOutcomes(read.plan!.stiffnessFactor, read.plan!.bare.maxDeflectionMm, read.body!.caseWeights!);
  expect(read.plan?.caseFactors).toEqual(outcomes.map((row) => row.factor));
  expect(read.plan?.caseDeflectionMm).toEqual(outcomes.map((row) => ({ bare: row.bareMm, ribbed: row.ribbedMm })));
  expect(shown).toEqual(caseResultLines(["spread", "point"], read.plan?.caseFactors, read.plan?.caseDeflectionMm));
  await page.locator("#autoRibsGain").scrollIntoViewIfNeeded();
  await page.locator("#autoRibsResult").screenshot({ path: "test-results/auto-ribs/10-two-cases-result.png" });
  await shot(page, "10-two-cases.png");

  await primary(page).click();
  await expect(page.locator("#autoRibsAppliedLine")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#autoRibsStress")).toHaveAttribute("data-tip", /Each case adds two slices and two solves/);
  await page.locator("#autoRibsStress").click();
  await expect(page.locator("#autoRibsStressResult li").nth(0)).toHaveText("spread: greatest deflection 0.4 mm → 0.1 mm: 4× as stiff.", { timeout: 20_000 });
  await expect(page.locator("#autoRibsStressResult li").nth(1)).toHaveText("point: greatest deflection 0.4 mm → 0.1 mm: 4× as stiff.");
  const bodies = await page.evaluate(() => (window as unknown as { __limeSimBodies: string[] }).__limeSimBodies.length);
  expect(bodies, "each case is a solve before and a solve after").toBe(4);
  await shot(page, "10b-two-cases-stress.png");
});
