import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { autoSliceOff } from "./auto-slice";
import path from "node:path";

type V = [number, number, number];

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

/** A box of the given size, as the modeler reports a solid. */
function boxSolid(sx: number, sy = 20, sz = 10) {
  const c = (x: number, y: number, z: number): V => [x * sx, y * sy, z * sz];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { id: 1, volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

/** Each Apply grows the box by 10 mm; Undo returns the starting box. Every slice request is counted. */
async function mockEngine(page: Page) {
  const slices: unknown[] = [];
  let applied = 0;
  const first = boxSolid(20);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: first.positions } }));
  await page.route("**/api/model/probe", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/model", (route) => route.fulfill({ json: first }));
  await page.route("**/api/model/boolean", (route) => route.fulfill({ json: boxSolid(20 + 10 * ++applied) }));
  await page.route("**/api/model/undo", (route) => route.fulfill({ json: first }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => {
    slices.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  return slices;
}

async function sliceNow(page: Page, slices: unknown[], total: number) {
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(total);
}

/** Opens a STEP file with one slice on screen: by itself when auto-slice is on, by the button otherwise. */
async function openModel(page: Page, slices: unknown[], autoOn: boolean) {
  await page.goto("/");
  if (!autoOn) await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  if (autoOn) await expect.poll(() => slices.length).toBe(1);
  else await sliceNow(page, slices, 1);
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

async function applyThreeAndUndo(page: Page) {
  await page.locator("#modelToolBoolean").click();
  for (const volume of [6000, 8000, 10000]) {
    await expect(page.locator("#modelApply")).toBeEnabled();
    await page.locator("#modelApply").click();
    await expect(page.locator("#modelReadout")).toContainText(`Volume ${volume} mm³`);
  }
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelReadout")).toContainText("Edit undone");
}

/** Longer than the 300 ms auto-slice pause and the 200 ms quiet refresh together. */
const settle = (page: Page) => page.waitForTimeout(900);

const chip = (page: Page) => page.locator("#modelPaused");

test.describe("auto-slice on", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("edits in Model send no slice, and leaving sends exactly one", async ({ page }) => {
    const slices = await mockEngine(page);
    await openModel(page, slices, true);
    await expect(chip(page)).toBeVisible();
    await expect(chip(page)).toHaveText("Slicing paused while modeling");
    if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/chip-light.png` });

    await applyThreeAndUndo(page);
    await settle(page);
    expect(slices).toHaveLength(1);

    await page.locator("#tabPrepare").click();
    await expect.poll(() => slices.length).toBe(2);
    await settle(page);
    expect(slices).toHaveLength(2);
    await expect(chip(page)).toBeHidden();
  });

  test("switching tabs without a Model change slices nothing", async ({ page }) => {
    const slices = await mockEngine(page);
    await openModel(page, slices, true);
    await expect(chip(page)).toBeVisible();
    for (const tab of ["#tabPrepare", "#tabModel", "#tabPreview", "#tabModel", "#tabGcode"]) {
      await page.locator(tab).click();
      if (tab === "#tabModel") await expect(chip(page)).toBeVisible();
      else await expect(chip(page)).toBeHidden();
    }
    await settle(page);
    expect(slices).toHaveLength(1);
  });

  test("a Prepare change still waiting out its pause when Model opens slices on leaving", async ({ page }) => {
    const slices = await mockEngine(page);
    await openModel(page, slices, true);
    await page.locator("#tabPrepare").click();
    await page.evaluate(() => {
      const x = document.querySelector<HTMLInputElement>("#placeX")!;
      x.value = String(Number(x.value) + 10);
      x.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector<HTMLButtonElement>("#tabModel")!.click();
    });
    await expect(chip(page)).toBeVisible();
    await settle(page);
    expect(slices).toHaveLength(1);
    await page.locator("#tabPrepare").click();
    await expect.poll(() => slices.length).toBe(2);
  });

  test("Slice in Model sends one request and leaving afterwards sends none", async ({ page }) => {
    const slices = await mockEngine(page);
    await openModel(page, slices, true);
    await applyThreeAndUndo(page);
    await sliceNow(page, slices, 2);
    await settle(page);
    await page.locator("#tabPreview").click();
    await settle(page);
    expect(slices).toHaveLength(2);
  });
});

test.describe("auto-slice off", () => {
  test("edits in Model send no slice, and leaving shows the out-of-date chip", async ({ page }) => {
    const slices = await mockEngine(page);
    await openModel(page, slices, false);
    await applyThreeAndUndo(page);
    await settle(page);
    expect(slices).toHaveLength(1);
    await page.locator("#tabPreview").click();
    await expect(page.locator("#staleChip")).toBeVisible();
    await settle(page);
    expect(slices).toHaveLength(1);
  });

  test("a refresh from the cache waits for leaving Model", async ({ page }) => {
    const slices = await mockEngine(page);
    await openModel(page, slices, false);
    await page.locator("#modelToolBoolean").click();
    await expect(page.locator("#modelApply")).toBeEnabled();
    await page.locator("#modelApply").click();
    await expect(page.locator("#modelReadout")).toContainText("Volume 6000 mm³");
    await sliceNow(page, slices, 2);
    await page.locator("#modelUndo").click();
    await expect(page.locator("#modelReadout")).toContainText("Edit undone");
    await settle(page);
    expect(slices).toHaveLength(2);
    await page.locator("#tabPreview").click();
    await expect.poll(() => slices.length).toBe(3);
    await settle(page);
    expect(slices).toHaveLength(3);
  });

  test("Slice in Model sends one request", async ({ page }) => {
    const slices = await mockEngine(page);
    await openModel(page, slices, false);
    await applyThreeAndUndo(page);
    await sliceNow(page, slices, 2);
    await settle(page);
    expect(slices).toHaveLength(2);
  });
});
