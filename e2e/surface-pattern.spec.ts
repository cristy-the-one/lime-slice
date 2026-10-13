import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type SliceBody = {
  topSurfacePattern?: string;
  blend?: { mode?: string; strategy?: string };
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

/** The next Slice click, ignoring a quiet refresh that already left. */
async function sliceMatching(page: Page, bodies: SliceBody[], match: (body: SliceBody) => boolean) {
  const start = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.slice(start).some(match)).toBe(true);
}

test("auto leaves a speed slice rectilinear, and toughness and an explicit pattern are sent", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await sliceMatching(page, bodies, (body) => body.topSurfacePattern === undefined && body.blend?.strategy !== "toughness");

  await page.locator("#toppattern").selectOption("monotonic");
  await sliceMatching(page, bodies, (body) => body.topSurfacePattern === "monotonic");

  await page.locator("#toppattern").selectOption("auto");
  await page.locator('[data-card="toughness"]').click();
  await expect(page.locator('[data-card="toughness"]')).toHaveAttribute("aria-pressed", "true");
  await sliceMatching(
    page,
    bodies,
    (body) => body.topSurfacePattern === "monotonic" && body.blend?.mode === "single" && body.blend.strategy === "toughness",
  );

  await page.locator("#toppattern").selectOption("rectilinear");
  await sliceMatching(
    page,
    bodies,
    (body) => body.topSurfacePattern === undefined && body.blend?.strategy === "toughness",
  );

  await page.locator("#toppattern").selectOption("concentric");
  await sliceMatching(page, bodies, (body) => body.topSurfacePattern === "concentric");
});
