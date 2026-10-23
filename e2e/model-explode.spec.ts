import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler reports as a solid, from the origin. */
function boxSolid(size: V): MockSolid {
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
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

const ROOT = boxSolid([60, 20, 10]);
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
const canvas = (page: Page) => page.locator("#model");

/** A split to print in three across X for the Form 4, as the MCP server stores it (plan section 11). */
const PARTITION = {
  kind: "partition",
  cuts: [20, 40].map((x) => ({ origin: [x, 10, 5], normal: [1, 0, 0], u: [0, 1, 0], profile: { kind: "straight" }, connectors: { on: false } })),
  target: { printer: "formlabs-form-4", process: "resin", volumeMm: [200, 125, 210] },
  orient: "keep",
  arrange: false,
  labels: { on: true, face: "cut", height: 4, depth: 0.4 },
  bedMarginMm: 10,
  maxPieces: 12,
};

type SavedObject = { id: string; name: string; modelPose?: { m: number[]; t: number[] }; modelTree?: { nodes: { id: number; op: Body | null; fingerprint: unknown; pieces?: (string | null)[] }[]; rootStep?: unknown } } & Record<string, unknown>;

async function save(page: Page): Promise<{ objects: SavedObject[] } & Record<string, unknown>> {
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  return JSON.parse((await readFile((await download.path())!)).toString("utf8"));
}

/** Every context part's world box from the canvas, `{ id: [minX, minY, minZ, maxX, maxY, maxZ] }`. */
async function contextBoxes(page: Page): Promise<Record<string, number[]>> {
  const raw = (await canvas(page).getAttribute("data-context")) ?? "";
  return Object.fromEntries(raw.split(" ").filter(Boolean).map((entry) => {
    const [id, box] = entry.split(":");
    return [id!, box!.split(",").map(Number)];
  }));
}

test("Explode spreads a split to print's pieces by the gap, numbers them, and saves nothing", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => ROOT, apply: () => boxSolid([20, 20, 10]) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "bar.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();

  // One step, saved; then the step becomes the split to print and the file gains its two pieces. Every plate mesh is
  // the first piece's here, so each piece is posed where it was cut: piece 2 between the cuts, piece 3 past both.
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill("20");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelPanel")).toBeHidden();
  const doc = await save(page);
  const part = doc.objects[0]!;
  const step = part.modelTree!.nodes.find((node) => node.id === 1)!;
  step.op = PARTITION;
  step.pieces = ["bar-2", "bar-3"];
  const piece = (id: string, name: string, x: number): SavedObject => ({
    ...structuredClone(part),
    id,
    name,
    modelPose: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [x, 0, 0] },
    modelTree: { nodes: [{ id: 0, parent: null, op: null, fingerprint: null } as never], current: 0, committed: 0, nextId: 1, rootStep: part.modelTree!.rootStep } as never,
  });
  doc.objects.push(piece("bar-2", "bar part 2", 20), piece("bar-3", "bar part 3", 40));

  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "bar.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("#objectList .obj")).toHaveCount(3);
  await page.locator("#objectList .obj").first().click();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await expect(canvas(page)).toHaveAttribute("data-context-count", "2");
  const before = await contextBoxes(page);
  expect(before["bar-2"]).toEqual([20, 0, 0, 40, 20, 10]);
  expect(before["bar-3"]).toEqual([40, 0, 0, 60, 20, 10]);
  await expect(canvas(page)).not.toHaveAttribute("data-explode", /.*/);

  // Explode lives in the View menu, shown because this part has pieces.
  await page.locator("#modelLookOpen").click();
  await expect(page.locator("#modelExplodeRow")).toBeVisible();
  await page.locator("#modelExplode").check();
  await expect(canvas(page)).toHaveAttribute("data-explode", "10");
  await expect(canvas(page), "piece 1 stays, piece 2 opens one gap, piece 3 two").toHaveAttribute("data-explode-parts", "1:0,0,0 2:10,0,0 3:20,0,0");
  const apart = await contextBoxes(page);
  expect(apart["bar-2"]).toEqual([30, 0, 0, 50, 20, 10]);
  expect(apart["bar-3"]).toEqual([60, 0, 0, 80, 20, 10]);
  await expect(page.locator(".model-part-tag"), "each piece shows its number").toHaveText(["1", "2", "3"]);
  await expect(canvas(page)).toHaveAttribute("data-tags", "1 2 3");

  // A typed gap moves them again.
  await page.locator("#modelExplodeGap").fill("25");
  await expect(canvas(page)).toHaveAttribute("data-explode", "25");
  await expect(canvas(page)).toHaveAttribute("data-explode-parts", "1:0,0,0 2:25,0,0 3:50,0,0");
  const wider = await contextBoxes(page);
  expect(wider["bar-2"]![0]! - before["bar-2"]![0]!).toBe(25);
  expect(wider["bar-3"]![0]! - before["bar-3"]![0]!).toBe(50);

  // Off, the pieces are back where they were cut, and the tags go.
  await page.locator("#modelExplode").uncheck();
  await expect(canvas(page)).not.toHaveAttribute("data-explode", /.*/);
  await expect(page.locator(".model-part-tag")).toHaveCount(0);
  expect(await contextBoxes(page)).toEqual(before);

  // Explode is a view: on again, then saved, the file is the file opened, poses and all.
  await page.locator("#modelExplode").check();
  await expect(canvas(page)).toHaveAttribute("data-explode", "25");
  await page.keyboard.press("Escape");
  const again = await save(page);
  expect(again.objects.map((obj) => [obj.id, obj.modelPose ?? null])).toEqual([
    [part.id, part.modelPose ?? null],
    ["bar-2", { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [20, 0, 0] }],
    ["bar-3", { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [40, 0, 0] }],
  ]);
  expect(again.objects[0]!.modelTree!.nodes.find((node) => node.id === 1)!.op).toEqual(PARTITION);
});

test("Explode is hidden for a part without a split to print", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, { open: () => ROOT });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "bar.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
  await page.locator("#modelLookOpen").click();
  await expect(page.locator("#modelLookPanel")).toBeVisible();
  await expect(page.locator("#modelExplodeRow")).toBeHidden();
});
