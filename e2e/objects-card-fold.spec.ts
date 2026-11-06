import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const shots = process.env.LIME_SHOTS_DIR ?? path.resolve("test-results/objects-card-fold");
fs.mkdirSync(shots, { recursive: true });

async function open(page: Page, width: number, height = 1000) {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-closed-groups", "[]");
    localStorage.setItem("lime-slice-theme", "dark");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
}

const group = (page: Page) => page.locator("#objPoseGroup");
const rows = (page: Page) => page.locator("#objectList .obj");

/** Every option of the select must fit its box: no option text is wider than the select's own text area. */
async function howFits(page: Page) {
  return page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>("#alignHow")!;
    const probe = document.createElement("span");
    const style = getComputedStyle(select);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font};`;
    document.body.append(probe);
    const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 22;
    const widest = Math.max(...[...select.options].map((o) => ((probe.textContent = o.textContent), probe.getBoundingClientRect().width)));
    probe.remove();
    return { scrollWidth: select.scrollWidth, clientWidth: select.clientWidth, widest, room };
  });
}

test("Objects card: rotation and alignment start folded, open, and stay as left", async ({ page }) => {
  await open(page, 1440);
  await expect(group(page)).toBeVisible();
  await expect(group(page)).not.toHaveAttribute("open", "");
  await expect(page.locator("#placeX")).toBeVisible();
  await expect(page.locator("#partScale")).toBeVisible();
  await expect(page.locator("#settleOn")).toBeVisible();
  await expect(page.locator("#placeRx")).toBeHidden();
  await expect(page.locator("#alignHow")).toBeHidden();
  await page.screenshot({ path: path.join(shots, "objects-folded-1440.png") });

  await group(page).locator("summary").click();
  await expect(page.locator("#placeRx")).toBeVisible();
  await expect(page.locator("#placeRz")).toBeVisible();
  await expect(page.locator("#alignTo")).toBeVisible();
  await expect(page.locator("#alignHow")).toBeVisible();
  await expect(page.locator("#alignGo")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "objects-open-1440.png") });

  // Editing in it re-renders the card; it stays open. A reload remembers it.
  await page.locator("#placeRx").fill("30");
  await page.locator("#placeRx").press("Tab");
  await expect(group(page)).toHaveAttribute("open", "");
  await page.reload();
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(rows(page)).toHaveCount(1);
  await expect(group(page)).toHaveAttribute("open", "");

  await group(page).locator("summary").click();
  await expect(group(page)).not.toHaveAttribute("open", "");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("lime-slice-open-subgroups"))).toBe("[]");
  await page.reload();
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(rows(page)).toHaveCount(1);
  await expect(group(page)).not.toHaveAttribute("open", "");
});

test("the folded header names the turn, and a search for rotation opens it", async ({ page }) => {
  await open(page, 1440);
  await expect(group(page).locator(".subgroup-sum")).toContainText("Align to");
  await page.locator("#find").fill("rotation x");
  await expect(group(page)).toHaveAttribute("open", "");
  await expect(page.locator("#placeRx")).toBeVisible();
});

for (const width of [1440, 300]) {
  test(`the How select shows every option whole at ${width === 300 ? "a 300 px panel" : "the default panel width"}`, async ({ page }) => {
    await open(page, 1440);
    if (width === 300) {
      await page.evaluate(() => document.documentElement.style.setProperty("--panel-left", "300px"));
    }
    await group(page).locator("summary").click();
    const dock = await page.locator("#left").boundingBox();
    if (width === 300) expect(Math.round(dock!.width)).toBeLessThanOrEqual(300);
    const fit = await howFits(page);
    expect(fit.widest).toBeLessThanOrEqual(fit.room);
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
    // The long option is chosen and its full words stay reachable in the tooltip.
    await page.locator("#alignHow").selectOption("centre");
    await expect(page.locator("#alignHow option[value='centre']")).toHaveAttribute("title", "Centre X and Y");
    await page.screenshot({ path: path.join(shots, `how-${width}.png`) });
  });
}

test("rail names show under the icons at 1440 and not in a narrow window", async ({ page }) => {
  await open(page, 1440);
  const move = page.locator('#toolRail [data-tool="move"]');
  const cap = (el: Element) => getComputedStyle(el, "::before").content;
  expect(await move.evaluate(cap)).toBe('"Move"');
  const railBefore = await page.locator("#toolRail").boundingBox();
  const stageBefore = await page.locator("#stage").boundingBox();
  expect(Math.round(railBefore!.width)).toBe(48);
  await page.screenshot({ path: path.join(shots, "rail-1440.png") });

  // The setting turns them off, and keeps that.
  await page.locator("#railCaptions").evaluate((el: HTMLInputElement) => { el.checked = false; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await expect(page.locator("html")).toHaveAttribute("data-rail-captions", "0");
  const off = await move.boundingBox();
  const stageOff = await page.locator("#stage").boundingBox();
  expect(Math.round(stageOff!.x)).toBe(Math.round(stageBefore!.x));
  expect(Math.round(stageOff!.width)).toBe(Math.round(stageBefore!.width));
  expect(off!.height).toBeLessThanOrEqual(33);
  await page.locator("#railCaptions").evaluate((el: HTMLInputElement) => { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); });

  for (const [w, h] of [[1100, 1000], [1440, 700]] as const) {
    await page.setViewportSize({ width: w, height: h });
    const box = await move.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(33);
    expect(Math.round((await page.locator("#toolRail").boundingBox())!.width)).toBe(48);
  }
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.screenshot({ path: path.join(shots, "rail-1100.png") });
});
