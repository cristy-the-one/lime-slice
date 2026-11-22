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

async function openFillet(page: Page) {
  const solid = boxSolid();
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: solid.positions } }));
  await mockModelTree(page, { open: () => solid });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  await page.locator("#modelToolFillet").evaluate((button) => {
    button.removeAttribute("disabled");
    button.setAttribute("aria-disabled", "false");
    button.classList.remove("is-disabled");
  });
  await page.locator("#modelToolFillet").click();
  await expect(page.locator("#modelFilletProfile")).toBeVisible();
}

test("fillet defaults to circular G1 and offers smooth G2, conic, and a variable radius", async ({ page }) => {
  await openFillet(page);
  await expect(page.locator("#modelFilletProfile [data-fillet-profile=g1]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelFilletRho")).toBeHidden();
  await expect(page.locator("#modelFilletStart")).toBeHidden();

  await page.locator("#modelFilletProfile [data-fillet-profile=g2]").click();
  await expect(page.locator("#modelFilletProfile [data-fillet-profile=g2]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelFilletProfile [data-fillet-profile=g1]")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#modelFilletRho")).toBeHidden();

  await page.locator("#modelFilletProfile [data-fillet-profile=conic]").click();
  await expect(page.locator("#modelFilletProfile [data-fillet-profile=conic]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modelFilletRho")).toBeVisible();

  await page.locator("#modelFilletVariable").check();
  await expect(page.locator("#modelFilletStart")).toBeVisible();
  await expect(page.locator("#modelFilletMid")).toBeVisible();
  await expect(page.locator("#modelFilletEnd")).toBeVisible();
});
