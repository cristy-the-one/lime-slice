import { expect, test } from "@playwright/test";
import { findFace, findFloor, openCard, openPart, primary, shot } from "./auto-ribs-box";

/**
 * Resin vents on the Auto ribs card, headless Chromium.
 * The box floor is walled in all round, so +Z reports that the part itself cups and cuts nothing.
 * A free plate drains, so the same direction cuts the gaps. Facing the platform cuts nothing.
 * Filament leaves the line and the vents key out.
 */

test("a walled floor says the part itself cups", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page);
  const floor = await findFloor(page);
  await openCard(page);
  await page.locator("#autoRibsSizes").locator("summary").click();
  await page.locator("#autoRibsProcess").selectOption("resin");
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  const line = page.locator("#autoRibsVents");
  await expect(line).toBeVisible();
  await expect(line).toHaveText("the part itself cups here; ribs cannot vent it");
  const shut = await page.evaluate(() => {
    const plan = (window as unknown as { __limeAutoRibs: { plan(): { vents?: { pockets: unknown[] } } } }).__limeAutoRibs.plan();
    return plan.vents?.pockets.length ?? -1;
  });
  expect(shut).toBe(0);
  await line.scrollIntoViewIfNeeded();
  await shot(page, "vents-cups.png");
});

test("a free plate vents toward the tank and not toward the platform", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page, { plate: true });
  const face = await findFace(page, "Face 1");
  await openCard(page);
  await page.locator("#autoRibsSizes").locator("summary").click();
  await page.locator("#autoRibsProcess").selectOption("resin");
  await page.mouse.click(face.x, face.y);
  await expect(primary(page)).toBeEnabled();
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  const line = page.locator("#autoRibsVents");
  await expect(line).toBeVisible({ timeout: 20_000 });
  await expect(line).toHaveText(/^\d+ pockets? vented$/);
  const vented = await page.evaluate(() => {
    const plan = (window as unknown as { __limeAutoRibs: { plan(): { ribs: { points: number[][] }[]; vents?: { pockets: { at: number[] }[]; sizeMm: number } } } }).__limeAutoRibs.plan();
    return { ribs: plan.ribs.length, pockets: plan.vents?.pockets.length ?? 0, sizeMm: plan.vents?.sizeMm ?? 0, points: plan.ribs.map((rib) => rib.points) };
  });
  expect(vented.pockets).toBeGreaterThan(0);
  expect(vented.ribs).toBeGreaterThan(vented.pockets);
  expect(vented.sizeMm).toBe(0.75);
  const gaps = gapWidths(vented.points);
  expect(gaps.some((gap) => Math.abs(gap - 0.75) < 1e-3)).toBe(true);
  await line.scrollIntoViewIfNeeded();
  await shot(page, "vents-built.png");

  await page.evaluate(() => {
    (window as unknown as { __limeAutoRibs: { setBuild(axis: number[]): void } }).__limeAutoRibs.setBuild([0, 0, -1]);
  });
  await expect(primary(page)).toHaveText("Run again");
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  await expect(line).toBeHidden();

  await page.locator("#autoRibsProcess").selectOption("filament");
  await expect(primary(page)).toHaveText("Run again");
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  await expect(line).toBeHidden();
  const filament = await page.evaluate(() => {
    const plan = (window as unknown as { __limeAutoRibs: { plan(): object } }).__limeAutoRibs.plan();
    return "vents" in plan;
  });
  expect(filament).toBe(false);
});

function gapWidths(ribs: number[][][]): number[] {
  const ends: number[][] = [];
  for (const points of ribs) {
    if (points.length >= 2) {
      ends.push(points[0]!, points[points.length - 1]!);
    }
  }
  const gaps: number[] = [];
  for (let i = 0; i < ends.length; i += 1) {
    for (let j = i + 1; j < ends.length; j += 1) {
      const a = ends[i]!;
      const b = ends[j]!;
      gaps.push(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!));
    }
  }
  return gaps.filter((gap) => gap > 0.2 && gap < 2);
}
