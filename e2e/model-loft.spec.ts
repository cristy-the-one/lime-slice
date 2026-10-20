import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";
import { loftAreaVolume, sectionArea } from "../src/sketch/loft.ts";
import type { LoftSection } from "../src/model-tree.ts";

type V = [number, number, number];

/** A box the modeler can pick. Face 0 is −Z, face 1 is +Z. */
function boxSolid(min: V = [0, 0, 0], size: V = [20, 20, 20]): MockSolid {
  const [ox, oy, oz] = min;
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): V => [ox + x * sx, oy + y * sy, oz + z * sz];
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
  const faces = quads.map((_, id) => ({ id, areaMm2: (id < 2 ? sx * sy : id < 4 ? sx * sz : sy * sz) }));
  return { volumeMm3: sx * sy * sz, positions, triangles, faces, edges };
}

function formatMm(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

async function start(page: Page): Promise<TreeMock> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => {
      const feature = request.feature as { kind?: string; sections?: LoftSection[]; depth?: number } | undefined;
      if (feature?.kind === "loft" && feature.sections) {
        return { ...boxSolid([0, 0, 0], [20, 20, 20]), volumeMm3: loftAreaVolume(feature.sections) };
      }
      const height = feature?.depth && feature.depth > 0 ? feature.depth : 10;
      return boxSolid([0, 0, 0], [20, 20, height]);
    },
    apply: (_request: Body, parent: MockSolid) => parent,
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmptySketch")).toBeVisible();
  return tree;
}

async function drawTypedRectangle(page: Page, width: string, height: string) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=rectangle]").click();
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "rectangle");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill(width);
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill(height);
  await hud.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
}

async function drawTypedCircle(page: Page, diameter: string) {
  await page.locator("[data-sketch-tool=circle]").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "circle");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill(diameter);
  await hud.locator("input").nth(0).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", /(^|,)circle$/);
}

/** A sketch on the XZ plane with one line straight up from the canvas centre, `length` long: a path across the bed. */
async function drawUprightPath(page: Page, length: string) {
  const canvas = page.locator("#model");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XZ]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "XZ");
  await page.locator("[data-sketch-tool=line]").click();
  const box = (await canvas.boundingBox())!;
  const start = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.55 };
  await page.mouse.click(start.x, start.y);
  await page.mouse.move(start.x, start.y - 30);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill(length);
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("90");
  await hud.locator("input").nth(1).press("Enter");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line");
}

test("a rectangle on the bed lofts to a circle 30 mm above, and History Edit reopens the picks", async ({ page }) => {
  const tree = await start(page);
  const tools = page.locator("#toolRail");
  const canvas = page.locator("#model");
  expect(await tools.evaluate((bar) => bar.scrollHeight <= bar.clientHeight + 1), "the toolbar fits at 1440").toBe(true);
  await expect(page.locator("#modelToolLoft")).toHaveCount(0);
  await expect(page.locator("#modelToolSweep")).toHaveCount(0);

  await page.locator("#modelEmptySketch").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await drawTypedRectangle(page, "10", "10");
  await page.keyboard.press("E");
  await expect(canvas).toHaveAttribute("data-extrude", "aim");
  const extrude = page.locator(".interact-hud:not([hidden])");
  await extrude.locator("input").first().fill("10");
  await extrude.locator("input").first().press("Enter");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(page.locator("[data-sketch-open]")).toHaveText("Sketch 1");

  await page.locator("#modelToolWorkplane").click();
  const z = page.locator("#modelWpZ");
  await expect(z).toBeVisible();
  await z.fill("30");
  await z.dispatchEvent("input");
  await expect(z).toHaveValue("30");

  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=workplane]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sketch-plane", "workplane");
  await expect(canvas).toHaveAttribute("data-sketch-camera", "locked");
  await drawTypedCircle(page, "10");
  await page.keyboard.press("Shift+L");
  await expect(canvas).toHaveAttribute("data-loft", "pick");
  await expect(canvas).toHaveAttribute("data-loft-sections", "1");
  await page.locator("[data-sketch-open]").click();
  await expect(canvas).toHaveAttribute("data-loft-sections", "2");
  // In Look around a click still picks a section: the circle under it is dropped, then taken again.
  await page.locator("button[data-sketch-look]").click();
  await expect(canvas).toHaveAttribute("data-sketch-look", "1");
  const view = (await canvas.boundingBox())!;
  await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
  await expect(canvas).toHaveAttribute("data-loft-sections", "1");
  await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
  await expect(canvas).toHaveAttribute("data-loft-sections", "2");
  await page.locator("button[data-sketch-look]").click();
  await expect(canvas).toHaveAttribute("data-sketch-look", "0");
  await page.locator("[data-sketch-ruled]").click();
  await expect(canvas).toHaveAttribute("data-loft-ruled", "1");
  await page.keyboard.press("R");
  await expect(canvas).toHaveAttribute("data-loft-ruled", "0");
  await page.keyboard.press("M");
  await expect(canvas).toHaveAttribute("data-loft-mode", "new");
  expect(await tools.evaluate((bar) => bar.scrollHeight <= bar.clientHeight + 1), "loft adds no toolbar button").toBe(true);
  await page.keyboard.press("Enter");

  await expect(page.locator("#objectList .obj").filter({ hasText: "Loft 1" })).toHaveCount(1);
  await expect(page.locator("#modelHistoryTree")).toContainText("Loft through 2 sections");
  const opened = tree.of("open");
  const feature = opened.at(-1)!.feature as {
    kind?: string;
    op?: string;
    sections?: LoftSection[];
    ruled?: boolean;
    drawing?: unknown;
    sketch?: unknown;
  };
  expect(feature.kind).toBe("loft");
  expect(feature.op).toBe("fuse");
  expect(feature.ruled).toBeUndefined();
  expect(feature.drawing, "the engine open does not carry the drawing").toBeUndefined();
  expect(feature.sketch).toBeUndefined();
  const sections = feature.sections ?? [];
  expect(sections).toHaveLength(2);
  const areas = sections.map((section) => sectionArea(section)).sort((a, b) => a - b);
  expect(areas[0]!).toBeCloseTo(Math.PI * 25, 1);
  expect(areas[1]!).toBeCloseTo(100, 1);
  const gap = Math.hypot(
    sections[1]!.origin[0] - sections[0]!.origin[0],
    sections[1]!.origin[1] - sections[0]!.origin[1],
    sections[1]!.origin[2] - sections[0]!.origin[2],
  );
  expect(gap).toBeCloseTo(30, 0);
  const volume = loftAreaVolume(sections);
  const low = Math.min(...areas) * gap;
  const high = Math.max(...areas) * gap;
  expect(volume).toBeGreaterThan(low);
  expect(volume).toBeLessThan(high);
  await expect(page.locator("#modelReadout")).toContainText(`Volume ${formatMm(volume)} mm³`);

  await page.locator("#modelHistoryTree .mh-edit").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-loft", "pick");
  await expect(canvas).toHaveAttribute("data-loft-sections", "2");
  await expect(canvas).toHaveAttribute("data-loft-mode", "new");
});

test("a square sweeps along a path across it, the end scale is dragged and typed, and History Edit reopens it", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await page.locator("#modelEmptySketch").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await drawTypedRectangle(page, "4", "4");
  await page.locator("[data-sketch-finish]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");

  await drawUprightPath(page, "30");
  await page.keyboard.press("W");
  await expect(canvas).toHaveAttribute("data-sweep", "pick");
  await expect(canvas).toHaveAttribute("data-sweep-profile", "1");
  await expect(canvas).toHaveAttribute("data-sweep-path", "1");
  await expect(canvas).toHaveAttribute("data-sweep-scale", "1");
  await expect(canvas).toHaveAttribute("data-sweep-mode", "new");

  const box = (await canvas.boundingBox())!;
  const at = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.7 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y - 80);
  await expect.poll(async () => Number((await canvas.getAttribute("data-sweep-scale")) ?? "NaN")).toBeGreaterThan(1);
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-sweep", "pick");

  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud.locator("input").first(), "the scale is the size at the path's end").toHaveAttribute("aria-label", "End scale");
  await hud.locator("input").first().fill("1");
  await hud.locator("input").first().press("Enter");

  await expect(page.locator("#objectList .obj").first()).toContainText("Sweep 1");
  await expect(page.locator("#modelHistoryTree")).toContainText(/Sweep along \d+ points/);
  const feature = tree.of("open").at(-1)!.feature as {
    kind?: string;
    sections?: unknown[];
    drawing?: unknown;
    sketch?: unknown;
  };
  expect(feature.kind).toBe("loft");
  expect((feature.sections?.length ?? 0) >= 2).toBe(true);
  expect(feature.drawing, "the engine open does not carry the drawing").toBeUndefined();
  expect(feature.sketch).toBeUndefined();

  await page.locator("#modelHistoryTree .mh-edit").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await expect(canvas).toHaveAttribute("data-sweep", "pick");
  await expect(canvas).toHaveAttribute("data-sweep-profile", "1");
  await expect(canvas).toHaveAttribute("data-sweep-path", "1");
  await expect(canvas).toHaveAttribute("data-sweep-scale", "1");
});

test("a washer sweeps where it was drawn with its hole, and a loft takes a two-region sketch's ring from its card", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await page.locator("#modelEmptySketch").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await drawTypedCircle(page, "12");
  await drawTypedCircle(page, "4");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle,circle");
  await page.locator("[data-sketch-finish]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");

  await drawUprightPath(page, "20");
  await page.keyboard.press("W");
  await expect(canvas).toHaveAttribute("data-sweep", "pick");
  await expect(canvas, "the washer's ring is the profile, though its sketch has two regions").toHaveAttribute("data-sweep-profile", "1");
  await expect(canvas).toHaveAttribute("data-sweep-path", "1");
  await page.keyboard.press("Enter");
  await expect(page.locator("#objectList .obj").first()).toContainText("Sweep 1");
  const feature = tree.of("open").at(-1)!.feature as { sections?: LoftSection[] };
  const sections = feature.sections ?? [];
  expect(sections.length).toBeGreaterThanOrEqual(2);
  expect(sections.every((section) => section.loops?.length === 2), "every section keeps the hole").toBe(true);
  expect(sections[0]!.origin, "the first section is the drawing on the bed, not recentred onto the path").toEqual([0, 0, 0]);
  expect(sections[0]!.turn).toEqual([0, 0, 0]);
  const top = sections.at(-1)!;
  expect(top.origin[2]).toBeCloseTo(20, 1);
  expect(sectionArea(top)).toBeCloseTo(Math.PI * (36 - 4), 0);

  // A loft takes the same two-region sketch from its card: the ring, not "no region".
  await page.locator("#modelToolWorkplane").click();
  const z = page.locator("#modelWpZ");
  await z.fill("30");
  await z.dispatchEvent("input");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=workplane]").click();
  await expect(canvas).toHaveAttribute("data-sketch-plane", "workplane");
  await drawTypedCircle(page, "10");
  await page.keyboard.press("Shift+L");
  await expect(canvas).toHaveAttribute("data-loft-sections", "1");
  await page.locator("[data-sketch-open]").filter({ hasText: "Sketch 1" }).click();
  await expect(canvas).toHaveAttribute("data-loft-sections", "2");
});

test("on an empty plate a loft starts from the bed and an origin plane offset 30 above it", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  await page.locator("#modelEmptySketch").click();
  await drawTypedRectangle(page, "10", "10");
  await page.locator("[data-sketch-finish]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");
  await page.locator("#modelToolSketch").click();
  await expect(canvas).toHaveAttribute("data-sketch", "choosing");
  const offset = page.locator("[data-sketch-offset]");
  await offset.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("30");
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await drawTypedCircle(page, "6");
  await page.keyboard.press("Shift+L");
  await page.locator("[data-sketch-open]").filter({ hasText: "Sketch 1" }).click();
  await expect(canvas).toHaveAttribute("data-loft-sections", "2");
  await page.keyboard.press("Enter");
  await expect(page.locator("#objectList .obj").filter({ hasText: "Loft 1" })).toHaveCount(1);
  const sections = ((tree.of("open").at(-1)!.feature as { sections?: LoftSection[] }).sections ?? []).map((section) => section.origin[2]).sort((a, b) => a - b);
  expect(sections, "the circle is 30 above the bed").toEqual([0, 30]);
});

test("an L path is refused instead of sweeping a sharp corner", async ({ page }) => {
  await start(page);
  const canvas = page.locator("#model");
  await page.locator("#modelEmptySketch").click();
  await drawTypedRectangle(page, "4", "4");
  await page.locator("[data-sketch-finish]").click();
  await expect(canvas).toHaveAttribute("data-sketch", "pinned");

  await page.locator("#modelEmptySketch").click();
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "line");
  const bed = (await canvas.boundingBox())!;
  const corner = { x: bed.x + bed.width * 0.45, y: bed.y + bed.height * 0.5 };
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 30, corner.y);
  const line = page.locator(".interact-hud:not([hidden])");
  await expect(line).toBeVisible();
  await line.locator("input").nth(0).fill("30");
  await line.locator("input").nth(0).press("Tab");
  await line.locator("input").nth(1).fill("0");
  await line.locator("input").nth(1).press("Enter");
  await line.locator("input").nth(0).fill("30");
  await line.locator("input").nth(0).press("Tab");
  await line.locator("input").nth(1).fill("90");
  await line.locator("input").nth(1).press("Enter");
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line");
  await page.keyboard.press("Escape");
  await page.keyboard.press("W");
  await expect(page.locator("#modelReadout")).toContainText("This path has a sharp corner. Fillet the corner, or draw a smooth arc. A sweep that follows the corner is not available yet.");
  await expect(page.locator("#objectList .obj")).toHaveCount(0);
});
