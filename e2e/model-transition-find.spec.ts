import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

/**
 * --- Print transitions, step 5 (docs/plan-belt-transitions.md, section 5, auto-find): the card's "Find edges that start
 * in the air" list on a synthetic part built here, never a company file. The part is a U on its side: a base with a full
 * post at its back and a shorter post at its front. Printed upside down on a flat bed, the base hangs between the posts
 * (two concave corners) and the short post's end hangs above the bed (two lips). The mocked kernel answers the finder as
 * `tree/transition_find.rs` would for that pose, each corner's fix building and each lip's refusing, as step 4 refuses a gusset with nothing to land on.
 */

type V = [number, number, number];
const out = process.env.LIME_SHOTS_DIR ?? path.join("test-results", "transition-find");

/** The side view in Y and Z, extruded 20 mm along X. */
const PROFILE: [number, number][] = [[0, 0], [40, 0], [40, 30], [30, 30], [30, 10], [10, 10], [10, 20], [0, 20]];
const WIDTH = 20;
/** Edge ids: the profile's corners along X, from the concave (30, 10) on. */
const ORDER = [4, 5, 6, 7, 0, 1, 2, 3];
const BACK = 0;
const FRONT = 1;
const LIPS = [2, 3];
/** The face under each edge's corner: the base's top, and the post's wall beside it. */
const BASE_TOP = 4;
const WALL: Record<number, number> = { [BACK]: 3, [FRONT]: 5 };
const NORMALS: V[] = [[0, 0, -1], [0, 1, 0], [0, 0, 1], [0, -1, 0], [0, 0, 1], [0, 1, 0], [0, 0, 1], [0, -1, 0]];
const BASE_VOLUME = 40 * 10 * WIDTH + 10 * 20 * WIDTH + 10 * 10 * WIDTH;
const LIP_SENTENCE = "There is nothing of the part under this lip within 20 mm along the build, so a gusset would itself start in the air. Supports or a split are the way here, or a larger maxMm.";

function quad(positions: number[], triangles: number[], face: number, corners: V[], normal: V) {
  const [a, b, c] = corners;
  const u = [b![0] - a![0], b![1] - a![1], b![2] - a![2]];
  const v = [c![0] - a![0], c![1] - a![1], c![2] - a![2]];
  const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const ordered = n[0]! * normal[0] + n[1]! * normal[1] + n[2]! * normal[2] >= 0 ? corners : [...corners].reverse();
  for (const tri of [[0, 1, 2], [0, 2, 3]]) {
    for (const i of tri) positions.push(...ordered[i]!);
    triangles.push(face);
  }
}

/** The U as the modeler reports it, with each flat face's outward normal. */
function uPart(volumeMm3 = BASE_VOLUME): MockSolid {
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (x: number, [y, z]: [number, number]): V => [x, y, z];
  const p = (i: number) => PROFILE[i]!;
  const n = PROFILE.length;
  for (let i = 0; i < n; i += 1) quad(positions, triangles, i, [at(0, p(i)), at(WIDTH, p(i)), at(WIDTH, p((i + 1) % n)), at(0, p((i + 1) % n))], NORMALS[i]!);
  for (const [face, x, sign] of [[n, 0, -1], [n + 1, WIDTH, 1]] as const) {
    quad(positions, triangles, face, [[x, 0, 0], [x, 40, 0], [x, 40, 10], [x, 0, 10]], [sign, 0, 0]);
    quad(positions, triangles, face, [[x, 30, 10], [x, 40, 10], [x, 40, 30], [x, 30, 30]], [sign, 0, 0]);
    quad(positions, triangles, face, [[x, 0, 10], [x, 10, 10], [x, 10, 20], [x, 0, 20]], [sign, 0, 0]);
  }
  const faces = [...NORMALS, [-1, 0, 0] as V, [1, 0, 0] as V].map((normal, id) => ({ id, areaMm2: 0, normal }));
  const edges = [
    ...ORDER.map((i) => [...at(0, p(i)), ...at(WIDTH, p(i))]),
    ...[0, WIDTH].flatMap((x) => PROFILE.map((_, i) => [...at(x, p(i)), ...at(x, p((i + 1) % n))])),
  ].map((points, id) => ({ id, lengthMm: Math.hypot(points[3]! - points[0]!, points[4]! - points[1]!, points[5]! - points[2]!), points }));
  return { volumeMm3, positions, triangles, faces: faces as MockSolid["faces"], edges };
}

const PART = uPart();
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
const round = (value: number) => Math.round(value * 1000) / 1000;

/** The kernel's wedge row for a corner of the U, for a build straight down the part's Z: the base's top and the wall a right angle apart. */
function wedgeRow(edge: number, angle: number, size: number) {
  const near = NORMALS[WALL[edge]!]!;
  const fromFar = (angle * Math.PI) / 180;
  const normal = [0, near[1] * Math.sin(fromFar), Math.cos(fromFar)].map(round);
  const nearReach = size * Math.tan(fromFar);
  return { edge, case: "corner", path: "chamfer", farFace: BASE_TOP, nearFace: WALL[edge]!, farDeg: 0, nearDeg: 90, normal, angleToLayersDeg: angle, reachMm: size, nearReachMm: round(nearReach), farEndMm: 10, volumeMm3: round(0.5 * size * nearReach * WIDTH) };
}

function wedge(op: Body): Body {
  const edges = (op.edges as unknown[]).map((edge) => (typeof edge === "number" ? edge : Number((edge as { index: number }).index)));
  if (edges.some((edge) => LIPS.includes(edge))) return { ok: false, error: LIP_SENTENCE };
  return { ok: true, transition: edges.map((edge) => wedgeRow(edge, Number(op.angleDeg), Number(op.size))) };
}

async function openPart(page: Page): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: PART.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  // Which corners each solid has fixed, by its volume: a wedge adds its own.
  const fixedAt = new Map<number, number[]>([[BASE_VOLUME, []]]);
  const tree = await mockModelTree(page, {
    open: () => PART,
    apply(request, parent) {
      const op = request.op as Body;
      if (op.kind !== "transition") return parent;
      const answer = wedge(op);
      if (answer.ok !== true) return { error: String(answer.error) };
      const added = (answer.transition as Body[]).reduce((sum, row) => sum + Number(row.volumeMm3), 0);
      const volume = round(parent.volumeMm3 + added);
      fixedAt.set(volume, [...(fixedAt.get(parent.volumeMm3) ?? []), ...(answer.transition as Body[]).map((row) => Number(row.edge))]);
      return uPart(volume);
    },
    probe: (request) => ((request.op as Body).kind === "transition" ? wedge(request.op as Body) : { ok: true }),
    transitionFind(request, on, node) {
      const build = request.build as number[];
      // Upright, the base's top looks up and the short post stands on the bed: nothing starts in the air.
      if (build[2]! > 0) return { id: node, rows: [], curvedSkipped: 0 };
      const fix = request.fix as Body;
      const fixed = fixedAt.get(on.volumeMm3) ?? [];
      const mid = (edge: number): V => [WIDTH / 2, PROFILE[ORDER[edge]!]![0], PROFILE[ORDER[edge]!]![1]];
      const corners = [BACK, FRONT].filter((edge) => !fixed.includes(edge)).map((edge) => ({
        edge, case: "corner", lengthMm: WIDTH, mid: mid(edge), farFace: BASE_TOP, nearFace: WALL[edge], farDeg: 0, nearDeg: 90,
        probe: wedge({ ...fix, edges: [edge] }),
      }));
      const lips = LIPS.map((edge) => ({ edge, case: "lip", lengthMm: WIDTH, mid: mid(edge), farFace: 6, nearFace: edge === 2 ? 5 : 7, farDeg: 0, nearDeg: 90, probe: { ok: false, error: LIP_SENTENCE } }));
      return { id: node, rows: [...corners, ...lips], curvedSkipped: 0 };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "u-part.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelTransition");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");
const current = (page: Page) => page.locator('#modelHistoryTree .mh-row[data-state="current"] .mh-label');
const rows = (page: Page) => page.locator("#modelTransList .tc-found-row");
const status = (page: Page) => page.locator("#modelTransFindStatus");

async function openCard(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuTransition").click();
  await expect(card(page)).toBeVisible();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name) });
}

test("Find edges that start in the air lists corners and lips, lights a row's edge, and fixes one or all as undoable steps", async ({ page }) => {
  test.setTimeout(180_000);
  const tree = await openPart(page);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(`Volume ${BASE_VOLUME} mm³`);

  // Upright, nothing hangs: the list says so plainly.
  await openCard(page);
  await expect(page.locator("#modelTransFind")).toHaveText("Find edges that start in the air");
  await page.locator("#modelTransFind").click();
  await expect(status(page)).toHaveText("No straight edge starts in the air in this pose.");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator("#modelTransFixAll")).toBeHidden();
  await expect(page.locator("#modelTransFind")).toHaveText("Find again");
  await page.keyboard.press("Escape");
  await expect(card(page)).toBeHidden();

  // Printed upside down: the base hangs between the posts, and the short post's end hangs over the bed.
  await page.locator("#tabPrepare").click();
  await page.locator("#rotX").click();
  await page.locator("#rotX").click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(`Volume ${BASE_VOLUME} mm³`);
  await openCard(page);
  await page.locator("#modelTransFind").click();
  await expect(status(page)).toHaveText("4 edges start in the air: 2 corners and 2 lips, longest first. 2 fixes build; 2 refuse, each saying why.");
  const asked = tree.of("transitionFind").at(-1)!;
  expect((asked.build as number[])[2]).toBeCloseTo(-1, 9);
  expect((asked.up as number[])[2]).toBeCloseTo(-1, 9);
  expect(asked.limitDeg).toBe(45);
  expect(asked.fix).toEqual({ mode: "auto", angleDeg: 45, size: 2 });
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0).locator(".tc-case")).toHaveText("Corner");
  await expect(rows(page).nth(0).locator(".tc-length")).toHaveText("20 mm");
  await expect(rows(page).nth(0).locator(".tc-fix-text")).toHaveText("Wedge, 2 mm at 45°, +40 mm³");
  await expect(rows(page).nth(2).locator(".tc-case")).toHaveText("Lip");
  await expect(rows(page).nth(2).locator(".tc-refused")).toHaveText(LIP_SENTENCE);
  await expect(rows(page).nth(2).locator(".tc-fix")).toBeDisabled();
  await expect(rows(page).nth(0).locator(".tc-fix")).toBeEnabled();
  await expect(page.locator("#modelTransFixAll")).toHaveText("Fix all (2)");
  await expect(page.locator("#model")).toHaveAttribute("data-flagged", "0,1,2,3");

  // Hovering a row lights its edge and shows its wedge; leaving the list puts both away.
  await rows(page).nth(1).hover();
  await expect(page.locator("#model")).toHaveAttribute("data-lit-edge", String(FRONT));
  await expect(rows(page).nth(1)).toHaveClass(/is-lit/);
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", /.+/);
  const ghost = (await page.locator("#model").getAttribute("data-ghost"))!.split(" ").map(Number);
  expect(ghost.slice(3), "the hovered corner's 20 × 2 × 2 mm wedge").toEqual([20, 2, 2]);
  await shot(page, "find-list.png");
  await rows(page).nth(2).hover();
  await expect(page.locator("#model")).toHaveAttribute("data-lit-edge", String(LIPS[0]));
  await expect(page.locator("#model")).not.toHaveAttribute("data-ghost", /.+/);
  await page.locator("#modelTransAngle").hover();
  await expect(page.locator("#model")).not.toHaveAttribute("data-lit-edge", /.*/);

  // A row's own button picks its edge into the card, which checks it as a click on the edge would.
  await rows(page).nth(0).locator(".tc-found-pick").click();
  await expect(page.locator("#modelTransEdges")).toHaveText("1 edge. Shift-click adds edges.");
  await expect(page.locator("#modelTransVolume")).toHaveText("+40 mm³ added");

  // Fix: one row, one history step. The card opens again on the new solid and lists what is left.
  const finds = tree.of("transitionFind").length;
  await rows(page).nth(1).locator(".tc-fix").click();
  await expect(labels(page).last()).toHaveText("Print transition (1 edge), 45°, 2 mm");
  const applied = tree.of("apply").at(-1)!.op as Body;
  expect(applied.kind).toBe("transition");
  expect(applied.edges).toEqual([FRONT]);
  expect((applied.build as number[])[2]).toBeCloseTo(-1, 9);
  expect(applied.size).toBe(2);
  await expect(readout(page)).toContainText(`Volume ${BASE_VOLUME + 40} mm³`);
  await expect.poll(() => tree.of("transitionFind").length).toBe(finds + 1);
  await expect(card(page)).toBeVisible();
  await expect(status(page)).toHaveText("3 edges start in the air: 1 corner and 2 lips, longest first. 1 fix builds; 2 refuse, each saying why.");
  await expect(page.locator("#modelTransFixAll")).toHaveText("Fix all (1)");
  await shot(page, "find-after-fix.png");

  // Undo takes the step back; the card closes with it, and Find lists both corners again.
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`Volume ${BASE_VOLUME} mm³`);
  await expect(current(page)).not.toHaveText(/Print transition/);
  if (!(await card(page).isVisible())) await openCard(page);
  await page.locator("#modelTransFind").click();
  await expect(rows(page)).toHaveCount(4);

  // Fix all: every fix that builds, as one step that names both corners.
  await page.locator("#modelTransFixAll").click();
  await expect(labels(page).last()).toHaveText("Print transition (2 edges), 45°, 2 mm");
  expect((tree.of("apply").at(-1)!.op as Body).edges).toEqual([BACK, FRONT]);
  await expect(readout(page)).toContainText(`Volume ${BASE_VOLUME + 80} mm³`);
  await expect(card(page)).toBeVisible();
  await expect(status(page)).toHaveText("2 edges start in the air: 2 lips, longest first. No fix builds as it is: each says why.");
  await expect(page.locator("#modelTransFixAll")).toBeDisabled();
  await shot(page, "find-after-fix-all.png");

  // The one step edits per edge in the card, and Undo takes both wedges back at once.
  await page.keyboard.press("Escape");
  await page.locator("#modelHistoryTree .mh-row").last().hover();
  await page.locator("#modelHistoryTree .mh-row").last().locator(".mh-edit").click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator("#modelTransEdges")).toHaveText("2 edges. Shift-click adds or removes one.");
  await expect(page.locator(".tc-find")).toBeHidden();
  await page.keyboard.press("Escape");
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText(`Volume ${BASE_VOLUME} mm³`);
  await expect(current(page)).not.toHaveText(/Print transition/);
});
