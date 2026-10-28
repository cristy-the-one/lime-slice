import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

/**
 * A STEP file of several solids, as Split to print's One STEP export writes it: the pieces' cut faces touch, so its
 * mesh is one shell. The engine is mocked: the mesh, and the kernel's `stepSolids` with each solid's own STEP file.
 */

const shots = process.env.STEP_SOLIDS_SHOTS ?? "";

function face(a: number[], b: number[], c: number[], d: number[]): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

function box(x0: number, x1: number, z0: number, z1: number): number[] {
  const p = (x: number, y: number, z: number) => [x, y, z];
  return [
    ...face(p(x0, 0, z0), p(x1, 0, z0), p(x1, 20, z0), p(x0, 20, z0)),
    ...face(p(x0, 0, z1), p(x0, 20, z1), p(x1, 20, z1), p(x1, 0, z1)),
    ...face(p(x0, 0, z0), p(x0, 0, z1), p(x1, 0, z1), p(x1, 0, z0)),
    ...face(p(x1, 20, z0), p(x1, 20, z1), p(x0, 20, z1), p(x0, 20, z0)),
    ...face(p(x0, 0, z0), p(x0, 20, z0), p(x0, 20, z1), p(x0, 0, z1)),
    ...face(p(x1, 0, z0), p(x1, 0, z1), p(x1, 20, z1), p(x1, 20, z0)),
  ];
}

/** Three 20 mm slabs side by side in X, touching: the whole file's mesh is one welded shell. */
const SLABS = [box(0, 20, 0, 20), box(20, 40, 0, 20), box(40, 60, 0, 20)];
const NAMES = ["cover-1", "cover-2", "cover-3"];

function stepText(solids: number, tag: string): Buffer {
  const rows = Array.from({ length: solids }, (_, i) => `#${10 + i}=MANIFOLD_SOLID_BREP('${tag}-${i}',#${100 + i});`);
  return Buffer.from(`ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${rows.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`);
}

/** Solid `i` alone, as the kernel writes it: the mock meshes it as that slab. */
function pieceFile(i: number): Buffer {
  return Buffer.from(`ISO-10303-21;\nDATA;\n#10=MANIFOLD_SOLID_BREP('piece-${i}',#11);\nENDSEC;\nEND-ISO-10303-21;\n`);
}

async function mockEngine(page: Page) {
  const asked: string[] = [];
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.route("**/api/mesh", async (route) => {
    const body = route.request().postDataJSON() as { filename: string; dataB64: string };
    const text = Buffer.from(body.dataB64, "base64").toString("latin1");
    const piece = /'piece-(\d)'/.exec(text);
    const positions = piece ? SLABS[Number(piece[1])]! : body.filename === "single.step" ? SLABS[0]! : SLABS.flat();
    await route.fulfill({ json: { positions, seatMm: 0 } });
  });
  await page.route("**/api/model/tree", async (route) => {
    const body = route.request().postDataJSON() as { call: string; files?: boolean };
    asked.push(body.call);
    if (body.call !== "stepSolids") return route.fulfill({ json: { error: `unexpected ${body.call}` } });
    const solids = NAMES.map((name, i) => ({
      name,
      volumeMm3: 8000,
      ...(body.files ? { bytesBase64: pieceFile(i).toString("base64") } : {}),
    }));
    await route.fulfill({ json: { solids } });
  });
  return asked;
}

async function open(page: Page, name: string, bytes: Buffer) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name, mimeType: "model/step", buffer: bytes });
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name) });
}

const offer = (page: Page) => page.locator("#toasts").getByRole("status").filter({ hasText: "This STEP file holds 3 solids." });

test("a STEP of several solids offers to open as its pieces", async ({ page }) => {
  const asked = await mockEngine(page);
  await open(page, "cover.step", stepText(3, "solid"));
  await expect(offer(page)).toBeVisible();
  await expect(offer(page).getByRole("button", { name: "Open as 3 pieces" })).toBeVisible();
  await expect(offer(page).getByRole("button", { name: "Open as one object" })).toBeVisible();
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  expect(asked, "the offer reads the count from the file, with no kernel call").toEqual([]);
  await shot(page, "import-choice.png");
});

test("Open as 3 pieces makes three objects named from the STEP, side by side as assembled", async ({ page }) => {
  await mockEngine(page);
  await open(page, "cover.step", stepText(3, "solid"));
  const before = Number(await page.locator("#placeX").inputValue());
  await offer(page).getByRole("button", { name: "Open as 3 pieces" }).click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(3);
  for (const [i, name] of NAMES.entries()) await expect(page.locator("[data-plate-id]").nth(i)).toContainText(name);
  // --- Assemblies M8. The solids of one file are one assembly, named for it, the first solid its root.
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await expect(page.locator("[data-assembly-head]")).toContainText("cover");
  await expect(page.locator("[data-assembly-head]")).toContainText("3 parts");
  const xs: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.locator("[data-plate-id]").nth(i).locator("[data-plate-select]").click();
    xs.push(Number(await page.locator("#placeX").inputValue()));
  }
  expect(xs[1]! - xs[0]!).toBeCloseTo(20, 0);
  expect(xs[2]! - xs[1]!).toBeCloseTo(20, 0);
  expect(xs[1]!).toBeCloseTo(before, 0);
  await shot(page, "pieces.png");
});

test("Open as one object keeps one, and Separate then splits it by its solids", async ({ page }) => {
  await mockEngine(page);
  await open(page, "cover.step", stepText(3, "solid"));
  await offer(page).getByRole("button", { name: "Open as one object" }).click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  const separate = page.locator("#separateShells");
  await expect(separate).toBeEnabled();
  await expect(separate).toHaveText("Separate into 3 objects");
  await separate.click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(3);
  for (const [i, name] of NAMES.entries()) await expect(page.locator("[data-plate-id]").nth(i)).toContainText(name);
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
});

test("a STEP of one solid shows no choice", async ({ page }) => {
  const asked = await mockEngine(page);
  await open(page, "single.step", stepText(1, "solid"));
  await page.waitForTimeout(500);
  await expect(page.locator("#toasts").getByText("solids")).toHaveCount(0);
  await expect(page.locator("#separateShells")).toBeDisabled();
  expect(asked).toEqual([]);
});
