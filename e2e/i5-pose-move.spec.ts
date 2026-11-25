import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { linkInPose } from "./link-in-pose";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

/**
 * I5 (docs/plan-interaction-model.md D4, D5). Pose's Move (M) is the design-space move: a free part and an assembly
 * member, snapping, one undo each. Shift+P does nothing in Model. Prepare has no assembly view chip.
 */

const shots = path.join("docs/screenshots/i5-pose-move");

type V = [number, number, number];

function boxSolid(size: V, at: V = [0, 0, 0]): MockSolid {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [at[0] + x * sx, at[1] + y * sy, at[2] + z * sz];
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

const SOLIDS: Record<string, MockSolid> = {
  "big.step": boxSolid([40, 30, 20], [60, 0, 0]),
  "small.step": boxSolid([20, 20, 10]),
};

const canvas = (page: Page) => page.locator("#pose");
const field = async (page: Page, id: string) => Number(await page.locator(id).inputValue());

async function boot(page: Page) {
  const named = (route: { request(): { postDataJSON(): { filename?: string } } }) => SOLIDS[route.request().postDataJSON().filename ?? ""]!;
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: named(route).positions } }));
  await mockModelTree(page, { open: (request) => SOLIDS[String(request.filename)]! });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
}

async function addStep(page: Page, name: string) {
  const step = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  const before = await page.locator("#objectList .obj").count();
  const input = before === 0 ? "#file" : "#plateAddFile";
  await page.locator(input).setInputFiles({ name, mimeType: "model/step", buffer: step });
  await expect(page.locator("#objectList .obj")).toHaveCount(before + 1);
}

async function armMove(page: Page) {
  if ((await page.locator("#tabPose").getAttribute("aria-pressed")) !== "true") await page.locator("#tabPose").click();
  await expect(canvas(page)).toBeVisible();
  if ((await page.locator('#toolRail [data-pose-tool="move"]').getAttribute("aria-pressed")) !== "true") await page.keyboard.press("M");
  await expect(page.locator("#poseMoveX")).toBeVisible();
}

/** The top view, pulled back until the parts are on screen. */
async function topView(page: Page) {
  const box = (await canvas(page).boundingBox())!;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("t");
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 400);
  let last = "";
  await expect.poll(async () => {
    const now = (await canvas(page).getAttribute("data-screen")) ?? "";
    const same = now !== "" && now === last;
    last = now;
    return same;
  }).toBe(true);
}

async function screenBox(page: Page, id: string) {
  const box = (await canvas(page).boundingBox())!;
  const raw = (await canvas(page).getAttribute("data-screen")) ?? "";
  const found = raw.split(" ").find((item) => item.startsWith(`${id}:`));
  const [x, y, w, h] = (found ?? ":0,0,0,0").split(":")[1]!.split(",").map(Number);
  return { cx: box.x + x! + w! / 2, cy: box.y + y! + h! / 2, w: w! };
}

test("M in Pose moves a free part, and one undo puts it back", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await boot(page);
  await addStep(page, "small.step");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  const id = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await armMove(page);
  await expect(page.locator('#toolRail [data-pose-tool="move"]')).toHaveAttribute("aria-pressed", "true");
  expect(await field(page, "#poseMoveX")).toBe(0);
  await page.locator("#poseMoveX").fill("15");
  await page.locator("#poseMoveX").press("Tab");
  await expect.poll(() => field(page, "#poseMoveX")).toBe(15);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#placeX"), "the print layout stays").not.toHaveValue("15");
  await page.locator("#tabPose").click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "pose-move-free.png") });
  await page.keyboard.press("Control+z");
  await expect.poll(() => field(page, "#poseMoveX")).toBe(0);
  await page.keyboard.press("Control+y");
  await expect.poll(() => field(page, "#poseMoveX")).toBe(15);
  expect(id).toBeTruthy();
});

test("M in Pose moves an assembly member, snaps it to the other part, and one undo takes the snap back", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await boot(page);
  await addStep(page, "big.step");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await addStep(page, "small.step");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const ids = await page.locator("#objectList [data-plate-select]").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.plateSelect!));
  const big = ids[0]!;
  const small = ids[1]!;
  await page.locator(`[data-plate-select='${big}']`).click();
  await linkInPose(page, small, big);
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  await page.locator(`#posePanel [data-object='${small}']`).click();
  await armMove(page);
  await topView(page);
  const solid = await screenBox(page, small);
  await page.mouse.move(solid.cx, solid.cy);
  await page.mouse.down();
  let x = solid.cx;
  let snapped = false;
  for (let i = 0; i < 180 && !snapped; i += 1) {
    x += 3;
    await page.mouse.move(x, solid.cy);
    snapped = ((await canvas(page).getAttribute("data-snap")) ?? "").includes("Touching");
  }
  expect(snapped, "the drag reached a snap").toBe(true);
  await expect(canvas(page)).toHaveAttribute("data-snap-target", big);
  expect(Math.abs((await field(page, "#poseMoveX")) - 40)).toBeLessThan(0.06);
  await page.screenshot({ path: path.join(shots, "pose-move-snap.png") });
  await page.mouse.up();
  await expect(canvas(page)).toHaveAttribute("data-snap-target", "");
  expect(await field(page, "#poseMoveX")).toBeCloseTo(40, 1);
  await page.keyboard.press("Control+z");
  await expect.poll(() => field(page, "#poseMoveX")).toBeCloseTo(0, 1);
});

test("Shift+P in Model does nothing, and Prepare has no view chip", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await boot(page);
  await addStep(page, "big.step");
  await addStep(page, "small.step");
  const ids = await page.locator("#objectList [data-plate-select]").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.plateSelect!));
  await page.locator(`[data-plate-select='${ids[0]}']`).click();
  await linkInPose(page, ids[1]!, ids[0]!);
  await expect(page.locator("#assemblyViewChip")).toHaveCount(0);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#prepareBody")).toBeVisible();
  await expect(page.locator("[data-assembly-view]")).toHaveCount(0);
  await page.evaluate(() => document.querySelector("#toasts")?.replaceChildren());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "prepare-no-chip.png") });

  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  const solid = (await page.locator("#model").getAttribute("data-solid")) ?? "";
  await expect(page.locator("#modelToolPlace")).toHaveCount(0);
  await page.keyboard.press("Shift+P");
  await expect(page.locator("#model")).toHaveAttribute("data-solid", solid);
  await expect(page.locator("#tabModel")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "model-no-place.png") });
});

test("Move is disabled off Pose with its reason", async ({ page }) => {
  await boot(page);
  await addStep(page, "small.step");
  await page.keyboard.press("Control+k");
  await page.locator("#paletteInput").fill("Move");
  const row = page.locator("#paletteList [data-id='pose-move']");
  await expect(row).toHaveAttribute("aria-disabled", "true");
  await expect(row).toHaveAttribute("title", "Move is in Pose.");
  await page.keyboard.press("Escape");
});
