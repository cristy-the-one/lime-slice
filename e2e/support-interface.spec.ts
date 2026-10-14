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

async function sliceMatching(page: Page, bodies: SliceBody[], match: (body: SliceBody) => boolean) {
  const start = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.slice(start).some(match)).toBe(true);
}

test("support gaps and a tree brim stay off a default slice and are sent when set", async ({ page }) => {
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
  await page.locator("#szgap").fill("0.35");
  await sliceMatching(page, bodies, (body) => body.supports === true && body.supportZGapMm === 0.35 && body.supportTreeBrimMm === undefined);

  await page.locator("#sxygap").fill("0.9");
  await sliceMatching(page, bodies, (body) => body.supportXyGapMm === 0.9);

  await page.locator("#sifacel").fill("2");
  await sliceMatching(page, bodies, (body) => body.supportInterfaceLayers === 2);

  await page.locator("#stbrim").fill("4");
  await sliceMatching(page, bodies, (body) => body.supportStyle === "tree" && body.supportTreeBrimMm === 4);

  await page.locator("#sstyle").selectOption("grid");
  await sliceMatching(page, bodies, (body) => body.supportStyle === "grid" && body.supportTreeBrimMm === undefined && body.supportZGapMm === 0.35);

  await page.locator("#sstyle").selectOption("tree");
  await page.locator("#szgap").fill("0");
  await page.locator("#sxygap").fill("0");
  await page.locator("#sifacel").fill("0");
  await page.locator("#stbrim").fill("0");
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
