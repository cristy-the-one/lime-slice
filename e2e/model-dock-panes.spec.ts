/**
 * The Model dock's sections share its height: none covers another, and the line between two drags.
 */
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";

type V = [number, number, number];

function boxSolid(volumeMm3: number): MockSolid {
  const c = (x: number, y: number, z: number): V => [x * 10, y * 10, z * 10];
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
  return { volumeMm3, positions, triangles, faces: quads.map((_, id) => ({ id, areaMm2: 100 })), edges: [] };
}

function volumeOf(request: Body): number {
  const primitive = request.primitive as { size?: number[] } | undefined;
  const op = request.op as { kind?: string; size?: number[] } | undefined;
  const size = primitive?.size ?? (op?.kind === "root" ? op.size : undefined);
  if (size && size.length >= 3) return (size[0] ?? 0) * (size[1] ?? 0) * (size[2] ?? 0);
  return 4000;
}

async function openModel(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/mesh", (route) => route.fulfill({ json: { positions: boxSolid(4000).positions } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const tree = await mockModelTree(page, {
    open: (request) => boxSolid(volumeOf(request)),
    apply: (request) => boxSolid(volumeOf(request)),
    probe: () => ({ ok: true }),
  });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles({ name: "plate.step", mimeType: "model/step", buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n") });
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume 4000 mm³");
  return tree;
}


/** Sections in the dock, top to bottom, as the user sees them. */
async function boxes(page: Page) {
  return page.evaluate(() =>
    ["#modelHistory", "#modelParams", "#modelStress"].map((sel) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const r = el.getBoundingClientRect();
      return { sel, top: r.top, bottom: r.bottom, height: r.height, shown: !el.hidden };
    }));
}

async function noOverlap(page: Page, when: string) {
  const rows = (await boxes(page)).filter((row) => row.shown);
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i]!.top, `${when}: ${rows[i - 1]!.sel} ends above ${rows[i]!.sel}`).toBeGreaterThanOrEqual(rows[i - 1]!.bottom - 0.5);
  }
}

async function openBoth(page: Page) {
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuParameters").click();
  await page.locator("#modelFeatureMore").click();
  await page.locator("#modelMenuStress").click();
  await expect(page.locator("#modelStressMain")).toBeVisible();
}

const height = (page: Page, sel: string) => page.locator(sel).evaluate((el) => el.getBoundingClientRect().height);

test("no section covers another while they fold and open, and each header stays clickable", async ({ page }) => {
  await openModel(page);
  await openBoth(page);
  await noOverlap(page, "all open");
  for (const toggle of ["#modelParamsToggle", "#modelParamsToggle", "#modelParamsToggle", "#modelStressToggle", "#modelStressToggle", "#modelHistoryToggle", "#modelHistoryToggle"]) {
    // A header under another section would fail this click.
    await page.locator(toggle).click({ timeout: 2000 });
    await noOverlap(page, `after ${toggle}`);
  }
  await expect(page.locator("#modelParamsToggle")).toHaveAttribute("aria-expanded", "false");
  expect(await height(page, "#modelParams"), "a folded section is its header").toBeLessThan(40);
  await expect(page.locator("#modelStress .pane-chev")).toBeVisible();
});

test("the line between two sections drags, takes arrow keys, is remembered, and resets on a double-click", async ({ page }) => {
  await openModel(page);
  await openBoth(page);
  // Advanced open, so Stress has more below its fold than the drag gives it: a section grows no taller than its content.
  await page.locator("#stressAdvanced > summary").click();
  const line = page.locator("#modelDock > .pane-line:has(+ #modelStress)");
  await expect(line).toHaveAttribute("role", "separator");
  await expect(line).toHaveAttribute("aria-label", "Resize Parameters and Stress");
  const full = await height(page, "#modelParams");
  const stress = await height(page, "#modelStress");

  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 20, { steps: 5 });
  await page.mouse.up();
  expect(await height(page, "#modelParams"), "dragged up 20 px").toBeCloseTo(full - 20, 0);
  expect(await height(page, "#modelStress"), "Stress took the 20 px").toBeCloseTo(stress + 20, 0);
  await noOverlap(page, "after the drag");

  await line.focus();
  await page.keyboard.press("ArrowDown");
  expect(await height(page, "#modelParams"), "ArrowDown gives 16 px back").toBeCloseTo(full - 4, 0);
  await page.keyboard.press("ArrowDown");
  expect(await height(page, "#modelParams"), "no taller than its content").toBeCloseTo(full, 0);
  await page.keyboard.press("Home");
  const least = await height(page, "#modelParams");
  expect(least, "Home goes to the least height").toBeLessThan(full);

  // Folded and opened again, a section keeps the height it was given.
  await page.locator("#modelParamsToggle").click();
  await page.locator("#modelParamsToggle").click();
  expect(await height(page, "#modelParams")).toBeCloseTo(least, 0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("lime-slice-dock-panes") ?? "{}").params)).toBeCloseTo(least, 0);

  await line.dblclick();
  expect(await height(page, "#modelParams"), "a double-click goes back to the content's height").toBeCloseTo(full, 0);
  expect(await page.evaluate(() => localStorage.getItem("lime-slice-dock-panes"))).toBeNull();
});

test("a line beside a folded section only, or above the first, does not drag", async ({ page }) => {
  await openModel(page);
  await openBoth(page);
  await page.locator("#modelStressToggle").click();
  const line = page.locator("#modelDock > .pane-line:has(+ #modelStress)");
  await expect(line).not.toHaveAttribute("data-live", "");
  await expect(line).toHaveAttribute("tabindex", "-1");
  await expect(page.locator("#modelDock > .pane-line:has(+ #modelHistory)")).toBeHidden();
});
