import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { setSupports } from "./supports";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));

type SliceBody = { belt?: unknown; supportStyle?: string; supportStrictStacking?: boolean };

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
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

test("tip under every row shows for belt trees only, is off by default, and is sent only when on", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await setSupports(page, "auto");

  const box = page.locator("#rowtips");
  await expect(page.locator("#sstyle")).toHaveValue("tree");
  await expect(box).toBeHidden();

  await choosePrinter(page, "ideaformer-ir3-v2");
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await sliceMatching(page, bodies, (body) => !!body.belt && !("supportStrictStacking" in body));

  await box.check();
  await sliceMatching(page, bodies, (body) => !!body.belt && body.supportStrictStacking === true);

  await page.locator("#sstyle").selectOption("grid");
  await expect(page.locator("#rowtips")).toBeHidden();
  await sliceMatching(page, bodies, (body) => body.supportStyle === "grid" && !("supportStrictStacking" in body));
});
