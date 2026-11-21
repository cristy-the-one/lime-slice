import { expect, test, type Page } from "@playwright/test";
import { openApp, still } from "./media";

/**
 * Auto ribs with Resist buckling (docs/readme-media.md): a 160 × 100 × 20 mm box, shelled to a 1 mm wall with the
 * top open, planned on the inner floor. The force runs along the 160 mm side, through the 100 mm × 1 mm section.
 * A 30 N probe finds the critical load, and the picture uses the force that leaves the bare floor at about 1.3×,
 * so the default 3× adds the ribs. The part is built here. Nothing is loaded from outside the repository.
 */
const BOX = { modelDx: "160", modelDy: "100", modelDz: "20" };
const THICK = 1;
const WIDTH = 100;
const DIR = { x: "1", y: "0", z: "0" };
const SECTION = WIDTH * THICK;
const TOP_MM2 = 160 * 100;
const FLOOR_MM2 = (160 - 2 * THICK) * (100 - 2 * THICK);
const STRESS_CAP = 20;

test("resist buckling on a wide thin panel", async ({ page }) => {
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
  await fill(page, "modelShell", String(THICK));
  await page.locator("#modelApply").click();
  await expect.poll(async () => volume(page), { timeout: 120_000 }).toBeLessThan(160_000);
  await expect(page.locator("#modelReadout")).toContainText("Shell");

  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuAutoRibs").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Auto ribs");
  await look(page, "t");
  await page.locator("#autoRibsJustThis").check();
  const floor = await innerFloor(page);
  await expect(page.locator("#autoRibsWallLine")).toContainText(`wall ${THICK} mm`);

  await page.locator("#autoRibsHowMuch > summary").click();
  await page.getByRole("button", { name: "Resist buckling" }).click();
  await expect(page.locator("#autoRibsSliderMid")).toHaveText("3×");
  await page.locator("#autoRibsHoldLoad > summary").click();
  await page.locator("#autoRibsLoadForce").click();
  await fill(page, "autoRibsDirX", DIR.x);
  await fill(page, "autoRibsDirY", DIR.y);
  await fill(page, "autoRibsDirZ", DIR.z);
  await fill(page, "autoRibsForce", "30");
  await page.locator("#autoRibsLoadPick").click();
  await page.mouse.click(floor.x, floor.y);
  await page.locator("#autoRibsLoadPick").click();

  const probe = await planAt(page, 30);
  if (!probe.ok) throw new Error(`the 30 N probe was refused: ${probe.text}`);
  const held = /The wall already holds ([\d.]+)×/.exec(probe.text);
  if (!held) throw new Error(`the 30 N probe did not report a factor: ${probe.text}`);
  const pcr = 30 * Number(held[1]);
  const force = Math.round(pcr / 1.3);
  console.log(`ribs-buckling probe 30 N holds ${held[1]}×, critical load about ${Math.round(pcr)} N; trying ${force} N (${stress(force)} MPa)`);
  if (stress(force) > STRESS_CAP) throw new Error(`${force} N is ${stress(force)} MPa, over ${STRESS_CAP} MPa`);
  const planned = await planAt(page, force);
  if (!planned.ok) throw new Error(`the plan refused ${force} N: ${planned.text}`);
  const buckled = /Buckles at ([\d.]+)× the load \(was ([\d.]+)×\)/.exec(planned.text);
  if (!buckled) throw new Error(`the plan did not add ribs: ${planned.text}`);
  const bare = Number(buckled[2]);
  const ribbed = Number(buckled[1]);
  const ribs = await page.locator("#autoRibsList [data-rib]").count();
  const goal = page.locator("#autoRibsGoal");
  const goalText = (await goal.isVisible()) ? (await goal.innerText()).replace(/\s+/g, " ").trim() : "";
  const compare = (await page.locator("#autoRibsCompare").innerText()).replace(/\s+/g, " ").trim();
  const notes = (await page.locator("#autoRibsNotes").innerText()).replace(/\s+/g, " ").trim();
  const loose = /stop short/.test(goalText);
  const compared = /thicker/.test(compare) && !/not computed/.test(compare) && !/Stopped before/.test(compare);
  const lines = (await page.locator("#autoRibsList [data-rib]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  console.log(`ribs-buckling box ${BOX.modelDx} × ${BOX.modelDy} × ${BOX.modelDz} mm, shell ${THICK} mm`);
  console.log(`ribs-buckling force ${force} N`);
  console.log(`ribs-buckling section ${WIDTH} mm × ${THICK} mm`);
  console.log(`ribs-buckling membrane stress ${stress(force)} MPa`);
  console.log(`ribs-buckling bare ${bare}×, ribbed ${ribbed}×`);
  console.log(`ribs-buckling ribs ${ribs}`);
  console.log(`ribs-buckling rib lines: ${lines.join(" | ") || "(none)"}`);
  console.log(`ribs-buckling comparisons computed: ${compared}`);
  console.log(`ribs-buckling compare: ${compare}`);
  console.log(`ribs-buckling loose-end warning: ${loose}`);
  console.log(`ribs-buckling goal: ${goalText || "(none)"}`);
  console.log(`ribs-buckling notes: ${notes}`);
  await page.locator("#autoRibsHoldLoad").evaluate((el) => {
    (el as HTMLDetailsElement).open = false;
  });
  await page.locator("#autoRibsHowMuch").evaluate((el) => {
    (el as HTMLDetailsElement).open = false;
  });
  await look(page, "i");
  const view = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(view.x + view.width * 0.62, view.y + view.height * 0.55);
  await page.mouse.wheel(0, -1400);
  await page.waitForTimeout(400);
  await page.locator("#autoRibsGain").scrollIntoViewIfNeeded();
  // The alt quotes this plan. A finished buckling plan leaves the stiffness baselines empty, so the card says
  // they were not computed, and it does not run the extension pass, so the short rib is listed as stopping short.
  if (force !== 750 || bare !== 1.3 || ribbed !== 3.1 || ribs !== 2 || !loose || compared) {
    await page.screenshot({ path: "/tmp/ribs-last.png" });
    throw new Error(`plan is not the picture the alt describes: ${force} N, ${ribs} ribs, loose ${loose}, bare ${bare}×, ribbed ${ribbed}×, comparisons ${compared}`);
  }
  await expect(page.locator(".toast-error")).toHaveCount(0);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height - 8);
  await page.waitForTimeout(700);
  await still(page, "ribs-buckling.png");
});

function stress(force: number): string {
  return (force / SECTION).toFixed(3);
}

/** Fill the force, Apply, and wait until the gain line is a new sentence or the card refuses the load. */
async function planAt(page: Page, force: number): Promise<{ ok: boolean; text: string }> {
  await fill(page, "autoRibsDirX", DIR.x);
  await fill(page, "autoRibsDirY", DIR.y);
  await fill(page, "autoRibsDirZ", DIR.z);
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
  }, { timeout: 600_000 }).not.toBe("");
  if (outcome.startsWith("error:")) return { ok: false, text: outcome.slice(6) };
  return { ok: true, text: outcome.slice(5) };
}

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

/** T is top, I is the three-quarter iso. Blur first so the key is not typed into a field. */
async function look(page: Page, key: "t" | "i") {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
}

/**
 * Click the inner floor. Each try starts from a clear wall, because a click toggles the face it hits.
 * The floor is the single face of about (160 − 2) × (100 − 2) mm², 1 mm thick.
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
  throw new Error(`inner floor (~${Math.round(FLOOR_MM2)} mm²) was not found; last wall line: ${last}`);
}

async function clickFloor(page: Page, at: { x: number; y: number }): Promise<boolean> {
  const line = page.locator("#autoRibsWallLine");
  await page.mouse.click(at.x, at.y);
  let text = "";
  try {
    await expect.poll(async () => {
      text = await line.innerText();
      return /wall /.test(text) && !/reading/.test(text);
    }, { timeout: 20_000 }).toBe(true);
  } catch {
    return false;
  }
  text = await line.innerText();
  const area = Number(/([\d,]+) mm²/.exec(text)?.[1]?.replace(/,/g, ""));
  return /^1 face/.test(text) && new RegExp(`wall ${THICK} mm`).test(text) && Math.abs(area - FLOOR_MM2) < 400;
}
