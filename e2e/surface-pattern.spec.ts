import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: { topSurfacePattern?: string }[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  return bodies;
}

test("auto leaves a speed slice rectilinear, and toughness and an explicit pattern are sent", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toHaveProperty("topSurfacePattern");

  await page.locator("#toppattern").selectOption("monotonic");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]?.topSurfacePattern).toBe("monotonic");

  await page.locator("#toppattern").selectOption("auto");
  await page.locator('[data-card="toughness"]').click();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]?.topSurfacePattern).toBe("monotonic");

  await page.locator("#toppattern").selectOption("rectilinear");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(4);
  expect(bodies[3]).not.toHaveProperty("topSurfacePattern");

  await page.locator("#toppattern").selectOption("concentric");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(5);
  expect(bodies[4]?.topSurfacePattern).toBe("concentric");
});
