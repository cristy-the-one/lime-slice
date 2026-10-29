import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";
import { encodePaths } from "../src/preview-wire";

/**
 * --- Print transitions, step 6b (docs/plan-belt-transitions.md, decision 7): Find's rows checked against the last slice,
 * on a synthetic part built here, never a company file. The part is step 5's U on its side, printed upside down on a
 * flat bed: two concave corners where the base hangs between the posts, and two lips at the short post's end. Before a
 * slice the card says to slice; once Find has been used the slice asks the engine for the part beads on nothing
 * (`partHold`). The mocked engine answers with patches placed where this pose puts them: one born along the back
 * corner, one under the short post's end (both lips), and one along the tall post's far top edge, which Find does not
 * list. Find again marks the corner and the lips "seen in the slice", lists the other edge as seen only in the slice,
 * and counts the skin patch away from every edge.
 */

type V = [number, number, number];
const out = process.env.LIME_SHOTS_DIR ?? path.join("test-results", "transition-seen");
const shotName = (name: string) => `${name}-${test.info().repeatEachIndex}.png`;

const PROFILE: [number, number][] = [[0, 0], [40, 0], [40, 30], [30, 30], [30, 10], [10, 10], [10, 20], [0, 20]];
const WIDTH = 20;
const ORDER = [4, 5, 6, 7, 0, 1, 2, 3];
const BACK = 0;
const FRONT = 1;
const LIPS = [2, 3];
/** The tall post's far top edge (40, 0) in the side view: last printed upside down, with nothing to explain it. */
const FAR_TOP = ORDER.indexOf(1);
const BASE_TOP = 4;
const WALL: Record<number, number> = { [BACK]: 3, [FRONT]: 5 };
const NORMALS: V[] = [[0, 0, -1], [0, 1, 0], [0, 0, 1], [0, -1, 0], [0, 0, 1], [0, 1, 0], [0, 0, 1], [0, -1, 0]];
const BASE_VOLUME = 40 * 10 * WIDTH + 10 * 20 * WIDTH + 10 * 10 * WIDTH;
const CONVEX_SENTENCE = "Both faces at this edge look up the build, so nothing here hangs.";
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

/** The U as the modeler reports it: the side view in Y and Z, extruded 20 mm along X. */
function uPart(): MockSolid {
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
  return { volumeMm3: BASE_VOLUME, positions, triangles, faces: faces as MockSolid["faces"], edges };
}

const PART = uPart();
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

/** A corner's 2 mm wedge, as the kernel answers it for a build down the part's Z. */
function wedgeRow(edge: number) {
  const near = NORMALS[WALL[edge]!]!;
  const s = Math.SQRT1_2;
  return { edge, case: "corner", path: "chamfer", farFace: BASE_TOP, nearFace: WALL[edge]!, farDeg: 0, nearDeg: 90, normal: [0, near[1] * s, s], angleToLayersDeg: 45, reachMm: 2, nearReachMm: 2, farEndMm: 10, volumeMm3: 40 };
}

interface Pose {
  rotation: number[];
  pivot: number[];
  translation: number[];
}

/** A point of the part where the slice puts it: the request's pose, turn about the mesh's centre, then place. */
function onPlate(pose: Pose, p: V): V {
  const m = pose.rotation;
  const d = [0, 1, 2].map((k) => p[k]! - pose.pivot[k]!);
  return [0, 1, 2].map((r) => m[3 * r]! * d[0]! + m[3 * r + 1]! * d[1]! + m[3 * r + 2]! * d[2]! + pose.translation[r]!) as V;
}

/** A patch born along `points`, as the engine's `partHold.largest` gives it. */
function patch(pose: Pose, mm: number, span: number, layers: [number, number], points: V[]) {
  const first = points.map((p) => onPlate(pose, p));
  return { mm, danglingMm: mm, longestSpanMm: span, layers, at: first[0], first };
}

/** The slice: one outer loop for the preview, and the part beads on nothing when the request asks for them. */
function sliceReply(body: Body) {
  const pose = body.pose as Pose;
  const placed = [];
  for (let i = 0; i < PART.positions.length; i += 3) placed.push(onPlate(pose, [PART.positions[i]!, PART.positions[i + 1]!, PART.positions[i + 2]!]));
  const min = [0, 1, 2].map((k) => Math.min(...placed.map((p) => p[k]!)));
  const max = [0, 1, 2].map((k) => Math.max(...placed.map((p) => p[k]!)));
  const xs = [2, 6, 10, 14, 18];
  const largest = [
    // Upside down the base's top is an underside: its first rows step out past the back corner, under it in Z.
    patch(pose, 120.4, 18.6, [100, 101], xs.map((x): V => [x, 29.8, 9.9])),
    // The short post's end, born at once over both lips.
    patch(pose, 210, 20, [50, 50], xs.flatMap((x): V[] => [[x, 0.2, 19.9], [x, 9.8, 19.9]])),
    // The tall post's far top edge, last printed: gap fill that Find has no row for.
    patch(pose, 92.1, 2.4, [148, 149], xs.map((x): V => [x, 39.8, 0.2])),
    // Skin over infill in the middle of the base: no edge near it.
    patch(pose, 14.2, 4.1, [120, 120], [[10, 20, 5]]),
  ];
  const paths = encodePaths([{ kind: "outer", strategy: "speed", pts: [[min[0]! + 1, min[1]! + 1], [max[0]! - 1, min[1]! + 1], [max[0]! - 1, max[1]! - 1], [min[0]! + 1, max[1]! - 1], [min[0]! + 1, min[1]! + 1]], width: 0.45, speed: 40, effectiveSpeed: 40, toughness: 0, beadHeight: 0.2 }]);
  return {
    coreMs: 1,
    baselineMs: 0,
    blend: "speed",
    mesh: { triangles: PART.triangles.length, sourceTriangles: PART.triangles.length, outlineToleranceMm: 0.025, min, max },
    sanity: { ok: true, notes: [], layers: 1, finalE: 1, extrusionLengthMm: 10 },
    estimate: { seconds: 8, filamentMm: 40, filamentG: 0.12, arcMoves: 0, byFeature: [] },
    gcode: "; preview\n",
    layers: [{ index: 0, z: 0.2, height: 0.2, note: "u", seconds: 8, speedWalls: 1, toughnessWalls: 0, supportPaths: 0, paths }],
    ...(body.partHold ? { partHold: { partMm: 9000, noBeadUnderMm: 500, unheldMm: 436.7, danglingMm: 436.7, longestSpanMm: 20, patches: 4, largest } } : {}),
  };
}

async function openPart(page: Page, slices: Body[]) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: PART.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as Body;
    slices.push(body);
    await route.fulfill({ json: sliceReply(body) });
  });
  await mockModelTree(page, {
    open: () => PART,
    probe: (request) => {
      const op = request.op as Body;
      if (op.kind !== "transition") return { ok: true };
      const edges = (op.edges as unknown[]).map((edge) => (typeof edge === "number" ? edge : Number((edge as { index: number }).index)));
      if (edges.some((edge) => LIPS.includes(edge))) return { ok: false, error: LIP_SENTENCE };
      if (edges.some((edge) => !(edge in WALL))) return { ok: false, error: CONVEX_SENTENCE };
      return { ok: true, transition: edges.map((edge) => wedgeRow(edge)) };
    },
    transitionFind(request, _on, node) {
      if ((request.build as number[])[2]! > 0) return { id: node, rows: [], curvedSkipped: 0 };
      const mid = (edge: number): V => [WIDTH / 2, PROFILE[ORDER[edge]!]![0], PROFILE[ORDER[edge]!]![1]];
      const corners = [BACK, FRONT].map((edge) => ({ edge, case: "corner", lengthMm: WIDTH, mid: mid(edge), farFace: BASE_TOP, nearFace: WALL[edge], farDeg: 0, nearDeg: 90, probe: { ok: true, transition: [wedgeRow(edge)] } }));
      const lips = LIPS.map((edge) => ({ edge, case: "lip", lengthMm: WIDTH, mid: mid(edge), farFace: 6, nearFace: edge === 2 ? 5 : 7, farDeg: 0, nearDeg: 90, probe: { ok: false, error: LIP_SENTENCE } }));
      return { id: node, rows: [...corners, ...lips], curvedSkipped: 0 };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "u-part.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
}

const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelTransition");
const rows = (page: Page) => page.locator("#modelTransList .tc-found-row");
const row = (page: Page, edge: number) => page.locator(`#modelTransList [data-found="${edge}"]`);
const sliceStatus = (page: Page) => page.locator("#modelTransSliceStatus");
const only = (page: Page) => page.locator("#modelTransSliceOnly .tc-only-row");

async function openCard(page: Page) {
  if (await card(page).isVisible()) return;
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuTransition").click();
  await expect(card(page)).toBeVisible();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, shotName(name)) });
}

test("Find marks the edges the last slice also finds hanging, and lists the ones only the slice finds", async ({ page }) => {
  test.setTimeout(180_000);
  const slices: Body[] = [];
  await openPart(page, slices);

  // A slice before Find asks for nothing new: the request and its cache key stay as they were.
  await page.locator("#rotX").click();
  await page.locator("#rotX").click();
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(1);
  expect(slices[0]!.partHold).toBeUndefined();

  // Find, with no slice of this pose checked: the rows, and a line that says to slice.
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(`Volume ${BASE_VOLUME} mm³`);
  await openCard(page);
  await page.locator("#modelTransFind").click();
  await expect(rows(page)).toHaveCount(4);
  await expect(sliceStatus(page)).toHaveText("Slice this pose, then Find again, to mark the edges that hang in the slice too.");
  await expect(page.locator("#modelTransList [data-seen]")).toHaveCount(0);
  await expect(only(page)).toHaveCount(0);

  // From the first Find on, a slice asks the engine for the part beads on nothing.
  await page.locator("#tabPrepare").click();
  await page.locator("#slice").click();
  await expect.poll(() => slices.length).toBe(2);
  expect(slices[1]!.partHold).toBe(true);

  // Find again: the back corner and both lips hang in the slice too; the front corner does not.
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(`Volume ${BASE_VOLUME} mm³`);
  await openCard(page);
  await page.locator("#modelTransFind").click();
  await expect(rows(page)).toHaveCount(4);
  await expect(sliceStatus(page)).toHaveText("3 edges hang in the last slice too. 1 other edge hangs in it that Find does not list. 1 patch hangs away from every edge, inside a face.");
  await expect(row(page, BACK).locator(".tc-seen")).toHaveText("Seen in the slice: 120.4 mm unheld, spans 18.6 mm, layers 101–102.");
  await expect(row(page, BACK)).toHaveAttribute("data-seen", "");
  await expect(row(page, FRONT).locator(".tc-seen")).toHaveCount(0);
  for (const lip of LIPS) await expect(row(page, lip).locator(".tc-seen")).toHaveText("Seen in the slice: 210 mm unheld, spans 20 mm, layer 51.");
  await expect(only(page)).toHaveCount(1);
  await expect(only(page).first().locator(".tc-case")).toHaveText("Slice only");
  await expect(only(page).first().locator(".tc-only-text")).toHaveText("92.1 mm unheld at this edge, spans 2.4 mm, layers 149–150.");
  await shot(page, "seen-in-slice");

  // Hovering the slice-only row lights its edge; its button picks the edge into the card to try a transition on it.
  await only(page).first().hover();
  await expect(page.locator("#model")).toHaveAttribute("data-lit-edge", String(FAR_TOP));
  await expect(page.locator("#model")).toHaveAttribute("data-flagged", `0,1,2,3,${FAR_TOP}`);
  await only(page).first().locator(".tc-found-pick").click();
  await expect(page.locator("#modelTransEdges")).toHaveText("1 edge. Shift-click adds edges.");
  await shot(page, "seen-only-picked");

  // A turn on the plate makes the slice another pose's: Find again lists the rows unmarked and says to slice.
  await page.keyboard.press("Escape");
  await page.locator("#tabPrepare").click();
  await page.locator("#rotZ").click();
  await page.locator("#tabModel").click();
  await openCard(page);
  await page.locator("#modelTransFind").click();
  await expect(page.locator("#modelTransList [data-seen]")).toHaveCount(0);
  await expect(sliceStatus(page)).toHaveText("Slice this pose, then Find again, to mark the edges that hang in the slice too.");
});
