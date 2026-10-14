import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type Action = { zMm: number; kind: string; note?: string };
type SliceBody = { layerActions?: Action[] };

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

test("a layer marker cycles pause, filament change, and clear", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await sliceMatching(page, bodies, (body) => body.layerActions === undefined);
  await page.locator("#tabPreview").click();
  const button = page.locator("#layerAction");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("+");
  await expect(button).toHaveAttribute("aria-label", "Pause at this layer");

  await button.click();
  await expect(button).toHaveText("P");
  await expect(page.locator("#layerPins .layer-pin")).toHaveCount(1);
  await sliceMatching(page, bodies, (body) => body.layerActions?.length === 1 && body.layerActions[0].kind === "pause" && (body.layerActions[0].zMm ?? 0) > 0);

  await button.click();
  await expect(button).toHaveText("F");
  await sliceMatching(page, bodies, (body) => body.layerActions?.length === 1 && body.layerActions[0].kind === "filamentChange");

  await button.click();
  await expect(button).toHaveText("+");
  await expect(page.locator("#layerPins .layer-pin")).toHaveCount(0);
  await sliceMatching(page, bodies, (body) => body.layerActions === undefined);
});