import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type SliceBody = {
  xyHoleCompensationMm?: number;
  xyContourCompensationMm?: number;
  elephantsFootCompensationMm?: number;
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

async function sliceMatching(page: Page, bodies: SliceBody[], match: (body: SliceBody) => boolean) {
  const start = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.slice(start).some(match)).toBe(true);
}

test("compensation stays off a default slice and is sent when set", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await sliceMatching(page, bodies, (body) => body.xyHoleCompensationMm === undefined && body.elephantsFootCompensationMm === undefined);

  await page.locator("#xyhole").fill("0.2");
  await sliceMatching(page, bodies, (body) => body.xyHoleCompensationMm === 0.2 && body.xyContourCompensationMm === undefined);

  await page.locator("#xycontour").fill("-0.1");
  await sliceMatching(page, bodies, (body) => body.xyContourCompensationMm === -0.1);

  await page.locator("#efoot").fill("0.15");
  await sliceMatching(page, bodies, (body) => body.elephantsFootCompensationMm === 0.15);

  await page.locator("#xyhole").fill("0");
  await page.locator("#xycontour").fill("0");
  await page.locator("#efoot").fill("0");
  await sliceMatching(
    page,
    bodies,
    (body) => body.xyHoleCompensationMm === undefined && body.xyContourCompensationMm === undefined && body.elephantsFootCompensationMm === undefined,
  );
});
