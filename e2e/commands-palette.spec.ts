import { expect, test, type Page } from "@playwright/test";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.goto("/");
  await expect(page.locator("#tabPreview")).toBeVisible();
});

function row(page: Page, id: string) {
  return page.locator(`#paletteList [data-id="${id}"]`);
}

async function openPalette(page: Page, query: string) {
  await page.keyboard.press("Control+K");
  const input = page.locator("#paletteInput");
  await expect(input).toBeVisible();
  await input.fill(query);
}

async function closePalette(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator("#palette")).toBeHidden();
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `test-results/i2-commands/${name}.png` });
}

test("preview palette lists the flyouts, and disables what cannot run", async ({ page }) => {
  await openPalette(page, "Print transition");
  await expect(row(page, "model-transition")).toHaveAttribute("aria-disabled", "true");
  await expect(row(page, "model-transition")).toHaveAttribute("title", "Print transition is in Model.");
  await shot(page, "print-transition-disabled");
  await closePalette(page);

  await openPalette(page, "Add height range");
  await expect(row(page, "add-height-range")).toHaveAttribute("title", "Add a part to the plate first.");
  await closePalette(page);

  await openPalette(page, "Measure between points");
  await expect(row(page, "measure-points")).toHaveAttribute("title", "Measure between points is in Prepare.");
  await closePalette(page);

  await openPalette(page, "Color by");
  await expect(row(page, "preview-color-by")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("#flyColor")).toBeVisible();
  await expect(page.locator("#palette")).toBeHidden();
  await shot(page, "color-by");

  await openPalette(page, "Features shown");
  await expect(row(page, "preview-features")).toHaveAttribute("title", "Slice to choose the features shown.");
  await shot(page, "features-shown-disabled");
  await closePalette(page);

  await openPalette(page, "Bed opacity");
  await expect(row(page, "preview-bed")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("#flyBed")).toBeVisible();
  await shot(page, "bed-opacity");
});

test("Prepare runs measure between points, and bed opacity stays available", async ({ page }) => {
  await page.locator("#tabPrepare").click();
  await openPalette(page, "Measure between points");
  await expect(row(page, "measure-points")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("#measurePoints")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#palette")).toBeHidden();

  await openPalette(page, "Bed opacity");
  await expect(row(page, "preview-bed")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("#flyBed")).toBeVisible();
});

test("a part on the plate gains a height range, a modifier and object settings", async ({ page }) => {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator("#objInfill")).toBeVisible();

  await openPalette(page, "Add height range");
  await expect(row(page, "add-height-range")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-range]")).toHaveCount(1);
  await expect(page.locator("#palette")).toBeHidden();
  await shot(page, "height-range");

  await openPalette(page, "Add box modifier");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-volume]")).toHaveCount(1);
  await shot(page, "box-modifier");

  await openPalette(page, "Object settings");
  await page.keyboard.press("Enter");
  await expect(page.locator("#objInfill")).toBeFocused();
  await shot(page, "object-settings");

  await page.locator("#levelPick").scrollIntoViewIfNeeded();
  await page.locator("#levelPick").selectOption("simple");
  await openPalette(page, "Add height range");
  await expect(row(page, "add-height-range")).toHaveAttribute("title", "Height ranges show at Advanced.");
  await expect(row(page, "add-modifier-box")).toHaveCount(0);
  await page.locator("#paletteInput").fill("Add box modifier");
  await expect(row(page, "add-modifier-box")).toHaveAttribute("title", "Modifiers show at Advanced.");
  await shot(page, "modifiers-simple");
});

test("Pose lists the animation commands disabled until an animation can play", async ({ page }) => {
  await page.locator("#tabPose").click();
  await expect(page.locator("#posePanel")).toContainText("No animation plugins in this project or library.");
  await openPalette(page, "Play");
  await expect(row(page, "pose-animation-play")).toHaveAttribute("title", "No animation plugins in this project or library.");
  await shot(page, "pose-animation");
  await closePalette(page);
  await openPalette(page, "Keep this frame");
  await expect(row(page, "pose-animation-keep")).toHaveAttribute("title", "Play an animation first.");
  await closePalette(page);
  await openPalette(page, "Stop");
  await expect(row(page, "pose-animation-stop")).toHaveAttribute("title", "Play an animation first.");
});

/** A 20 × 20 × 10 box. Enough for the Features menu and Print transition to see a solid. */
function boxSolid(): MockSolid {
  const c = (x: number, y: number, z: number): [number, number, number] => [x * 20, y * 20, z * 10];
  const quads: [number, number, number][][] = [
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
    for (const tri of [[0, 1, 2], [0, 2, 3]] as const) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { volumeMm3: 4000, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 400 })), edges: [] };
}

test("Model runs Print transition, View and Boss from the palette", async ({ page }) => {
  const root = boxSolid();
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await mockModelTree(page, {
    open: () => root,
    apply: (_request: Body, _parent: MockSolid) => root,
    probe: () => ({ ok: true }),
  });
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");

  await openPalette(page, "Print transition");
  await expect(row(page, "model-transition")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelPanelTitle")).toHaveText("Print transition");
  await expect(page.locator("#modelTransition")).toBeVisible();
  await shot(page, "print-transition");

  await openPalette(page, "Boss");
  await expect(row(page, "model-boss")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelToolFeatures")).toHaveText("Boss");
  await expect(page.locator("#modelToolFeatures")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelNote")).toHaveText("Pick one flat face.");
  await shot(page, "boss");

  await openPalette(page, "bed look");
  await expect(row(page, "model-view")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelLookPanel")).toBeVisible();
  await shot(page, "model-view");
});
