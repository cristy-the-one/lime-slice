import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

/**
 * --- Print transitions, step 4 (docs/plan-belt-transitions.md, sections 2 and 5): Lip and Cut on the card, on a
 * synthetic shelf built here, never a company file. A wall at Y 0–5 and a shelf on it at Z 20–32 reaching 10 mm out
 * to Y 15, 20 mm along X, on the flat bed: the shelf's underside is level, so its lowest edge, at Y 15 and Z 20, is a lip
 * born in the air. The mocked kernel answers as `tree/transition.rs` would: a gusset at the angle asked from that edge
 * back to the wall, or a ramp cut from the root up to the shelf's front, refused under the 0.8 mm wall floor.
 */

type V = [number, number, number];
const out = process.env.LIME_SHOTS_DIR ?? path.join("test-results", "transition-lip");

/** The side view in Y and Z, extruded 20 mm along X. */
const PROFILE: [number, number][] = [[0, 0], [5, 0], [5, 20], [15, 20], [15, 32], [5, 32], [5, 40], [0, 40]];
const WIDTH = 20;
const DEPTH = 10;
const THICK = 12;
/** Edges along X at each profile corner, in this order: the lip's first edge, the root, then the rest. */
const LIP = 0;
const ROOT = 1;
const UNDER = 2;
const FRONT = 3;
const WALL = 1;

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

/** The wall and shelf as the modeler reports them. */
function shelfPart(volumeMm3 = (5 * 40 + DEPTH * THICK) * WIDTH): MockSolid {
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (x: number, [y, z]: [number, number]): V => [x, y, z];
  const p = (i: number) => PROFILE[i % PROFILE.length]!;
  // Each profile edge's outward normal: bottom, wall below the shelf, the shelf's underside, front, top, wall above, top, back.
  const normals: V[] = [[0, 0, -1], [0, 1, 0], [0, 0, -1], [0, 1, 0], [0, 0, 1], [0, 1, 0], [0, 0, 1], [0, -1, 0]];
  for (let i = 0; i < PROFILE.length; i += 1) quad(positions, triangles, i, [at(0, p(i)), at(WIDTH, p(i)), at(WIDTH, p(i + 1)), at(0, p(i + 1))], normals[i]!);
  for (const [face, x, sign] of [[8, 0, -1], [9, WIDTH, 1]] as const) {
    quad(positions, triangles, face, [[x, 0, 0], [x, 5, 0], [x, 5, 40], [x, 0, 40]], [sign, 0, 0]);
    quad(positions, triangles, face, [[x, 5, 20], [x, 15, 20], [x, 15, 32], [x, 5, 32]], [sign, 0, 0]);
  }
  const faces = [...normals, [-1, 0, 0] as V, [1, 0, 0] as V].map((normal, id) => ({ id, areaMm2: 0, normal }));
  const corners = [3, 2, 0, 1, 4, 5, 6, 7];
  const edges = [
    ...corners.map((i) => [...at(0, p(i)), ...at(WIDTH, p(i))]),
    ...[0, WIDTH].flatMap((x) => PROFILE.map((_, i) => [...at(x, p(i)), ...at(x, p(i + 1))])),
  ].map((points, id) => ({ id, lengthMm: Math.hypot(points[3]! - points[0]!, points[4]! - points[1]!, points[5]! - points[2]!), points }));
  return { volumeMm3, positions, triangles, faces: faces as MockSolid["faces"], edges };
}

const PART = shelfPart();
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
const CORNER_ON_LIP = "This edge is convex. A corner wedge goes in a concave corner, on the inner side of a bend; a convex edge at the bottom of a ledge is a lip, which the Lip case fixes.";

/** A triangle (Y, Z) pushed 20 mm along X, as the kernel's triangles. */
function prism(section: [number, number][]): number[] {
  const out: number[] = [];
  const tri = (...points: V[]) => points.forEach((point) => out.push(...point));
  const a = section.map(([y, z]) => [0, y, z] as V);
  const b = section.map(([y, z]) => [WIDTH, y, z] as V);
  tri(a[0]!, a[2]!, a[1]!);
  tri(b[0]!, b[1]!, b[2]!);
  for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) tri(a[i]!, a[j]!, b[j]!, a[i]!, b[j]!, b[i]!);
  return out;
}

/** What the kernel answers for a transition on the shelf, the build along +Z. */
function answer(op: Body): Body {
  const edges = (op.edges as unknown[]).map((edge) => (typeof edge === "number" ? edge : Number((edge as { index: number }).index)));
  const angle = Number(op.angleDeg);
  const t = Math.tan((angle * Math.PI) / 180);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const normal = [0, round(Math.sin((angle * Math.PI) / 180)), round(-Math.cos((angle * Math.PI) / 180))];
  const rows = [];
  for (const edge of edges) {
    const lip = edge === LIP ? op.case !== "corner" : edge === ROOT && op.case === "lip";
    if (edge === LIP && op.case === "corner") return { ok: false, error: CORNER_ON_LIP };
    if (!lip && edge !== ROOT) return { ok: false, error: "This edge is convex, and a face at it goes on down the build past it, so no lip starts here. A lip's first edge is the lowest point of both its faces; a corner wedge goes in a concave edge." };
    if (!lip) {
      // The root as a corner: a 2 mm wedge between the shelf's underside and the wall.
      if (op.mode === "cut") return { ok: false, error: "Cut is for a lip. This edge is a corner, which takes add: cutting a bend thins the wall on its other side and leaves the rows that hang." };
      const reach = Number(op.size ?? 2);
      rows.push({ edge, case: "corner", path: "chamfer", material: "add", farFace: UNDER, nearFace: WALL, farDeg: 0, nearDeg: 90, normal, angleToLayersDeg: angle, reachMm: reach, nearReachMm: round(reach * t), farEndMm: DEPTH, volumeMm3: round(0.5 * reach * reach * t * WIDTH) });
      continue;
    }
    const common = { edge, case: "lip", firstEdge: LIP, farFace: UNDER, nearFace: FRONT, farDeg: 0, nearDeg: 90, normal, angleToLayersDeg: angle, depthMm: DEPTH, reachMm: DEPTH };
    if (op.mode === "cut") {
      const up = DEPTH * t;
      const left = THICK - up;
      const floor = Number(op.floorMm);
      if (left < floor) return { ok: false, error: `A ramp at ${angle}° from the lip's root would leave ${left.toFixed(2)} mm at this lip's first edge, under the ${floor} mm wall floor (twice the nozzle). A gusset (mode add) keeps the lip whole.` };
      rows.push({ ...common, path: "ramp", material: "cut", nearReachMm: round(up), heightMm: round(up), leftMm: round(left), floorMm: floor, volumeMm3: round(0.5 * DEPTH * up * WIDTH), soup: prism([[15, 20], [5, 20], [15, 20 + up]]) });
      continue;
    }
    const height = DEPTH * t;
    if (height >= 20) return { ok: false, error: "There is nothing of the part under this lip within 20 mm along the build, so a gusset would itself start in the air. Supports or a split are the way here, or a larger maxMm." };
    rows.push({ ...common, path: "gusset", material: "add", nearReachMm: 0, heightMm: round(height), landingMm: round(Math.hypot(DEPTH, height)), volumeMm3: round(0.5 * DEPTH * height * WIDTH), soup: prism([[15, 20], [5, 20], [5, 20 - height]]) });
  }
  return { ok: true, transition: rows };
}

async function openPart(page: Page): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: PART.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => PART,
    apply(request, parent) {
      const op = request.op as Body;
      if (op.kind !== "transition") return parent;
      const made = answer(op);
      if (!made.ok) return { error: String(made.error) };
      const rows = made.transition as Body[];
      // The kernel stores a step of lips as one.
      if (!op.case && rows.every((row) => row.case === "lip")) op.case = "lip";
      const sign = rows.some((row) => row.material === "cut") ? -1 : 1;
      return shelfPart(parent.volumeMm3 + sign * rows.reduce((sum, row) => sum + Number(row.volumeMm3), 0));
    },
    probe: (request) => ((request.op as Body).kind === "transition" ? answer(request.op as Body) : { ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "shelf.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelTransition");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");
const model = (page: Page) => page.locator("#model");

/** Where on the view each of `wanted` edges can be clicked: a scan in Edge mode, read from the readout ("Edge 1" is index 0). */
async function findEdges(page: Page, wanted: number[]): Promise<Map<number, { x: number; y: number }>> {
  const box = (await model(page).boundingBox())!;
  const hits = new Map<number, { x: number; y: number }>();
  for (let row = 0; row < 30 && hits.size < wanted.length; row += 1) {
    for (let col = 0; col < 30 && hits.size < wanted.length; col += 1) {
      const x = box.x + box.width * (0.15 + col * 0.023);
      const y = box.y + box.height * (0.1 + row * 0.027);
      await page.mouse.click(x, y);
      const match = (await readout(page).innerText()).match(/^Edge (\d+) /);
      const edge = match ? Number(match[1]) - 1 : null;
      if (edge != null && wanted.includes(edge) && !hits.has(edge)) hits.set(edge, { x, y });
    }
  }
  return hits;
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name) });
}

test("the Print transition card finds a lip, adds a gusset or cuts a ramp, refuses a thin ramp, and changes the case", async ({ page }) => {
  test.setTimeout(180_000);
  const tree = await openPart(page);
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(`Volume ${(5 * 40 + DEPTH * THICK) * WIDTH} mm³`);

  await page.locator("#modelPickEdge").click();
  const at = await findEdges(page, [LIP, ROOT]);
  expect(at.size, "the scan finds the lip's edge and its root").toBe(2);
  await page.keyboard.press("Escape");

  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuTransition").click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator("#modelTransEdges")).toHaveText("Pick an edge in a concave corner, or a lip's lowest edge. Shift-click adds edges.");
  await expect(page.locator("#modelTransModeRow")).toBeHidden();

  // The lip's lowest edge: found a lip, a gusset 10 mm down to the wall, green.
  await page.mouse.click(at.get(LIP)!.x, at.get(LIP)!.y);
  await expect(page.locator("#modelTransFound")).toHaveText("Found a lip.");
  await expect(page.locator("#modelTransLip")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTransCorner")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#modelTransModeRow")).toBeVisible();
  await expect(page.locator("#modelTransSizeRow")).toBeHidden();
  await expect(page.locator("#modelTransFarLabel")).toHaveText("Underside");
  await expect(page.locator("#modelTransFar")).toHaveText("0° to the layers, 10 mm deep");
  await expect(page.locator("#modelTransReachLabel")).toHaveText("Gusset");
  await expect(page.locator("#modelTransReach")).toHaveText("10 mm down the build, landing 14.14 mm from the edge");
  await expect(page.locator("#modelTransVolume")).toHaveText("+1000 mm³ added");
  await expect(model(page)).toHaveAttribute("data-ghost-tone", "add");
  const ghost = (await model(page).getAttribute("data-ghost"))!.split(" ").map(Number);
  expect(ghost.slice(3), "the ghost is the 20 × 10 × 10 mm gusset").toEqual([20, 10, 10]);
  await expect(page.locator("#modelApply")).toBeEnabled();
  const probed = tree.of("probe").at(-1)!.op as Body;
  expect(probed.edges).toEqual([LIP]);
  expect("case" in probed || "mode" in probed).toBe(false);
  await shot(page, "card-lip-gusset.png");

  // Cut: a ramp from the root, red, keeping the 0.8 mm floor.
  await page.locator("#modelTransCut").click();
  await expect(page.locator("#modelTransReachLabel")).toHaveText("Ramp");
  await expect(page.locator("#modelTransReach")).toHaveText("from the root, leaving 2 mm at the first edge");
  await expect(page.locator("#modelTransVolume")).toHaveText("−1000 mm³ removed");
  await expect(page.locator("#modelTransFloor")).toHaveText("The ramp keeps at least 0.8 mm at the lip's first edge, twice the nozzle.");
  await expect(model(page)).toHaveAttribute("data-ghost-tone", "cut");
  const cutOp = tree.of("probe").at(-1)!.op as Body;
  expect(cutOp.mode).toBe("cut");
  expect(cutOp.floorMm).toBe(0.8);
  await shot(page, "card-lip-cut.png");

  // At 50° the ramp climbs 11.9 mm of the 12 mm front: under the floor, refused, and Apply stays off.
  await page.locator("#modelTransAngle").fill("50");
  await expect(page.locator("#modelTransStatus")).toHaveText("A ramp at 50° from the lip's root would leave 0.08 mm at this lip's first edge, under the 0.8 mm wall floor (twice the nozzle). A gusset (mode add) keeps the lip whole.");
  await expect(page.locator("#modelTransNumbers")).toBeHidden();
  await expect(page.locator("#modelApply")).toBeDisabled();
  await shot(page, "card-lip-cut-thin.png");

  // Back to 45° and Add: Apply makes one row that names the lip.
  await page.locator("#modelTransAngle").fill("45");
  await page.locator("#modelTransAdd").click();
  await expect(page.locator("#modelTransVolume")).toHaveText("+1000 mm³ added");
  await page.locator("#modelApply").click();
  await expect(labels(page).last()).toHaveText("Print transition (1 lip), 45°");
  await expect(card(page)).toBeHidden();
  await expect(readout(page)).toContainText(`Volume ${(5 * 40 + DEPTH * THICK) * WIDTH + 1000} mm³`);
  await shot(page, "history-lip.png");

  // The pencil reopens it as a lip; Cut there, then Update.
  await page.locator("#modelHistoryTree .mh-row").last().hover();
  await page.locator("#modelHistoryTree .mh-row").last().locator(".mh-edit").click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator("#modelTransLip")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await page.locator("#modelTransCut").click();
  await expect(page.locator("#modelTransVolume")).toHaveText("−1000 mm³ removed");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(labels(page).last()).toHaveText("Print transition (1 lip), cut, 45°");
  const edited = tree.of("edit").at(-1)!.op as Body;
  expect(edited.mode).toBe("cut");
  expect(edited.case).toBe("lip");

  // A new card on the root: found a corner, with no Cut. Lip there reads it as the lip's root.
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuTransition").click();
  await page.mouse.click(at.get(ROOT)!.x, at.get(ROOT)!.y);
  await expect(page.locator("#modelTransFound")).toHaveText("Found a corner.");
  await expect(page.locator("#modelTransCorner")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTransModeRow")).toBeHidden();
  await expect(page.locator("#modelTransSizeRow")).toBeVisible();
  await page.locator("#modelTransLip").click();
  await expect(page.locator("#modelTransFound")).toHaveText("Found a corner; set to Lip.");
  await expect(page.locator("#modelTransVolume")).toHaveText("+1000 mm³ added");
  expect((tree.of("probe").at(-1)!.op as Body).case).toBe("lip");
  await shot(page, "card-root-as-lip.png");
  // Back to Corner: the found case again, the 2 mm wedge's answer, known already, so nothing is asked again.
  const asked = tree.of("probe").length;
  await page.locator("#modelTransCorner").click();
  await expect(page.locator("#modelTransFound")).toHaveText("Found a corner.");
  await expect(page.locator("#modelTransVolume")).toHaveText("+40 mm³ added");
  expect(tree.of("probe").length).toBe(asked);

  // Corner on the lip's edge is refused with the kernel's sentence.
  await page.mouse.click(at.get(LIP)!.x, at.get(LIP)!.y);
  await expect(page.locator("#modelTransFound")).toHaveText("Found a lip.");
  await page.locator("#modelTransCorner").click();
  await expect(page.locator("#modelTransStatus")).toHaveText(CORNER_ON_LIP);
  await expect(page.locator("#modelApply")).toBeDisabled();
});
