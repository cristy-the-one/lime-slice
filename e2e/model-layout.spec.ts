import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 × 10 mm box, as the modeler reports a solid. */
function boxSolid() {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 10];
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
  return { volumeMm3: 4000, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

const STEP = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

async function openModel(page: Page, size: { width: number; height: number }) {
  const solid = boxSolid();
  await page.setViewportSize(size);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => solid, probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: STEP });
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

const railFits = (page: Page) => page.locator("#toolRail").evaluate((rail) => rail.scrollHeight <= rail.clientHeight + 1);
const folded = (page: Page) => page.locator(".rail-group[data-folded]").evaluateAll((groups) => groups.map((group) => (group as HTMLElement).dataset.group));

test("the rail keeps every Model tool at 1440 × 900, and a short window folds the least used group into a flyout", async ({ page }) => {
  await openModel(page, { width: 1440, height: 900 });
  expect(await railFits(page), "every tool fits").toBe(true);
  expect(await folded(page)).toEqual([]);
  for (const id of ["#modelToolNew", "#modelToolPull", "#modelToolBoolean", "#modelToolPattern", "#modelToolHole", "#modelToolCheck", "#modelLookOpen", "#modelToolWorkplane", "#modelUndo", "#modelStep"]) {
    await expect(page.locator(id), id).toBeVisible();
  }
  // C21: Push/Pull leads Shape, named in its label and tip.
  await expect(page.locator("#modelToolPull")).toHaveAccessibleName("Push/Pull");
  for (const heading of ["Create", "Shape", "Features", "Inspect", "Frame", "Edit"]) {
    await expect(page.locator("#railModel .rail-caption, #railModelFoot .rail-caption").filter({ hasText: new RegExp(`^${heading}$`) })).toBeVisible();
  }
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
  for (const heading of ["Create", "Shape", "Features", "Inspect", "Frame", "Edit"]) {
    await expect(page.locator("#railModel .rail-caption, #railModelFoot .rail-caption").filter({ hasText: new RegExp(`^${heading}$`) })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const pull = page.locator("#modelToolPull");
  await pull.evaluate((button: HTMLElement) => button.focus({ focusVisible: true }));
  await expect(page.locator(".lime-tip")).toContainText("P");
  const unnamed = await page.locator("#railModel button, #railModelFoot button").evaluateAll((nodes) =>
    nodes
      .filter((node) => (node as HTMLElement).checkVisibility())
      .filter((node) => !((node as HTMLElement).getAttribute("aria-label") || node.textContent?.trim()))
      .map((node) => (node as HTMLElement).id),
  );
  expect(unnamed).toEqual([]);

  await page.setViewportSize({ width: 1366, height: 768 });
  await expect.poll(() => folded(page)).toEqual(["frame"]);
  expect(await railFits(page), "the rest fits").toBe(true);
  const fold = page.locator('.rail-group[data-group="frame"] .rail-fold');
  await expect(page.locator("#modelToolPlace")).toBeHidden();
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#modelToolPlace")).toBeVisible();
  const row = (await page.locator("#modelToolPlace").boundingBox())!;
  const rail = (await page.locator("#toolRail").boundingBox())!;
  expect(row.x, "the group opens beside the rail").toBeGreaterThanOrEqual(rail.x + rail.width);
  await page.locator("#modelToolPlace").click();
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "place");
  await expect(fold, "a tool picked from the group closes it").toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  await fold.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelToolPlace")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(fold, "Esc gives the focus back to the group's button").toBeFocused();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => folded(page), "room again unfolds it").toEqual([]);
});

test("a disabled tool is dashed, not striped, and still says why", async ({ page }) => {
  await openModel(page, { width: 1440, height: 900 });
  const undo = page.locator("#modelUndo");
  await expect(undo).toBeDisabled();
  const image = await undo.evaluate((button) => getComputedStyle(button).backgroundImage);
  expect(image).toBe("none");
  const style = await undo.evaluate((button) => getComputedStyle(button).borderStyle);
  expect(style).toBe("dashed");
  await undo.hover();
  await expect(page.locator(".lime-tip")).toContainText("Undo");
  if (process.env.LIME_SHOTS) await page.locator("#toolRail").screenshot({ path: `${process.env.LIME_SHOTS}/ux02-after-disabled.png` });
});

test("a tool opens a closed Model panel for itself and closes it again, and leaves an open one alone", async ({ page }) => {
  await openModel(page, { width: 1440, height: 900 });
  const dock = page.locator("#leftDock");
  await expect(dock).toHaveAttribute("aria-label", "Model");
  await page.keyboard.press("Control+b");
  await expect(dock).toBeHidden();
  const camera = await page.locator("#model").getAttribute("data-camera");
  await page.locator("#modelToolHole").click();
  await expect(page.locator("#leftDock #modelPanel")).toBeVisible();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Hole");
  await expect(page.locator("#model"), "the camera stays where it was").toHaveAttribute("data-camera", camera!);
  await page.locator("#modelCancel").click();
  await expect(dock, "it closes again with the tool").toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-panel-left-collapsed")), "the user's choice stays closed").toBe("1");

  await page.keyboard.press("Control+b");
  await expect(dock).toBeVisible();
  await page.locator("#modelToolHole").click();
  await page.locator("#modelCancel").click();
  await expect(dock, "an open dock stays open").toBeVisible();
});

test("an empty Parameters section starts collapsed, and History sits above it", async ({ page }) => {
  await openModel(page, { width: 1440, height: 900 });
  await expect(page.locator("#modelParamsCount")).toHaveText("· 0");
  await expect(page.locator("#modelParamsMain")).toBeHidden();
  const history = (await page.locator("#modelHistory").boundingBox())!;
  const params = (await page.locator("#modelParams").boundingBox())!;
  expect(params.y).toBeGreaterThanOrEqual(history.y + history.height - 4);
  expect(params.height).toBeLessThan(72);
  if (process.env.LIME_SHOTS) await page.locator("#leftDock").screenshot({ path: `${process.env.LIME_SHOTS}/ux07-after-params.png` });
  await page.locator("#modelParamsToggle").click();
  await expect(page.locator("#modelParamsMain")).toBeVisible();
  await page.locator("#modelParamsToggle").click();
  await expect(page.locator("#modelParamsMain")).toBeHidden();
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
  await expect(page.locator("#modelParams"), "an empty Parameters section stays out of a sketch").toBeHidden();
});

test("Ctrl+Alt+P opens Parameters from anywhere, and folds them from inside", async ({ page }) => {
  await openModel(page, { width: 1440, height: 900 });
  await expect(page.locator("#modelParamsMain")).toBeHidden();
  await page.keyboard.press("Control+b");
  await expect(page.locator("#leftDock")).toBeHidden();
  await page.locator("#model").focus();
  await page.keyboard.press("Control+Alt+p");
  await expect(page.locator("#leftDock")).toBeVisible();
  await expect(page.locator("#modelParamsMain")).toBeVisible();
  await expect(page.locator("#modelParams [data-param-name]").first()).toBeFocused();
  await page.keyboard.press("Control+Alt+p");
  await expect(page.locator("#modelParamsMain")).toBeHidden();
});

test("Inspect lists the plate with the Prepare list's actions, and the size", async ({ page }) => {
  await openModel(page, { width: 1920, height: 1080 });
  await page.locator("#timing").click();
  const inspect = page.locator("#modelInspect");
  await expect(inspect).toBeVisible();
  await expect(page.locator("#rightDock")).toHaveAttribute("aria-label", "Inspect");
  await expect(page.locator("#modelInspectSize")).toContainText("20.0 × 20.0 × 10.0 mm");
  await expect(page.locator("#modelInspectVolume")).toHaveText("4000 mm³");
  await expect(inspect.locator("[data-plate-select]")).toHaveCount(1);
  await expect(inspect.locator("[data-plate-select]")).toHaveAttribute("aria-pressed", "true");
  await inspect.locator("#modelInspectDuplicate").click();
  await expect(inspect.locator("[data-plate-select]")).toHaveCount(2);
  await expect(inspect.locator("[data-plate-remove]")).toHaveCount(2);
  await inspect.locator("[data-plate-remove]").nth(1).click();
  await expect(inspect.locator("[data-plate-select]")).toHaveCount(1);
});

test("in the drawer range, Esc ends an open tool first and closes the drawer only after", async ({ page }) => {
  await openModel(page, { width: 1100, height: 800 });
  const dock = page.locator("#leftDock");
  await expect(dock).toBeHidden();
  await page.locator("#modelToolHole").click();
  await expect(dock, "the tool opens the drawer").toBeVisible();
  await page.locator("#modelHoleD").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelPanel")).toBeHidden();
  await expect(dock, "and the drawer goes with the tool").toBeHidden();
  await page.locator("#leftToggle").click();
  await expect(dock).toBeVisible();
  await page.locator("#modelParamsToggle").focus();
  await page.keyboard.press("Escape");
  await expect(dock, "with nothing open, Esc closes the drawer").toBeHidden();
});
