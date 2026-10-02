import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

/**
 * Edit tree supports against a real engine:
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test support-edits
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;

/** Extrusion moves printed under the engine's `; TYPE:SUPPORT` marker, interface included. */
function supportMoves(gcode: string) {
  let inSupport = false;
  let moves = 0;
  for (const line of gcode.split("\n")) {
    const type = /^; TYPE:(\S+)/.exec(line);
    if (type) inSupport = type[1].startsWith("SUPPORT");
    else if (inSupport && /^G[123] .*E/.test(line)) moves += 1;
  }
  return moves;
}

async function exportedSupportMoves(page: Page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export").click()]);
  return supportMoves(fs.readFileSync((await download.path())!, "utf8"));
}

async function supportSeconds(page: Page) {
  const text = (await page.locator('#legend label:has(input[data-kind="support"])').textContent()) ?? "";
  return { text, seconds: Number(/· ([\d.]+) s/.exec(text)?.[1]) };
}

async function sliced(page: Page) {
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeDisabled();
}

async function gapCount(page: Page) {
  return Number(await page.locator("#pane3d").getAttribute("data-gaps"));
}

test("delete a tree, regrow its gap, undo, and clear", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    const response = await route.fetch({ url, timeout: SLICE_MS });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#samples summary").click();
  await page.locator('[data-sample="overhang_ledge.stl"]').click();
  await expect(page.locator("#status")).toContainText("loaded", { timeout: 30_000 });
  await page.locator('[data-level-choice="advanced"]').first().click();
  await page.locator("#supports").check();
  await page.locator("#sstyle").selectOption("tree");
  await page.locator("#slice").click();
  await sliced(page);
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.keyboard.press("End");

  const before = await supportSeconds(page);
  expect(before.seconds).toBeGreaterThan(0);
  const movesBefore = await exportedSupportMoves(page);
  expect(movesBefore).toBeGreaterThan(0);

  await page.keyboard.press("e");
  const readout = page.locator("#supportReadout");
  await expect(readout).toHaveText("Click a support. Shift-click takes the whole tree.");
  const box = (await page.locator("#view3d").boundingBox())!;
  let at: { x: number; y: number } | null = null;
  for (let row = 1; row < 24 && !at; row++) {
    for (let col = 1; col < 32 && !at; col++) {
      const x = box.x + (box.width * col) / 32;
      const y = box.y + (box.height * row) / 24;
      await page.mouse.move(x, y);
      if (/^(Tree|Branch) · /.test((await readout.textContent()) ?? "")) at = { x, y };
    }
  }
  expect(at, "a support under the pointer somewhere in the view").not.toBeNull();
  await page.keyboard.down("Shift");
  await page.mouse.click(at!.x, at!.y);
  await page.keyboard.up("Shift");
  await expect(readout).toHaveText(/^Tree · \d+ tips?$/);

  await page.keyboard.press("Delete");
  await expect(page.locator(".toast").filter({ hasText: /Removed 1 tree \(\d+ tips?\)\./ })).toBeVisible({ timeout: SLICE_MS });
  await sliced(page);
  const pruned = await supportSeconds(page);
  expect(pruned.seconds).toBeLessThan(before.seconds);
  const gapsPruned = await gapCount(page);
  expect(gapsPruned).toBeGreaterThanOrEqual(1);
  const rows = page.locator("#supportEdits li[data-edit]");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".se-badge")).toHaveText(/applied|rebound/);
  expect(await exportedSupportMoves(page)).toBeLessThan(movesBefore);

  await page.locator('#supportEdits [data-action="regrow"]').first().click();
  await expect(rows).toHaveCount(2);
  await expect(page.locator(".toast").filter({ hasText: /^Regrew supports\./ })).toBeVisible({ timeout: SLICE_MS });
  await sliced(page);
  expect(await gapCount(page)).toBeLessThan(gapsPruned);

  await page.getByRole("button", { name: "Undo last" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Edit removed. Supports replayed." })).toBeVisible({ timeout: SLICE_MS });
  await sliced(page);
  await expect(rows).toHaveCount(1);
  expect(await gapCount(page)).toBe(gapsPruned);

  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page.locator(".toast").filter({ hasText: "All support edits cleared." })).toBeVisible({ timeout: SLICE_MS });
  await sliced(page);
  await expect(rows).toHaveCount(0);
  await expect(page.locator("#supportEdits")).toContainText("No edits yet.");
  expect((await supportSeconds(page)).text).toBe(before.text);
});

test("trees grown with Smart supports off can be edited", async ({ page }) => {
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    const response = await route.fetch({ url, timeout: SLICE_MS });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#samples summary").click();
  await page.locator('[data-sample="overhang_ledge.stl"]').click();
  await expect(page.locator("#status")).toContainText("loaded", { timeout: 30_000 });
  await expect(page.locator("#supports")).not.toBeChecked();
  await page.locator("#slice").click();
  await sliced(page);
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  expect((await supportSeconds(page)).seconds).toBeGreaterThan(0);

  const toggle = page.locator('#toolRail [data-tool="supports"]');
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("e");
  await expect(page.locator("#supportReadout")).toHaveText("Click a support. Shift-click takes the whole tree.");
});
