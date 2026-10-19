import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 box `h` tall, with its twelve edges, as the modeler reports a solid. */
function boxSolid(h: number, volumeMm3 = 400 * h): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * h];
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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const [pa, pb] = [corners[a!]!, corners[b!]!];
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

const heightOf = (solid: MockSolid) => Math.max(...solid.positions.filter((_, i) => i % 3 === 2));

function build(request: Body, parent: MockSolid): Built {
  const op = request.op as { kind: string; size?: number[] | number };
  if (op.kind === "boolean") return boxSolid((op.size as number[])[0]!);
  if (op.kind === "fillet" || op.kind === "chamfer") {
    const size = op.size as number;
    if (size >= heightOf(parent) / 4) return { error: "The fillet did not fit this edge" };
    return { ...boxSolid(heightOf(parent)), volumeMm3: parent.volumeMm3 - 10 * size };
  }
  return { error: `unexpected ${op.kind}` };
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid(10);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: build,
    probe: (request, on) => {
      const built = build(request, on);
      return "error" in built ? { ok: false, error: built.error } : { ok: true };
    },
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  return tree;
}

const row = (page: Page, label: string) => page.getByRole("treeitem", { name: new RegExp(`^${label}`) });

/** Pick one edge so Fillet can open. A step then replaces that pick. */
async function pickEdge(page: Page) {
  await page.locator("#modelPickEdge").click();
  const box = (await page.locator("#model").boundingBox())!;
  for (let r = 0; r < 9; r += 1) {
    for (let col = 0; col < 9; col += 1) {
      await page.mouse.click(box.x + box.width * (0.18 + col * 0.08), box.y + box.height * (0.18 + r * 0.08));
      if (/Edge \d+/.test(await page.locator("#modelReadout").innerText())) return;
    }
  }
  throw new Error("no edge under the scan");
}

test("fillet can take the convex edges a history step made, by a row or a typed number", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill("8");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3200 mm³");
  await expect(page.locator("#modelPanel")).toBeHidden();

  await pickEdge(page);
  await page.locator("#modelToolFillet").click();
  await expect(page.locator("#modelEdgesPicked")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#modelEdgesStep").click();
  await expect(page.locator("#modelEdgeNode")).toHaveValue("1");
  await expect(page.locator("#modelEdgeOf")).toHaveText("Edges of: Cut box 8×10×10 (all)");
  await expect.poll(() => tree.of("stepEdges").length).toBeGreaterThan(0);

  await page.locator("#modelEdgeNode").fill("0");
  await expect(page.locator("#modelEdgeOf")).toHaveText("Edges of: plate.step (all)");
  await row(page, "Cut box 8").locator(".mh-label").click();
  await expect(page.locator("#modelEdgeNode")).toHaveValue("1");
  await expect(page.locator("#modelEdgeOf")).toHaveText("Edges of: Cut box 8×10×10 (all)");
  await expect(page.locator("#modelReadout")).toContainText("Volume 3200 mm³");

  await page.locator("#modelEdgeConvex").click();
  await expect(page.locator("#modelEdgeOf")).toHaveText("Edges of: Cut box 8×10×10 (convex)");
  await expect(page.locator("#modelApply")).toBeEnabled();
  const applies = tree.of("apply").length;
  await page.locator("#modelApply").click();
  await expect.poll(() => tree.of("apply").length).toBe(applies + 1);
  expect(tree.of("apply").at(-1)?.op).toEqual({ kind: "fillet", edges: [{ fromNode: 1, filter: "convex" }], size: 1 });
  await expect(page.locator("#modelReadout")).toContainText("Fillet. Volume 3190 mm³");

  await row(page, "Fillet convex edges of node 1").locator(".mh-edit").click();
  await expect(page.locator("#modelEditHead")).toContainText("Fillet convex edges of node 1");
  await expect(page.locator("#modelEdgesStep")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelEdgeNode")).toHaveValue("1");
  await expect(page.locator("#modelEdgeConvex")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelEdgeOf")).toHaveText("Edges of: Cut box 8×10×10 (convex)");
  await expect(page.locator("#modelReadout")).toContainText("Edges of: Cut box 8×10×10 (convex)");
});

test("the step list follows Undo and Redo while Fillet is open", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill("8");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3200 mm³");

  await pickEdge(page);
  await page.locator("#modelToolFillet").click();
  await page.locator("#modelEdgesStep").click();
  await expect(page.locator("#modelEdgeNode")).toHaveValue("1");
  await expect(page.locator("#modelEdgeStep option")).toHaveText(["plate.step", "Cut box 8×10×10"]);

  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await expect(page.locator("#modelEdgeStep option"), "the undone step leaves the list").toHaveText(["plate.step"]);
  await expect(page.locator("#modelEdgeOf")).toHaveText("Step 1 is not on this solid. Pick this step or one above it.");
  await expect(page.locator("#modelApply")).toBeDisabled();

  await page.locator("#modelRedo").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3200 mm³");
  await expect(page.locator("#modelEdgeStep option")).toHaveText(["plate.step", "Cut box 8×10×10"]);
  await expect(page.locator("#modelEdgeOf")).toHaveText("Edges of: Cut box 8×10×10 (all)");
  await expect(page.locator("#modelApply")).toBeEnabled();
});
