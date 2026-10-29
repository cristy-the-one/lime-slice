import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));

type SliceBody = { belt?: unknown; shallowSkins?: boolean };

async function quiet(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-closed-groups", "[]");
    localStorage.setItem("lime-slice-theme", "dark");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: SliceBody[] = [];
  await page.route("**/api/slice", (route) => {
    const body = route.request().postDataJSON() as SliceBody;
    bodies.push(body);
    return route.fulfill({ json: body.belt ? beltCube : cube });
  });
  return bodies;
}

async function choosePrinter(page: Page, id: string) {
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption(id);
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
}

async function sliceMatching(page: Page, bodies: SliceBody[], match: (body: SliceBody) => boolean) {
  const slice = page.locator("#slice");
  const start = bodies.length;
  await slice.click();
  await expect.poll(() => bodies.slice(start).some(match)).toBe(true);
  await expect(slice).toBeEnabled({ timeout: 0 });
}

test("skin on shallow slopes is off by default and is sent only when on", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();

  const box = page.locator("#shallowskin");
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await sliceMatching(page, bodies, (body) => !("shallowSkins" in body));

  await box.check();
  await sliceMatching(page, bodies, (body) => body.shallowSkins === true);

  await choosePrinter(page, "ideaformer-ir3-v2");
  await expect(box).toBeVisible();
  await expect(box).toBeChecked();
  await sliceMatching(page, bodies, (body) => !!body.belt && body.shallowSkins === true);
  if (process.env.LIME_SHOTS) {
    await box.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(process.env.LIME_SHOTS, "shallow-skins-setting.png") });
  }

  await box.uncheck();
  await sliceMatching(page, bodies, (body) => !!body.belt && !("shallowSkins" in body));
});
