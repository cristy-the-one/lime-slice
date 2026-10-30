import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { setSupports } from "./supports";

/**
 * Grow branches on a picked tree, against a scripted engine: pick a tree, ask for three branches, see the two that
 * grew selected with a toast that can undo them, then undo. The engine side is covered by the Rust tests.
 */
const out = path.resolve("test-results/support-grow");
fs.mkdirSync(out, { recursive: true });

const hull = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/hull-speed.json"), "utf8"));

/** A trunk through the hull center and one branch, so a click in the middle of the 3D view hits the tree. */
const skeleton = {
  id: [1, 2],
  tree: [1, 1],
  into: [0, 1],
  live: [1, 1],
  siteX: [0, 6],
  siteY: [0, 2],
  siteZ: [20, 12],
  start: [0, 2, 4],
  xs: [0, 0, 6, 3],
  ys: [0, 0, 2, 1],
  zs: [20, 0, 12, 4],
  rs: [2.4, 3, 1.2, 1.6],
};

/** The same tree with two branches grown into its trunk. */
const grownSkeleton = {
  id: [1, 2, 3, 4],
  tree: [1, 1, 1, 1],
  into: [0, 1, 1, 1],
  live: [1, 1, 1, 1],
  siteX: [0, 6, -4, 3],
  siteY: [0, 2, -3, -5],
  siteZ: [20, 12, 19.6, 19.6],
  start: [0, 2, 4, 6, 8],
  xs: [0, 0, 6, 3, -4, -0.5, 3, 0.5],
  ys: [0, 0, 2, 1, -3, -0.5, -5, -1],
  zs: [20, 0, 12, 4, 19, 14, 19, 13],
  rs: [2.4, 3, 1.2, 1.6, 0.4, 0.8, 0.4, 0.8],
};

type Edit = { kind: string; count?: number; sites?: unknown[] };

function responseFor(edits: Edit[]) {
  const body = structuredClone(hull);
  body.coverage = [];
  const grew = edits.some((edit) => edit.kind === "grow");
  body.skeleton = grew ? grownSkeleton : skeleton;
  if (edits.length) {
    body.supportEdits = edits.map((edit) =>
      edit.kind === "grow"
        ? { status: "applied", changedLayers: 40, changedSpan: [60, 99], newlyFloatingMm2: 0, floating: [], grown: [3, 4] }
        : { status: "applied", changedLayers: 6, newlyFloatingMm2: 0, floating: [] },
    );
  }
  return body;
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, name) });
}

test("pick a tree, grow branches, see them, and undo", async ({ page }) => {
  const requests: Edit[][] = [];
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-theme", "dark");
    localStorage.setItem("lime-slice-auto-slice", "0");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", async (route) => {
    const edits = (route.request().postDataJSON()?.supportEdits ?? []) as Edit[];
    requests.push(edits);
    await route.fulfill({ json: responseFor(edits) });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.locator('[data-sample="lime_hull.stl"]').click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
  await setSupports(page, "auto");
  await page.locator("#slice").click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator("#slice")).toBeEnabled();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.keyboard.press("End");

  await page.keyboard.press("e");
  const toggle = page.locator('#toolRail [data-tool="supports"]');
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const readout = page.locator("#supportReadout");
  const grow = page.locator('#supportEditbar [data-action="grow"]');
  const count = page.locator("#supportGrowCount");
  await expect(grow).toBeVisible();
  await expect(grow).toBeDisabled();
  await expect(count).toHaveValue("6");

  const box = (await page.locator("#view3d").boundingBox())!;
  let at: { x: number; y: number } | null = null;
  for (let row = 4; row < 20 && !at; row++) {
    for (let col = 6; col < 26 && !at; col++) {
      const x = box.x + (box.width * col) / 32;
      const y = box.y + (box.height * row) / 24;
      await page.mouse.move(x, y);
      if (/^(Tree|Branch) · /.test((await readout.textContent()) ?? "")) at = { x, y };
    }
  }
  expect(at, "the tree under the pointer somewhere in the view").not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
  await expect(readout).toHaveText(/^Branch · \d+ tips?$/);
  await expect(grow).toBeEnabled();
  await count.fill("3");
  await shot(page, "01-grow-picked.png");

  await grow.click();
  await expect.poll(() => requests.length).toBe(2);
  const sent = requests[1];
  expect(sent).toHaveLength(1);
  expect(sent[0].kind).toBe("grow");
  expect(sent[0].count).toBe(3);
  // A branch was picked, and the grow still names the whole tree.
  expect(sent[0].sites).toHaveLength(2);

  await expect(readout).toHaveText("New · 2 branches");
  await expect(page.locator('#supportEditbar [data-action="delete"]')).toContainText("Delete new");
  const toast = page.locator(".toast", { hasText: "Grew 2 branches on the tree." });
  await expect(toast).toContainText("1 more found no clear path.");
  const rows = page.locator("#supportEdits li[data-edit]");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Grow tree · +3 branches");
  await expect(page.locator("#pane3d")).toHaveAttribute("data-capsules", /^[1-9]/);
  await shot(page, "02-grow-preview.png");

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toHaveLength(0);
  await expect(rows).toHaveCount(0);
  await expect(readout).toBeEmpty();
  await shot(page, "03-grow-undone.png");

  // The keyboard path: G grows the picked tree by the count in the field.
  await page.mouse.click(at!.x, at!.y);
  await expect(readout).toHaveText(/^Branch · \d+ tips?$/);
  await page.keyboard.press("g");
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[3][0]).toMatchObject({ kind: "grow", count: 3 });
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: "Undo last" }).click();
  await expect.poll(() => requests.length).toBe(5);
  await expect(rows).toHaveCount(0);
});
