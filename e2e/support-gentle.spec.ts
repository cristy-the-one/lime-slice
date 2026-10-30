import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { setSupports } from "./supports";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));

type SliceBody = {
  belt?: unknown;
  supports?: boolean;
  supportStyle?: string;
  supportSlowFragile?: boolean;
  supportGentleSpeedMmS?: number;
  supportGentleAccelMmS2?: number;
  supportTreeBrimMm?: number;
};

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

async function sliceMatching(page: Page, bodies: SliceBody[], match: (body: SliceBody) => boolean) {
  const slice = page.locator("#slice");
  const start = bodies.length;
  await slice.click();
  await expect.poll(() => bodies.slice(start).some(match)).toBe(true);
  await expect(slice).toBeEnabled({ timeout: 0 });
}

/** A slice reply rebuilds the panel; retry until the box shows what was typed. */
async function fillNumber(page: Page, id: string, value: string) {
  const input = page.locator(`#${id}`);
  await expect(async () => {
    await expect(page.locator("#slice")).toBeEnabled();
    await input.fill(value);
    await expect(input).toHaveValue(value, { timeout: 250 });
  }).toPass();
}

/** The panel row that holds the control `id`, with its label. */
function rowOf(page: Page, id: string) {
  return page.locator(".setting, label").filter({ has: page.locator(`#${id}`) }).first();
}

async function openCube(page: Page, level: "advanced" | "expert") {
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption(level);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
}

test("print supports gently sends its speed and acceleration only when set, for every style", async ({ page }) => {
  const bodies = await quiet(page);
  await openCube(page, "expert");
  await setSupports(page, "auto");

  const box = page.locator("#fragile");
  await expect(box).not.toBeChecked();
  await expect(rowOf(page, "fragile")).toContainText("Print supports gently");
  await expect(page.locator("#gentlespeed")).toBeHidden();
  await expect(page.locator("#gentleaccel")).toBeHidden();
  await sliceMatching(page, bodies, (body) => body.supports === true && !("supportSlowFragile" in body) && !("supportGentleSpeedMmS" in body));

  await box.check();
  await expect(page.locator("#gentlespeed")).toBeVisible();
  await expect(page.locator("#gentlespeed")).toHaveAttribute("placeholder", "40");
  await expect(page.locator("#gentleaccel")).toHaveAttribute("placeholder", "2000");
  await sliceMatching(
    page,
    bodies,
    (body) => body.supportSlowFragile === true && !("supportGentleSpeedMmS" in body) && !("supportGentleAccelMmS2" in body),
  );

  await fillNumber(page, "gentlespeed", "25");
  await fillNumber(page, "gentleaccel", "1200");
  await sliceMatching(page, bodies, (body) => body.supportStyle === "tree" && body.supportGentleSpeedMmS === 25 && body.supportGentleAccelMmS2 === 1200);

  await page.locator("#sstyle").selectOption("grid");
  await sliceMatching(page, bodies, (body) => body.supportStyle === "grid" && body.supportSlowFragile === true && body.supportGentleSpeedMmS === 25);

  await fillNumber(page, "gentlespeed", "");
  await sliceMatching(page, bodies, (body) => body.supportSlowFragile === true && !("supportGentleSpeedMmS" in body) && body.supportGentleAccelMmS2 === 1200);

  await box.uncheck();
  await expect(page.locator("#gentleaccel")).toBeHidden();
  await sliceMatching(page, bodies, (body) => body.supports === true && !("supportSlowFragile" in body) && !("supportGentleAccelMmS2" in body));
});

test("the gentle speed and acceleration stay out of the advanced level", async ({ page }) => {
  await quiet(page);
  await openCube(page, "advanced");
  await setSupports(page, "auto");
  await page.locator("#fragile").check();
  await expect(page.locator("#gentlespeed")).toBeHidden();
  await expect(page.locator("#gentleaccel")).toBeHidden();
});

test("a support brim is sent for grid and tree, on a flat bed and on a belt", async ({ page }) => {
  const bodies = await quiet(page);
  await openCube(page, "advanced");
  await setSupports(page, "auto");
  const brim = page.locator("#stbrim");
  await expect(rowOf(page, "stbrim")).toContainText("Support brim");
  await expect(brim).toHaveValue("0");
  await sliceMatching(page, bodies, (body) => body.supports === true && !("supportTreeBrimMm" in body));

  await fillNumber(page, "stbrim", "3");
  await sliceMatching(page, bodies, (body) => body.supportStyle === "tree" && body.supportTreeBrimMm === 3);
  await page.locator("#sstyle").selectOption("grid");
  await expect(brim).toBeVisible();
  await sliceMatching(page, bodies, (body) => body.supportStyle === "grid" && body.supportTreeBrimMm === 3);

  await page.locator("#machineKind").selectOption("belt");
  await expect(brim).toHaveValue("3");
  await sliceMatching(page, bodies, (body) => !!body.belt && body.supportStyle === "grid" && body.supportTreeBrimMm === 3);

  await setSupports(page, "off");
  await expect(brim).toBeHidden();
  await sliceMatching(page, bodies, (body) => !!body.belt && body.supports === false && !("supportTreeBrimMm" in body));
});
