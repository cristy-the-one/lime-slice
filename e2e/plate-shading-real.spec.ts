import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { autoSliceOff } from "./auto-slice";

/**
 * Prepare and Pose shade a part that has a solid with the solid's exact normals, on the plate mesh's own triangles
 * (src/plate-shading.ts), against the real kernel:
 * - a box rounded on every edge, opened as a STEP file, from one stateless `meshStep` call on that file;
 * - a cylinder made in Model, from the normals its reply carried (`display.plateNormals`), and a copy of it;
 * - an STL mesh, which has no solid, is drawn flat as before.
 * Nothing new is saved: the project is still version 4, with no normals in it.
 *   lime-slice serve --port 43218 (with the OCCT bridge)
 *   LIME_EDIT_API=http://127.0.0.1:43218 npx playwright test plate-shading-real
 */
const api = process.env.LIME_EDIT_API;

test.skip(!api, "set LIME_EDIT_API to a running lime-slice serve");
test.setTimeout(240_000);

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${api}/api/model/tree`, {
    data: { call: "open", key: "shading-real-probe", primitive: { primitive: "box", origin: [0, 0, 0], size: [1, 1, 1], turn: [0, 0, 0] }, chordMm: 0.1 },
  });
  const body = (await res.json().catch(() => ({}))) as { volumeMm3?: number };
  test.skip(typeof body.volumeMm3 !== "number", "this engine has no OCCT modeler");
  await request.post(`${api}/api/model/tree`, { data: { call: "close", key: "shading-real-probe" } });
});

async function proxy(page: Page) {
  await page.route("http://127.0.0.1:43118/**", async (route) => {
    const url = route.request().url().replace("http://127.0.0.1:43118", api!);
    await route.fulfill({ response: await route.fetch({ url, timeout: 120_000 }) });
  });
}

/** A box rounded 6 mm on every edge, as the kernel writes it to STEP. */
async function roundedBoxStep(page: Page): Promise<Buffer> {
  const post = async (data: Record<string, unknown>) => (await (await page.request.post(`${api}/api/model/tree`, { data, timeout: 120_000 })).json()) as Record<string, unknown>;
  await post({ call: "open", key: "shading-real-box", box: [40, 30, 20], chordMm: 0.05 });
  const rounded = await post({ call: "apply", key: "shading-real-box", parent: 0, node: 1, chordMm: 0.05, op: { kind: "fillet", edges: [...Array(12).keys()], size: 6 } });
  expect(rounded.error, "the kernel rounds the box").toBeUndefined();
  const step = await post({ call: "export", key: "shading-real-box", node: 1, format: "step" });
  await post({ call: "close", key: "shading-real-box" });
  return Buffer.from(String(step.bytesBase64), "base64");
}

const rows = (page: Page) => page.locator("#objectList .obj");
const prepare = (page: Page) => page.locator("#prepare");

test("a solid is drawn smooth in Prepare and Pose on its own plate mesh; a mesh without one stays flat", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await proxy(page);
  const step = await roundedBoxStep(page);
  await page.goto("/");
  await autoSliceOff(page);

  // A rounded box opened as STEP: one kernel call on the file brings its normals, and the box it draws takes them.
  await page.locator("#file").setInputFiles({ name: "rounded-box.step", mimeType: "model/step", buffer: step });
  await expect(rows(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator("body")).toHaveAttribute("data-plate-shading-asked", /^[1-9]/, { timeout: 60_000 });
  await expect(prepare(page), "the STEP box is shaded smooth").toHaveAttribute("data-plate-shading", "smooth");

  // A cylinder made in Model: its commit hands the plate mesh its normals in the same step.
  await page.locator("#tabModel").click();
  await page.locator("#modelToolNew").click();
  await page.locator('#modelPrim [data-kind="cylinder"]').click();
  await page.locator("#modelRadius").fill("10");
  await page.locator("#modelHeight").fill("30");
  await page.locator("#modelApply").click();
  await expect(page.locator("#modelReadout")).toContainText("Volume", { timeout: 60_000 });
  await page.locator("#tabPrepare").click();
  await expect(rows(page)).toHaveCount(2);
  await expect(prepare(page), "the cylinder made in Model is shaded smooth").toHaveAttribute("data-plate-shading", "smooth");
  await expect(prepare(page), "and the box beside it too").toHaveAttribute("data-plate-shaded-others", "1");

  // An STL mesh has no solid: drawn flat, as before.
  await page.locator("#plateAddFile").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(rows(page)).toHaveCount(3, { timeout: 60_000 });
  await rows(page).nth(2).click();
  await expect(prepare(page), "the STL is drawn as before").toHaveAttribute("data-plate-shading", "flat");
  await expect(prepare(page), "while both solids beside it are smooth").toHaveAttribute("data-plate-shaded-others", "2");

  // A duplicate shares its source's mesh, and so its normals.
  await rows(page).nth(1).click();
  await page.keyboard.press("Control+d");
  await expect(rows(page)).toHaveCount(4);
  await expect(prepare(page), "the copy of the cylinder is smooth").toHaveAttribute("data-plate-shading", "smooth");

  // Pose draws every part: the three solids smooth, the STL flat.
  await page.locator("#tabPose").click();
  await expect(page.locator("#pose")).toHaveAttribute("data-plate-shaded", "3", { timeout: 30_000 });

  // Nothing new is saved: version 4, and no normals anywhere in the file.
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const text = fs.readFileSync((await download.path())!, "utf8");
  const doc = JSON.parse(text) as { version: number };
  expect(doc.version, "a project with no new feature is still version 4").toBe(4);
  expect(text.includes("plateNormals") || text.includes("\"normals\""), "no normals are saved").toBe(false);
});
