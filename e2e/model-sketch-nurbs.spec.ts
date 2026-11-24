import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";
import { evalNurbsCurve2D } from "../src/modeling/nurbs-eval.ts";
import { nurbsSegmentCurve } from "../src/sketch/nurbs-seg.ts";

type V = [number, number, number];

/** A 20 × 20 × 10 mm box, as the modeler reports a solid. */
function boxSolid() {
  const [sx, sy, sz] = [20, 20, 10];
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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] as { id: number; lengthMm: number; points: number[] }[] };
}

async function openSketch(page: Page) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await page.locator("#modelToolSketch").click();
  await page.locator("[data-sketch-plane=XY]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch", "editing");
}

test("the spline tool defaults to control-point NURBS and can switch to through-points and a curvature comb", async ({ page }) => {
  await openSketch(page);
  await page.locator("[data-sketch-tool=spline]").click();
  await expect(page.locator("#model")).toHaveAttribute("data-sketch-current-tool", "spline");
  const cv = page.locator("[data-sketch-spline-mode=cv]");
  const through = page.locator("[data-sketch-spline-mode=through]");
  await expect(cv).toHaveAttribute("aria-pressed", "true");
  await expect(through).toHaveAttribute("aria-pressed", "false");
  await through.click();
  await expect(through).toHaveAttribute("aria-pressed", "true");
  await expect(cv).toHaveAttribute("aria-pressed", "false");
  const comb = page.locator("[data-sketch-comb]");
  await expect(comb).toHaveAttribute("aria-pressed", "false");
  await comb.click();
  await expect(comb).toHaveAttribute("aria-pressed", "true");
});

type Screen = { x: number; y: number };
type Frame = { o: Screen; u: Screen; v: Screen };

/** Where the plane's origin and 10 mm along its X and Y are on screen, once the view has settled. */
async function sketchFrame(page: Page): Promise<Frame> {
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

const spot = (frame: Frame, u: number, v: number): Screen => ({
  x: frame.o.x + ((frame.u.x - frame.o.x) / 10) * u + ((frame.v.x - frame.o.x) / 10) * v,
  y: frame.o.y + ((frame.u.y - frame.o.y) / 10) * u + ((frame.v.y - frame.o.y) / 10) * v,
});

test("a closed control-point spline extrudes as the curve the sketch shows, 19.17 mm across a 20 mm square of poles, not 20", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => boxSolid(), probe: () => ({ ok: true }) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptySketch").click();
  const canvas = page.locator("#model");
  await expect(canvas).toHaveAttribute("data-sketch", "editing");
  await page.locator("[data-sketch-tool=spline]").click();
  await expect(page.locator("[data-sketch-spline-mode=cv]")).toHaveAttribute("aria-pressed", "true");
  const frame = await sketchFrame(page);
  // Four corners of a 20 mm square, then the first again: the Spline tool closes the curve.
  for (const [u, v] of [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]] as const) {
    const at = spot(frame, u, v);
    await page.mouse.click(at.x, at.y);
  }
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "spline");
  const extrude = page.locator("button[data-sketch-extrude]");
  await expect(extrude).not.toHaveAttribute("aria-disabled", "true");
  await extrude.click();
  const hud = page.locator(".interact-hud:not([hidden])");
  await hud.locator("input").first().fill("5");
  await hud.locator("input").first().press("Enter");
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  const feature = tree.of("open").at(-1)!.feature as { kind?: string; loops?: { start: [number, number]; segments: { kind: string; poles?: [number, number][]; to: [number, number] }[] }[] };
  expect(feature.kind).toBe("extrude");
  const loop = feature.loops?.[0];
  const segment = loop?.segments[0];
  expect(loop?.segments.length, "one segment: the whole closed curve").toBe(1);
  expect(segment?.kind, "sent as the control-point curve, not a spline through its poles").toBe("nurbs");
  const curve = nurbsSegmentCurve(loop!.start, segment as { poles: [number, number][]; to: [number, number] });
  expect(curve.periodic, "read as one periodic curve, as the kernel reads it").toBe(true);
  const xs = curve.poles.map((p) => p[0]);
  const poleSpan = Math.max(...xs) - Math.min(...xs);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 2000; i += 1) {
    const x = evalNurbsCurve2D(curve, (curve.poles.length * i) / 2000).point[0];
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  console.log(`closed CV square: pole span ${poleSpan.toFixed(3)} mm, solid curve from ${(lo - Math.min(...xs)).toFixed(3)} to ${(hi - Math.min(...xs)).toFixed(3)} mm`);
  expect(Math.abs(poleSpan - 20), "the poles are the clicked 20 mm square").toBeLessThan(0.5);
  // A uniform periodic cubic over a square's corners runs from 1/24 to 23/24 of the side: 0.83 to 19.17 on 20 mm.
  expect(Math.abs((hi - Math.min(...xs)) / poleSpan - 23 / 24)).toBeLessThan(0.002);
  expect(Math.abs((lo - Math.min(...xs)) / poleSpan - 1 / 24)).toBeLessThan(0.002);
});
