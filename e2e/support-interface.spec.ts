import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { setSupports } from "./supports";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type SliceBody = {
  supports?: boolean;
  supportStyle?: string;
  supportZGapMm?: number;
  supportXyGapMm?: number;
  supportInterfaceLayers?: number;
  supportTreeBrimMm?: number;
};

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: SliceBody[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  return bodies;
}

/**
 * The request is recorded before the reply rebuilds the settings panel.
 * Returning here used to let the next edit run during that rebuild.
 */
async function sliceMatching(page: Page, bodies: SliceBody[], match: (body: SliceBody) => boolean) {
  const slice = page.locator("#slice");
  const start = bodies.length;
  await slice.click();
  await expect.poll(() => bodies.slice(start).some(match)).toBe(true);
  await expect(slice).toBeEnabled({ timeout: 0 });
}

/**
 * A number fill focuses, then types on a later turn. The slice reply, and a
 * quiet refresh, rebuild the settings panel; a rebuild between those turns
 * drops the text and Slice sends the previous value. Retry until the field
 * shows what was stored.
 */
async function fillNumber(page: Page, id: string, value: string) {
  const input = page.locator(`#${id}`);
  await expect(async () => {
    await expect(page.locator("#slice")).toBeEnabled();
    await input.fill(value);
    await expect(input).toHaveValue(value, { timeout: 250 });
  }).toPass();
}

test("support gaps and a support brim stay off a default slice and are sent when set", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await sliceMatching(
    page,
    bodies,
    (body) =>
      body.supportZGapMm === undefined &&
      body.supportXyGapMm === undefined &&
      body.supportInterfaceLayers === undefined &&
      body.supportTreeBrimMm === undefined,
  );

  await setSupports(page, "auto");
  await expect(page.locator("#szgap")).toBeVisible();
  await fillNumber(page, "szgap", "0.35");
  await sliceMatching(page, bodies, (body) => body.supports === true && body.supportZGapMm === 0.35 && body.supportTreeBrimMm === undefined);

  await fillNumber(page, "sxygap", "0.9");
  await sliceMatching(page, bodies, (body) => body.supportXyGapMm === 0.9);

  await fillNumber(page, "sifacel", "2");
  await sliceMatching(page, bodies, (body) => body.supportInterfaceLayers === 2);

  await fillNumber(page, "stbrim", "4");
  await sliceMatching(page, bodies, (body) => body.supportStyle === "tree" && body.supportTreeBrimMm === 4);

  await page.locator("#sstyle").selectOption("grid");
  await sliceMatching(page, bodies, (body) => body.supportStyle === "grid" && body.supportTreeBrimMm === 4 && body.supportZGapMm === 0.35);

  await page.locator("#sstyle").selectOption("tree");
  await fillNumber(page, "szgap", "");
  await fillNumber(page, "sxygap", "");
  await fillNumber(page, "sifacel", "");
  await fillNumber(page, "stbrim", "0");
  await sliceMatching(
    page,
    bodies,
    (body) =>
      body.supportZGapMm === undefined &&
      body.supportXyGapMm === undefined &&
      body.supportInterfaceLayers === undefined &&
      body.supportTreeBrimMm === undefined,
  );
});

test("the support gaps show Auto, a typed 0 is sent as 0, and clearing the box is Auto again", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await setSupports(page, "auto");

  for (const id of ["szgap", "sxygap", "sifacel"]) {
    await expect(page.locator(`#${id}`)).toHaveValue("");
    await expect(page.locator(`#${id}`)).toHaveAttribute("placeholder", "Auto");
  }

  await fillNumber(page, "szgap", "0");
  await fillNumber(page, "sxygap", "0");
  await fillNumber(page, "sifacel", "0");
  await sliceMatching(page, bodies, (body) => body.supports === true && body.supportZGapMm === 0 && body.supportXyGapMm === 0 && body.supportInterfaceLayers === 1);
  await page.locator("#sifacel").blur();
  await expect(page.locator("#sifacel")).toHaveValue("1");
  await expect(page.locator("#szgap")).toHaveValue("0");
  await expect(page.locator("#sxygap")).toHaveValue("0");

  await fillNumber(page, "szgap", "");
  await fillNumber(page, "sxygap", "");
  await fillNumber(page, "sifacel", "");
  await sliceMatching(
    page,
    bodies,
    (body) => body.supports === true && body.supportZGapMm === undefined && body.supportXyGapMm === undefined && body.supportInterfaceLayers === undefined,
  );
  for (const id of ["szgap", "sxygap", "sifacel"]) await expect(page.locator(`#${id}`)).toHaveValue("");
  await expect(page.locator("#szgap")).toHaveAttribute("placeholder", "Auto");
});
