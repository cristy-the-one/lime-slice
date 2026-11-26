import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid } from "./model-tree-mock";

/**
 * I4 (docs/plan-interaction-model.md R6). Ctrl+Z undoes the last change in the stage you are in.
 * Model reads the open part, a sketch reads the sketch, and Pose and Prepare read the plate.
 * Ctrl+Shift+Z redoes that same change. Another stage's change stays.
 */

const shots = path.join("docs/screenshots/i4-stage-undo");

type V = [number, number, number];

function boxSolid(size: V): MockSolid {
  const [sx, sy, sz] = size;
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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

const ROOT = boxSolid([20, 20, 10]);

function built(request: Body): Built {
  const op = request.op as { size?: number[] };
  return boxSolid([20, 20, op.size?.[0] ?? 10]);
}

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await mockModelTree(page, { open: () => ROOT, apply: built });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
}

async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** One print-layout move, after its gesture has landed. */
async function prepareMove(page: Page): Promise<string> {
  await page.locator("#tabPrepare").click();
  await page.locator("#placeX").fill("40");
  await page.locator("#placeX").press("Tab");
  await blur(page);
  await page.waitForTimeout(350);
  return page.locator("#placeX").inputValue();
}

async function poseX(page: Page): Promise<number> {
  return Number(await page.locator("#poseMoveX").inputValue());
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("Model: Ctrl+Z undoes the part's last step and leaves the print layout", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await boot(page);
  const laid = await prepareMove(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelDx").fill("5");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 2000 mm³");
  const step = (await page.locator('#modelHistoryTree [data-state="current"] .mh-label').textContent())?.trim() ?? "";
  expect(step.length, "the cut has a history name").toBeGreaterThan(0);

  await blur(page);
  await page.keyboard.press("Control+K");
  await page.locator("#paletteInput").fill("Undo");
  const row = page.locator('#paletteList [data-id="undo"]');
  await expect(row).toContainText(`Undo ${step}`);
  await page.screenshot({ path: path.join(shots, "palette-undo-model.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#palette")).toBeHidden();

  await page.keyboard.press("Control+z");
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#placeX"), "the print layout is not the part's undo").toHaveValue(laid);
  await page.locator("#tabModel").click();
  await blur(page);
  await page.keyboard.press("Control+Shift+Z");
  await expect(page.locator("#modelReadout")).toContainText("Volume 2000 mm³");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#placeX")).toHaveValue(laid);
});

test("Sketch: Ctrl+Z undoes the sketch line and leaves the solid and the print layout", async ({ page }) => {
  await boot(page);
  const laid = await prepareMove(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  const canvas = page.locator("#model");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(start.x, start.y);
  await page.mouse.click(start.x + 140, start.y - 40);
  await expect(canvas).toHaveAttribute("data-sketch-entities", "1");
  await expect(page.locator("#objectList .obj"), "the line is not a solid edit").toContainText("20 × 20 × 10");
  await blur(page);
  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "0");
  await expect(page.locator("#objectList .obj")).toContainText("20 × 20 × 10");
  await expect(page.locator("#placeX"), "the print layout is not the sketch's undo").toHaveValue(laid);
  await page.keyboard.press("Control+Shift+Z");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "1");
  await expect(page.locator("#objectList .obj")).toContainText("20 × 20 × 10");
  await expect(page.locator("#placeX")).toHaveValue(laid);
});

test("Pose: Ctrl+Z undoes the design-space move and leaves the print layout", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await boot(page);
  const laid = await prepareMove(page);
  await page.locator("#tabPose").click();
  await page.keyboard.press("M");
  await expect(page.locator("#poseMoveX")).toBeVisible();
  await page.locator("#poseMoveX").fill("15");
  await page.locator("#poseMoveX").press("Tab");
  await blur(page);
  await page.waitForTimeout(350);
  await expect.poll(() => poseX(page)).toBe(15);

  await page.keyboard.press("Control+K");
  await page.locator("#paletteInput").fill("Undo");
  const row = page.locator('#paletteList [data-id="undo"]');
  await expect(row).toContainText("Undo Move");
  await page.screenshot({ path: path.join(shots, "palette-undo-pose.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#palette")).toBeHidden();

  await blur(page);
  await page.keyboard.press("Control+z");
  await expect.poll(() => poseX(page)).toBe(0);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#placeX"), "the print layout is not Pose's undo").toHaveValue(laid);
  await page.locator("#tabPose").click();
  await blur(page);
  await page.keyboard.press("Control+Shift+Z");
  await expect.poll(() => poseX(page)).toBe(15);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#placeX")).toHaveValue(laid);
});

test("Prepare: Ctrl+Z undoes the print-layout move and leaves the design-space move", async ({ page }) => {
  await boot(page);
  await page.locator("#tabPose").click();
  await page.keyboard.press("M");
  await expect(page.locator("#poseMoveX")).toBeVisible();
  await page.locator("#poseMoveX").fill("15");
  await page.locator("#poseMoveX").press("Tab");
  await blur(page);
  await page.waitForTimeout(350);
  await expect.poll(() => poseX(page)).toBe(15);
  const laid = await prepareMove(page);
  expect(laid).not.toBe("");
  await blur(page);
  await page.keyboard.press("Control+z");
  await expect(page.locator("#placeX")).not.toHaveValue(laid);
  await page.locator("#tabPose").click();
  await expect.poll(() => poseX(page), "the design-space move is not Prepare's undo").toBe(15);
  await page.locator("#tabPrepare").click();
  await blur(page);
  await page.keyboard.press("Control+Shift+Z");
  await expect(page.locator("#placeX")).toHaveValue(laid);
  await page.locator("#tabPose").click();
  await expect.poll(() => poseX(page)).toBe(15);
});
