import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

/**
 * Two different meshes on one plate, sliced by a real engine:
 *   lime-slice serve --port 43218 --cache-dir <dir>
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test plate-distinct-real
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(300_000);

const SLICE_MS = 120_000;
const shots = "/opt/cursor/artifacts/plate-distinct";

type Obj = { id?: string; filename?: string; dataB64?: string; meshRef?: string };
type Body = { objects?: Obj[] };
type Reply = { gcode?: string; gcodeToken?: string; meshIds?: Record<string, string> };

async function shot(page: Page, name: string) {
  try {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, name) });
  } catch {
    // Review shots. The assertions below do not depend on the directory.
  }
}

async function sliced(page: Page) {
  await expect(page.locator("#slice")).toBeEnabled({ timeout: SLICE_MS });
  await expect(page.locator("#cancel")).toBeHidden();
}

async function proxy(page: Page) {
  const seen = { bodies: [] as Body[], replies: [] as Reply[], lose: false };
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    let postData = route.request().postData() ?? undefined;
    if (route.request().method() === "POST" && /\/api\/jobs$/.test(url) && postData) {
      let body = JSON.parse(postData) as Body;
      if (seen.lose && body.objects?.some((obj) => obj.meshRef)) {
        seen.lose = false;
        body = {
          ...body,
          objects: body.objects.map((obj) => (obj.meshRef ? { ...obj, meshRef: "0".repeat(64) } : obj)),
        };
        postData = JSON.stringify(body);
      }
      seen.bodies.push(body);
    }
    const response = await route.fetch({ url, postData, timeout: SLICE_MS });
    if (/\/api\/jobs\/[^/]+\/result$/.test(url) && response.status() === 200) seen.replies.push(JSON.parse(await response.text()));
    await route.fulfill({ response });
  });
  return seen;
}

async function gcodeOf(page: Page, reply: Reply) {
  if (reply.gcode) return reply.gcode;
  const res = await page.request.get(`${api}/api/gcode/${reply.gcodeToken}`);
  expect(res.ok()).toBe(true);
  return res.text();
}

test("a cube and a ledge slice as two meshes, and a forgotten ref sends the bytes again", async ({ page }) => {
  const seen = await proxy(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#file").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(page.locator("#objectList .obj").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("#plateOverlap")).toHaveCount(0);

  await page.locator("#slice").click();
  await sliced(page);
  await page.locator("#sliceMore").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#force").click();
  await sliced(page);

  const sent = seen.bodies[0]!.objects!;
  expect(sent.map((obj) => obj.filename)).toEqual(["calibration_cube_20mm.stl", "overhang_ledge.stl"]);
  expect(sent[0]!.dataB64).toBeTruthy();
  expect(sent[1]!.dataB64).toBeTruthy();
  expect(sent[0]!.dataB64).not.toBe(sent[1]!.dataB64);
  const ids = Object.values(seen.replies[0]!.meshIds ?? {});
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);

  const gcode = await gcodeOf(page, seen.replies.at(-1)!);
  expect(gcode).toContain(";OBJECT:part");
  expect(gcode).toMatch(/;OBJECT:obj-/);
  await expect(page.locator("#view3d")).toHaveAttribute("data-object-offsets", /;/);
  const offsets = (await page.locator("#view3d").getAttribute("data-object-offsets"))!.split(";");
  expect(offsets).toHaveLength(2);
  expect(offsets[0]).not.toBe(offsets[1]);

  await page.locator("#tabPreview").click();
  await expect(page.locator("#view3d")).toBeVisible();
  await shot(page, "preview-after.png");

  const named = seen.bodies.find((body) => body.objects?.every((obj) => obj.meshRef && !obj.dataB64));
  expect(named?.objects?.map((obj) => obj.meshRef)).toHaveLength(2);
  expect(new Set(named!.objects!.map((obj) => obj.meshRef)).size).toBe(2);

  seen.lose = true;
  const before = seen.bodies.length;
  await page.locator("[data-plate-select='part']").click();
  const field = page.locator("#placeX");
  await field.fill(String(Number(await field.inputValue()) + 15));
  await field.press("Tab");
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current", { timeout: SLICE_MS });
  await expect.poll(() => seen.bodies.length, { timeout: SLICE_MS }).toBeGreaterThan(before);
  const again = seen.bodies.filter((body) => body.objects?.every((obj) => obj.dataB64));
  expect(again.length).toBeGreaterThan(1);
  expect(again.at(-1)!.objects![0]!.dataB64).not.toBe(again.at(-1)!.objects![1]!.dataB64);
  const recovered = await gcodeOf(page, seen.replies.at(-1)!);
  expect(recovered).toContain(";OBJECT:part");
  expect(recovered).toMatch(/;OBJECT:obj-/);
});
