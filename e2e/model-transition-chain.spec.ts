import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";

/**
 * --- Print transitions, step 6 (docs/plan-belt-transitions.md, section 5, "Using it"): a click on an edge takes its
 * tangent chain, a second click on one edge of that chain takes it alone, and Shift-click adds or removes one edge. The
 * part is synthetic, built here, never a company file: step 3's L (a base with a post at its back, printed upside down),
 * whose concave corner is three edges in a line, as a STEP file often splits one. The mocked kernel answers `edgeChain`
 * as `tree.rs` would, and each corner row carries the kernel's own triangles (`soup`), which the ghost draws.
 */

type V = [number, number, number];
const out = process.env.LIME_SHOTS_DIR ?? path.join("test-results", "transition-chain");

const PROFILE: [number, number][] = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [0, 10]];
const WIDTH = 20;
/** The corner's three edges along X, then the base's convex front edge. */
const SEGMENTS: [number, number][] = [[0, 6], [6, 14], [14, 20]];
const CHAIN = [0, 1, 2];
const CONVEX = 3;
const FLOOR = 4;
const WALL = 3;
/** The kernel's wedge triangles: a 3 mm section, so the ghost shows they are drawn rather than the 2 mm reach numbers. */
const SOUP_MM = 3;

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

function lPart(volumeMm3 = 10000): MockSolid {
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (x: number, [y, z]: [number, number]): V => [x, y, z];
  const p = (i: number) => PROFILE[i]!;
  const normals: V[] = [[0, 0, -1], [0, 1, 0], [0, 0, 1], [0, -1, 0], [0, 0, 1], [0, -1, 0]];
  for (let i = 0; i < 6; i += 1) quad(positions, triangles, i, [at(0, p(i)), at(WIDTH, p(i)), at(WIDTH, p((i + 1) % 6)), at(0, p((i + 1) % 6))], normals[i]!);
  for (const [face, x, sign] of [[6, 0, -1], [7, WIDTH, 1]] as const) {
    quad(positions, triangles, face, [[x, 0, 0], [x, 30, 0], [x, 30, 10], [x, 0, 10]], [sign, 0, 0]);
    quad(positions, triangles, face, [[x, 20, 10], [x, 30, 10], [x, 30, 30], [x, 20, 30]], [sign, 0, 0]);
  }
  const faces = [...normals, [-1, 0, 0] as V, [1, 0, 0] as V].map((normal, id) => ({ id, areaMm2: 0, normal }));
  const edges = [
    ...SEGMENTS.map(([a, b]) => [a, 20, 10, b, 20, 10]),
    ...[5, 0, 1, 2, 3].map((i) => [...at(0, p(i)), ...at(WIDTH, p(i))]),
    ...[0, WIDTH].flatMap((x) => PROFILE.map((_, i) => [...at(x, p(i)), ...at(x, p((i + 1) % 6))])),
  ].map((points, id) => ({ id, lengthMm: Math.hypot(points[3]! - points[0]!, points[4]! - points[1]!, points[5]! - points[2]!), points }));
  return { volumeMm3, positions, triangles, faces: faces as MockSolid["faces"], edges };
}

const PART = lPart();
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

/** One segment's wedge as the kernel's triangles: the section (20, 10), (20 − 3, 10), (20, 10 + 3) in Y and Z, along X. */
function soup([x0, x1]: [number, number]): number[] {
  const ring = (x: number): V[] => [[x, 20, 10], [x, 20 - SOUP_MM, 10], [x, 20, 10 + SOUP_MM]];
  const [a0, a1, a2] = ring(x0);
  const [b0, b1, b2] = ring(x1);
  const tris: V[][] = [[a0!, a2!, a1!], [b0!, b1!, b2!], [a0!, a1!, b1!], [a0!, b1!, b0!], [a1!, a2!, b2!], [a1!, b2!, b1!], [a2!, a0!, b0!], [a2!, b0!, b2!]];
  return tris.flat(2);
}

function wedge(op: Body): Body {
  const edges = (op.edges as unknown[]).map((edge) => (typeof edge === "number" ? edge : Number((edge as { index: number }).index)));
  if (edges.some((edge) => !CHAIN.includes(edge))) return { ok: false, error: "This edge is convex, and nothing of the part lies under it within 20 mm." };
  const rows = edges.map((edge) => {
    const [x0, x1] = SEGMENTS[edge]!;
    return { edge, case: "corner", path: "sweep", material: "add", farFace: FLOOR, nearFace: WALL, farDeg: 0, nearDeg: 90, normal: [0, -Math.SQRT1_2, Math.SQRT1_2], angleToLayersDeg: 45, reachMm: 2, nearReachMm: 2, volumeMm3: 2 * (x1 - x0), soup: soup([x0, x1]) };
  });
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
    apply: (_request, parent) => parent,
    probe: (request) => ((request.op as Body).kind === "transition" ? wedge(request.op as Body) : { ok: true }),
    edgeChain: (request, _on, node) => ({ id: node, edge: request.edge, edges: CHAIN.includes(Number(request.edge)) ? CHAIN : [request.edge], closed: false }),
    transitionFind: (request, _on, node) => ({
      id: node,
      curvedSkipped: 0,
      rows: [{ edge: 1, case: "corner", lengthMm: 8, mid: [10, 20, 10], farFace: FLOOR, nearFace: WALL, farDeg: 0, nearDeg: 90, curved: true, probe: wedge({ ...(request.fix as Body), edges: [1] }) }],
    }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "chain.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
const edgesLine = (page: Page) => page.locator("#modelTransEdges");

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
  const repeat = test.info().repeatEachIndex;
  await page.screenshot({ path: path.join(out, repeat > 0 ? name.replace(/\.png$/, `-${repeat}.png`) : name) });
}

async function ghostSize(page: Page): Promise<number[]> {
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", /.+/);
  return (await page.locator("#model").getAttribute("data-ghost"))!.split(" ").map(Number).slice(3);
}

const probedEdges = (tree: TreeMock) => ((tree.of("probe").at(-1)!.op as Body).edges as unknown[]).map((edge) => (typeof edge === "number" ? edge : Number((edge as { index: number }).index)));

test("a click on an edge takes its tangent chain, a second click takes that edge alone, and Shift-click adds one", async ({ page }) => {
  test.setTimeout(180_000);
  const tree = await openPart(page);
  await page.locator("#rotX").click();
  await page.locator("#rotX").click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume 10000 mm³");

  // The edges, found once in Edge mode with the card shut (no chain is asked then), then the selection cleared.
  await page.locator("#modelPickEdge").click();
  const at = await findEdges(page, [...CHAIN, CONVEX]);
  expect(at.size, "the scan finds the three corner edges and the convex edge").toBe(4);
  expect(tree.of("edgeChain"), "no chain is asked with the card shut").toHaveLength(0);
  await page.keyboard.press("Escape");

  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuTransition").click();
  await expect(page.locator("#modelTransition")).toBeVisible();
  await expect(page.locator("#modelTransStraight")).toHaveText("Curved edges and edges on curved faces work too: the wedge follows the curve.");

  // One click on the middle edge: the kernel's chain is picked, all three, and the ghost is the kernel's own triangles.
  await page.mouse.click(at.get(1)!.x, at.get(1)!.y);
  await expect(edgesLine(page)).toHaveText("A chain of 3 edges that run on with no corner. Click one of them again to take it alone; Shift-click adds or removes one.");
  expect(tree.of("edgeChain").at(-1)).toMatchObject({ call: "edgeChain", edge: 1 });
  await expect.poll(() => probedEdges(tree).sort()).toEqual(CHAIN);
  await expect(readout(page)).toContainText("A chain of 3 edges");
  expect(await ghostSize(page), "the ghost is the kernel's 3 mm triangles along the whole chain").toEqual([20, SOUP_MM, SOUP_MM]);
  await expect(page.locator("#modelApply")).toBeEnabled();
  await shot(page, "chain-picked.png");

  // A second click on one edge of the chain takes it alone, with no new chain asked.
  const asked = tree.of("edgeChain").length;
  await page.mouse.click(at.get(2)!.x, at.get(2)!.y);
  await expect(edgesLine(page)).toHaveText("1 edge. Shift-click adds edges.");
  await expect.poll(() => probedEdges(tree)).toEqual([2]);
  expect(await ghostSize(page)).toEqual([6, SOUP_MM, SOUP_MM]);
  expect(tree.of("edgeChain")).toHaveLength(asked);
  await shot(page, "chain-single.png");

  // Shift-click adds one edge, and asks for no chain.
  await page.keyboard.down("Shift");
  await page.mouse.click(at.get(1)!.x, at.get(1)!.y);
  await page.keyboard.up("Shift");
  await expect(edgesLine(page)).toHaveText("2 edges. Shift-click adds or removes one.");
  await expect.poll(() => probedEdges(tree).sort()).toEqual([1, 2]);
  expect(tree.of("edgeChain")).toHaveLength(asked);

  // A plain click again takes the chain again.
  await page.mouse.click(at.get(0)!.x, at.get(0)!.y);
  await expect(edgesLine(page)).toHaveText(/^A chain of 3 edges/);
  // The card already holds the kernel's answer for these three edges, so the ghost comes back with no new probe.
  await expect.poll(() => ghostSize(page)).toEqual([20, SOUP_MM, SOUP_MM]);

  // An edge on no chain stays alone.
  await page.mouse.click(at.get(CONVEX)!.x, at.get(CONVEX)!.y);
  await expect(edgesLine(page)).toHaveText("1 edge. Shift-click adds edges.");
  expect(tree.of("edgeChain").at(-1)).toMatchObject({ edge: CONVEX });
  await expect(page.locator("#modelApply")).toBeDisabled();

  // Find marks a curved edge's row.
  await page.locator("#modelTransFind").click();
  const row = page.locator("#modelTransList .tc-found-row").first();
  await expect(row.locator(".tc-curved")).toHaveText("curved");
  await expect(row.locator(".tc-fix")).toHaveAttribute("aria-label", "Fix this curved corner, 8 mm");
  await shot(page, "find-curved.png");
});
