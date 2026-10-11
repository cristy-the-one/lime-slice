import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { meshKeyHex } from "../src/slice-action.ts";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const shots = "/opt/cursor/artifacts/plate-distinct";

async function shot(page: Page, name: string) {
  try {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, name) });
  } catch {
    // The review shots live on this machine. A runner without the directory still asserts the plate.
  }
}

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
}

async function loadCube(page: Page) {
  await page.locator("#file").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
}

function triangles(buf: Buffer): number {
  return buf.toString("latin1").split("<triangle ").length - 1;
}

async function exportTriangles(page: Page): Promise<number> {
  await page.locator("#fileMenu > summary").click();
  const download = page.waitForEvent("download");
  await page.locator("#export3mf").click();
  return triangles(fs.readFileSync((await (await download).path())!));
}

test("add a different STL, then undo, save, and export both parts", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await quiet(page);
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await shot(page, "prepare-before.png");

  expect(await exportTriangles(page)).toBe(12);
  const accept = (await page.locator("#plateAddFile").getAttribute("accept"))!.toLowerCase();
  expect(accept).toContain(".stl");
  expect(accept).toContain(".3mf");
  expect(accept).toContain(".step");
  expect(accept).not.toContain("lime");
  expect((await page.locator("#file").getAttribute("accept"))!.toLowerCase()).toContain(".lime");

  const chooser = page.waitForEvent("filechooser");
  await page.locator("#plateAdd").click();
  await (await chooser).setFiles(path.resolve("samples/overhang_ledge.stl"));
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("[data-selected='true']")).toContainText("overhang_ledge.stl");
  await expect(page.locator("[data-plate-id='part'] span").first()).toHaveText("20 × 20 × 20 mm");
  await expect(page.locator("[data-selected='true'] span").first()).toHaveText("48 × 24 × 16 mm");
  await expect(page.locator("#plateOverlap")).toHaveCount(0);
  await shot(page, "prepare-after.png");

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  const sent = bodies[0]!.objects as { id: string; filename: string; dataB64: string }[];
  expect(sent.map((obj) => obj.filename)).toEqual(["calibration_cube_20mm.stl", "overhang_ledge.stl"]);
  expect(sent[0]!.dataB64).not.toBe(sent[1]!.dataB64);
  expect(meshKeyHex(Buffer.from(sent[0]!.dataB64, "base64"))).not.toBe(meshKeyHex(Buffer.from(sent[1]!.dataB64, "base64")));
  expect(new Set(sent.map((obj) => obj.id)).size).toBe(2);

  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("[data-plate-id]").nth(1)).toContainText("overhang_ledge.stl");
  await expect(page.locator("[data-selected='true'] span").first()).toHaveText("48 × 24 × 16 mm");

  const [plateFile] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Control+s"),
  ]);
  const doc = JSON.parse(fs.readFileSync((await plateFile.path())!, "utf8")) as {
    version: number;
    objects?: { name: string; mesh: { name: string; bytesBase64: string } }[];
  };
  expect(doc.version).toBe(2);
  expect(doc.objects?.map((obj) => obj.mesh.name)).toEqual(["calibration_cube_20mm.stl", "overhang_ledge.stl"]);
  expect(doc.objects![0]!.mesh.bytesBase64).not.toBe(doc.objects![1]!.mesh.bytesBase64);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#projectFile").setInputFiles({
    name: "two-parts.lime",
    mimeType: "application/json",
    buffer: fs.readFileSync((await plateFile.path())!),
  });
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("[data-plate-id='part'] span").first()).toHaveText("20 × 20 × 20 mm");
  await expect(page.locator("[data-plate-id]").nth(1).locator("span").first()).toHaveText("48 × 24 × 16 mm");

  expect(await exportTriangles(page)).toBe(36);
});

test("duplicate copies the selected object", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  await page.locator("#prepare").click();
  await page.keyboard.press("Control+d");
  await expect(page.locator("[data-plate-id]")).toHaveCount(3);
  await expect(page.locator("[data-selected='true'] span").first()).toHaveText("20 × 20 × 20 mm");
  await expect(page.locator("[data-plate-id]").filter({ hasText: "overhang_ledge.stl" })).toHaveCount(1);
  await expect(page.locator("[data-plate-id]").filter({ hasText: "20 × 20 × 20 mm" })).toHaveCount(2);
});

test("cancelling the picker or a bad file leaves the plate alone", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.evaluate(() => {
    document.querySelector("#plateAddFile")!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  await expect(page.locator(".toast")).toHaveCount(0);

  await page.locator("#plateAddFile").setInputFiles({
    name: "notes.stl",
    mimeType: "model/stl",
    buffer: Buffer.from("this is not a mesh"),
  });
  await expect(page.locator(".toast-error")).toContainText("Could not read notes.stl");
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  await expect(page.locator("[data-plate-id='part']")).toContainText("calibration_cube_20mm.stl");
});

test("add reads a STEP at the chord on screen", async ({ page }) => {
  const meshCalls: { filename?: string; stepToleranceMm?: number }[] = [];
  await quiet(page);
  await page.route("**/api/mesh", async (route) => {
    meshCalls.push(route.request().postDataJSON());
    await route.fulfill({ json: { positions: [0, 0, 0, 30, 0, 0, 0, 12, 8] } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.locator("#plateAddFile").setInputFiles({
    name: "bracket.step",
    mimeType: "model/step",
    buffer: Buffer.from("ISO-10303-21;"),
  });
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("[data-selected='true']")).toContainText("bracket.step");
  expect(meshCalls[0]).toMatchObject({ filename: "bracket.step", stepToleranceMm: 0.1 });

  await page.locator("#stepTol").fill("0.25");
  await page.locator("#stepTol").blur();
  await expect.poll(() => meshCalls.filter((call) => call.filename === "bracket.step" && call.stepToleranceMm === 0.25).length).toBeGreaterThan(0);
  await page.locator("#plateAddFile").setInputFiles({
    name: "clip.step",
    mimeType: "model/step",
    buffer: Buffer.from("ISO-10303-21;"),
  });
  await expect(page.locator("[data-plate-id]")).toHaveCount(3);
  await expect.poll(() => meshCalls.some((call) => call.filename === "clip.step" && call.stepToleranceMm === 0.25)).toBe(true);
});

test("File > Open still replaces the plate", async ({ page }) => {
  await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#file").setInputFiles("samples/bridge_span.stl");
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  await expect(page.locator("[data-plate-id='part']")).toContainText("bridge_span.stl");
  await expect(page.locator("[data-plate-id='part'] span").first()).toHaveText("30 × 16 × 10 mm");
});
