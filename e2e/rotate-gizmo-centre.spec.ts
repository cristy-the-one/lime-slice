import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { placeText } from "./place";

const shots = process.env.LIME_SHOTS ? path.resolve(process.env.LIME_SHOTS) : "";

async function open(page: Page, printer: string | null) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ status: 404, json: { error: "off" } }));
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    // The rotation fields sit in the "Rotation and alignment" group (#605), closed by default.
    localStorage.setItem("lime-slice-open-subgroups", '["object-pose"]');
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  if (printer) {
    await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await page.locator("#machinePrinter").selectOption(printer);
  }
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#partScale")).toHaveValue("100");
  await page.locator("#tabPrepare").click();
}

async function pair(page: Page, name: "ringHub" | "partMid"): Promise<[number, number]> {
  const attr = name === "ringHub" ? "data-ring-hub" : "data-part-mid";
  await expect.poll(async () => page.locator("#prepare").getAttribute(attr)).toBeTruthy();
  const [x, y] = ((await page.locator("#prepare").getAttribute(attr)) ?? "0,0").split(",").map(Number);
  return [x!, y!];
}

async function setXY(page: Page, x: string, y: string) {
  await page.locator("#placeX").fill(x);
  await page.locator("#placeX").press("Tab");
  await page.locator("#placeY").fill(y);
  await page.locator("#placeY").press("Tab");
}

/** The rings' centre lands on the drawn part's middle (a few px), and on the canvas. Polled: the camera glides after a Frame. */
async function ringsOnPart(page: Page) {
  const box = (await page.locator("#prepare").boundingBox())!;
  await expect.poll(async () => {
    const [hx, hy] = await pair(page, "ringHub");
    const [px, py] = await pair(page, "partMid");
    const on = hx > 0 && hx < box.width && hy > 0 && hy < box.height;
    return on ? Math.round(Math.hypot(hx - px, hy - py) * 10) / 10 : -1;
  }, { message: "rings centre vs part centre, px (-1 = rings off canvas)", timeout: 6000 }).toBeLessThan(4);
  expect(await page.locator("#prepare").evaluate((el) => Number((el.getAttribute("data-ring-hub") ?? "-1,-1").split(",")[0]))).toBeGreaterThan(0);
}

for (const [label, printer] of [["flat bed", null], ["IR3 V2 belt", "ideaformer-ir3-v2"]] as const) {
  test(`${label}: the rotate rings are centred on a part placed off the origin, and a turn keeps its centre`, async ({ page }) => {
    await open(page, printer);
    await setXY(page, "60", "35");
    await page.locator("[data-plate-frame=part]").click();
    await page.locator('#toolRail .tool[data-tool="rotate"]').click();
    await expect(page.locator("#prepare")).toHaveAttribute("data-gizmo-at", "part");
    await ringsOnPart(page);
    if (shots) await page.screenshot({ path: path.join(shots, `rotate-${printer ? "belt" : "flat"}.png`) });

    // Other tools keep the parked widget; coming back to Rotate re-seats the rings on the part.
    await page.locator('#toolRail .tool[data-tool="move"]').click();
    await expect(page.locator("#prepare")).toHaveAttribute("data-gizmo-at", "park");
    await page.locator('#toolRail .tool[data-tool="rotate"]').click();
    await ringsOnPart(page);

    // The part moves: the rings follow it.
    await setXY(page, "-40", "80");
    await page.locator("[data-plate-frame=part]").click();
    await ringsOnPart(page);

    // A fixed turn leaves the part's centre where it was.
    const before = (await placeText(page)).split(" · bed")[0];
    await page.locator("#placeRz").fill("40");
    await page.locator("#placeRz").press("Tab");
    await expect.poll(async () => page.locator("#placeRz").inputValue().then(Number)).toBe(40);
    expect((await placeText(page)).split(" · bed")[0]).toBe(before);
    await ringsOnPart(page);

    // Orbit and zoom keep them on the part.
    const box = (await page.locator("#prepare").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(250);
    await ringsOnPart(page);
  });
}
