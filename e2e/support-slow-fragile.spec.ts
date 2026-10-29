import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { setSupports } from "./supports";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type SliceBody = { supports?: boolean; supportStyle?: string; supportSlowFragile?: boolean };

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: SliceBody[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as SliceBody);
    return route.fulfill({ json: cube });
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

test("slow fragile supports shows with supports, is off by default, and is sent only when on", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();

  const box = page.locator("#fragile");
  await setSupports(page, "off");
  await expect(box).toBeHidden();

  await setSupports(page, "auto");
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await sliceMatching(page, bodies, (body) => body.supports === true && !("supportSlowFragile" in body));

  await box.check();
  await sliceMatching(page, bodies, (body) => body.supportStyle === "tree" && body.supportSlowFragile === true);

  await page.locator("#sstyle").selectOption("grid");
  await expect(box).toBeChecked();
  await sliceMatching(page, bodies, (body) => body.supportStyle === "grid" && body.supportSlowFragile === true);

  await setSupports(page, "off");
  await sliceMatching(page, bodies, (body) => body.supports === false && !("supportSlowFragile" in body));
});
