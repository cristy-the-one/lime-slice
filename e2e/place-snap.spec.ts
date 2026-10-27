import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const shots = path.resolve("test-results/place-snap");
fs.mkdirSync(shots, { recursive: true });

async function commit(page: Page, id: "#placeX" | "#placeY", value: number) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press("Tab");
}

/** The 20 mm cube centred at (100, 100) is "part"; the 48 x 24 x 16 ledge centred at (150, 100) is added last and selected. */
async function twoObjects(page: Page): Promise<string> {
  await page.addInitScript(() => {
    localStorage.setItem("lime-slice-closed-groups", "[]");
    localStorage.setItem("lime-slice-theme", "dark");
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await commit(page, "#placeX", 100);
  await commit(page, "#placeY", 100);
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  await commit(page, "#placeX", 150);
  await commit(page, "#placeY", 100);
  const id = await page.locator("#prepare").getAttribute("data-plate-selected");
  expect(id).toBeTruthy();
  return id!;
}

async function greyCentre(page: Page, id: string): Promise<{ x: number; y: number }> {
  const canvas = page.locator("#prepare");
  const read = async () => {
    const raw = (await canvas.getAttribute("data-plate-context-screen")) ?? "";
    const entry = raw.split(" ").find((item) => item.startsWith(`${id}:`));
    return entry ? entry.split(":")[1]!.split(",").map(Number) : null;
  };
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await read());
    const settled = now === last && now !== "null";
    last = now;
    return settled;
  }).toBe(true);
  const [x, y, w, h] = (await read())!;
  const box = (await canvas.boundingBox())!;
  return { x: box.x + x! + w! / 2, y: box.y + y! + h! / 2 };
}

const field = async (page: Page, id: string) => Number(await page.locator(id).inputValue());
const snapOf = (page: Page) => page.locator("#prepare").getAttribute("data-snap");

/** Select the cube and arm Move; the cube's body is the thing to drag. Returns where its middle is on the page. */
async function armCube(page: Page): Promise<{ x: number; y: number }> {
  await page.locator("#viewPresets button").nth(0).click();
  await page.waitForTimeout(1200);
  const canvasBox = (await page.locator("#prepare").boundingBox())!;
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, 200);
  await page.waitForTimeout(800);
  const at = await greyCentre(page, "part");
  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  await page.locator('#toolRail .tool[data-tool="move"]').click();
  return at;
}

/** Drag right in small steps until `stop` says so. The mouse stays down; the caller releases it. */
async function pushRight(page: Page, from: { x: number; y: number }, stop: () => Promise<boolean>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  let x = from.x;
  for (let i = 0; i < 160; i += 1) {
    x += 8;
    await page.mouse.move(x, from.y);
    if (await stop()) return true;
  }
  return false;
}

test("dragging a part near another snaps it flush, shows what it met, and tints that part", async ({ page }) => {
  const ledge = await twoObjects(page);
  const start = await armCube(page);
  const canvas = page.locator("#prepare");

  await expect(canvas).toHaveAttribute("data-snap-target", "");
  const snapped = await pushRight(page, start, async () => ((await snapOf(page)) ?? "").includes("Touching"));
  expect(snapped, "the drag reached a snap").toBe(true);
  const label = await snapOf(page);
  expect(label).toMatch(/Touching .* · X/);
  await expect(page.locator("#gizmoReadout")).toContainText(label!);
  await expect(canvas).toHaveAttribute("data-snap-target", ledge);
  await page.screenshot({ path: path.join(shots, "snap-during-drag.png") });
  expect(Math.abs((await field(page, "#placeX")) - 116)).toBeLessThan(0.06);
  await page.mouse.up();

  await expect(canvas).toHaveAttribute("data-snap-target", "");
  await expect(page.locator("#gizmoReadout")).toBeHidden();
  await expect.poll(() => field(page, "#placeX")).toBeCloseTo(116, 1);
});

test("holding Alt turns the snap off for that drag", async ({ page }) => {
  await twoObjects(page);
  const start = await armCube(page);
  const canvas = page.locator("#prepare");

  await page.keyboard.down("Alt");
  let reached = false;
  let sawLabel = false;
  const done = await pushRight(page, start, async () => {
    sawLabel ||= ((await snapOf(page)) ?? "") !== "";
    const x = await field(page, "#placeX");
    reached ||= x > 114 && x < 118;
    return x > 118.5;
  });
  expect(done).toBe(true);
  expect(reached, "the drag passed through the snap zone").toBe(true);
  expect(sawLabel).toBe(false);
  await expect(canvas).toHaveAttribute("data-snap-target", "");
  await page.mouse.up();
  await page.keyboard.up("Alt");
});

test("Align to... centres on the other part, and one Undo puts it back", async ({ page }) => {
  const ledge = await twoObjects(page);
  await page.locator("[data-plate-select='part']").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-plate-selected", "part");
  const before = { x: await field(page, "#placeX"), y: await field(page, "#placeY") };
  await commit(page, "#placeY", 130);
  await page.waitForTimeout(700);
  const lifted = { x: await field(page, "#placeX"), y: await field(page, "#placeY") };

  const row = page.locator("#placeAlign");
  await row.scrollIntoViewIfNeeded();
  await row.locator("#alignTo").focus();
  await expect(page.locator("#prepare")).toHaveAttribute("data-snap-target", "");
  await row.locator("#alignTo").selectOption(ledge);
  await expect(page.locator("#prepare")).toHaveAttribute("data-snap-target", ledge);
  await row.locator("#alignHow").selectOption("centre");
  await page.screenshot({ path: path.join(shots, "align-to.png") });
  await row.locator("#alignGo").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-snap-target", "");

  await expect.poll(() => field(page, "#placeX")).toBeCloseTo(150, 2);
  await expect.poll(() => field(page, "#placeY")).toBeCloseTo(100, 2);
  expect(before.y).toBe(100);

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect.poll(() => field(page, "#placeX")).toBeCloseTo(lifted.x, 2);
  await expect.poll(() => field(page, "#placeY")).toBeCloseTo(lifted.y, 2);
});

test("Align to... on top stacks the part, and the bed takes only flush and centre", async ({ page }) => {
  const ledge = await twoObjects(page);
  await page.locator("[data-plate-select='part']").click();
  const row = page.locator("#placeAlign");
  await row.locator("#alignTo").selectOption(ledge);
  await row.locator("#alignHow").selectOption("on-top");
  await row.locator("#alignGo").click();
  await expect(page.locator("#placeXY")).toHaveAttribute("data-bed-z", "16.0");
  await row.locator("#alignTo").selectOption("bed");
  await expect(row.locator("#alignHow option[value='on-top']")).toHaveCount(0);
  await expect(row.locator("#alignHow option[value='flush-left']")).toHaveCount(1);
});
