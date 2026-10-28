import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveSliceJob } from "./serve-job";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));
const out = path.resolve("test-results/preview-section-arrow");

const AMBER: [number, number, number] = [0xf5, 0xa5, 0x24];
const HOT: [number, number, number] = [0xff, 0xff, 0xff];
const RINGS: [number, number, number][] = [[0xe8, 0x5d, 0x4c], [0x8f, 0xce, 0x6a], [0x6a, 0xa7, 0xff]];

type Gizmo = { ringX: number; ringY: number; amber: number; amberX: number; amberY: number; hot: number };

/** The parked aim gizmo on the left of the 3D view: the rings' centre, and the arrow's amber and hot pixels near it. CSS px in the view. */
async function gizmo(page: Page, name = ""): Promise<Gizmo> {
  const png = name
    ? await page.locator("#view3d").screenshot({ path: path.join(out, `${name}.png`) })
    : await page.locator("#view3d").screenshot();
  return page.evaluate(async ({ data, amber, hot, rings }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const near = (i: number, c: number[], tol: number) =>
      Math.abs(px[i] - c[0]) + Math.abs(px[i + 1] - c[1]) + Math.abs(px[i + 2] - c[2]) < tol;
    const left = Math.floor(canvas.width * 0.34);
    let rn = 0, rx = 0, ry = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < left; x++) {
        const i = (y * canvas.width + x) * 4;
        if (rings.some((c) => near(i, c, 50))) { rn++; rx += x; ry += y; }
      }
    }
    const ringX = rn ? rx / rn : 0;
    const ringY = rn ? ry / rn : 0;
    let an = 0, ax = 0, ay = 0, hn = 0;
    const reach = 150;
    for (let y = Math.max(0, Math.floor(ringY - reach)); y < Math.min(canvas.height, ringY + reach); y++) {
      for (let x = Math.max(0, Math.floor(ringX - reach)); x < Math.min(canvas.width, ringX + reach); x++) {
        const i = (y * canvas.width + x) * 4;
        if (near(i, amber, 60)) { an++; ax += x; ay += y; }
        if (near(i, hot, 24)) hn++;
      }
    }
    return { ringX, ringY, amber: an, amberX: an ? ax / an : 0, amberY: an ? ay / an : 0, hot: hn };
  }, { data: png.toString("base64"), amber: AMBER, hot: HOT, rings: RINGS });
}

async function offsetOf(page: Page) {
  return Number(await page.locator("#sectionOffset").inputValue());
}

async function openSection(page: Page, belt: boolean) {
  const logs: string[] = [];
  page.on("pageerror", (err) => logs.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  if (belt) {
    await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
    await page.route("**/api/slice", (route) => route.fulfill({ json: beltCube }));
  } else {
    await serveSliceJob(page, cube);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  if (belt) {
    await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await page.locator("#machinePrinter").selectOption("ideaformer-ir3-v2");
    await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  }
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect(page.locator("#estimate")).toContainText("g");
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.locator('#toolRail [data-tool="section"]').click();
  await expect(page.locator("#sectionOn")).toBeChecked();
  await expect(page.locator("#sectionAxis")).toHaveValue("z");
  await page.mouse.move(1430, 990);
  await page.waitForTimeout(400);
  return logs;
}

for (const belt of [false, true]) {
  const name = belt ? "ir3" : "flat";
  test(`the clip plane's arrow lights on hover and its drag moves the plane (${name})`, async ({ page }) => {
    fs.mkdirSync(out, { recursive: true });
    const logs = await openSection(page, belt);
    const box = (await page.locator("#view3d").boundingBox())!;
    const rest = await gizmo(page, `${name}-rest`);
    expect(rest.amber, "the arrow is drawn amber beside the rings").toBeGreaterThan(80);
    // The arrow starts at the rings' centre and points along the normal: grab it halfway out.
    const grabX = box.x + (rest.ringX + rest.amberX) / 2 + (rest.amberX - rest.ringX) * 0.4;
    const grabY = box.y + (rest.ringY + rest.amberY) / 2 + (rest.amberY - rest.ringY) * 0.4;
    await page.mouse.move(grabX, grabY, { steps: 4 });
    await page.waitForTimeout(200);
    const hovered = await gizmo(page, `${name}-hover`);
    await page.screenshot({ path: path.join(out, `${name}-page-hover.png`) });
    expect(hovered.amber, "a hovered arrow is no longer amber").toBeLessThan(rest.amber * 0.3);
    expect(hovered.hot, "a hovered arrow takes the hot colour").toBeGreaterThan(rest.hot + 60);
    await expect(page.locator("#view3d")).toHaveCSS("cursor", "grab");

    const before = await offsetOf(page);
    const along = { x: rest.amberX - rest.ringX, y: rest.amberY - rest.ringY };
    const length = Math.hypot(along.x, along.y);
    const ux = along.x / length;
    const uy = along.y / length;
    await page.mouse.down();
    await page.mouse.move(grabX - ux * 60, grabY - uy * 60, { steps: 10 });
    const during = await gizmo(page, `${name}-drag`);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const lowered = await offsetOf(page);
    expect(lowered, "dragging the arrow back lowers the plane").toBeLessThan(before - 1);
    expect(during.hot).toBeGreaterThan(rest.hot + 60);

    // The gizmo stays parked at the edge while the plane moves, so the next grab is in the same place.
    await page.mouse.move(grabX, grabY, { steps: 4 });
    await page.mouse.down();
    await page.mouse.move(grabX + ux * 30, grabY + uy * 30, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const raised = await offsetOf(page);
    expect(raised, "dragging the arrow out raises the plane").toBeGreaterThan(lowered + 1);
    await page.mouse.move(1430, 990);
    await page.waitForTimeout(200);
    const after = await gizmo(page, `${name}-after`);
    expect(after.amber).toBeGreaterThan(rest.amber * 0.6);
    await page.screenshot({ path: path.join(out, `${name}-page-after.png`) });
    expect(logs).toEqual([]);
  });
}
