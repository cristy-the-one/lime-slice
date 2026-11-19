import { expect, test } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/** A 20 mm cube as a binary STL with its first triangle left out: one three-edge hole in the floor. */
function holedCube(): Buffer {
  const c = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const tris = quads.flatMap(([a, b, d, e]) => [[c[a!]!, c[b!]!, c[d!]!], [c[a!]!, c[d!]!, c[e!]!]]).slice(1);
  const out = Buffer.alloc(84 + tris.length * 50);
  out.writeUInt32LE(tris.length, 80);
  tris.forEach((tri, t) => tri.forEach((p, v) => p.forEach((x, k) => out.writeFloatLE(x, 84 + t * 50 + 12 + v * 12 + k * 4))));
  return out;
}

/**
 * A mesh with a hole in it shows "Close holes" with its open edges counted. One click fills the hole as one undo step:
 * the object stays where it is, and the row goes because nothing is open any more.
 */
test("Close holes fills a mesh's hole in one undo step", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "holed.stl", mimeType: "model/stl", buffer: holedCube() });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  const row = page.locator("#closeHoles");
  await expect(row).toHaveText("Close holes · 3 open edges");
  const where = await page.locator("#placeX").inputValue();
  await row.click();
  await expect(page.getByText("Closed 1 hole in holed.stl with 1 triangle.")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  expect(await page.locator("#placeX").inputValue()).toBe(where);
  await page.keyboard.press("Control+z");
  await expect(row).toHaveText("Close holes · 3 open edges");
});
