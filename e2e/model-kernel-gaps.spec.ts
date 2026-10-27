import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type Built, type MockSolid, type TreeMock } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 × 10 box from the origin with its twelve edges. Face 1 is the top. */
function boxSolid(volumeMm3 = 4000): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 20, y * 20, z * 10];
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 400 })), edges };
}

/** A rect pocket takes out its rounded footprint; a chamfer by two sizes ½ · a · b along a 20 mm edge. */
function build(request: Body, parent: MockSolid): Built {
  const op = request.op as { kind: string; size?: number; size2?: number; angleDeg?: number; source?: { width: number; height: number; depth: number; cornerRadius?: number } };
  if (op.kind === "group" && op.source) {
    const { width, height, depth, cornerRadius = 0 } = op.source;
    return boxSolid(Math.round(parent.volumeMm3 - (width * height - (4 - Math.PI) * cornerRadius ** 2) * depth));
  }
  if (op.kind === "chamfer") {
    const a = op.size ?? 0;
    const b = op.size2 ?? (op.angleDeg !== undefined ? a * Math.tan((op.angleDeg * Math.PI) / 180) : a);
    return boxSolid(Math.round((parent.volumeMm3 - 0.5 * a * b * 20) * 100) / 100);
  }
  return { error: `unexpected ${op.kind}` };
}

async function openModel(page: Page): Promise<TreeMock> {
  const root = boxSolid();
  await page.setViewportSize({ width: 1440, height: 900 });
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

async function pickFace(page: Page) {
  const [x, y, w, h] = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const box = (await page.locator("#model").boundingBox())!;
  await page.mouse.click(box.x + x! + w! * 0.5, box.y + y! + h! * 0.5);
}

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

test("a rect pocket takes a corner radius in its one cut, and an edit reopens it", async ({ page }) => {
  const tree = await openModel(page);
  await page.locator("#modelToolFeatures").click();
  await pickFace(page);
  await expect(page.locator("#modelReadout")).toContainText("Face");
  const corner = page.locator("#modelFeatR");
  await expect(corner).toBeVisible();
  await expect(corner).toHaveValue("0");
  await page.locator("#modelFeatShape [data-shape=circle]").click();
  await expect(corner).toBeHidden();
  await page.locator("#modelFeatShape [data-shape=arch]").click();
  await expect(corner).toBeHidden();
  await page.locator("#modelFeatShape [data-shape=rect]").click();
  await expect(corner).toBeVisible();
  await corner.fill("2");
  await corner.dispatchEvent("input");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText(`Volume ${Math.round(4000 - (100 - (4 - Math.PI) * 4) * 2)} mm³`);
  const op = tree.of("apply").at(-1)!.op as { label: string; source: { cornerRadius?: number }; steps: { kind: string; op: string; cornerRadius?: number; merge?: boolean }[] };
  expect(op.source.cornerRadius).toBe(2);
  expect(op.label).toBe("Pocket 10 × 10 r 2");
  expect(op.steps).toHaveLength(1);
  expect(op.steps[0]).toMatchObject({ kind: "boolean", op: "cut", primitive: "box", cornerRadius: 2, merge: true });
  await expect(page.locator("#modelHistoryTree [role=treeitem]").nth(1)).toContainText("Pocket 10 × 10 r 2");

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(corner).toHaveValue("2");
});

test("a chamfer takes two sizes or a size and an angle, flips its sides, and reopens as it was", async ({ page }) => {
  const tree = await openModel(page);
  await pickEdge(page);
  await page.locator("#modelToolChamfer").click();
  const form = (name: string) => page.locator(`#modelChamferForm [data-chamfer-form=${name}]`);
  await expect(form("equal")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelChamfer2")).toBeHidden();
  await expect(page.locator("#modelChamferAngle")).toBeHidden();
  await expect(page.locator("#modelChamferFlip")).toBeHidden();

  await form("two").click();
  await expect(form("two")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelChamfer2")).toBeVisible();
  await expect(page.locator("#modelChamferAngle")).toBeHidden();
  await expect(page.locator("#modelChamferSide")).toHaveText("Size runs along each edge's upper face.");
  await page.locator("#modelBlend").fill("2.7");
  await page.locator("#modelChamfer2").fill("5");
  await page.locator("#modelChamfer2").dispatchEvent("input");
  await expect.poll(() => (tree.of("probe").at(-1)?.op as { size2?: number } | undefined)?.size2).toBe(5);
  await page.locator("#modelChamferFlip").check();
  await expect(page.locator("#modelChamferSide")).toHaveText("Size runs along each edge's lower face.");
  await expect.poll(() => (tree.of("probe").at(-1)?.op as { flip?: boolean } | undefined)?.flip).toBe(true);
  await page.locator("#modelChamferFlip").uncheck();
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 3865 mm³");
  const two = tree.of("apply").at(-1)!.op as Record<string, unknown>;
  expect(two).toMatchObject({ kind: "chamfer", size: 2.7, size2: 5 });
  expect(two.flip).toBeUndefined();
  expect(two.angleDeg).toBeUndefined();
  await expect(page.locator("#modelHistoryTree [role=treeitem]").nth(1)).toContainText("Chamfer 1 edge 2.7 × 5");

  await page.keyboard.press("Shift+E");
  await expect(page.locator("#modelApply")).toHaveText("Update");
  await expect(form("two")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelBlend")).toHaveValue("2.7");
  await expect(page.locator("#modelChamfer2")).toHaveValue("5");
  await form("angle").click();
  await expect(page.locator("#modelChamfer2")).toBeHidden();
  await expect(page.locator("#modelChamferAngle")).toBeVisible();
  await page.locator("#modelBlend").fill("2");
  await page.locator("#modelChamferAngle").fill("45");
  await page.locator("#modelChamferAngle").dispatchEvent("input");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect.poll(() => (tree.of("edit").at(-1)?.op as { angleDeg?: number } | undefined)?.angleDeg).toBe(45);
  const angled = tree.of("edit").at(-1)!.op as Record<string, unknown>;
  expect(angled).toMatchObject({ kind: "chamfer", size: 2, angleDeg: 45 });
  expect(angled.size2).toBeUndefined();
  await expect(page.locator("#modelHistoryTree [role=treeitem]").filter({ hasText: "Chamfer 1 edge 2 at 45°" })).toHaveCount(1);
});
