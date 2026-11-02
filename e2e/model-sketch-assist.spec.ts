import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";
import { sectionArea } from "../src/sketch/loft.ts";
import type { LoftSection } from "../src/model-tree.ts";

/**
 * --- Sketch for people, milestone 3 (docs/plan-sketch-for-people.md): E1 Close the gap, and L1 Add a shape above. ---
 */

type V = [number, number, number];

/** A box the modeler can pick. */
function boxSolid(size: V = [20, 20, 10]): MockSolid {
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
  const faces = quads.map((_, id) => ({ id, areaMm2: id < 2 ? sx * sy : id < 4 ? sx * sz : sy * sz }));
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges: [] };
}

async function start(page: Page): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => boxSolid(),
    apply: (_request: Body, parent: MockSolid) => parent,
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptySketch").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
  return tree;
}

/** Lines from the canvas centre, each typed as length and angle in the size box. */
async function drawLines(page: Page, legs: [string, string][]) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=line]").click();
  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.6 };
  await page.mouse.click(start.x, start.y);
  await page.mouse.move(start.x + 30, start.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  for (const [length, angle] of legs) {
    await hud.locator("input").nth(0).fill(length);
    await hud.locator("input").nth(0).press("Tab");
    await hud.locator("input").nth(1).fill(angle);
    await hud.locator("input").nth(1).press("Enter");
  }
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", legs.map(() => "line").join(","));
}

/** A rectangle from the canvas centre; `centred` holds Ctrl on the first click, so the centre is the middle. */
async function drawTypedRectangle(page: Page, width: string, height: string, centred = false) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=rectangle]").click();
  const box = (await canvas.boundingBox())!;
  if (centred) await page.keyboard.down("Control");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  if (centred) await page.keyboard.up("Control");
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill(width);
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill(height);
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
}

async function drawTypedCircle(page: Page, diameter: string) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=circle]").click();
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "circle");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill(diameter);
  await hud.locator("input").nth(0).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", /(^|,)circle$/);
}

const shots = process.env.LIME_SHOTS;

test("Close the gap joins the red ends of a near-closed L in one undo step, and it extrudes", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  // An L whose last line stops 0.6 mm short of where it started.
  await drawLines(page, [["20", "0"], ["8", "90"], ["12", "180"], ["12", "90"], ["8", "180"], ["19.4", "270"]]);
  const extrude = page.locator("button[data-sketch-extrude]");
  const close = page.locator("button[data-sketch-close-gap]");
  await expect(extrude).toHaveAttribute("aria-disabled", "true");
  await expect(extrude).toHaveAttribute("data-reason", /Click Close the gap, or drag one end onto the other\.$/);
  await expect(close).toBeVisible();
  await expect(close).toHaveAttribute("data-tip", /^Join the red open ends/);
  await close.hover();
  await expect(canvas, "the two open ends are marked").toHaveAttribute("data-sketch-marks", "2");
  await expect(canvas).toHaveAttribute("data-sketch-marks-kind", "open");
  const overflow = await page.locator("#sketchCards button").evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => (node as HTMLElement).innerText));
  expect(overflow, "no card button is cut off").toEqual([]);
  if (shots) await page.screenshot({ path: `${shots}/e1-before.png` });

  await close.click();
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line,line,line,line,line");
  await expect(extrude).not.toHaveAttribute("aria-disabled", "true");
  await expect(close).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-sketch-marks", "0");
  await expect(page.locator("#modelReadout")).toContainText("A line now joins the ends.");
  if (shots) await page.screenshot({ path: `${shots}/e1-after.png` });

  // One undo step takes the line back, and Close the gap with it.
  await page.mouse.move(10, 10);
  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line,line,line,line");
  await expect(close).toBeVisible();
  await close.click();
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line,line,line,line,line,line");

  await extrude.click();
  await expect(canvas).toHaveAttribute("data-extrude", /aim|drag/);
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("5");
  await hud.locator("input").first().press("Enter");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  const feature = tree.of("open").at(-1)!.feature as { kind?: string; loops?: { segments: unknown[] }[]; depth?: number };
  expect(feature.kind).toBe("extrude");
  expect(feature.depth).toBe(5);
  expect(feature.loops?.[0]?.segments.length, "a closed L: six sides, the closing line runs on along the last one").toBe(6);
});

test("Add a shape above: square to round without setting up a plane, with the height dragged", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await drawTypedRectangle(page, "10", "10", true);
  await page.keyboard.press("Shift+L");
  await expect(canvas).toHaveAttribute("data-loft", "pick");
  await expect(canvas).toHaveAttribute("data-loft-sections", "1");
  const add = page.locator("button[data-sketch-above]");
  await expect(add).toBeVisible();
  await expect(add).toHaveAttribute("data-tip", /^Start the next section on a plane above/);
  await expect(page.locator(".sketch-prompt-text")).toHaveText("A loft needs a second shape at another height. Click Add a shape above, or another sketch's card.");
  const height = page.locator("[data-sketch-above-height]");
  await expect(height).toHaveValue("20");
  // Drag the word sideways: 4 px a millimetre.
  const label = (await page.locator(".sketch-height .sketch-scrub").boundingBox())!;
  await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
  await page.mouse.down();
  await page.mouse.move(label.x + label.width / 2 + 20, label.y + label.height / 2, { steps: 4 });
  await page.mouse.move(label.x + label.width / 2 + 40, label.y + label.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(height).toHaveValue("30");
  if (shots) await page.screenshot({ path: `${shots}/l1-loft.png` });

  await add.click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-loft", "off");
  await expect(page.locator("[data-sketch-section=above]")).toBeVisible();
  await expect(canvas, "the copy of the square").toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  await expect(page.locator("[data-sketch-open]").filter({ hasText: "Sketch 1" })).toHaveCount(1);
  await expect(page.locator("[data-sketch-above-height]")).toHaveValue("30");
  if (shots) await page.screenshot({ path: `${shots}/l1-copy.png` });

  await drawTypedCircle(page, "6");
  await expect(page.locator("button[data-sketch-above-done]")).not.toHaveAttribute("aria-disabled", "true");
  if (shots) await page.screenshot({ path: `${shots}/l1-circle.png` });
  await page.locator("button[data-sketch-above-done]").click();
  await expect(canvas).toHaveAttribute("data-loft", "pick");
  await expect(canvas).toHaveAttribute("data-loft-sections", "2");
  await expect(canvas, "the first sketch is open again").toHaveAttribute("data-sketch-kinds", "line,line,line,line");
  if (shots) await page.screenshot({ path: `${shots}/l1-back.png` });
  await page.locator("button[data-sketch-apply]").click();

  await expect(page.locator("#objectList .obj").filter({ hasText: "Loft 1" })).toHaveCount(1);
  await expect(page.locator("#modelHistoryTree")).toContainText("Loft Sketch 1 → Sketch 2");
  const sections = (tree.of("open").at(-1)!.feature as { sections?: LoftSection[] }).sections ?? [];
  expect(sections).toHaveLength(2);
  expect(sectionArea(sections[0]!)).toBeCloseTo(100, 1);
  expect(sectionArea(sections[1]!), "the circle, not the copy, is the top").toBeCloseTo(Math.PI * 9, 1);
  expect(sections.map((section) => section.origin[2])).toEqual([0, 30]);
});

test("Cancel on the shape above drops it and goes back to the loft with its one section", async ({ page }) => {
  await start(page);
  const canvas = page.locator("#model");
  await drawTypedRectangle(page, "10", "10");
  await page.keyboard.press("Shift+L");
  const height = page.locator("[data-sketch-above-height]");
  await height.fill("15");
  await height.press("Enter");
  await page.locator("button[data-sketch-above]").click();
  await expect(page.locator("[data-sketch-section=above]")).toBeVisible();
  // The height moves the open sketch, and the field keeps it.
  const field = page.locator("[data-sketch-section=above] [data-sketch-above-height]");
  await expect(field).toHaveValue("15");
  await field.fill("25");
  await field.press("Enter");
  await expect(page.locator("#modelReadout")).toContainText("25 mm above it");
  await page.locator("button[data-sketch-above-cancel]").click();
  await expect(canvas).toHaveAttribute("data-loft", "pick");
  await expect(canvas).toHaveAttribute("data-loft-sections", "1");
  await expect(page.locator("[data-sketch-open]")).toHaveCount(0);
  await expect(page.locator("button[data-sketch-above]")).toBeVisible();

  // Finish on the shape above does what Back to loft does: the copy, as it came, is the second section.
  await page.locator("button[data-sketch-above]").click();
  await expect(page.locator("[data-sketch-section=above]")).toBeVisible();
  await expect(page.locator("button[data-sketch-finish]")).not.toHaveClass(/primary/);
  await page.locator("button[data-sketch-finish]").click();
  await expect(canvas).toHaveAttribute("data-loft", "pick");
  await expect(canvas).toHaveAttribute("data-loft-sections", "2");
});
