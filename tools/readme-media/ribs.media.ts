import { expect, test, type Page } from "@playwright/test";
import { openApp, still } from "./media";

/**
 * Auto ribs with Resist buckling (docs/readme-media.md): a 64 × 40 × 14 mm box, shelled to a 2 mm wall with the top
 * open, planned on the inner floor. The force along the floor is raised until the card says "Buckles at", so the
 * numbers in the picture are the engine's. The part is built here. Nothing is loaded from outside the repository.
 */
const BOX = { modelDx: "64", modelDy: "40", modelDz: "14" };
const TOP_MM2 = 64 * 40;
const FLOOR_MM2 = (64 - 4) * (40 - 4);

test("resist buckling on a shelled box", async ({ page }) => {
  test.setTimeout(900_000);
  await page.addInitScript(() => localStorage.setItem("lime-slice-auto-slice", "0"));
  await openApp(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="box"]').click();
  for (const [id, value] of Object.entries(BOX)) await page.locator(`#${id}`).fill(value);
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume", { timeout: 120_000 });
  await expect(page.locator("#modelPanel")).toBeHidden();

  const top = await holeOrigin(page);
  await page.locator("#modelToolShell").click();
  await expect(page.locator("#modelShell")).toBeVisible();
  await page.mouse.click(top.x, top.y);
  await expect(page.locator("#modelReadout")).toContainText(`${TOP_MM2} mm²`);
  await fill(page, "modelShell", "2");
  await page.locator("#modelApply").click();
  await expect.poll(async () => volume(page), { timeout: 120_000 }).toBeLessThan(15_000);

  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuAutoRibs").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Auto ribs");
  await lookDown(page);
  await page.locator("#autoRibsJustThis").check();
  const floor = await innerFloor(page);
  await expect(page.locator("#autoRibsWallLine")).toContainText("wall 2 mm");

  await page.locator("#autoRibsHowMuch > summary").click();
  await page.getByRole("button", { name: "Resist buckling" }).click();
  await expect(page.locator("#autoRibsSliderMid")).toHaveText("3×");
  await page.locator("#autoRibsHoldLoad > summary").click();
  await page.locator("#autoRibsLoadForce").click();
  await fill(page, "autoRibsDirX", "1");
  await fill(page, "autoRibsDirY", "0");
  await fill(page, "autoRibsDirZ", "0");
  await fill(page, "autoRibsForce", "200");
  await page.locator("#autoRibsLoadPick").click();
  await page.mouse.click(floor.x, floor.y);

  let force = 200;
  let gain = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const field = page.locator("#autoRibsForce");
    await field.scrollIntoViewIfNeeded();
    await field.fill(String(force));
    await field.press("Tab");
    await expect(field).toHaveValue(String(force));
    const previous = (await page.locator("#autoRibsGain").innerText()).trim();
    await page.locator("#modelApply").click();
    let outcome = "";
    await expect.poll(async () => {
      const error = page.locator("#autoRibsError");
      if (await error.isVisible()) outcome = `error:${(await error.innerText()).trim()}`;
      else if (await page.locator("#autoRibsGain").isVisible()) {
        const text = (await page.locator("#autoRibsGain").innerText()).trim();
        outcome = text && text !== previous ? `gain:${text}` : "";
      } else outcome = "";
      return outcome;
    }, { timeout: 240_000 }).not.toBe("");
    if (outcome.startsWith("error:")) throw new Error(`auto ribs: ${outcome.slice(6)}`);
    gain = outcome.slice(5);
    const held = /The wall already holds ([\d.]+)×/.exec(gain);
    if (!held) break;
    const factor = Number(held[1]);
    const next = Math.max(force + 1, Math.ceil((force * factor) / 2.5));
    console.log(`force ${force} N already holds ${factor}×; trying ${next} N`);
    force = next;
  }
  await expect(page.locator("#autoRibsGain")).toHaveText(/^Buckles at \d+(\.\d)?× the load \(was \d+(\.\d)?×\)\.$/);
  await expect(page.locator("#autoRibsNotes")).toContainText("This is the ideal buckling load. A curved wall, or one that isn't perfectly flat, can buckle well below it.");
  await expect(page.locator(".toast-error")).toHaveCount(0);

  await page.locator("#autoRibsNotes").scrollIntoViewIfNeeded();
  await page.locator("#autoRibsGain").scrollIntoViewIfNeeded();
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height - 8);
  await page.waitForTimeout(600);
  gain = (await page.locator("#autoRibsGain").innerText()).trim();
  const notes = (await page.locator("#autoRibsNotes").innerText()).trim();
  console.log(`ribs-buckling force ${force} N`);
  console.log(`ribs-buckling gain: ${gain}`);
  console.log(`ribs-buckling notes: ${notes}`);
  await still(page, "ribs-buckling.png");
});

async function fill(page: Page, id: string, value: string) {
  const field = page.locator(`#${id}`);
  await field.fill(value);
  await field.press("Tab");
}

async function volume(page: Page): Promise<number> {
  const text = await page.locator("#modelReadout").innerText();
  const match = /Volume ([\d.,]+) mm³/.exec(text);
  return match ? Number(match[1]!.replace(/,/g, "")) : Number.NaN;
}

/** The Hole tool's origin dot, which the window puts on the middle of the top face. */
async function holeOrigin(page: Page): Promise<{ x: number; y: number }> {
  await page.locator("#modelToolHole").click();
  await expect.poll(async () => handleAt(page, "hole-origin")).not.toBeNull();
  const at = (await handleAt(page, "hole-origin"))!;
  await page.locator("#modelCancel").click();
  await expect(page.locator("#modelPanel")).toBeHidden();
  return at;
}

async function handleAt(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  const text = (await page.locator("#model").getAttribute("data-handles")) ?? "";
  const box = await page.locator("#model").boundingBox();
  if (!box) return null;
  for (const item of text.split(" ").filter(Boolean)) {
    const [name, at] = item.split(":");
    if (name !== id || !at) continue;
    const [x, y] = at.split(",").map(Number);
    if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) continue;
    return { x: box.x + x, y: box.y + y };
  }
  return null;
}

/** Top view, so the open top shows the inner floor. T is the Model command; blur first so it is not typed into a field. */
async function lookDown(page: Page) {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.keyboard.press("t");
  await page.waitForTimeout(400);
}

/**
 * Click the inner floor. Each try starts from a clear wall, because a click toggles the face it hits.
 * The floor is the single face of about (64 − 4) × (40 − 4) mm², 2 mm thick.
 */
async function innerFloor(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator("#model").boundingBox())!;
  const points: { x: number; y: number }[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      points.push({ x: box.x + box.width * (0.42 + col * 0.04), y: box.y + box.height * (0.42 + row * 0.04) });
    }
  }
  let last = "";
  for (const at of points) {
    const clear = page.locator("#autoRibsWallClear");
    if (await clear.isVisible()) await clear.click();
    const hit = await clickFloor(page, at);
    last = (await page.locator("#autoRibsWallLine").innerText()).replace(/\s+/g, " ");
    if (hit) {
      console.log(`inner floor: ${last}`);
      return at;
    }
  }
  await page.screenshot({ path: "/tmp/ribs-floor-miss.png" });
  throw new Error(`inner floor (~${FLOOR_MM2} mm²) was not found; last wall line: ${last}`);
}

async function clickFloor(page: Page, at: { x: number; y: number }): Promise<boolean> {
  const line = page.locator("#autoRibsWallLine");
  await page.mouse.click(at.x, at.y);
  let text = "";
  try {
    await expect.poll(async () => {
      text = await line.innerText();
      return /wall /.test(text) && !/reading/.test(text);
    }, { timeout: 8_000 }).toBe(true);
  } catch {
    return false;
  }
  text = await line.innerText();
  const area = Number(/([\d,]+) mm²/.exec(text)?.[1]?.replace(/,/g, ""));
  return /^1 face/.test(text) && /wall 2 mm/.test(text) && Math.abs(area - FLOOR_MM2) < 200;
}
