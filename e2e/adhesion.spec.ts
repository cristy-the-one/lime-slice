import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: { adhesion?: string; brimWidthMm?: number; skirtLoops?: number }[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  return bodies;
}

test("a skirt is left off the slice, and a brim is sent when chosen", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("adhesion");
  expect(bodies[0]).not.toHaveProperty("skirtLoops");

  await page.locator("#adhesion").selectOption("brim");
  await expect(page.locator("#brimwidth")).toHaveValue("5");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({ adhesion: "brim", brimWidthMm: 5, brimGapMm: 0.1 });
});

test("ABS offers mouse ears and a 5 mm brim", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machineFilament").selectOption("lime-abs");
  const toast = page.locator("#toasts").getByRole("status").filter({ hasText: "ABS lifts at the corners" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "5 mm brim" }).click();
  await page.locator("#levelPick").selectOption("advanced");
  await expect(page.locator("#adhesion")).toHaveValue("brim");
  await expect(page.locator("#brimwidth")).toHaveValue("5");

  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ adhesion: "brim", brimWidthMm: 5 });
});
