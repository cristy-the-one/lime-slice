import { expect, test } from "@playwright/test";
import { FLOOR, cardBox, findFloor, labels, openCard, openPart, panelRun, planRibs, primary, readout, shot } from "./auto-ribs-box";
import type { Body } from "./model-tree-mock";

/**
 * Auto ribs (docs/plan-auto-ribs.md 7.1): the card on a synthetic shelled box (e2e/auto-ribs-box.ts), the modeler mocked
 * and plans from the deterministic stand-in. e2e/model-auto-ribs-real.spec.ts plans with the engine.
 */

test("four actions: open the card, click the floor, Run, Apply; one History row, then what it added and the print check", async ({ page }) => {
  test.setTimeout(180_000);
  const tree = await openPart(page, { stress: true });
  const floor = await findFloor(page);
  await openCard(page);
  // Empty: the prompt, and Run waits for a wall.
  await expect(page.locator("#autoRibsWallLine")).toHaveText("Click the inside wall to reinforce.");
  await expect(primary(page)).toHaveText("Run");
  await expect(primary(page)).toBeDisabled();
  await shot(page, "1-empty.png");

  // Hovering the floor shows what a click takes; the click takes it, and the wall is read.
  await page.mouse.move(floor.x, floor.y);
  await expect(page.locator("#model")).toHaveAttribute("data-auto-ribs-hover", String(FLOOR));
  await page.mouse.click(floor.x, floor.y);
  await expect(page.locator("#autoRibsWallLine")).toHaveText("1 face · 8,816 mm² · wall 2 mm");
  await expect(page.locator("#autoRibsWallStep")).toHaveAttribute("data-done", "");
  await expect(primary(page)).toBeEnabled();
  await shot(page, "2-wall-picked.png");

  // Run: ribs, then the result.
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  // The headline is the worst point; the strain-energy figure is labelled as the wall alone, held at its edges.
  await expect(page.locator("#autoRibsGain")).toHaveText(/^Bends \d+(\.\d)?× less at its worst point$/);
  await expect(page.locator("#autoRibsOverall")).toHaveText(/^\d+(\.\d)?× as stiff overall: this wall alone, held at its edges\.$/);
  await expect(page.locator("#autoRibsCost")).toHaveText(/^\+\d+(\.\d)? g, \+\d+(\.\d)? %$/);
  await expect(page.locator("#autoRibsCompare li")).toHaveCount(3);
  await expect(page.locator("#autoRibsCompare li").last()).toContainText("less than either");
  // The note names the material card the shell was solved with (the selected filament's, or the default standing in).
  await expect(page.locator("#autoRibsRelative")).toContainText(/relative.* Material: /);
  const ribs = await page.locator("#autoRibsList li").count();
  expect(ribs, "the stand-in plans three ribs at Balanced (four, the weakest pruned)").toBe(3);
  await expect(page.locator("#model")).toHaveAttribute("data-ribs-ghost", "3/0");
  await expect(primary(page)).toHaveText("Apply");
  await shot(page, "4-result.png");

  // Hovering a rib in the list lights it in the view.
  await page.locator("#autoRibsList li").nth(1).hover();
  await expect(page.locator("#model")).toHaveAttribute("data-auto-ribs-lit", "1");

  // Apply: one row, the card stays with what was measured and the print check.
  const before = tree.of("apply").length;
  await primary(page).click();
  await expect(labels(page).last()).toHaveText("Auto ribs");
  expect(tree.of("apply").length - before, "one apply").toBe(1);
  const op = tree.of("apply").at(-1)!.op as Body;
  expect(op.kind).toBe("group");
  expect(op.combine).toBe("fuse");
  expect((op.source as Body).kind).toBe("ribNet");
  expect(((op.source as Body).auto as Body).panel, "the row keeps the panel's request").toBeTruthy();
  await expect(page.locator("#autoRibsAppliedLine")).toHaveText(/^Added \d+(\.\d)? g \(\d+(\.\d)? % of the part\), measured on the solid: [\d,]+ mm³\.$/);
  await expect(page.locator("#autoRibsCheck li").first()).toContainText("Print check on", { timeout: 20_000 });
  await expect(primary(page)).toHaveText("Done");
  await shot(page, "6-applied.png");
  // Check with Stress, opt-in: the sliced study before and after, through the desktop study solve.
  await page.locator("#autoRibsStress").click();
  // A rough ratio only: no "N× stiffer", no deflection or safety factor from one cell size.
  await expect(page.locator("#autoRibsStressResult li").first()).toHaveText("Sliced check, rough: bends 4× less.", { timeout: 20_000 });
  await expect(page.locator("#autoRibsStressResult")).not.toContainText(/stiffer|safety factor \d/);
  const bodies = await page.evaluate(() => (window as unknown as { __limeSimBodies: string[] }).__limeSimBodies.length);
  expect(bodies, "two solves: before and after").toBe(2);
  await shot(page, "6b-stress.png");
  await primary(page).click();
  await expect(cardBox(page)).toBeHidden();
});

test("the plan runs in the background: ribs appear as they are chosen, the bar never goes back, and Stop gives a plan that applies", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page, { tickMs: 400 });
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await primary(page).click();
  await expect(page.locator("#autoRibsProgress")).toBeVisible();
  await expect(page.locator("#autoRibsStop")).toBeEnabled();
  // The window stays usable: a fold opens while the plan runs.
  await page.locator("#autoRibsSizes > summary").click();
  await expect(page.locator("#autoRibsSizes")).toHaveAttribute("open", "");
  // A rib is drawn while the plan still runs.
  await expect(page.locator("#model")).toHaveAttribute("data-auto-ribs-live", /^[1-9]/, { timeout: 15_000 });
  const fractions: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    fractions.push((await panelRun(page)).fraction);
    await page.waitForTimeout(150);
  }
  expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]!), `the fraction never goes back: ${fractions}`).toBe(true);
  await expect(page.locator("#autoRibsTotals")).toContainText(/^\d+ ribs? · \+/);
  await expect(page.locator("#autoRibsStage")).toHaveText("Choosing ribs");
  await shot(page, "3-running.png");
  // Esc stops it: the plan so far, stopped early, and it applies.
  await page.keyboard.press("Escape");
  await expect(page.locator("#autoRibsStopped")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#autoRibsStoppedLine")).toBeVisible();
  const run = await panelRun(page);
  expect(run.plan?.stoppedEarly).toBe(true);
  expect(run.plan!.ribs, "stopped after the first rib or two").toBeGreaterThan(0);
  await expect(page.locator("#autoRibsCompare li")).toHaveText(["Stopped before the comparisons with a thicker wall and an even grid."]);
  await expect(primary(page)).toHaveText("Apply");
  await shot(page, "3b-stopped.png");
  await primary(page).click();
  await expect(labels(page).last()).toHaveText("Auto ribs");
});

test("a no-rib box typed as numbers keeps every rib out, and a rib taken out of the plan marks it edited", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page);
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(page.locator("#autoRibsWallLine")).toHaveText(/^1 face/);
  await page.locator("#autoRibsKeepClear > summary").click();
  // Box: placed by a click on the wall, then typed.
  await page.locator("[data-add-zone=box]").click();
  await expect(page.locator("#autoRibsPlaceHint")).toContainText("Click the wall where the box goes");
  await page.mouse.click(floor.x, floor.y);
  await expect(page.locator("#autoRibsZones li")).toHaveCount(1);
  const set = async (key: string, value: number) => {
    const input = page.locator(`[data-zone-field="${key}"]`).first();
    await input.fill(String(value));
    await input.press("Tab");
  };
  await set("c0", 60);
  await set("c1", 40);
  await set("c2", 2);
  await set("s0", 40);
  await set("s1", 30);
  await set("s2", 10);
  await expect(page.locator("[data-zone-title]").first()).toHaveText("Box 40 × 30 × 10 mm at (60, 40, 2)");
  await expect(page.locator("[data-zone-landed]").first()).toHaveText(/^1,[0-9]{3} mm² of the wall$/, { timeout: 15_000 });
  await expect(page.locator("#model")).toHaveAttribute("data-ribs-ghost", "0/1");
  await shot(page, "5-zones.png");
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  const ribs = await planRibs(page);
  expect(ribs.length).toBeGreaterThan(0);
  const inside = ribs.flatMap((rib) => rib.points).filter((p) => Math.abs(p[0] - 60) < 20 && Math.abs(p[1] - 40) < 15);
  expect(inside, "no rib point stands in the box").toEqual([]);
  // A rib taken out: edited, the material recounted, the stiffness marked stale.
  await page.locator("[data-remove-rib]").first().click();
  await expect(page.locator("#autoRibsEdited")).toBeVisible();
  await expect(page.locator("#autoRibsEditedNote")).toContainText("not solved again (stale)");
  await expect(page.locator("#autoRibsGain")).toContainText("before the edit");
});

test("another object over the wall is an obstacle: no rib under it where it leaves no room", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page, { obstacle: true });
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(page.locator("#autoRibsWallLine")).toHaveText(/^1 face/);
  await page.locator("#autoRibsKeepClear > summary").click();
  await page.locator("[data-add-zone=obstacle]").click();
  await expect(page.locator("[data-zone-title]").first()).toHaveText(/^block.*, 1 mm clear$/);
  await expect(page.locator("[data-zone-landed]").first()).toHaveText(/mm² of the wall/, { timeout: 15_000 });
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  const ribs = await planRibs(page);
  const under = ribs.flatMap((rib) => rib.points).filter((p) => p[0] > 46 && p[0] < 74 && p[1] > 26 && p[1] < 54);
  expect(under, "no rib under the block, where 1.5 mm less 1 mm of clearance is under the least height").toEqual([]);
});

test("the History row's pencil opens the card on its request; planning again replaces the row", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page);
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await primary(page).click();
  await expect(primary(page)).toHaveText("Apply", { timeout: 20_000 });
  await primary(page).click();
  await expect(labels(page).last()).toHaveText("Auto ribs");
  await primary(page).click();
  const rows = await labels(page).count();
  await page.locator("#modelHistoryTree .mh-row").last().hover();
  await page.locator("#modelHistoryTree .mh-row").last().locator(".mh-edit").click();
  await expect(cardBox(page)).toBeVisible();
  await expect(page.locator("#modelEditHead")).toBeVisible();
  await expect(page.locator("#autoRibsWallLine")).toHaveText(/^1 face · /, { timeout: 15_000 });
  await expect(primary(page)).toHaveText("Run");
  await primary(page).click();
  await expect(primary(page)).toHaveText("Update", { timeout: 20_000 });
  await primary(page).click();
  await expect(labels(page)).toHaveCount(rows);
  await expect(labels(page).last()).toHaveText("Auto ribs");
});

test("the states it refuses or warns in say so in plain words", async ({ page }) => {
  test.setTimeout(180_000);
  // A plan that beats neither comparison, and a goal that is not met.
  await openPart(page, { beatsNeither: true });
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await page.locator("#autoRibsHowMuch > summary").click();
  await page.locator("[data-amount=stiffer]").click();
  await page.locator("#autoRibsStiffer").fill("50");
  await page.locator("#autoRibsStiffer").press("Tab");
  await primary(page).click();
  await expect(page.locator("#autoRibsGoal")).toHaveText(/^Reached \d+(\.\d)?× of the 50× asked/, { timeout: 20_000 });
  await expect(page.locator("#autoRibsCompare li").last()).toContainText("These ribs are no better");
  await shot(page, "7-beats-neither.png");
});

test("a load that misses the wall is refused by name; Plan without it plans under even pressure and says so first", async ({ page }) => {
  test.setTimeout(180_000);
  await openPart(page);
  const floor = await findFloor(page);
  // A point on an inner side wall (faces 8..11, "Face 9" to "Face 12" in the readout): not on the floor or behind it.
  const box = (await page.locator("#model").boundingBox())!;
  let side: { x: number; y: number } | null = null;
  for (let row = 0; row < 24 && !side; row += 1) {
    for (let col = 0; col < 24 && !side; col += 1) {
      const x = box.x + box.width * (0.2 + col * 0.025);
      const y = box.y + box.height * (0.2 + row * 0.025);
      await page.mouse.click(x, y);
      if (/^Face (9|10|11|12) /.test(await readout(page).innerText())) side = { x, y };
    }
  }
  expect(side, "an inner side wall on screen").not.toBeNull();
  await page.keyboard.press("Escape");
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await page.locator("#autoRibsHoldLoad > summary").click();
  await page.locator("#autoRibsLoadPick").click();
  await page.mouse.click(side!.x, side!.y);
  await page.locator("#autoRibsLoadPick").click();
  // Refused: the readout names the load, why, and what to do; the list under Hold and load says it; the offer shows.
  await expect(readout(page)).toContainText("Load 1: The load is not on the wall or on its far side", { timeout: 20_000 });
  await expect(readout(page)).toContainText("Include the face it is on in the wall");
  await expect(page.locator("#autoRibsNotOnWall li").first()).toContainText("Load 1:");
  await expect(page.locator("#autoRibsEvenPressure")).toBeVisible();
  await shot(page, "9-load-off-wall.png");
  // Plan without it: read again, the sentence first, and the plan runs.
  await page.locator("#autoRibsEvenPressure").click();
  await expect(page.locator("#autoRibsEvenPressure")).toHaveAttribute("aria-pressed", "true");
  await expect(readout(page)).toContainText(/^Planned under even pressure instead of the given load: load 1 misses the wall/, { timeout: 20_000 });
  await expect(page.locator("#autoRibsNotOnWall li").first()).toHaveText(/^Planned under even pressure/);
  await primary(page).click();
  await expect(page.locator("#autoRibsResult")).toBeVisible({ timeout: 20_000 });
  await shot(page, "9b-even-pressure.png");
});

test("an engine refusal, a failed apply and a surfaces-only import each say what happened and change nothing", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await openPart(page, { refuse: "The wall's thickness must be above zero everywhere." });
  const floor = await findFloor(page);
  await openCard(page);
  await page.mouse.click(floor.x, floor.y);
  await expect(primary(page)).toBeEnabled();
  await primary(page).click();
  await expect(page.locator("#autoRibsError")).toHaveText("The wall's thickness must be above zero everywhere.");
  await expect(primary(page)).toHaveText("Run");
  await shot(page, "8-refused.png");

  const second = await browser.newPage();
  const tree = await openPart(second, { applyError: "The fuse left two solids." });
  const at = await findFloor(second);
  await openCard(second);
  await second.mouse.click(at.x, at.y);
  await expect(primary(second)).toBeEnabled();
  await primary(second).click();
  await expect(primary(second)).toHaveText("Apply", { timeout: 20_000 });
  const rows = await labels(second).count();
  await primary(second).click();
  await expect(second.locator("#autoRibsError")).toContainText("The solid is unchanged.");
  await expect(labels(second)).toHaveCount(rows);
  expect(tree.of("apply").length).toBeGreaterThan(0);
  await second.close();

  const third = await browser.newPage();
  await openPart(third, { surfaces: true });
  await third.keyboard.press("Control+k");
  await third.locator("#paletteInput").fill("Auto ribs");
  await third.keyboard.press("Enter");
  await expect(third.locator("#autoRibsRefusal")).toHaveText("This part is surfaces only, not a closed solid, so ribs cannot be added to it. Import it as a solid STEP.");
  await expect(primary(third)).toBeDisabled();
  await third.close();
});
