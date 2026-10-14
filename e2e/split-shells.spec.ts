import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { encodeStl } from "../src/mesh-place.ts";
import { autoSliceOff } from "./auto-slice";

const shots = "/opt/cursor/artifacts/split-shells";

function face(a: number[], b: number[], c: number[], d: number[]): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const p = (x: number, y: number, z: number) => [x, y, z];
  return new Float32Array([
    ...face(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)),
    ...face(p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1), p(x1, y0, z1)),
    ...face(p(x0, y0, z0), p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0)),
    ...face(p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...face(p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)),
    ...face(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0)),
  ]);
}

function join(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Two boxes in one STL. The second sits 40 mm over in X and 5 mm off the bed. */
function pairStl(): Buffer {
  const mesh = join([box(0, 0, 0, 10, 10, 10), box(40, 0, 5, 50, 10, 15)]);
  return Buffer.from(encodeStl(mesh, "pair.stl"));
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name) });
}

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
}

async function openPrepare(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
}

test("one solid keeps Separate disabled, with the reason on the row", async ({ page }) => {
  await quiet(page);
  await openPrepare(page);
  await page.locator("#file").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  const row = page.locator(".separate-row");
  await expect(row).toHaveAttribute("data-tip", "This object is one connected solid.");
  await expect(page.locator("#separateShells")).toBeDisabled();
  await expect(page.locator("#separateShells")).toHaveText("Separate into plate objects");
  await page.locator("#separateShells").scrollIntoViewIfNeeded();
  await shot(page, "one-solid.png");
});

test("Separate keeps each shell where it already sits, and undo puts them back", async ({ page }) => {
  await quiet(page);
  await openPrepare(page);
  await page.locator("#file").setInputFiles({
    name: "pair.stl",
    mimeType: "model/stl",
    buffer: pairStl(),
  });
  await expect(page.locator("#separateShells")).toBeEnabled();
  await expect(page.locator("#separateShells")).toHaveText("Separate into 2 objects");
  await expect(page.locator(".separate-row")).toHaveAttribute(
    "data-tip",
    "Make 2 objects from the separate shells. They stay where they are. Cut faces are not laid on the bed.",
  );
  await page.locator("#separateShells").scrollIntoViewIfNeeded();
  await shot(page, "before.png");

  await page.locator("#separateShells").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("[data-plate-id='part']")).toContainText("pair 1");
  await expect(page.locator("[data-plate-id]").nth(1)).toContainText("pair 2");
  await expect(page.locator(".toast")).toHaveCount(0);

  const firstX = Number(await page.locator("#placeX").inputValue());
  await page.locator("[data-plate-id]").nth(1).locator("[data-plate-select]").click();
  await expect(page.locator("#placeXY")).toHaveAttribute("data-bed-z", "5.0");
  const secondX = Number(await page.locator("#placeX").inputValue());
  expect(Math.abs(secondX - firstX - 40)).toBeLessThan(0.2);
  await expect(page.locator("#separateShells")).toBeDisabled();
  await page.locator("#separateShells").scrollIntoViewIfNeeded();
  await shot(page, "after.png");

  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("[data-selected='true']")).toContainText("pair 1");
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  await expect(page.locator("#separateShells")).toHaveText("Separate into 2 objects");
});
