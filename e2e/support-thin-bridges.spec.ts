import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { askSheet } from "./ask-sheet";
import { autoSliceOff } from "./auto-slice";
import { setSupports } from "./supports";

/**
 * Support thin belt edges (`supportBeltHoldThin`) and Free bridges mm (`supportBridgeMm`):
 * off by default and absent from the request, each one key when set, the belt switch only on a belt printer,
 * and both kept by a saved project.
 */
const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));
const shots = path.resolve("test-results/support-settings-ui");

type Body = Record<string, unknown>;

async function start(page: Page): Promise<Body[]> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: Body[] = [];
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as Body;
    bodies.push(body);
    await route.fulfill({ json: body.belt ? beltCube : cube });
  });
  return bodies;
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
}

async function slice(page: Page, bodies: Body[]): Promise<Body> {
  const before = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBeGreaterThan(before);
  return bodies.at(-1)!;
}

async function setNumber(page: Page, id: string, value: string) {
  await page.locator(`#${id}`).fill(value);
  await page.locator(`#${id}`).press("Tab");
}

test("both are off by default and absent from the request, on a flat printer and on a belt", async ({ page }) => {
  const bodies = await start(page);
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);

  const flatOff = await slice(page, bodies);
  expect(flatOff).not.toHaveProperty("supportBridgeMm");
  expect(flatOff).not.toHaveProperty("supportBeltHoldThin");

  await setSupports(page, "auto");
  await expect(page.locator("#sbridge")).toHaveValue("0");
  const flatOn = await slice(page, bodies);
  expect(flatOn.supports).toBe(true);
  expect(flatOn).not.toHaveProperty("supportBridgeMm");
  expect(flatOn).not.toHaveProperty("supportBeltHoldThin");

  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#thinedges")).not.toBeChecked();
  const belt = await slice(page, bodies);
  expect(belt.belt).toBeTruthy();
  expect(belt).not.toHaveProperty("supportBridgeMm");
  expect(belt).not.toHaveProperty("supportBeltHoldThin");
});

test("the bridge limit is sent while supports are on, and 0 sends nothing", async ({ page }) => {
  const bodies = await start(page);
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  // Supports off: the field is not on the page.
  await expect(page.locator("#sbridge")).toHaveCount(0);
  await setSupports(page, "auto");
  await setNumber(page, "sbridge", "6");
  expect((await slice(page, bodies)).supportBridgeMm).toBe(6);

  // The engine's limit is 50 mm; a longer one is sent as 50.
  await setNumber(page, "sbridge", "80");
  expect((await slice(page, bodies)).supportBridgeMm).toBe(50);

  await setNumber(page, "sbridge", "0");
  expect(await slice(page, bodies)).not.toHaveProperty("supportBridgeMm");

  await setNumber(page, "sbridge", "4");
  await setSupports(page, "off");
  await expect(page.locator("#sbridge")).toHaveCount(0);
  expect(await slice(page, bodies)).not.toHaveProperty("supportBridgeMm");
});

test("thin belt edges show only on a belt printer and are sent only there", async ({ page }) => {
  const bodies = await start(page);
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await setSupports(page, "auto");
  // A flat printer has no such switch.
  await expect(page.locator("#sbridge")).toBeVisible();
  await expect(page.locator("#thinedges")).toHaveCount(0);

  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#thinedges")).toBeVisible();
  await page.locator("#thinedges").check();
  const on = await slice(page, bodies);
  expect(on.belt).toBeTruthy();
  expect(on.supportBeltHoldThin).toBe(true);

  // Back on a flat printer it is hidden and left out; the choice is kept for the belt.
  await page.locator("#machineKind").selectOption("cartesian");
  await expect(page.locator("#thinedges")).toHaveCount(0);
  const flat = await slice(page, bodies);
  expect(flat).not.toHaveProperty("belt");
  expect(flat).not.toHaveProperty("supportBeltHoldThin");
  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#thinedges")).toBeChecked();

  await page.locator("#thinedges").uncheck();
  expect(await slice(page, bodies)).not.toHaveProperty("supportBeltHoldThin");
});

test("both survive a project save and open", async ({ page }) => {
  const bodies = await start(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.locator("#machineKind").selectOption("belt");
  await setSupports(page, "auto");
  await page.locator("#thinedges").check();
  await setNumber(page, "sbridge", "7.5");

  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!);
  const doc = JSON.parse(saved.toString("utf8")) as { settings: Record<string, unknown> };
  expect(doc.settings.supportBeltHoldThin).toBe(true);
  expect(doc.settings.supportBridgeMm).toBe(7.5);

  // Change both, then open the saved file over the change.
  await page.locator("#thinedges").uncheck();
  await setNumber(page, "sbridge", "0");
  await page.locator("#projectFile").setInputFiles({ name: "thin.lime", mimeType: "application/json", buffer: saved });
  await expect(askSheet(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(askSheet(page)).toBeHidden();
  await expect(page.locator("#thinedges")).toBeChecked();
  await expect(page.locator("#sbridge")).toHaveValue("7.5");
  const opened = await slice(page, bodies);
  expect(opened.supportBeltHoldThin).toBe(true);
  expect(opened.supportBridgeMm).toBe(7.5);
});

test("screenshots: the Supports panel on a belt printer and on a flat one, dark theme", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.addInitScript(() => localStorage.setItem("lime-slice-settings-level", "advanced"));
  await start(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.locator("#machineKind").selectOption("belt");
  await setSupports(page, "auto");
  await page.locator("#thinedges").check();
  await setNumber(page, "sbridge", "5");
  const group = page.locator('.group[data-group="supports"]');
  await group.scrollIntoViewIfNeeded();
  await page.locator("#sbridge").scrollIntoViewIfNeeded();
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "supports-belt.png") });
  await group.screenshot({ path: path.join(shots, "supports-belt-panel.png") });
  await page.locator("#thinedges").hover();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, "supports-belt-hint.png") });

  await page.locator("#machineKind").selectOption("cartesian");
  await expect(page.locator("#thinedges")).toHaveCount(0);
  await page.locator("#sbridge").scrollIntoViewIfNeeded();
  await group.screenshot({ path: path.join(shots, "supports-flat-panel.png") });
  await page.locator("#sbridge").hover();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, "supports-flat-hint.png") });
});
