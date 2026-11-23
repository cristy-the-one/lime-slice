import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

/** One open quad: a sheet the modeler reports as not a solid, with one naked edge. */
function sheet(): MockSolid {
  const corners: V[] = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]];
  const positions = [...corners[0]!, ...corners[1]!, ...corners[2]!, ...corners[0]!, ...corners[2]!, ...corners[3]!];
  return {
    volumeMm3: 0,
    positions,
    triangles: [0, 0],
    faces: [{ id: 0, areaMm2: 400 }],
    edges: [{ id: 0, lengthMm: 20, points: [...corners[0]!, ...corners[1]!] }],
    solid: false,
    nakedEdges: [0],
  };
}

/** The same quad, closed, after Thicken or Cap & Sew. */
function closed(): MockSolid {
  const open = sheet();
  return { ...open, volumeMm3: 800, solid: true, nakedEdges: [] };
}

/** A 20 x 20 x 10 box, as the modeler reports a solid. */
function box(): MockSolid {
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
  return { volumeMm3: 4000, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges: [{ id: 0, lengthMm: 20, points: [0, 0, 0, 20, 0, 0] }] };
}

async function load(page: Page, root: MockSolid) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: root.positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: () => root,
    apply: (request) => {
      const kind = (request.op as Body | undefined)?.kind;
      // The stand-in for a step that leaves an open sheet (a real one is a patch, a split, an unclosed sew).
      if (kind === "boolean") return sheet();
      if (kind === "thicken" || kind === "sew") return closed();
      return { error: `unexpected ${String(kind)}` };
    },
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "roof.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  return tree;
}

/** A box, then a step that leaves an open sheet: the notice shows. */
async function openSheet(page: Page) {
  const tree = await load(page, box());
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await page.locator("#modelToolBoolean").click();
  await page.locator("#modelCut").click();
  await page.locator("#modelDx").fill("8");
  await expect(page.locator("#modelApply")).toBeEnabled();
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelSheetBar")).toBeVisible();
  await expect(page.locator("#modelSheetText")).toContainText("1 open border");
  await expect(page.locator("#modelHistoryTree .mh-sheet")).toHaveText("Sheet");
  return tree;
}

test("a STEP that opens as surfaces only is no sheet: no notice, and leaving Model commits it as before", async ({ page }) => {
  await load(page, sheet());
  await expect(page.locator("#modelReadout")).toBeVisible();
  await expect(page.locator("#modelSheetBar")).toBeHidden();
  await expect(page.locator("#modelHistoryTree .mh-sheet")).toHaveCount(0);
  await page.locator("#tabPrepare").click();
  await page.locator("#tabModel").click();
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#toasts")).not.toContainText("open sheet");
});

test("a step that leaves an open sheet is held off the plate, with a toast", async ({ page }) => {
  await openSheet(page);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#toasts")).toContainText("This part is an open sheet.");
});

test("an open sheet thickens from the notice", async ({ page }) => {
  const tree = await openSheet(page);
  await expect(page.locator("#modelSheetThickenGo")).toBeVisible();
  await expect(page.locator("#modelSheetSewGo")).toBeVisible();
  await page.locator("#modelSheetThickenMm").fill("2.4");
  await page.locator("#modelSheetThickenGo").click();
  await expect.poll(() => tree.of("apply").length).toBe(2);
  expect(tree.of("apply")[1]?.op).toEqual({ kind: "thicken", thickness: 2.4 });
  await expect(page.locator("#modelSheetBar")).toBeHidden();
});

test("an open sheet caps and sews from the notice", async ({ page }) => {
  const tree = await openSheet(page);
  await page.locator("#modelSheetSewGo").click();
  await expect.poll(() => tree.of("apply").length).toBe(2);
  expect(tree.of("apply")[1]?.op).toEqual({ kind: "sew", capPlanar: true });
  await expect(page.locator("#modelSheetBar")).toBeHidden();
});

/** Click over the viewport until the readout names an edge (the sheet's one border edge). */
async function pickEdge(page: Page) {
  await page.locator("#modelPickEdge").click();
  const box = (await page.locator("#model").boundingBox())!;
  for (let r = 0; r < 13; r += 1) {
    for (let col = 0; col < 13; col += 1) {
      await page.mouse.click(box.x + box.width * (0.14 + col * 0.06), box.y + box.height * (0.14 + r * 0.06));
      if (/Edge \d+/.test(await page.locator("#modelReadout").innerText())) return;
    }
  }
  throw new Error("no edge under the scan");
}

test("a Patch edge badge is one button that a real click cycles G1, G2, G0", async ({ page }) => {
  await openSheet(page);
  await pickEdge(page);
  await page.locator("#modelToolPatch").click();
  const badge = page.locator("#modelEdgeBadges button").first();
  await expect(badge).toHaveText("G1");
  // The same element across two animation frames: the badges are moved each frame, not rebuilt.
  const stable = await page.evaluate(async () => {
    const before = document.querySelector("#modelEdgeBadges button");
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const after = document.querySelector("#modelEdgeBadges button");
    return !!before && before === after && before.isConnected;
  });
  expect(stable).toBe(true);
  // A real mouse click: press and release land on the same button even when frames pass between them.
  const at = (await badge.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.mouse.up();
  await expect(badge).toHaveText("G2");
  await badge.click();
  await expect(badge).toHaveText("G0");
  await badge.click();
  await expect(badge).toHaveText("G1");
});
