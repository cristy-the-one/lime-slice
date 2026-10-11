import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";
import { scrubTravel } from "../src/ui/scrub.ts";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const shots = path.resolve("/opt/cursor/artifacts/plate-scrub");
fs.mkdirSync(shots, { recursive: true });

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
}

async function loadCube(page: Page) {
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator("[data-scrub=x]")).toBeVisible();
}

async function share(page: Page) {
  const box = await page.evaluate(() => {
    const el = document.querySelector("#prepare");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewW: window.innerWidth, viewH: window.innerHeight };
  });
  expect(box).not.toBeNull();
  return canvasShare({ width: box!.width, height: box!.height }, { width: box!.viewW, height: box!.viewH });
}

async function dragLabel(page: Page, axis: "x" | "y", dx: number, dy: number, shift = false) {
  const label = page.locator(`[data-scrub=${axis}]`);
  await label.scrollIntoViewIfNeeded();
  const box = (await label.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 6);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  return { up: async () => {
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
  } };
}

test("dragging X moves the centre by tenths, once, and a typed tenth is one undo", async ({ page }) => {
  const bodies: { dataB64?: string; pose?: { rotation: number[]; translation: number[] } }[] = [];
  await quiet(page);
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: cube });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await loadCube(page);
  await page.screenshot({ path: path.join(shots, "before-xy.png") });

  const pane = await page.evaluate(() => {
    const canvas = document.querySelector("#prepare")!.getBoundingClientRect();
    const host = document.querySelector("#prepareBody")!.getBoundingClientRect();
    return (canvas.width * canvas.height) / (host.width * host.height);
  });
  expect(pane, `prepare canvas of its pane ${pane}`).toBeGreaterThanOrEqual(0.7);
  await expect(page.locator("#placeX")).toHaveAttribute("step", "0.1");
  await expect(page.locator("#placeY")).toHaveAttribute("step", "0.1");
  await expect(page.locator("#partScale")).toHaveAttribute("step", "5");

  const before = Number(await page.locator("#placeX").inputValue());
  const gesture = await dragLabel(page, "x", scrubTravel(14), 0);
  await expect(page.locator("#gizmoReadout")).toHaveText("X +1.4 mm");
  await page.screenshot({ path: path.join(shots, "during-x-scrub.png") });
  await gesture.up();
  await expect(page.locator("#gizmoReadout")).toBeHidden();
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before + 1.4, 1);
  await page.screenshot({ path: path.join(shots, "after-x-scrub.png") });

  await page.keyboard.press("Control+z");
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before, 1);
  await page.keyboard.press("Control+Shift+Z");
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before + 1.4, 1);
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before, 1);

  const shifted = await dragLabel(page, "x", scrubTravel(2), 0, true);
  await shifted.up();
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before + 2, 1);
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before, 1);

  const nudge = await dragLabel(page, "x", 2, 0);
  await nudge.up();
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before, 1);

  const down = await dragLabel(page, "x", 0, 28);
  await down.up();
  await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before, 1);

  const y0 = Number(await page.locator("#placeY").inputValue());
  const yDrag = await dragLabel(page, "y", scrubTravel(-3), 0);
  await yDrag.up();
  await expect.poll(() => page.locator("#placeY").inputValue().then(Number)).toBeCloseTo(y0 - 0.3, 1);
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.locator("#placeY").inputValue().then(Number)).toBeCloseTo(y0, 1);

  const field = page.locator("#placeX");
  await field.click();
  await field.fill("12.5");
  await field.blur();
  await page.waitForTimeout(400);
  await expect.poll(() => field.inputValue().then(Number)).toBeCloseTo(12.5, 1);
  await page.keyboard.press("Control+z");
  await expect.poll(() => field.inputValue().then(Number)).toBeCloseTo(before, 1);

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  const home = bodies[0]!;
  const moved = await dragLabel(page, "x", scrubTravel(14), 0);
  await moved.up();
  // An X move re-emits by itself. The mesh bytes and the rotation stay.
  await expect.poll(() => bodies.length).toBe(2);
  const next = bodies[1]!;
  expect(next.dataB64).toBe(home.dataB64);
  expect(next.pose?.rotation).toEqual(home.pose?.rotation);
  expect(next.pose!.translation[0]).toBeCloseTo(home.pose!.translation[0] + 1.4, 1);
  expect(next.pose!.translation[1]).toBeCloseTo(home.pose!.translation[1], 1);
});

test.describe("compact sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a short drag scrolls the sheet and does not move the solid", async ({ page }) => {
    await quiet(page);
    await page.goto("/?layout=compact");
    await autoSliceOff(page);
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    await loadCube(page);
    const peek = await share(page);
    expect(peek, `peek share ${peek}`).toBeGreaterThanOrEqual(0.7);

    await page.locator("#compactTabs [data-tab=settings]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "half");
    const label = page.locator("[data-scrub=x]");
    await label.scrollIntoViewIfNeeded();
    const before = Number(await page.locator("#placeX").inputValue());
    const scroller = page.locator("#compactSheetBody");
    const top = await scroller.evaluate((el) => el.scrollTop);

    const box = (await label.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 2, id: 1 }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before, 1);

    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 1, y: y + 48, id: 1 }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await client.detach();
    await expect.poll(() => page.locator("#placeX").inputValue().then(Number)).toBeCloseTo(before, 1);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).not.toBe(top);
    await page.screenshot({ path: path.join(shots, "compact-scroll.png") });
  });
});
