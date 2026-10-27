import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A box the modeler reports as a solid, from `min`. */
function boxSolid(size: V, min: V = [0, 0, 0]): MockSolid {
  const c = (x: number, y: number, z: number): V => [min[0] + x * size[0], min[1] + y * size[1], min[2] + z * size[2]];
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
  return { volumeMm3: size[0] * size[1] * size[2], positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [] };
}

/** The box a mock solid spans. */
function boxOf(solid: MockSolid): { min: V; max: V } {
  const min: V = [Infinity, Infinity, Infinity];
  const max: V = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < solid.positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, solid.positions[i + k]!);
      max[k] = Math.max(max[k]!, solid.positions[i + k]!);
    }
  }
  return { min, max };
}

/** A 500 mm bar: the Lime 220's 210 mm usable length takes three pieces. */
const BAR = boxSolid([500, 20, 20]);
const FILE = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");

type Placed = { id: string; type: string };
type Cut = { origin: V; normal: V; connectors?: { on?: boolean; placed?: Placed[] } };

/** The connectors a stored op placed, every cut's, as the kernel would build them all. */
const placedOf = (cuts: Cut[]) => cuts.flatMap((cut) => (cut.connectors?.on ? (cut.connectors.placed ?? []) : []));

/** The pins of `count` dowels: 6 × 6 × 8 mm posts standing in a row, as one solid. */
function pinsSolid(count: number): MockSolid {
  const posts = Array.from({ length: count }, (_, at) => boxSolid([6, 6, 8], [at * 9, 40, 0]));
  return {
    volumeMm3: posts.reduce((sum, post) => sum + post.volumeMm3, 0),
    positions: posts.flatMap((post) => post.positions),
    triangles: posts.flatMap((post, at) => post.triangles.map((face) => face + 6 * at)),
    faces: posts.flatMap((post, at) => post.faces.map((face) => ({ ...face, id: face.id + 6 * at }))),
    edges: [],
  };
}

/** The boxes between the cuts across the axis they are square to, as the kernel orders them: negative side first. */
function piecesOf(parent: MockSolid, cuts: Cut[]): MockSolid[] {
  const { min, max } = boxOf(parent);
  const axis = [0, 1, 2].reduce((best, i) => (Math.abs(cuts[0]!.normal[i]!) > Math.abs(cuts[0]!.normal[best]!) ? i : best), 0);
  const stops = cuts.map((cut) => cut.origin[axis]!).sort((a, b) => a - b);
  const bounds = [min[axis]!, ...stops, max[axis]!];
  return bounds.slice(1).map((hi, k) => {
    const size: V = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const from: V = [min[0], min[1], min[2]];
    size[axis] = hi - bounds[k]!;
    from[axis] = bounds[k]!;
    return boxSolid(size, from);
  });
}

function built(request: Body, parent: MockSolid): Built {
  const op = request.op as { kind: string; cuts?: Cut[]; op?: string; origin?: V; size?: V };
  if (op.kind === "partition") {
    const [kept, ...pieces] = piecesOf(parent, op.cuts!);
    const placed = placedOf(op.cuts!);
    const dowels = placed.filter((row) => row.type === "dowel").length;
    const joints = placed.length > 0 ? { connectors: { placed: placed.map((row) => ({ id: row.id, at: [0, 0, 0], teardrop: true })), dropped: [] } } : {};
    return { kept: kept!, pieces, ...(dowels > 0 ? { pins: pinsSolid(dowels) } : {}), ...joints };
  }
  // A Boolean cut takes its box out of the part, and misses a part it does not reach.
  if (op.kind === "boolean" && op.origin && op.size) {
    const { min, max } = boxOf(parent);
    if (op.origin[0] >= max[0] || op.origin[0] + op.size[0] <= min[0]) return { error: "The tool misses the solid" };
    return { ...parent, volumeMm3: parent.volumeMm3 - op.size[0] * op.size[1] * op.size[2] };
  }
  return parent;
}

async function openBar(page: Page, compact = false, part: MockSolid = BAR): Promise<TreeMock> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: part.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => part,
    fitCoupon(request) {
      const spec = request.spec as { name: string; holes: unknown[]; pins: unknown[] };
      const file = (text: string) => ({ stepB64: Buffer.from(`ISO-10303-21;\n/* ${text} */\nEND-ISO-10303-21;\n`).toString("base64"), volumeMm3: 1000, solids: 1 });
      return { plate: file(spec.name), pins: spec.pins.length > 0 ? file(`${spec.name}-pins`) : null, engravedMm3: 4.2 };
    },
    apply: built,
    probe(request, on) {
      const op = request.op as { kind: string; cuts?: Cut[] };
      if (op.kind !== "partition") return { ok: true };
      const parts = piecesOf(on, op.cuts!).map((piece) => ({ volumeMm3: piece.volumeMm3, ...boxOf(piece) }));
      const placed = placedOf(op.cuts!);
      const dowels = placed.filter((row) => row.type === "dowel").length;
      const joints = placed.length > 0 ? { connectors: { placed: placed.map((row) => ({ id: row.id, at: [0, 0, 0], teardrop: true })), dropped: [] }, notes: [] } : {};
      return { ok: true, volumeMm3: parts[0]!.volumeMm3, parts, ...(dowels > 0 ? { pins: { count: dowels, volumeMm3: pinsSolid(dowels).volumeMm3 } } : {}), ...joints };
    },
  });
  await page.goto(compact ? "/?layout=compact" : "/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "bar.step", mimeType: "model/step", buffer: FILE });
  await expect(page.locator("#objectList .obj").first()).toBeAttached();
  await page.locator(compact ? "#compactTabs [data-tab=model]" : "#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  return tree;
}

const readout = (page: Page) => page.locator("#modelReadout");
async function openCard(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuSplitPrint").click();
  await expect(page.locator("#modelPanel")).toBeVisible();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Split to print");
}

// --- Milestone 11: measured fits, entered from the card.
const jointsOn = (page: Page) => page.locator("#modelPartJointsOn");
const fitNote = (page: Page) => page.locator("#modelPartJointFitNote");
const apply = (page: Page) => page.locator("#modelApply");
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/split-fits/${name}.png` });

/** The owner's filament, PETG, on the plate before the part opens in Model. */
async function petgCard(page: Page): Promise<TreeMock> {
  const tree = await openBar(page);
  await page.locator("#tabPrepare").click();
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machineFilament").selectOption("lime-petg");
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  await page.locator("#tabModel").click();
  await expect(readout(page)).toContainText("Volume");
  await openCard(page);
  await jointsOn(page).check();
  await expect(fitNote(page), "PETG's Snug is a starting value").toHaveText("Starting fit. 0.2 mm each side (0.4 mm on the diameter).");
  return tree;
}

const enter = async (page: Page, fit: "snug" | "loose" | "press", label: string) => page.locator(`#modelPartResult-${fit}`).selectOption(label);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("lime-slice-machines") ?? "{}").measuredFits ?? null);

test("Enter coupon results… saves PETG Snug as measured, and the card reads Measured.", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await petgCard(page);
  await page.locator("#modelPartResultsOpen").click();
  await expect(page.locator("#modelPartResultsRow"), "it opens on the plate's filament").toHaveValue("petg");
  const options = await page.locator("#modelPartResult-snug option").allTextContents();
  expect(options, "the engraved labels of the coupon around PETG's Snug").toEqual(["Not entered", "0.10 mm", "0.15 mm", "0.20 mm", "0.25 mm", "0.30 mm", "0.35 mm", "0.40 mm", "Other…"]);
  await enter(page, "snug", "0.15");
  await page.locator("#modelPartResultsSave").click();
  await expect(page.locator("#modelPartResultsNote")).toHaveText("Saved for PETG: Snug 0.15 mm each side. New cuts use it; cuts already applied keep their clearance.");
  await expect(fitNote(page)).toHaveText("Measured. 0.15 mm each side (0.3 mm on the diameter).");
  await page.locator("#modelPartJointFit").selectOption("loose");
  await expect(fitNote(page), "the cells not entered stay starting values").toHaveText("Starting fit. 0.3 mm each side (0.6 mm on the diameter).");
  await page.locator("#modelPartJointFit").selectOption("snug");
  expect(await stored(page), "kept in the machine library, so it outlasts the project").toEqual({ cells: { petg: { snug: 0.15 } } });
  await page.locator("#modelPartResultsOpen").click();
  await page.locator("#modelPartResultsOpen").click();
  await expect(page.locator("#modelPartResult-snug"), "reopening shows what was saved").toHaveValue("0.15");
  if ((await page.locator("#modelPartHowOpen").getAttribute("aria-expanded")) === "true") await page.locator("#modelPartHowOpen").click();
  await page.locator("#modelPartResultsSave").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, "enter-results");
});

test("a typed label is entered through Other…, and a refusal is a sentence", async ({ page }) => {
  await petgCard(page);
  await page.locator("#modelPartResultsOpen").click();
  await page.locator("#modelPartResultsSave").click();
  await expect(page.locator("#modelPartResultsNote")).toContainText("Give at least one of snug, loose, press");
  await enter(page, "press", "other");
  await page.locator("#modelPartResultValue-press").fill("0.07");
  await page.locator("#modelPartResultsSave").click();
  await page.locator("#modelPartJointFit").selectOption("press");
  await expect(fitNote(page)).toHaveText("Measured. 0.07 mm each side (0.14 mm on the diameter).");
});

test("a cut made after entering results stores the measured clearance", async ({ page }) => {
  const tree = await petgCard(page);
  await page.locator("#modelPartResultsOpen").click();
  await enter(page, "snug", "0.15");
  await page.locator("#modelPartResultsSave").click();
  await expect(fitNote(page)).toHaveText("Measured. 0.15 mm each side (0.3 mm on the diameter).");
  await apply(page).click();
  await expect.poll(() => tree.of("apply").length).toBeGreaterThan(0);
  const op = tree.of("apply").at(-1)!.op as { cuts: { connectors: { types: { clearance: number }[] } }[] };
  expect(op.cuts[0]!.connectors.types[0]!.clearance, "the stored op holds the number, so a later entry cannot move it").toBe(0.15);
});

test("Reset to starting values puts the row's starting fit back", async ({ page }) => {
  await petgCard(page);
  await page.locator("#modelPartResultsOpen").click();
  await enter(page, "snug", "0.15");
  await page.locator("#modelPartResultsSave").click();
  await expect(fitNote(page)).toHaveText("Measured. 0.15 mm each side (0.3 mm on the diameter).");
  await page.locator("#modelPartResultsReset").click();
  await expect(page.locator("#modelPartResultsNote")).toHaveText("Back to the starting values for PETG.");
  await expect(fitNote(page)).toHaveText("Starting fit. 0.2 mm each side (0.4 mm on the diameter).");
  await expect(page.locator("#modelPartResult-snug")).toHaveValue("");
  expect(await stored(page)).toBeNull();
});

test("a resin entry also takes the thinnest wall that held", async ({ page }) => {
  await openBar(page);
  await openCard(page);
  await page.locator("#modelPartTarget").selectOption("formlabs-form-4");
  await jointsOn(page).check();
  await page.locator("#modelPartResultsOpen").click();
  await expect(page.locator("#modelPartResultsRow")).toHaveValue("resin");
  await expect(page.locator("#modelPartResultWall")).toBeVisible();
  await enter(page, "snug", "0.10");
  await page.locator("#modelPartResultWall").fill("0.6");
  await page.locator("#modelPartResultsSave").click();
  await expect(fitNote(page)).toHaveText("Measured. 0.1 mm each side (0.2 mm on the diameter).");
  expect(await stored(page)).toEqual({ cells: { resin: { snug: 0.1 } }, resinFeatureMm: 0.6 });
});
