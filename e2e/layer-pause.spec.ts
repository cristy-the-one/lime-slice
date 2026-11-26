import { expect, test, type Page } from "@playwright/test";
import { acceptSheets } from "./ask-sheet";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type Action = { zMm: number; kind: string; note?: string };
type SliceBody = { layerActions?: Action[] };

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: SliceBody[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  return bodies;
}

async function sliceMatching(page: Page, bodies: SliceBody[], match: (body: SliceBody) => boolean) {
  const start = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.slice(start).some(match)).toBe(true);
}

test("a layer marker cycles pause, filament change, and clear", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await sliceMatching(page, bodies, (body) => body.layerActions === undefined);
  await page.locator("#tabPreview").click();
  const button = page.locator("#layerAction");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("+");
  await expect(button).toHaveAttribute("aria-label", "Pause at this layer");
  await expect(button).toHaveAttribute("data-tip", "Pause at this layer");

  await button.click();
  await expect(button).toHaveText("P");
  await expect(page.locator("#layerPins .layer-pin")).toHaveCount(1);
  await expect(button).toHaveAttribute("data-tip", "Filament change at this layer. On Klipper, M600 needs a macro in printer.cfg.");
  await sliceMatching(page, bodies, (body) => body.layerActions?.length === 1 && body.layerActions[0].kind === "pause" && (body.layerActions[0].zMm ?? 0) > 0);

  await button.click();
  await expect(button).toHaveText("F");
  await sliceMatching(page, bodies, (body) => body.layerActions?.length === 1 && body.layerActions[0].kind === "filamentChange");

  await button.click();
  await expect(button).toHaveText("+");
  await expect(page.locator("#layerPins .layer-pin")).toHaveCount(0);
  await sliceMatching(page, bodies, (body) => body.layerActions === undefined);
});

test("a saved project keeps its layer actions, and a new mesh clears them", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  const loadCube = () => page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await loadCube();
  await expect(page.locator("#slice")).toBeEnabled();
  await sliceMatching(page, bodies, (body) => body.layerActions === undefined);
  await page.locator("#tabPreview").click();
  await page.locator("#layerAction").click();
  await expect(page.locator("#layerPins .layer-pin")).toHaveCount(1);
  await sliceMatching(page, bodies, (body) => body.layerActions?.length === 1);
  const sent = bodies[bodies.length - 1].layerActions!;
  expect(sent).toEqual([{ zMm: expect.any(Number), kind: "pause" }]);

  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const saved = fs.readFileSync((await download.path())!);
  expect((JSON.parse(saved.toString("utf8")) as { layerActions?: Action[] }).layerActions).toEqual(sent);

  page.on("dialog", (dialog) => void dialog.accept());

  await acceptSheets(page);
  await loadCube();
  await expect(page.locator("#layerPins .layer-pin")).toHaveCount(0);
  await sliceMatching(page, bodies, (body) => body.layerActions === undefined);

  await page.locator("#projectFile").setInputFiles({ name: "cube.lime", mimeType: "application/json", buffer: saved });
  await expect(page.locator("#objectList")).toContainText("calibration_cube");
  await sliceMatching(page, bodies, (body) => JSON.stringify(body.layerActions) === JSON.stringify(sent));
  await page.locator("#tabPreview").click();
  await expect(page.locator("#layerPins .layer-pin")).toHaveCount(1);
});

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Hit box of the range thumb. The input ignores pointers except on the thumb, so elementFromPoint finds it. */
async function thumbBox(page: Page, id: string): Promise<Box> {
  const box = await page.locator(id).evaluate((input) => {
    const track = input.parentElement!.getBoundingClientRect();
    const hits: { x: number; y: number }[] = [];
    const x0 = Math.floor(track.left) - 16;
    const x1 = Math.ceil(track.right) + 16;
    const y0 = Math.floor(track.top) - 20;
    const y1 = Math.ceil(track.bottom) + 20;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (document.elementFromPoint(x, y) === input) hits.push({ x, y });
      }
    }
    if (hits.length === 0) return null;
    const xs = hits.map((hit) => hit.x);
    const ys = hits.map((hit) => hit.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs) + 1;
    const bottom = Math.max(...ys) + 1;
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
  expect(box, `${id} thumb hit box`).not.toBeNull();
  return box!;
}

test("the pause button sits clear of a wider layer thumb", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await page.locator("#tabPreview").click();
  const button = page.locator("#layerAction");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("+");

  const at = async (where: string) => {
    const thumb = await thumbBox(page, "#rangeHigh");
    const pause = (await button.boundingBox())!;
    const gap = pause.x - (thumb.x + thumb.width);
    expect.soft(thumb.width, `${where} thumb width`).toBeGreaterThanOrEqual(22);
    expect.soft(thumb.height, `${where} thumb height`).toBeGreaterThanOrEqual(22);
    expect.soft(gap, `${where} gap between thumb and pause`).toBeGreaterThanOrEqual(6);
    expect.soft(overlaps(pause, thumb), `${where} pause overlaps the thumb`).toBe(false);
    expect.soft(pause.y < thumb.y + thumb.height && pause.y + pause.height > thumb.y, `${where} pause tracks the thumb`).toBe(true);
    return { thumb, pause, gap };
  };

  const top = await at("top layer");
  const next = (await page.locator("#layerNext").boundingBox())!;
  expect.soft(overlaps(top.pause, next), "top layer pause overlaps Next layer").toBe(false);

  const before = await page.locator("#rangeHigh").inputValue();
  const track = (await page.locator("#vslider .track").boundingBox())!;
  await page.mouse.click(track.x + track.width / 2, track.y + track.height / 2);
  await expect(page.locator("#rangeHigh")).toHaveValue(before);

  const thumb = top.thumb;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 70, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator("#rangeHigh").inputValue())).toBeLessThan(Number(before));

  await page.locator("#rangeHigh").evaluate((el: HTMLInputElement) => {
    el.value = String(Math.round(Number(el.max) / 2));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await at("middle layer");
});