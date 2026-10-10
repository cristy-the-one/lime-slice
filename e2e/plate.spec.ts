import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { placeText } from "./place";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
}

async function share(page: Page, selector: string) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  }, selector);
  expect(box, selector).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
}

test("add, select, place, overlap, arrange, undo, and save a plate", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await quiet(page);
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await loadCube(page);

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  const alone = bodies[0]!;
  expect(alone).not.toHaveProperty("objects");
  expect(alone).not.toHaveProperty("offset");
  expect(String(alone.filename)).toContain("cube");
  expect(alone).toHaveProperty("pose");
  const aloneTris = stlTriangles(alone.dataB64);

  const [single] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Control+s"),
  ]);
  const singleDoc = JSON.parse(fs.readFileSync((await single.path())!, "utf8")) as { version: number; objects?: unknown; mesh?: { name: string } };
  expect(singleDoc.version).toBe(1);
  expect(singleDoc.objects).toBeUndefined();
  expect(singleDoc.mesh?.name).toContain("cube");

  await page.locator("#plateAdd").click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("[data-selected='true']")).toContainText("2");
  await expect(page.locator("#plateOverlap")).toContainText("overlaps");
  await expect(page.locator("#plateDuplicate")).toBeVisible();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-objects", "2");
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-overlap", "1");

  await page.locator("#partScale").fill("50");
  await expect(page.locator("#partScale")).toHaveValue("50");
  await page.waitForTimeout(400);
  await page.locator("#rotZ").click();
  await expect(page.locator("[data-selected='true'] span")).toContainText("10 × 10 × 10 mm");
  await expect(page.locator("[data-plate-id='part'] span")).toContainText("20 × 20 × 20 mm");
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-selected='true'] span")).toContainText("10 × 10 × 10 mm");

  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  await expect(page.locator("#partScale")).toHaveValue("100");
  await page.locator("[data-plate-select]").nth(1).click();
  await expect(page.locator("#partScale")).toHaveValue("50");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#partScale")).toHaveValue("50");

  const before = await placeText(page);
  await page.locator("#plateArrange").click();
  await expect(page.locator("#plateOverlap")).toHaveCount(0);
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-overlap", "0");
  await expect.poll(() => placeText(page)).not.toBe(before);

  const [plateFile] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Control+s"),
  ]);
  const plateDoc = JSON.parse(fs.readFileSync((await plateFile.path())!, "utf8")) as {
    version: number;
    mesh?: unknown;
    objects?: { id: string; placement: { scale: number } }[];
    printOrder?: unknown;
  };
  expect(plateDoc.version).toBe(2);
  expect(plateDoc.mesh).toBeUndefined();
  expect(plateDoc.objects?.[0]?.id).toBe("part");
  expect(plateDoc.objects?.[1]?.id).toMatch(/^obj-/);
  expect(plateDoc.objects?.[1]?.placement.scale).toBeCloseTo(0.5);
  expect(plateDoc).not.toHaveProperty("printOrder");

  await page.keyboard.press("Control+z");
  await expect(page.locator("#plateOverlap")).toContainText("overlaps");
  await expect(page.locator("[data-selected='true'] span")).toContainText("10 × 10 × 10 mm");
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-selected='true'] span")).toContainText("20 × 20 × 20 mm");
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#projectFile").setInputFiles({
    name: "plate.lime",
    mimeType: "application/json",
    buffer: fs.readFileSync((await plateFile.path())!),
  });
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);
  await expect(page.locator("[data-plate-id='part'] span")).toContainText("20 × 20 × 20 mm");
  await expect(page.locator("[data-plate-id]").nth(1).locator("span")).toContainText("10 × 10 × 10 mm");
  await expect(page.locator("#plateOverlap")).toHaveCount(0);

  await page.locator("[data-plate-remove]").nth(1).click();
  await expect(page.locator("[data-plate-id]")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator("[data-plate-id]")).toHaveCount(2);

  const beforeSlice = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(beforeSlice + 1);
  const sent = bodies.at(-1)!;
  type Sent = { id: string; filename: string; dataB64: string; pose: { translation: number[] } };
  const objects = sent.objects as Sent[];
  for (const key of ["filename", "dataB64", "pose", "printOrder", "offset"]) expect(sent).not.toHaveProperty(key);
  expect(objects.map((o) => o.id)).toEqual(["part", expect.stringMatching(/^obj-/)]);
  expect(objects.map((o) => o.filename)).toEqual(["calibration_cube_20mm.stl", "calibration_cube_20mm.stl"]);
  expect(objects.map((o) => stlTriangles(o.dataB64))).toEqual([aloneTris, aloneTris]);
  expect(objects[0]!.pose.translation[0]).not.toBeCloseTo(objects[1]!.pose.translation[0], 1);
});

function stlTriangles(dataB64: unknown): number {
  const raw = Buffer.from(String(dataB64), "base64");
  return raw.readUInt32LE(80);
}

test.describe("compact plate list", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test("the object list stays in the sheet and the peek canvas stays at least 70%", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await loadCube(page);
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    const prepare = await share(page, "#prepare");
    expect(prepare, `prepare viewport share ${prepare}`).toBeGreaterThanOrEqual(0.7);

    await page.locator("#compactTabs [data-tab=settings]").click();
    await expect(page.locator("#compactSheet #plateAdd")).toBeVisible();
    await expect(page.locator("#compactSheet #plateDuplicate")).toBeVisible();
    await expect(page.locator("#compactSheet #objectList")).toBeVisible();
    await page.locator("#plateAdd").click();
    await expect(page.locator("#compactSheet [data-plate-id]")).toHaveCount(2);
    await expect(page.locator("#compactSheet #plateOverlap")).toBeVisible();

    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    const peeked = await share(page, "#prepare");
    expect(peeked, `peek viewport share ${peeked}`).toBeGreaterThanOrEqual(0.7);
  });
});
