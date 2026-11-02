import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";
import type { LoftSection } from "../src/model-tree.ts";

/**
 * --- S1 and S2 (docs/plan-sketch-for-people.md). A shape and a route drawn in one sketch sweep with W then Enter, and
 * a route alone sweeps as a pipe. ---
 */

type V = [number, number, number];

function slab(): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 4];
  const quads: V[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of tri) positions.push(...q[i]!);
      triangles.push(face);
    }
  });
  return { volumeMm3: 1600, positions, triangles, faces: [{ id: 0, areaMm2: 400 }, { id: 1, areaMm2: 400 }], edges: [] };
}

async function start(page: Page): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: slab().positions, seatMm: 0 } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => slab(),
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

/** A route of two lines from `at`: 30 mm along X, then 20 mm turning 20°, gentle enough to sweep. */
async function drawRoute(page: Page, at: { x: number; y: number }) {
  const canvas = page.locator("#model");
  await page.locator("[data-sketch-tool=line]").click();
  await expect(canvas).toHaveAttribute("data-sketch-current-tool", "line");
  await page.mouse.click(at.x, at.y);
  await page.mouse.move(at.x + 30, at.y);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  for (const [length, angle] of [["30", "0"], ["20", "20"]]) {
    await hud.locator("input").nth(0).fill(length!);
    await hud.locator("input").nth(0).press("Tab");
    await hud.locator("input").nth(1).fill(angle!);
    await hud.locator("input").nth(1).press("Enter");
  }
  await page.keyboard.press("Escape");
}

test("a circle and a route in one sketch sweep with W then Enter, the circle stood up at the route's start", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  const box = (await canvas.boundingBox())!;
  await page.locator("[data-sketch-tool=circle]").click();
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.5);
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud).toBeVisible();
  await hud.locator("input").nth(0).fill("6");
  await hud.locator("input").nth(0).press("Enter");
  await drawRoute(page, { x: box.x + box.width * 0.42, y: box.y + box.height * 0.5 });
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "circle,line,line");

  await page.keyboard.press("W");
  await expect(canvas).toHaveAttribute("data-sweep", "pick");
  await expect(canvas, "the shape is stood up at the start").toHaveAttribute("data-sweep-made", "up");
  await expect(canvas).toHaveAttribute("data-sweep-profile", "1");
  await expect(canvas).toHaveAttribute("data-sweep-path", "1");
  const stance = page.locator("button[data-sketch-stance]");
  await expect(stance).toHaveText("Profile: stood up at the start");
  await expect(page.locator("button[data-sketch-apply]")).toHaveAttribute("aria-disabled", "false");
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/s1-stood-up.png` });

  // As drawn brings back the strict path's refusal, in its words; stood up again clears it.
  await stance.click();
  await expect(canvas).toHaveAttribute("data-sweep-made", "drawn");
  await expect(page.locator("button[data-sketch-stance]")).toHaveText("Profile: as drawn");
  await expect(page.locator("#modelReadout")).toContainText("on the same plane");
  await page.locator("button[data-sketch-stance]").click();
  await expect(canvas).toHaveAttribute("data-sweep-made", "up");

  await page.keyboard.press("Enter");
  await expect(page.locator("#objectList .obj").first()).toContainText("Sweep 1");
  const feature = tree.of("open").at(-1)!.feature as { kind?: string; sections?: LoftSection[] };
  expect(feature.kind).toBe("loft");
  const first = feature.sections?.[0];
  expect((feature.sections?.length ?? 0) >= 3, "a section at each route point").toBe(true);
  expect(first?.turn.some((angle) => Math.abs(angle) > 1), "the first section stands up, off the bed's plane").toBe(true);
  expect(first?.loops?.length, "the circle, with no hole").toBe(1);

  // History Edit reopens it as a two-sketch sweep: the stood-up circle and the route.
  await page.locator("#modelHistoryTree .mh-edit").click();
  await expect(canvas).toHaveAttribute("data-sweep", "pick");
  await expect(canvas).toHaveAttribute("data-sweep-profile", "1");
  await expect(canvas).toHaveAttribute("data-sweep-path", "1");
});

test("a route alone sweeps as a pipe: type the diameter, and a wall makes it a tube", async ({ page }) => {
  const tree = await start(page);
  const canvas = page.locator("#model");
  const box = (await canvas.boundingBox())!;
  await drawRoute(page, { x: box.x + box.width * 0.4, y: box.y + box.height * 0.5 });
  await expect(canvas).toHaveAttribute("data-sketch-kinds", "line,line");

  await page.keyboard.press("W");
  await expect(canvas, "a route with no shape opens as a pipe").toHaveAttribute("data-sweep-made", "pipe");
  await expect(page.locator(".sketch-feature-name")).toHaveText("Pipe");
  const hud = page.locator(".interact-hud:not([hidden])");
  await expect(hud.locator("input").nth(0)).toHaveAttribute("aria-label", "Diameter");
  await expect(hud.locator("input").nth(1)).toHaveAttribute("aria-label", "Wall");
  await hud.locator("input").nth(0).fill("8");
  await hud.locator("input").nth(0).press("Tab");
  await hud.locator("input").nth(1).fill("1");
  if (process.env.LIME_SHOTS) await page.screenshot({ path: `${process.env.LIME_SHOTS}/s2-pipe.png` });
  await hud.locator("input").nth(1).press("Enter");

  await expect(page.locator("#objectList .obj").first()).toContainText("Sweep 1");
  const feature = tree.of("open").at(-1)!.feature as { kind?: string; sections?: LoftSection[] };
  expect(feature.kind).toBe("loft");
  expect(feature.sections?.every((section) => section.loops?.length === 2), "a tube: the outside and the bore on every section").toBe(true);
  const start0 = feature.sections?.[0]?.loops?.[0];
  const reach = start0 ? Math.max(...[start0.start, ...start0.segments.map((segment) => segment.to)].map((point) => Math.hypot(point[0], point[1]))) : 0;
  expect(reach, "the outside is the typed 8 mm diameter").toBeCloseTo(4, 3);
});
