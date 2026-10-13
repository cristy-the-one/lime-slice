import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
}

test("a repaired mesh shows a dismissible warning in the estimate", async ({ page }) => {
  await quiet(page);
  let n = 0;
  await page.route("**/api/slice", (route) => {
    n += 1;
    const body = structuredClone(cube);
    if (n === 1) {
      body.mesh.repairedLayers = 4;
      body.mesh.droppedChains = 2;
      body.warnings = [{ code: "mesh-repair", repairedLayers: 4, bridgedMm: 12.5, droppedChains: 2 }];
    } else {
      body.mesh.repairedLayers = 1;
      body.mesh.droppedChains = 0;
    }
    return route.fulfill({ json: body });
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();

  await page.locator("#slice").click();
  const pill = page.locator("#summaryCard #meshWarn");
  await expect(pill).toContainText("The mesh has gaps on 4 layers.");
  await expect(pill).toContainText("The slicer closed 12.5 mm of those gaps.");
  await expect(pill).toContainText("2 open contour segments were skipped, so that outline is missing.");
  await expect(pill).not.toContainText("Repair");
  await expect(page.locator("#right")).toContainText("Repaired layers 4 Dropped chains 2");

  await page.locator("#dismissMeshWarn").click();
  await expect(page.locator("#meshWarn")).toHaveCount(0);
  await expect(page.locator("#right")).toContainText("Repaired layers 4 Dropped chains 2");

  await page.locator("#slice").click();
  await expect(page.locator("#summaryCard #meshWarn")).toContainText("The mesh has gaps on 1 layer.");
  await expect(page.locator("#meshWarn")).not.toContainText("12.5 mm");
  await expect(page.locator("#meshWarn")).not.toContainText("open contour");
});
