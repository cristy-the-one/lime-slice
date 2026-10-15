import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

const shots = path.resolve("artifacts/workplane");
fs.mkdirSync(shots, { recursive: true });

type V = [number, number, number];

/** A 20 x 20 x 10 mm box as the modeler reports it. */
function boxSolid() {
  const [sx, sy, sz] = [20, 20, 10];
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
  const corners: V[] = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edges = pairs.map(([a, b], id) => {
    const pa = corners[a!]!;
    const pb = corners[b!]!;
    return { id, lengthMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), points: [...pa, ...pb] };
  });
  return { volumeMm3: sx * sy * sz, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 0 })), edges };
}

async function openModel(page: Page) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume");
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function grips(page: Page): Promise<Record<string, { x: number; y: number }>> {
  const text = (await page.locator("#model").getAttribute("data-handles")) ?? "";
  const box = (await page.locator("#model").boundingBox())!;
  const map: Record<string, { x: number; y: number }> = {};
  for (const item of text.split(" ").filter(Boolean)) {
    const [id, at] = item.split(":");
    const [x, y] = at!.split(",").map(Number);
    map[id!] = { x: box.x + x!, y: box.y + y! };
  }
  return map;
}

async function drag(page: Page, id: string, dx: number, dy: number) {
  await expect.poll(async () => Object.keys(await grips(page))).toContain(id);
  const from = (await grips(page))[id]!;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
}

const value = async (page: Page, id: string) => Number(await page.locator(`#${id}`).inputValue());

test("the workplane frame is numeric and dragged, and a tilt stands the part up", async ({ page }) => {
  await openModel(page);
  await page.locator("#modelToolPlane").click();
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "plane");
  await expect(page.locator("#modelCancel")).toHaveText("Done");
  await expect(page.locator("#modelApply")).toBeHidden();
  await expect(page.locator("#modelWpU")).toBeVisible();
  await expect(page.locator("#model")).toHaveAttribute("data-workplane", "global:0.00,0.00,0.00:0.00,0.00,0.00");
  await expect(page.locator("#model")).toHaveAttribute("data-datum-pick", "1");
  await expect.poll(async () => Object.keys(await grips(page))).toEqual(expect.arrayContaining(["wp-u", "wp-v", "wp-w"]));

  const canvas = (await page.locator("#model").boundingBox())!;
  const body = (await page.locator("#modelBody").boundingBox())!;
  expect(canvas.width / body.width).toBeGreaterThanOrEqual(0.98);
  expect(canvas.height / body.height).toBeGreaterThanOrEqual(0.98);
  expect(canvas.width / page.viewportSize()!.width).toBeGreaterThanOrEqual(0.7);

  const solid = ((await page.locator("#model").getAttribute("data-solid-screen")) ?? "").split(",").map(Number);
  const dock = ((await page.locator("#model").getAttribute("data-gizmo-at")) ?? "").split(",").map(Number);
  const [sx, sy, sw, sh] = solid;
  const inside = dock[0]! >= sx! && dock[0]! <= sx! + sw! && dock[1]! >= sy! && dock[1]! <= sy! + sh!;
  expect(inside, "the dock gizmo covers the solid").toBe(false);
  await shot(page, "01-global");

  const before = await value(page, "modelWpU");
  await drag(page, "wp-u", 80, 0);
  expect(await value(page, "modelWpU")).not.toBe(before);
  await shot(page, "02-dragged");

  await page.locator("#modelWpGlobal").click();
  await expect(page.locator("#modelWpU")).toHaveValue("0");

  await page.locator("#modelWpBed").click();
  await expect(page.locator("#model")).toHaveAttribute("data-workplane", /^bed:10\.00,10\.00,0\.00:0\.00,0\.00,0\.00$/);
  await expect(page.locator("#modelNote")).toContainText("On the bed");
  await shot(page, "03-bed");

  await page.locator("#modelWpRu").fill("90");
  await page.locator("#modelWpRu").dispatchEvent("input");
  await expect(page.locator("#modelNote")).toContainText("W points up");
  await expect(page.locator("#modelNote")).toContainText("sits on the bed");
  await shot(page, "04-tilted");

  await page.locator("#modelToolHole").click();
  await expect(page.locator("label:has(#modelX) .scrub-label")).toHaveText("U");
  await expect(page.locator("label:has(#modelY) .scrub-label")).toHaveText("V");
  await expect(page.locator("label:has(#modelZ) .scrub-label")).toHaveText("W");
  await expect(page.locator("#model")).toHaveAttribute("data-ghost", /.+/);
  await shot(page, "05-hole");

  await page.locator("#modelToolPlane").click();
  await page.locator("#modelWpGlobal").click();
  await expect(page.locator("#model")).toHaveAttribute("data-workplane", "global:0.00,0.00,0.00:0.00,0.00,0.00");
  await page.locator("#modelToolHole").click();
  await expect(page.locator("label:has(#modelX) .scrub-label")).toHaveText("X");
  await expect(page.locator("label:has(#modelY) .scrub-label")).toHaveText("Y");
  await expect(page.locator("label:has(#modelZ) .scrub-label")).toHaveText("Z");
  await shot(page, "06-global-again");
});
