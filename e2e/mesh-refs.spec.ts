import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { filamentGrams } from "../src/estimate.ts";

/**
 * The mesh is uploaded once per engine session, then named by `meshRef`.
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test mesh-refs
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;

type Body = Record<string, unknown> & { dataB64?: string; meshRef?: string };
type Reply = { meshId?: string; gcodeToken?: string; estimate: { filamentMm: number } };

/**
 * Send the app's engine calls to the real engine. Keeps every job body as sent,
 * and each reply. `lose` rewrites the next `meshRef` to one the engine never held.
 */
async function proxy(page: Page) {
  const seen = { bodies: [] as Body[], sizes: [] as number[], replies: [] as Reply[], lose: false };
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    let postData = route.request().postData() ?? undefined;
    if (route.request().method() === "POST" && /\/api\/jobs$/.test(url) && postData) {
      const body = JSON.parse(postData) as Body;
      seen.bodies.push(body);
      seen.sizes.push(postData.length);
      if (seen.lose && body.meshRef) {
        seen.lose = false;
        postData = JSON.stringify({ ...body, meshRef: "0".repeat(64) });
      }
    }
    const response = await route.fetch({ url, postData, timeout: SLICE_MS });
    if (/\/api\/jobs\/[^/]+\/result$/.test(url) && response.status() === 200) seen.replies.push(JSON.parse(await response.text()));
    await route.fulfill({ response });
  });
  return seen;
}

async function sliced(page: Page) {
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeHidden();
}

async function load(page: Page, file: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    localStorage.setItem("lime-slice-closed-groups", "[]");
  });
  await page.goto("/");
  await page.locator("#file").setInputFiles(file);
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
}

async function moveX(page: Page, by: number) {
  const field = page.locator("#placeX");
  await field.fill(String(Number(await field.inputValue()) + by));
  await field.press("Tab");
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: SLICE_MS });
}

const sentAs = (body: Body) => (body.meshRef ? `ref:${body.meshRef}` : body.dataB64 ? "data" : "none");

test("the second slice names the mesh instead of sending it", async ({ page }) => {
  const seen = await proxy(page);
  await load(page, "samples/dragon_2_5.stl");
  await page.locator("#slice").click();
  await sliced(page);
  await moveX(page, 20);

  const id = seen.replies[0]!.meshId!;
  expect(id).toMatch(/^[0-9a-f]{64}$/);
  expect(seen.bodies.map(sentAs)).toEqual(["data", `ref:${id}`]);
  expect(seen.bodies[1]).not.toHaveProperty("dataB64");
  expect(seen.sizes[0]).toBeGreaterThan(1_000_000);
  expect(seen.sizes[1]).toBeLessThan(10_000);
  console.log(`request bytes: first ${seen.sizes[0]}, move ${seen.sizes[1]}`);
});

test("an engine that no longer holds the mesh gets the bytes once more", async ({ page }) => {
  const seen = await proxy(page);
  await load(page, "samples/dragon_2_5.stl");
  await page.locator("#slice").click();
  await sliced(page);
  const id = seen.replies[0]!.meshId!;

  seen.lose = true;
  await moveX(page, 15);
  await expect(page.locator("#stage")).not.toHaveClass(/stale/);
  await moveX(page, 15);

  expect(seen.bodies.map(sentAs)).toEqual(["data", `ref:${id}`, "data", `ref:${id}`]);
  expect(seen.replies).toHaveLength(3);
  await expect(page.locator(".toast.error")).toHaveCount(0);
});

test("a density change rewrites the exported footer's grams without a slice", async ({ page }) => {
  const seen = await proxy(page);
  await load(page, "samples/calibration_cube_20mm.stl");
  await page.locator("#slice").click();
  await sliced(page);
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  const reply = seen.replies[0]!;

  await page.locator("#levelPick").selectOption("advanced");
  await page.locator("#density").fill("1.27");
  await page.locator("#density").press("Tab");
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  const download = page.waitForEvent("download", { timeout: 30_000 });
  await page.locator("#export").click();
  const gcode = fs.readFileSync((await (await download).path())!, "utf8");

  const grams = filamentGrams(reply.estimate.filamentMm, { filamentDiameter: 1.75, filamentDensityGCm3: 1.27, filamentCostPerKg: 0 });
  expect(gcode).toMatch(new RegExp(`^; TIME:\\S+ FILAMENT_MM:\\S+ FILAMENT_G:${grams.toFixed(3).replace(".", "\\.")} `, "m"));
  expect(seen.bodies).toHaveLength(1);
  expect(seen.bodies[0]!.printer).not.toHaveProperty("filamentDensityGCm3");
});
