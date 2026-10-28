import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
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
  const op = request.op as { kind: string; source?: { width: number; height: number; depth: number; cornerRadius?: number } };
  if (op.kind === "group" && op.source) {
    const { width, height, depth, cornerRadius = 0 } = op.source;
    return boxSolid(Math.round(parent.volumeMm3 - (width * height - (4 - Math.PI) * cornerRadius ** 2) * depth));
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


const shots = process.env.SMALL_UI_SHOTS ?? "test-results/small-ui";
const LONG = "assembly_front_housing_left_hinge_bracket_piece_03_of_12.stl";

async function shot(page: Page, name: string) {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name) });
}

async function plateOfTwo(page: Page, name = LONG) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#plateAdd").click();
  await (await chooser).setFiles({ name, mimeType: "model/stl", buffer: fs.readFileSync(path.resolve("samples/overhang_ledge.stl")) });
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
}

async function typeInto(page: Page, id: string, value: string, key: "Enter" | "Tab") {
  const field = page.locator(id);
  await field.fill(value);
  await field.press(key);
}

for (const key of ["Enter", "Tab"] as const) {
  test(`the overlap row follows a typed X and Y (${key})`, async ({ page }) => {
    await plateOfTwo(page);
    await page.locator("[data-plate-select='part']").click();
    const cx = await page.locator("#placeX").inputValue();
    const cy = await page.locator("#placeY").inputValue();
    await page.locator("[data-plate-id]:not([data-plate-id='part']) [data-plate-select]").click();
    await expect(page.locator("#plateOverlap")).toHaveCount(0);

    await typeInto(page, "#placeX", cx, key);
    await typeInto(page, "#placeY", cy, key);
    await expect(page.locator("#plateOverlap"), "typed onto the cube's spot, the two overlap").toBeVisible();
    await expect(page.locator("#plateOverlap")).toContainText("overlaps");
    await shot(page, `overlap-after-${key}.png`);

    await typeInto(page, "#placeX", "200", key);
    await expect(page.locator("#plateOverlap"), "typed clear of the cube, the row goes").toHaveCount(0);

    await typeInto(page, "#placeX", cx, key);
    await expect(page.locator("#plateOverlap"), "typed back, the row returns").toBeVisible();
  });
}

test("a long object name wraps in its row and keeps the tools reachable", async ({ page }) => {
  await plateOfTwo(page);
  const row = page.locator("[data-plate-id]:not([data-plate-id='part'])");
  const name = row.locator(".obj-select b");
  const fits = await name.evaluate((el) => ({ clipped: el.scrollHeight > el.clientHeight + 1, lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)), width: el.clientWidth }));
  expect(fits.clipped, "no part of the name is cut off").toBe(false);
  expect(fits.width, "the name has the row's width, not a few letters").toBeGreaterThan(150);
  expect(fits.lines).toBeGreaterThan(1);
  expect(await row.locator(".obj-select").getAttribute("data-tip")).toContain(LONG);
  const rowBox = (await row.boundingBox())!;
  for (const tool of ["check", "frame", "remove"]) {
    const button = row.locator(`.obj-${tool}`);
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
  }
  await row.locator(".obj-frame").click();
  await shot(page, "name-after.png");
  const absurd = "x".repeat(200) + ".stl";
  await page.evaluate((text) => {
    const b = document.querySelector("[data-plate-id]:not([data-plate-id='part']) .obj-select b")!;
    b.textContent = text;
  }, absurd);
  const clamped = await name.evaluate((el) => el.clientHeight <= 3 * parseFloat(getComputedStyle(el).lineHeight) + 1);
  expect(clamped, "a name of any length stops at three lines").toBe(true);
});

test("a rounded pocket previews with its rounded corners while it is set up", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolFeatures").click();
  await pickFace(page);
  await expect(page.locator("#modelReadout")).toContainText("Face");
  const ghostTriangles = () => page.locator("#model").getAttribute("data-ghost-triangles");
  await expect.poll(ghostTriangles, "a sharp pocket's tool is a box: 12 triangles").toBe("12");
  await shot(page, "pocket-sharp.png");
  const corner = page.locator("#modelFeatR");
  await corner.fill("3");
  await corner.dispatchEvent("input");
  await expect.poll(async () => Number(await ghostTriangles()), "the rounded pocket's tool has arcs at its corners").toBeGreaterThan(100);
  await shot(page, "pocket-rounded.png");
  await corner.fill("0");
  await corner.dispatchEvent("input");
  await expect.poll(ghostTriangles).toBe("12");
});
