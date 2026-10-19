import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree } from "./model-tree-mock";

type V = [number, number, number];

/** A 20 × 20 × 10 mm box, as the modeler reports a solid. */
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

async function openModel(page: Page, probe: () => { ok: boolean; error?: string; voids?: { min: number[]; max: number[] }[] }) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid, probe });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
}

test("a refused probe with voids draws a red box and Show where frames it", async ({ page }) => {
  await openModel(page, () => ({ ok: false, error: "This would seal off a hollow inside the part.", voids: [{ min: [2, 2, 2], max: [8, 8, 6] }] }));
  await page.locator("#modelToolBoolean").click();
  await expect(page.locator("#modelNote")).toContainText("This would seal off a hollow inside the part.");
  await expect(page.locator("#model")).toHaveAttribute("data-located", /red:2\.00,2\.00,2\.00,8\.00,8\.00,6\.00/);
  const show = page.locator("#modelShowWhere");
  await expect(show).toBeVisible();
  await expect(show).toHaveText("Show where");
  const before = await page.locator("#model").getAttribute("data-camera");
  await show.click();
  await expect(page.locator("#model")).not.toHaveAttribute("data-camera", before ?? "");
});

test("Check lists the solid and frames the row that was clicked", async ({ page }) => {
  await openModel(page, () => ({ ok: true }));
  await expect(page.locator("#objectList [data-plate-check]")).toHaveText("Check");
  await page.locator("#modelToolCheck").click();
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "check");
  await expect(page.locator("#modelApply")).toBeHidden();
  await expect(page.locator("#modelCancel")).toHaveText("Done");
  await expect(page.locator("#modelThin")).toHaveValue("0.8");
  const row = page.locator("#modelCheckList [data-check-row]").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("Fits the build volume");
  await expect(row).toContainText("mm");
  await expect(page.locator("#modelNote")).toContainText("Nothing in this check needs a change.");
  const canvas = page.locator("#model");
  const framed = await canvas.getAttribute("data-camera");
  await canvas.hover();
  await page.mouse.wheel(0, 400);
  await expect(canvas).not.toHaveAttribute("data-camera", framed ?? "");
  const zoomed = await canvas.getAttribute("data-camera");
  await row.click();
  await expect(canvas).toHaveAttribute("data-check-box", /0\.00,0\.00,0\.00,20\.00,20\.00,10\.00/);
  await expect(canvas).not.toHaveAttribute("data-camera", zoomed ?? "");
});

test("Enter on a focused Model button presses that button, not Apply", async ({ page }) => {
  await openModel(page, () => ({ ok: true }));
  await page.locator("#modelToolCheck").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelBar")).toHaveAttribute("data-tool", "check");
  await page.locator("#modelCancel").click();
  await page.locator("#modelFeatureMore").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelFeatureMenu")).toBeVisible();
});

test("Check says why a thin wall cannot be used, and lists its rows as items", async ({ page }) => {
  await openModel(page, () => ({ ok: true }));
  await page.locator("#modelToolCheck").click();
  const rows = page.locator("#modelCheckList [data-check-row]");
  await expect(rows.first()).toBeVisible();
  await expect(page.locator("#modelCheckList > [role=listitem] > button[data-check-row]").first()).toBeVisible();
  const thin = page.locator("#modelThin");
  for (const [typed, said] of [["0", "Thin wall is at least 0.05 mm."], ["-1", "Thin wall is at least 0.05 mm."], ["", "Type a thin wall in millimetres."], ["25", "Thin wall is at most 20 mm."]] as const) {
    await thin.selectText();
    if (typed) await page.keyboard.type(typed);
    else await page.keyboard.press("Delete");
    await page.keyboard.press("Tab");
    await expect(page.locator("#modelNote"), `thin wall "${typed}"`).toHaveText(said);
    await expect(rows).toHaveCount(0);
    await expect(thin).toHaveAttribute("aria-invalid", "true");
  }
  await thin.selectText();
  await page.keyboard.type("0.8");
  await page.keyboard.press("Tab");
  await expect(rows.first()).toBeVisible();
  await expect(thin).not.toHaveAttribute("aria-invalid", /.*/);
});

test("Check says so when its worker fails", async ({ page }) => {
  await page.route("**/*model-check-worker*", (route) => route.fulfill({ contentType: "text/javascript", body: "throw new Error('boom');" }));
  await openModel(page, () => ({ ok: true }));
  await page.locator("#modelToolCheck").click();
  await expect(page.locator("#modelNote")).toContainText("The check stopped:");
  await expect(page.locator("#modelCheckList [data-check-row]")).toHaveCount(0);
});
