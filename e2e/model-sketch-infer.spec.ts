import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type MockSolid } from "./model-tree-mock";

/**
 * --- Sketch for people, milestone 7 (docs/plan-sketch-for-people.md, K1): constraints while drawing. With the Line
 * tool the app shows the rule a click would keep beside the pointer (H, V, square, =), keeps it on the click, and Ctrl
 * skips it. One polyline draws an L (H, then V), a slanted line with Ctrl (nothing), a line square to it, a line the
 * same length as the one before, and a last Ctrl-click that keeps nothing even beside level. Undo takes a line with its
 * rule. The Constrain menu lists what fits the selection. ---
 */

type V = [number, number, number];

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

async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => boxSolid(), apply: (_request, parent) => parent, probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptySketch").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
  await expect(page.locator("#model")).toHaveAttribute("data-sketch-current-tool", "line");
}

type Screen = { x: number; y: number };
type Frame = { o: Screen; u: Screen; v: Screen };

/** Where the plane's origin and 10 mm along U and V fall on screen, once the camera has settled: two reads agree. */
async function settledFrame(page: Page): Promise<Frame> {
  const canvas = page.locator("#model");
  let last = "";
  for (let i = 0; i < 60; i += 1) {
    const now = (await canvas.getAttribute("data-sketch-frame")) ?? "";
    if (now && now === last) {
      const [o, u, v] = now.split(" ").map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return { x: x!, y: y! };
      });
      return { o: o!, u: u!, v: v! };
    }
    last = now;
    await page.waitForTimeout(80);
  }
  throw new Error(`the plane frame did not settle: ${last}`);
}

/** The client point for (u, v) millimetres on the plane, nudged by whole pixels. */
function spot(frame: Frame, u: number, v: number, dx = 0, dy = 0): Screen {
  return {
    x: frame.o.x + ((frame.u.x - frame.o.x) / 10) * u + ((frame.v.x - frame.o.x) / 10) * v + dx,
    y: frame.o.y + ((frame.u.y - frame.o.y) / 10) * u + ((frame.v.y - frame.o.y) / 10) * v + dy,
  };
}

/** A click with Ctrl held, as a person makes it. */
async function ctrlClick(page: Page, at: Screen) {
  await page.keyboard.down("Control");
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Control");
}

const shots = process.env.LIME_SHOTS;

test("a line draws with H, V, square and equal inferred; Ctrl keeps none; one undo takes a line and its rule", async ({ page }) => {
  await start(page);
  const canvas = page.locator("#model");
  const frame = await settledFrame(page);
  const marks = page.locator(".sketch-infer-mark");
  const keeps = page.locator("#modelReadout");

  // Nothing is inferred before there is a line to measure from.
  const home = spot(frame, 0, 0);
  await page.mouse.move(home.x, home.y);
  await expect(canvas).toHaveAttribute("data-sketch-infer", "");
  const p0 = spot(frame, 0, 0);
  await page.mouse.click(p0.x, p0.y);

  // H: a little off level is placed level, shown as H, and kept.
  const p1 = spot(frame, 20, 0, 0, 3);
  await page.mouse.move(p1.x, p1.y);
  await expect(canvas).toHaveAttribute("data-sketch-infer", "horizontal");
  await expect(marks).toHaveText(["H"]);
  await expect(keeps).toContainText("Click keeps it horizontal. Ctrl skips.");
  if (shots) await page.screenshot({ path: `${shots}/1-horizontal.png` });
  await page.mouse.click(p1.x, p1.y);
  await expect(canvas).toHaveAttribute("data-sketch-constraints", "1");
  await expect(page.locator(".sketch-glyph").first(), "and the kept rule shows as a mark on the line").toHaveText("H");

  // Ctrl held, without a mouse move, takes the mark away; letting go brings it back.
  const p2 = spot(frame, 20, 15, 3, 0);
  await page.mouse.move(p2.x, p2.y);
  await expect(canvas).toHaveAttribute("data-sketch-infer", "vertical");
  await expect(marks).toHaveText(["V"]);
  if (shots) await page.screenshot({ path: `${shots}/2-vertical.png` });
  await page.keyboard.down("Control");
  await expect(canvas, "Ctrl clears the inference at once").toHaveAttribute("data-sketch-infer", "");
  await expect(marks).toHaveCount(0);
  await page.keyboard.up("Control");
  await expect(canvas).toHaveAttribute("data-sketch-infer", "vertical");
  await page.mouse.click(p2.x, p2.y);
  await expect(canvas).toHaveAttribute("data-sketch-constraints", "2");
  await expect(canvas, "square to the line before is not stored on top of level and upright").toHaveAttribute("data-sketch-entities", "2");

  // A slanted line with Ctrl: the click keeps nothing and the point is where it was clicked.
  const p3 = spot(frame, 30, 20);
  await page.mouse.move(p3.x, p3.y);
  await ctrlClick(page, p3);
  await expect(canvas).toHaveAttribute("data-sketch-entities", "3");
  await expect(canvas, "a Ctrl-click keeps nothing").toHaveAttribute("data-sketch-constraints", "2");

  // Square to the line before: perpendicular to (10, 5) from (30, 20) is along (-5, 10).
  const p4 = spot(frame, 22, 36, 0, 0);
  await page.mouse.move(p4.x + 2, p4.y + 2);
  await expect(canvas).toHaveAttribute("data-sketch-infer", "perpendicular");
  await expect(marks).toHaveText(["⊥"]);
  await expect(keeps).toContainText("square to the last line");
  if (shots) await page.screenshot({ path: `${shots}/3-square.png` });
  await page.mouse.click(p4.x + 2, p4.y + 2);
  await expect(canvas).toHaveAttribute("data-sketch-constraints", "3");

  // Equal: a diagonal as long as the line before (17.9 mm) is held to that length.
  const side = Math.hypot(8, 16);
  const p5 = spot(frame, 22 - side * Math.SQRT1_2, 36 - side * Math.SQRT1_2, 3, 0);
  await page.mouse.move(p5.x, p5.y);
  await expect(canvas).toHaveAttribute("data-sketch-infer", "equal");
  await expect(marks).toHaveText(["="]);
  await expect(keeps).toContainText("equal to the last line");
  if (shots) await page.screenshot({ path: `${shots}/4-equal.png` });
  await page.mouse.click(p5.x, p5.y);
  await expect(canvas).toHaveAttribute("data-sketch-constraints", "4");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "5");

  // A last Ctrl-click beside level keeps nothing, and its point is not pulled level.
  const p6 = spot(frame, 0, 23.35, 0, 3);
  await page.mouse.move(p6.x, p6.y, { steps: 4 });
  await page.keyboard.down("Control");
  await expect(canvas).toHaveAttribute("data-sketch-infer", "");
  await page.mouse.click(p6.x, p6.y);
  await page.keyboard.up("Control");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "6");
  await expect(canvas, "a Ctrl-click beside level keeps nothing").toHaveAttribute("data-sketch-constraints", "4");
  await page.keyboard.press("Escape");
  if (shots) await page.screenshot({ path: `${shots}/5-drawn.png` });

  // Undo: the Ctrl line alone, then the equal line together with its rule.
  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "5");
  await expect(canvas).toHaveAttribute("data-sketch-constraints", "4");
  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-sketch-entities", "4");
  await expect(canvas, "the line and its rule leave in one step").toHaveAttribute("data-sketch-constraints", "3");
});

test("the Constrain menu lists the rules that fit the selection, and every rule when nothing is selected", async ({ page }) => {
  await start(page);
  const canvas = page.locator("#model");
  const frame = await settledFrame(page);
  const a = spot(frame, 0, 0);
  const b = spot(frame, 30, 10);
  // A slanted line, drawn with Ctrl so it holds no rule, and a circle beside it.
  await page.mouse.click(a.x, a.y);
  await ctrlClick(page, b);
  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  const centre = spot(frame, 45, 30);
  await page.mouse.click(centre.x, centre.y);
  const rim = spot(frame, 52, 30);
  await page.mouse.click(rim.x, rim.y);
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,circle");

  const items = page.locator("[data-sketch-constrain]");
  await page.locator("[data-sketch-menu=constrain]").click();
  await expect(items, "nothing selected lists every rule").toHaveCount(16);
  await expect(page.locator("[data-sketch-menu-fit]")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Pick the line: level, upright, length and the rules that wait for a second line; no radius.
  await page.locator("[data-sketch-tool=select]").click();
  const mid = spot(frame, 15, 5);
  await page.mouse.click(mid.x, mid.y);
  await page.locator("[data-sketch-menu=constrain]").click();
  await expect(page.locator("[data-sketch-constrain=horizontal]")).toBeVisible();
  await expect(page.locator("[data-sketch-constrain=length]")).toBeVisible();
  await expect(page.locator("[data-sketch-constrain=equal]")).toBeVisible();
  await expect(page.locator("[data-sketch-constrain=radius]")).toHaveCount(0);
  await expect(page.locator("[data-sketch-constrain=concentric]")).toHaveCount(0);
  await expect(page.locator("[data-sketch-menu-fit]")).toContainText("fit the selection");
  if (shots) await page.screenshot({ path: `${shots}/6-menu-line.png` });
  await page.keyboard.press("Escape");

  // Pick the circle instead: radius and diameter, no level.
  const onRim = spot(frame, 52, 30);
  await page.mouse.click(onRim.x, onRim.y);
  await page.locator("[data-sketch-menu=constrain]").click();
  await expect(page.locator("[data-sketch-constrain=radius]")).toBeVisible();
  await expect(page.locator("[data-sketch-constrain=diameter]")).toBeVisible();
  await expect(page.locator("[data-sketch-constrain=horizontal]")).toHaveCount(0);
  await expect(page.locator("[data-sketch-constrain=length]")).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/7-menu-circle.png` });
  await page.keyboard.press("Escape");

  // Click empty space: every rule again.
  const empty = spot(frame, -30, 40);
  await page.mouse.click(empty.x, empty.y);
  await page.locator("[data-sketch-menu=constrain]").click();
  await expect(items).toHaveCount(16);
});
