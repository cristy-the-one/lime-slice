import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

/**
 * --- Print transitions, step 3 (docs/plan-belt-transitions.md, section 5): the card in the Model tab on a synthetic
 * corner part built here, never a company file. The part is an L, a 20 mm wide base with a post at its back; printed
 * upside down (turned 180° about X on the plate) the base's top is an underside hanging off the post, the case a corner
 * wedge fixes. The mocked kernel answers the probe as `tree/transition.rs` would for that pose.
 */

type V = [number, number, number];
const out = process.env.LIME_SHOTS_DIR ?? path.join("test-results", "transition-card");

/** The L's side view in Y and Z, extruded 20 mm along X. E is the concave corner, F the base's convex front edge. */
const PROFILE: [number, number][] = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [0, 10]];
const WIDTH = 20;
const CONCAVE = 0;
const CONVEX = 1;
const FLOOR = 4;
const WALL = 3;

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

/** The L as the modeler reports it, with each flat face's outward normal. */
function lPart(volumeMm3 = 10000): MockSolid {
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (x: number, [y, z]: [number, number]): V => [x, y, z];
  const p = (i: number) => PROFILE[i]!;
  // The profile's edges: bottom, back, post top, wall, base top, front.
  const normals: V[] = [[0, 0, -1], [0, 1, 0], [0, 0, 1], [0, -1, 0], [0, 0, 1], [0, -1, 0]];
  for (let i = 0; i < 6; i += 1) quad(positions, triangles, i, [at(0, p(i)), at(WIDTH, p(i)), at(WIDTH, p((i + 1) % 6)), at(0, p((i + 1) % 6))], normals[i]!);
  // The two sides, each the L as a base and a post.
  for (const [face, x, sign] of [[6, 0, -1], [7, WIDTH, 1]] as const) {
    quad(positions, triangles, face, [[x, 0, 0], [x, 30, 0], [x, 30, 10], [x, 0, 10]], [sign, 0, 0]);
    quad(positions, triangles, face, [[x, 20, 10], [x, 30, 10], [x, 30, 30], [x, 20, 30]], [sign, 0, 0]);
  }
  const faces = [...normals, [-1, 0, 0] as V, [1, 0, 0] as V].map((normal, id) => ({ id, areaMm2: 0, normal }));
  // Along X at each corner of the profile, the concave E first and the convex F second; then the sides' outlines.
  const corners = [4, 5, 0, 1, 2, 3];
  const edges = [
    ...corners.map((i) => [...at(0, p(i)), ...at(WIDTH, p(i))]),
    ...[0, WIDTH].flatMap((x) => PROFILE.map((_, i) => [...at(x, p(i)), ...at(x, p((i + 1) % 6))])),
  ].map((points, id) => ({ id, lengthMm: Math.hypot(points[3]! - points[0]!, points[4]! - points[1]!, points[5]! - points[2]!), points }));
  return { volumeMm3, positions, triangles, faces: faces as MockSolid["faces"], edges };
}

const PART = lPart();
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
/** Upside down, the base's front edge F is a lip whose gusset would land 20 mm down the build, at the post's end: past the limit. */
const LIP_SENTENCE = "There is nothing of the part under this lip within 20 mm along the build, so a gusset would itself start in the air. Supports or a split are the way here, or a larger maxMm.";

/** What the kernel answers for a transition on the L's corner, for the op's build direction, as `corner()` works it out. */
function wedge(op: Body): Body {
  const edges = (op.edges as unknown[]).map((edge) => (typeof edge === "number" ? edge : Number((edge as { index: number }).index)));
  if (edges.some((edge) => edge !== CONCAVE)) return { ok: false, error: LIP_SENTENCE };
  const b = op.build as V;
  const down: V = [-b[0], -b[1], -b[2]];
  const toLayers = (n: V) => (Math.acos(Math.max(-1, Math.min(1, n[0] * down[0] + n[1] * down[1] + n[2] * down[2]))) * 180) / Math.PI;
  const far: V = [0, 0, 1];
  const near: V = [0, -1, 0];
  const angle = Number(op.angleDeg);
  if (toLayers(far) >= angle - 0.05) return { ok: false, error: `The flatter face here already grows at ${toLayers(far).toFixed(1)}° to the layers, as steep as the ${angle}° asked, so a wedge adds nothing. A steeper angle makes one.` };
  if (toLayers(near) < angle - 0.05) return { ok: false, error: `Both faces here grow flatter than ${angle}° to the layers (the steeper at ${toLayers(near).toFixed(1)}°), so a wedge would itself start in the air. That is a lip: the Lip case puts a gusset under the flatter face, back into the part.` };
  // The new face's normal turns from the floor's toward the wall's, a right angle apart, until it makes the angle asked.
  const turn = (t: number): V => [0, -Math.sin(t), Math.cos(t)];
  let [lo, hi] = [0, Math.PI / 2];
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (toLayers(turn(mid)) < angle) lo = mid;
    else hi = mid;
  }
  const fromFar = (lo + hi) / 2;
  const reach = op.size === "face" ? 20 : Number(op.size);
  const nearReach = reach * Math.tan(fromFar);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const row = { edge: CONCAVE, case: "corner", path: op.size === "face" ? "prism" : "chamfer", material: "add", farFace: FLOOR, nearFace: WALL, farDeg: round(toLayers(far)), nearDeg: round(toLayers(near)), normal: turn(fromFar).map(round), angleToLayersDeg: angle, reachMm: reach, nearReachMm: round(nearReach), farEndMm: 20, volumeMm3: round(0.5 * reach * nearReach * WIDTH) };
  return { ok: true, transition: [row] };
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
      const answer = wedge(op);
      return answer.ok ? lPart(parent.volumeMm3 + Number((answer.transition as Body[])[0]!.volumeMm3)) : { error: String(answer.error) };
    },
    probe: (request) => ((request.op as Body).kind === "transition" ? wedge(request.op as Body) : { ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "corner.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelTransition");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");

/** Where on the view each of `wanted` edges can be clicked: a scan in Edge mode, read from the readout ("Edge 1" is index 0). */
async function findEdges(page: Page, wanted: number[]): Promise<Map<number, { x: number; y: number }>> {
  const box = (await page.locator("#model").boundingBox())!;
  const hits = new Map<number, { x: number; y: number }>();
  for (let row = 0; row < 24 && hits.size < wanted.length; row += 1) {
    for (let col = 0; col < 24 && hits.size < wanted.length; col += 1) {
      const x = box.x + box.width * (0.2 + col * 0.026);
      const y = box.y + box.height * (0.15 + row * 0.03);
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

test("the Print transition card picks an edge, previews the wedge, refuses a lip with nothing under it, applies, edits, and re-aims a stale step", async ({ page }) => {
  test.setTimeout(180_000);
  const tree = await openPart(page);
  // Printed upside down: the base's top becomes an underside hanging off the post.
  await page.locator("#rotX").click();
  await page.locator("#rotX").click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 10000 mm³");

  // The edges, found once in Edge mode, then the selection cleared.
  await page.locator("#modelPickEdge").click();
  const at = await findEdges(page, [CONCAVE, CONVEX]);
  expect(at.size, "the scan finds the corner and the convex edge").toBe(2);
  await page.keyboard.press("Escape");

  // The Features menu opens the card; with no edge it asks for one, and Apply waits.
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuTransition").click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Print transition");
  await expect(page.locator("#modelTransEdges")).toHaveText("Pick an edge in a concave corner, or a lip's lowest edge. A click takes its whole chain; Shift-click adds edges.");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await expect(page.locator("#modelTransAngle")).toHaveValue("45");
  await expect(page.locator("#modelTransMm")).toHaveValue("2");
  await expect(page.locator("#modelTransSource")).toHaveText("From this pose on the Lime 220, its bed.");
  // Material, Add or Cut, is a lip's only: hidden until an edge is found a lip.
  await expect(page.locator("#modelTransModeRow")).toBeHidden();

  // The corner: the green wedge and its numbers.
  await page.mouse.click(at.get(CONCAVE)!.x, at.get(CONCAVE)!.y);
  await expect(page.locator("#modelTransEdges")).toHaveText("1 edge. Shift-click adds edges.");
  await expect(page.locator("#modelTransFound")).toHaveText("Found a corner.");
  await expect(page.locator("#modelTransCorner")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelTransFace")).toHaveText("45° to the layers, 45° to the bed");
  await expect(page.locator("#modelTransFar")).toHaveText("0° to the layers");
  await expect(page.locator("#modelTransReach")).toHaveText("2 mm along the flatter face, 2 mm up the steeper");
  await expect(page.locator("#modelTransVolume")).toHaveText("+40 mm³ added");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", /.+/);
  const ghost = (await page.locator("#model").getAttribute("data-ghost"))!.split(" ").map(Number);
  expect(ghost.slice(3), "the ghost is the 20 × 2 × 2 mm wedge").toEqual([20, 2, 2]);
  await expect(page.locator("#modelApply")).toBeEnabled();
  const probed = tree.of("probe").at(-1)!.op as Body;
  expect(probed.kind).toBe("transition");
  expect(probed.edges).toEqual([CONCAVE]);
  expect(probed.build).toEqual([0, 0, -1]);
  expect(probed.angleDeg).toBe(45);
  expect(probed.size).toBe(2);
  expect(probed.printer).toBe("lime-220");
  await shot(page, "card-corner.png");

  // The base's front edge, a lip with nothing under it within 20 mm: the kernel's sentence in place of the ghost, and Apply stays off.
  await page.mouse.click(at.get(CONVEX)!.x, at.get(CONVEX)!.y);
  await expect(page.locator("#modelTransStatus")).toHaveText(LIP_SENTENCE);
  await expect(page.locator("#modelTransNumbers")).toBeHidden();
  await expect(page.locator("#model")).not.toHaveAttribute("data-ghost", /.+/);
  await expect(page.locator("#modelApply")).toBeDisabled();
  await shot(page, "card-refusal.png");

  // Back on the corner, Apply: one history row.
  await page.mouse.click(at.get(CONCAVE)!.x, at.get(CONCAVE)!.y);
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(labels(page).last()).toHaveText("Print transition (1 edge), 45°, 2 mm");
  await expect(card(page)).toBeHidden();
  await expect(readout(page)).toContainText("Volume 10040 mm³");

  // The pencil reopens the card on the step's numbers; Update waits for a change, and the row rebuilds from it.
  await page.locator("#modelHistoryTree .mh-row").last().hover();
  await page.locator("#modelHistoryTree .mh-row").last().locator(".mh-edit").click();
  await expect(card(page)).toBeVisible();
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(page.locator("#modelTransAngle")).toHaveValue("45");
  await expect(page.locator("#modelTransEdges")).toHaveText("1 edge. Shift-click adds edges.");
  await expect(page.locator("#modelTransVolume")).toHaveText("+40 mm³ added");
  await expect(page.locator("#modelApply")).toBeDisabled();
  await page.locator("#modelTransAngle").fill("50");
  await expect(page.locator("#modelTransFace")).toHaveText("50° to the layers, 50° to the bed");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await shot(page, "card-edit.png");
  await page.locator("#modelApply").click();
  await expect(labels(page).last()).toHaveText("Print transition (1 edge), 50°, 2 mm");
  const edited = tree.of("edit").at(-1)!.op as Body;
  expect(edited.angleDeg).toBe(50);
  expect(edited.build).toEqual([0, 0, -1]);

  // On the IR3 V2 the layers lie at 45°: the solid keeps the wedge, and Prepare and History say the step is stale.
  await page.locator("#tabPrepare").click();
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption("ideaformer-ir3-v2");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  const prepareNote = page.locator("#objectList .obj-stale");
  await expect(prepareNote).toContainText("1 print transition was made for another pose. On the belt, even a turn about the plate's Z changes the layers. Re-aim it, or keep it as it is.");
  await page.locator("#tabModel").click();
  const historyNote = page.locator("#modelStaleNote");
  await expect(historyNote).toBeVisible();
  await expect(page.locator("#modelHistoryTree .mh-row[data-stale]")).toHaveCount(1);
  await expect(page.locator("#modelHistoryTree .mh-row[data-stale] .mh-label")).toHaveText("Print transition (1 edge), 50°, 2 mm");
  const edits = tree.of("edit").length;

  // In this pose the wall itself is flatter than 50°: Re-aim says why, and the step stays as it was.
  await page.locator("#modelStaleReaim").click();
  await expect(readout(page)).toContainText("Both faces here grow flatter than 50° to the layers");
  expect(tree.of("edit").length).toBe(edits + 1);
  await expect(historyNote).toBeVisible();
  await expect(labels(page).last()).toHaveText("Print transition (1 edge), 50°, 2 mm");

  // Turned a quarter about the plate's Z, the corner works again; the note stays until it is re-aimed.
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await expect(prepareNote).toBeVisible();
  await shot(page, "prepare-stale.png");
  await page.locator("#tabModel").click();
  await expect(historyNote).toContainText("1 print transition was made for another pose.");
  await shot(page, "history-stale.png");

  // Re-aim: the step rebuilt from this pose on the IR3 V2, every other number kept.
  await page.locator("#modelStaleReaim").click();
  await expect.poll(() => tree.of("edit").length).toBe(edits + 2);
  const reaimed = tree.of("edit").at(-1)!.op as Body;
  expect(reaimed.angleDeg).toBe(50);
  expect(reaimed.size).toBe(2);
  expect(reaimed.printer).toBe("ideaformer-ir3-v2");
  expect(reaimed.beltDeg).toBe(45);
  expect(Math.abs((reaimed.build as number[])[2]! + Math.SQRT1_2)).toBeLessThan(1e-6);
  await expect(historyNote).toBeHidden();
  await expect(page.locator("#modelHistoryTree .mh-row[data-stale]")).toHaveCount(0);
  await expect(readout(page)).toContainText("Updated");
  await shot(page, "history-reaimed.png");

  // Keep, from Prepare: another turn warns again, and Keep sends the note away for that pose without a rebuild.
  await page.locator("#tabPrepare").click();
  await expect(prepareNote).toHaveCount(0);
  await page.locator("#rotZ").click();
  await expect(prepareNote).toBeVisible();
  await page.locator("#objectList [data-transition-keep]").click();
  await expect(prepareNote).toHaveCount(0);
  expect(tree.of("edit").length).toBe(edits + 2);
});
