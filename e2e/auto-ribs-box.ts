import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid, type TreeMock } from "./model-tree-mock";
import { ribSoup } from "../src/auto-ribs";
import { mockReply } from "./stress-mock";

/**
 * Auto ribs (docs/plan-auto-ribs.md 7.1), the specs' shared part: the card on a synthetic shelled box built here, never a company file. The
 * modeler is mocked (an Apply of the rib network adds its runs as boxes and their volume); plans come from the
 * deterministic stand-in (`__limeRibPlanFake`, src/auto-ribs-plan.ts). The wall is read for real, in the app's worker.
 */

export type V = [number, number, number];
const out = process.env.LIME_SHOTS_DIR ?? path.join("test-results", "auto-ribs");

const X = 120;
const Y = 80;
const Z = 30;
const T = 2;
export const FLOOR = 6;

/** An open box shell (rib-wall.test.ts's): 0 outer bottom, 1 rim, 2..5 outer sides, 6 inner floor, 8..11 inner sides. */
export function openBox(volumeMm3 = X * Y * Z - (X - 2 * T) * (Y - 2 * T) * (Z - T)): MockSolid {
  const positions: number[] = [];
  const triangles: number[] = [];
  const normals = new Map<number, V>();
  const quad = (f: number, a: V, b: V, c: V, d: V, want: V) => {
    normals.set(f, want);
    const tri = (p: V, q: V, r: V) => {
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const flip = n[0]! * want[0] + n[1]! * want[1] + n[2]! * want[2] < 0;
      positions.push(...p, ...(flip ? r : q), ...(flip ? q : r));
      triangles.push(f);
    };
    tri(a, b, c);
    tri(a, c, d);
  };
  quad(0, [0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, -1]);
  quad(FLOOR, [T, T, T], [X - T, T, T], [X - T, Y - T, T], [T, Y - T, T], [0, 0, 1]);
  quad(2, [0, 0, 0], [0, Y, 0], [0, Y, Z], [0, 0, Z], [-1, 0, 0]);
  quad(3, [X, 0, 0], [X, Y, 0], [X, Y, Z], [X, 0, Z], [1, 0, 0]);
  quad(4, [0, 0, 0], [X, 0, 0], [X, 0, Z], [0, 0, Z], [0, -1, 0]);
  quad(5, [0, Y, 0], [X, Y, 0], [X, Y, Z], [0, Y, Z], [0, 1, 0]);
  quad(8, [T, T, T], [T, Y - T, T], [T, Y - T, Z], [T, T, Z], [1, 0, 0]);
  quad(9, [X - T, T, T], [X - T, Y - T, T], [X - T, Y - T, Z], [X - T, T, Z], [-1, 0, 0]);
  quad(10, [T, T, T], [X - T, T, T], [X - T, T, Z], [T, T, Z], [0, 1, 0]);
  quad(11, [T, Y - T, T], [X - T, Y - T, T], [X - T, Y - T, Z], [T, Y - T, Z], [0, -1, 0]);
  const up: V = [0, 0, 1];
  quad(1, [0, 0, Z], [X, 0, Z], [X - T, T, Z], [T, T, Z], up);
  positions.push(...[X, 0, Z], ...[X, Y, Z], ...[X - T, Y - T, Z], ...[X, 0, Z], ...[X - T, Y - T, Z], ...[X - T, T, Z]);
  triangles.push(1, 1);
  positions.push(...[X, Y, Z], ...[0, Y, Z], ...[T, Y - T, Z], ...[X, Y, Z], ...[T, Y - T, Z], ...[X - T, Y - T, Z]);
  triangles.push(1, 1);
  positions.push(...[0, Y, Z], ...[0, 0, Z], ...[T, T, Z], ...[0, Y, Z], ...[T, T, Z], ...[T, Y - T, Z]);
  triangles.push(1, 1);
  // Face ids run 0..11 with 7 unused: the faces list is indexed by id.
  const faces = Array.from({ length: 12 }, (_, id) => ({ id, areaMm2: 0, ...(normals.get(id) ? { normal: normals.get(id)! } : {}) }));
  return { volumeMm3, positions, triangles, faces, edges: [] };
}

/** A block standing over the floor's middle, its underside `gap` mm over the floor. */
export function block(gap: number): MockSolid {
  const positions: number[] = [];
  const triangles: number[] = [];
  const [x0, x1, y0, y1, z0, z1] = [45, 75, 25, 55, T + gap, T + gap + 10];
  const v = (x: number, y: number, z: number): V => [x, y, z];
  const quad = (f: number, a: V, b: V, c: V, d: V) => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    triangles.push(f, f);
  };
  quad(0, v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0));
  quad(1, v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1));
  quad(2, v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1));
  quad(3, v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0));
  quad(4, v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0));
  quad(5, v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1));
  return { volumeMm3: 30 * 30 * 10, positions, triangles, faces: Array.from({ length: 6 }, (_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

/** One free-edged plate, face 0, normal +Z. Synthetic, and only the vents spec uses it. */
export function openPlate(): MockSolid {
  const positions: number[] = [];
  const triangles: number[] = [];
  const a: V = [0, 0, 2];
  const b: V = [X, 0, 2];
  const c: V = [X, Y, 2];
  const d: V = [0, Y, 2];
  positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  triangles.push(0, 0);
  return { volumeMm3: X * Y * T, positions, triangles, faces: [{ id: 0, areaMm2: X * Y, normal: [0, 0, 1] }], edges: [] };
}

const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

export interface Options {
  tickMs?: number;
  beatsNeither?: boolean;
  refuse?: string;
  applyError?: string;
  surfaces?: boolean;
  obstacle?: boolean;
  /** Plan with the engine at this `lime-slice serve` instead of the stand-in. */
  api?: string;
  /** Answer the desktop study solve (Check with Stress). */
  stress?: boolean;
  /** A single free-edged plate, so a resin plan can vent. The box floor is walled in all round. */
  plate?: boolean;
}

/** What Apply adds: each path as boxes on the floor, its volume on the part's. */
export function withRibs(parent: MockSolid, op: Body): MockSolid {
  const source = op.source as { paths?: { points: V[]; height: number; width: number }[] } | undefined;
  const positions = [...parent.positions];
  const triangles = [...parent.triangles];
  let volume = 0;
  for (const path of source?.paths ?? []) {
    const soup = ribSoup({ points: path.points, normals: path.points.map(() => [0, 0, 1]), heights: path.points.slice(1).map(() => path.height), width: path.width });
    positions.push(...soup);
    for (let i = 0; i < soup.length / 9; i += 1) triangles.push(20);
    for (let k = 1; k < path.points.length; k += 1) volume += path.width * path.height * Math.hypot(...path.points[k]!.map((v, i) => v - path.points[k - 1]![i]!));
  }
  const faces = [...parent.faces];
  if (!faces.some((face) => face.id === 20)) for (let id = faces.length; id <= 20; id += 1) faces.push({ id, areaMm2: 0 });
  return { ...parent, positions, triangles, faces, volumeMm3: Math.round((parent.volumeMm3 + volume) * 100) / 100 };
}

export async function openPart(page: Page, options: Options = {}): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  if (!options.api) {
    await page.addInitScript((knobs) => {
      (globalThis as { __limeRibPlanFake?: unknown }).__limeRibPlanFake = knobs;
    }, { tickMs: options.tickMs ?? 40, ...(options.beatsNeither ? { beatsNeither: true } : {}), ...(options.refuse ? { refuse: options.refuse } : {}) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const part = options.plate ? openPlate() : openBox();
  const obstacle = block(1.5);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { filename?: string };
    return route.fulfill({ json: { positions: String(body.filename).startsWith("block") ? obstacle.positions : part.positions } });
  });
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => (String(request.filename).startsWith("block") ? obstacle : options.surfaces ? { ...part, solid: false } : part),
    apply(request, parent) {
      const op = request.op as Body;
      if (op.kind !== "group") return parent;
      if (options.applyError) return { error: options.applyError };
      return withRibs(parent, op);
    },
    probe: () => ({ ok: true }),
  });
  if (options.stress) {
    // The desktop study solve, answered: the part before the ribs bends 0.4 mm, after them 0.1 mm.
    const replies = [mockReply().replace("\"maxDisplacementMm\":0.1", "\"maxDisplacementMm\":0.4"), mockReply()];
    await page.addInitScript((texts: string[]) => {
      const bag = window as unknown as { __limeSimStudy?: (body: string) => string; __limeSimBodies?: string[] };
      bag.__limeSimBodies = [];
      bag.__limeSimStudy = (body: string) => {
        bag.__limeSimBodies!.push(body);
        return texts[(bag.__limeSimBodies!.length - 1) % 2]!;
      };
    }, replies);
  }
  if (options.api) {
    const api = options.api;
    await page.route("**/api/ribs/**", async (route) => {
      const url = route.request().url().replace(/^https?:\/\/[^/]+/, api);
      const res = await route.fetch({ url, timeout: 120_000 });
      await route.fulfill({ status: res.status(), headers: res.headers(), body: await res.body() });
    });
  }
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "cover.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
  if (options.obstacle) {
    await page.locator("#plateAddFile").setInputFiles({ name: "block.step", mimeType: "model/step", buffer: FILE });
    await expect(page.locator("#objectList .obj")).toHaveCount(2);
    await page.locator("#objectList .obj").first().click();
  }
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText(options.surfaces ? "Surfaces only" : "Volume");
  return tree;
}

export const readout = (page: Page) => page.locator("#modelReadout");
export const cardBox = (page: Page) => page.locator("#modelAutoRibs");
export const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");
export const primary = (page: Page) => page.locator("#modelApply");

/** Where a face can be clicked. "Face 7" is the box floor; "Face 1" is the plate. */
export async function findFace(page: Page, readoutPrefix: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator("#model").boundingBox())!;
  for (let row = 0; row < 16; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      const x = box.x + box.width * (0.3 + col * 0.025);
      const y = box.y + box.height * (0.3 + row * 0.025);
      await page.mouse.click(x, y);
      if (new RegExp(`^${readoutPrefix} `).test(await readout(page).innerText())) {
        await page.keyboard.press("Escape");
        return { x, y };
      }
    }
  }
  throw new Error(`${readoutPrefix} was not found on screen`);
}

/** Where the floor can be clicked: a scan in Face mode, read from the readout ("Face 7" is face 6). */
export async function findFloor(page: Page): Promise<{ x: number; y: number }> {
  return findFace(page, "Face 7");
}

export async function openCard(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuAutoRibs").click();
  await expect(cardBox(page)).toBeVisible();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Auto ribs");
}

export async function shot(page: Page, name: string) {
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name) });
}

export type PanelRun = { phase: string; stage: string | null; fraction: number; ribs: number; plan: { ribs: number; stoppedEarly: boolean } | null; removed: number[] };
export const panelRun = (page: Page) => page.evaluate(() => (globalThis as unknown as { __limeAutoRibs: { run(): PanelRun } }).__limeAutoRibs.run());
export const planRibs = (page: Page) => page.evaluate(() => (globalThis as unknown as { __limeAutoRibs: { faceRibs(): { points: V[]; heights: number[] }[] } }).__limeAutoRibs.faceRibs());

