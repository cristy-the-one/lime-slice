import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: { printer: Record<string, unknown> }[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  return bodies;
}

async function chooseIr3(page: Page) {
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption("ideaformer-ir3-v2");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
}

test("the IR3 V2 shows its printer.cfg limits at Expert and sends them with its firmware", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await chooseIr3(page);
  await loadCube(page);

  const group = page.locator('#left .group[data-group="printer"]');
  await page.locator("#levelPick").selectOption("advanced");
  await expect(group.locator("#scv")).toBeHidden();
  await page.locator("#levelPick").selectOption("expert");
  await expect(group.locator("#vmax")).toHaveValue("400");
  await expect(group.locator("#scv")).toHaveValue("8");
  await expect(group.locator("#mcr")).toHaveValue("0.5");
  await expect(group.locator("#ecv")).toHaveValue("1");
  await expect(group.locator("#zvmax")).toHaveValue("20");
  await expect(group.locator("#zamax")).toHaveValue("500");
  await expect(group.locator('[data-tip*="configfile=settings"]')).toHaveCount(6);

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.locator("#slice")).toBeEnabled();
  expect(bodies[0]!.printer).toMatchObject({
    firmware: "klipper",
    maxAccel: 20000,
    maxVelocity: 400,
    squareCornerVelocity: 8,
    minimumCruiseRatio: 0.5,
    extruderCornerVelocity: 1,
    maxZVelocity: 20,
    maxZAccel: 500,
  });

  await page.locator("#scv").fill("10");
  await page.locator("#scv").blur();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]!.printer).toMatchObject({ firmware: "klipper", squareCornerVelocity: 10 });
});

test("a Marlin printer hides the limits and sends none of them", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("expert");
  await loadCube(page);
  const group = page.locator('#left .group[data-group="printer"]');
  await expect(group.locator("#scv")).toBeVisible();

  await page.locator("#machineFirmware").selectOption("marlin");
  await expect(group.locator("#scv")).toHaveCount(0);
  await expect(group.locator("#vmax")).toHaveCount(0);

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  const printer = bodies[0]!.printer;
  for (const key of ["firmware", "squareCornerVelocity", "minimumCruiseRatio", "extruderCornerVelocity", "maxVelocity", "maxZVelocity", "maxZAccel"]) {
    expect(printer, key).not.toHaveProperty(key);
  }
});
