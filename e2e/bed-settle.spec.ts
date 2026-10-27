import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { placeText } from "./place";

interface Grip {
  from: { x: number; y: number };
  to: { x: number; y: number };
  facing: number;
}

async function ringGrip(page: Page, axis: "x" | "y" | "z"): Promise<Grip> {
  const canvas = page.locator("#prepare");
  await expect.poll(async () => canvas.getAttribute("data-ring-grips")).toBeTruthy();
  const text = (await canvas.getAttribute("data-ring-grips")) ?? "";
  const box = (await canvas.boundingBox())!;
  for (const item of text.split(" ")) {
    const [id, from, to, facing] = item.split(":");
    if (id !== axis) continue;
    const [fx, fy] = from!.split(",").map(Number);
    const [tx, ty] = to!.split(",").map(Number);
    return { from: { x: box.x + fx!, y: box.y + fy! }, to: { x: box.x + tx!, y: box.y + ty! }, facing: Number(facing) };
  }
  throw new Error(`no grip for ${axis}`);
}

const field = (page: Page, id: "placeRx" | "placeRy" | "placeRz") => page.locator(`#${id}`);

async function rotation(page: Page) {
  return {
    x: Number(await field(page, "placeRx").inputValue()),
    y: Number(await field(page, "placeRy").inputValue()),
    z: Number(await field(page, "placeRz").inputValue()),
  };
}

async function loadCube(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ status: 404, json: { error: "off" } }));
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#partScale")).toHaveValue("100");
  await page.locator('#toolRail .tool[data-tool="rotate"]').click();
  await expect(page.locator("#toolRail")).toHaveAttribute("data-tool", "rotate");
}

/** Press on the ring, turn it by 10 degrees one way (`sign` 1) or the other, and stop short of the release. */
async function holdRing(page: Page, axis: "x" | "y" | "z", sign: 1 | -1) {
  const grip = await ringGrip(page, axis);
  const a = sign > 0 ? grip.from : grip.to;
  const b = sign > 0 ? grip.to : grip.from;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
}

async function pickRing(page: Page): Promise<"x" | "y"> {
  const x = await ringGrip(page, "x");
  const y = await ringGrip(page, "y");
  return x.facing >= y.facing ? "x" : "y";
}

test("a turn never sinks the part below the bed", async ({ page }) => {
  await loadCube(page);
  const axis = await pickRing(page);
  await holdRing(page, axis, 1);
  const turned = await rotation(page);
  expect(Math.abs(turned.x) + Math.abs(turned.y)).toBeGreaterThan(3);
  expect(await placeText(page)).toContain("bed Z 0.0");
  await page.mouse.up();
  expect(await placeText(page)).toContain("bed Z 0.0");

  await field(page, "placeRx").fill("37");
  await field(page, "placeRx").press("Tab");
  await expect.poll(async () => placeText(page)).toContain("bed Z 0.0");
  await field(page, "placeRy").fill("-52.5");
  await field(page, "placeRy").press("Tab");
  await expect.poll(async () => placeText(page)).toContain("bed Z 0.0");
});

test("with Settle on, a drag that ends near flat comes to rest flat, and the contact shows", async ({ page }) => {
  await loadCube(page);
  await page.locator("#settleOn").check();
  const axis = await pickRing(page);
  await holdRing(page, axis, 1);
  await expect(page.locator("#contactReadout")).toBeVisible();
  await expect(page.locator("#contactReadout")).toHaveText("Contact 400 mm²");
  await expect(page.locator("#prepare")).toHaveAttribute("data-contact", /^[1-9]/);
  if (process.env.LIME_SHOTS) await page.locator("#prepareBody").screenshot({ path: `${process.env.LIME_SHOTS}/bed-settle/mid-drag.png` });
  await page.mouse.up();
  await expect(page.locator("#contactReadout")).toBeHidden();
  await expect(page.locator("#prepare")).toHaveAttribute("data-contact", "0");
  const rest = await rotation(page);
  expect(rest).toEqual({ x: 0, y: 0, z: 0 });
  expect(await placeText(page)).toContain("bed Z 0.0");
  if (process.env.LIME_SHOTS) await page.locator("#prepareBody").screenshot({ path: `${process.env.LIME_SHOTS}/bed-settle/settled.png` });
});

test("with Settle off, the same drag keeps the angle and still shows the contact", async ({ page }) => {
  await loadCube(page);
  const axis = await pickRing(page);
  await holdRing(page, axis, 1);
  await expect(page.locator("#contactReadout")).toBeVisible();
  await expect(page.locator("#contactReadout")).toHaveText(/^Contact \d+ mm²$/);
  const text = (await page.locator("#contactReadout").textContent()) ?? "";
  expect(Number(/\d+/.exec(text)![0])).toBeLessThan(100);
  if (process.env.LIME_SHOTS) await page.locator("#prepareBody").screenshot({ path: `${process.env.LIME_SHOTS}/bed-settle/mid-drag-free.png` });
  await page.mouse.up();
  const turned = await rotation(page);
  expect(Math.abs(turned.x) + Math.abs(turned.y)).toBeGreaterThan(5);
});

test("a pose far from every flat face keeps its angle with Settle on", async ({ page }) => {
  await loadCube(page);
  await page.locator("#settleOn").check();
  await field(page, "placeRx").fill("40");
  await field(page, "placeRx").press("Tab");
  await expect.poll(async () => (await rotation(page)).x).toBeCloseTo(40, 1);
  await holdRing(page, "x", 1);
  await page.mouse.up();
  const after = await rotation(page);
  expect(Math.abs(after.x - 40)).toBeGreaterThan(3);
  expect(Math.abs(after.x - 40)).toBeLessThan(20);
  expect(await placeText(page)).toContain("bed Z 0.0");
});

test("one undo takes back a rotate and settle", async ({ page }) => {
  await loadCube(page);
  await field(page, "placeRx").fill("5");
  await field(page, "placeRx").press("Tab");
  await expect.poll(async () => (await rotation(page)).x).toBeCloseTo(5, 1);
  // A typed edit closes its undo step 280 ms after the last change; the drag is a step of its own.
  await page.waitForTimeout(450);
  await page.locator("#settleOn").check();
  await holdRing(page, "x", -1);
  await page.mouse.up();
  const settled = await rotation(page);
  expect(Math.abs(settled.x - 5)).toBeGreaterThan(1);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await rotation(page)).x).toBeCloseTo(5, 1);
  expect(await rotation(page)).toMatchObject({ y: 0, z: 0 });
});
