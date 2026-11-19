import { expect, test } from "@playwright/test";
import { FLOOR, findFloor, openCard, openPart } from "./auto-ribs-box";

/**
 * Include side walls (folded) on the synthetic open box. Off, a click takes the floor alone, as before.
 * On, the four inner walls join it. The modeler is mocked; the wall is read for real.
 */
test("Include side walls is off, and checking it takes the box's walls", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page);
  const floor = await findFloor(page);
  await openCard(page);
  const box = page.locator("#autoRibsFolded");
  await expect(box, "the box is on the wall step").toBeVisible();
  await expect(box, "it starts off").not.toBeChecked();

  await page.mouse.move(floor.x, floor.y);
  await expect(page.locator("#model"), "off, a hover is the floor alone").toHaveAttribute("data-auto-ribs-hover", String(FLOOR));
  await page.mouse.click(floor.x, floor.y);
  await expect(page.locator("#autoRibsWallLine")).toHaveText("1 face · 8,816 mm² · wall 2 mm");

  await box.check();
  await expect(page.locator("#autoRibsWallLine")).toContainText("including side walls");
  const on = await page.evaluate(() => {
    const bag = (globalThis as unknown as { __limeAutoRibs: { card(): { folded: boolean }; wall(): { faces: number[]; folded: number[] } | null } }).__limeAutoRibs;
    return { folded: bag.card().folded, wall: bag.wall() };
  });
  expect(on.folded, "the card keeps the check").toBe(true);
  expect(on.wall?.faces, "the floor and the four inner walls").toEqual(expect.arrayContaining([FLOOR, 8, 9, 10, 11]));
  expect(on.wall?.folded, "the walls are the faces taken across the fold").toEqual(expect.arrayContaining([8, 9, 10, 11]));

  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect(page.locator("#autoRibsWallLine")).toHaveText("1 face · 8,816 mm² · wall 2 mm");
  const off = await page.evaluate(() => (globalThis as unknown as { __limeAutoRibs: { card(): { folded: boolean } } }).__limeAutoRibs.card().folded);
  expect(off).toBe(false);
});
