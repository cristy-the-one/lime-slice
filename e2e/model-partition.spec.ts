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
const readout = (page: Page) => page.locator("#modelReadout");
const labels = (page: Page) => page.locator("#modelHistoryTree .mh-label");

/** A split to print in three across X, as the MCP server stores it (docs/plan-split-connectors.md, section 11). */
const PARTITION = {
  kind: "partition",
  cuts: [20, 40].map((x) => ({ origin: [x, 10, 5], normal: [1, 0, 0], u: [0, 1, 0], profile: { kind: "straight" }, connectors: { on: false } })),
  target: { printer: "lime-220", process: "fdm", volumeMm: [220, 220, 250] },
  orient: "keep",
  arrange: true,
  bedMarginMm: 5,
  maxPieces: 12,
};

type SavedObject = { id: string; name: string; modelTree?: { nodes: { id: number; op: Body | null; fingerprint: unknown; pieces?: (string | null)[] }[]; rootStep?: unknown } } & Record<string, unknown>;

/** Save from Prepare with Ctrl+S, and the file the app wrote. */
async function save(page: Page): Promise<{ objects: SavedObject[] } & Record<string, unknown>> {
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const { readFile } = await import("node:fs/promises");
  return JSON.parse((await readFile((await download.path())!)).toString("utf8"));
}

test("a saved project with a split to print opens with its row, and its pieces are on the plate", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: ROOT.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, { open: () => ROOT, apply: () => boxSolid([20, 20, 10]) });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "bar.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();

  // A part with one step, saved: then the step becomes the split to print the MCP server would have stored, and the
  // file gains the two pieces it made, each a plate object with its own STEP-rooted tree.
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await page.locator("#modelToolBoolean").click();
  if ((await page.locator("#modelCut").getAttribute("aria-pressed")) !== "true") await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill("20");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelPanel"), "Apply ends the tool").toBeHidden();
  const doc = await save(page);
  const part = doc.objects[0]!;
  const step = part.modelTree!.nodes.find((node) => node.id === 1)!;
  step.op = PARTITION;
  step.pieces = ["bar-2", "bar-3"];
  const piece = (id: string, name: string): SavedObject => ({
    ...structuredClone(part),
    id,
    name,
    modelTree: { nodes: [{ id: 0, parent: null, op: null, fingerprint: null } as never], current: 0, committed: 0, nextId: 1, rootStep: part.modelTree!.rootStep } as never,
  });
  doc.objects.push(piece("bar-2", "bar part 2"), piece("bar-3", "bar part 3"));

  await page.reload();
  const opens = tree.of("open").length;
  await page.locator("#projectFile").setInputFiles({ name: "bar.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("#objectList .obj"), "the part and both pieces are on the plate").toHaveCount(3);
  await expect(page.locator("#objectList .obj").nth(1)).toContainText("bar part 2");
  await expect(page.locator("#objectList .obj").nth(2)).toContainText("bar part 3");

  await page.locator("#objectList .obj").first().click();
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await expect(labels(page), "the history shows the row").toHaveText(["bar.step", "Split to print, 3 parts"]);
  const row = page.getByRole("treeitem", { name: /^Split to print, 3 parts/ });
  await row.hover();
  await expect(row.locator(".mh-edit"), "its pencil reopens the Split to print card").toBeVisible();
  expect(tree.calls.slice(opens).some((request) => (request.op as Body | undefined)?.kind === "partition" && request.call === "apply"), "nothing is cut again").toBe(false);

  // Saved again, the step still names both pieces by their plate objects.
  const again = await save(page);
  const kept = again.objects[0]!.modelTree!.nodes.find((node) => node.id === 1)!;
  expect(kept.op, "the op is kept as stored").toEqual(PARTITION);
  expect(kept.pieces, "with its pieces' objects").toEqual(["bar-2", "bar-3"]);
});
