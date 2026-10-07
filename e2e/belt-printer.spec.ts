import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { canvasShare } from "../src/ui/compact/viewport-share.ts";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));
// The engine's reply for the same cube on a 45° belt: layer z is the belt
// position, 40 mm at the top. Regenerate with the ignored test in
// crates/lime-slice-core/tests/e2e_fixtures.rs.
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));

async function quiet(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
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

test("a belt printer sends belt settings and a cartesian printer does not", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    await route.fulfill({ json: body.belt ? beltCube : cube });
  });
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-plane", "1");
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await expect(page.locator("#beltFields")).toBeVisible();
  await expect(page.locator("#beltSeam")).not.toBeChecked();
  await expect(page.locator("#beltFloor")).not.toBeChecked();
  await expect(page.locator("#beltRaft")).not.toBeChecked();
  await expect(page.locator("#beltRaftLayers")).toBeDisabled();
  // Before any slice, so a toggle back to a sliced recipe cannot refresh it by itself.
  await page.locator("#beltFloor").check();
  await expect(page.locator("#beltRaft")).toBeDisabled();
  await page.locator("#beltFloor").uncheck();
  await expect(page.locator("#beltRaft")).toBeEnabled();
  await expect(page.getByText("Mock only")).toHaveCount(0);
  await page.locator("#beltCopies").fill("3");
  await page.locator("#beltCopies").blur();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-copies", "3");

  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  const belt = bodies[0].belt as Record<string, unknown>;
  expect(belt.angleDeg).toBe(45);
  expect(belt.axis).toBe("z");
  expect(belt.direction).toBe(1);
  expect(belt.copies).toBe(3);
  expect(belt).not.toHaveProperty("maxLengthMm");
  expect(belt).not.toHaveProperty("seamOnEdge");
  expect(belt).not.toHaveProperty("raftLayers");
  expect(belt).not.toHaveProperty("floorSupports");
  expect(bodies[0].printer).not.toHaveProperty("belt");
  await expect(page.locator("#banner")).not.toContainText("Mock");
  await expect(page.locator("#export")).toBeEnabled();
  await expect(page.locator("#sendPrinter")).toBeDisabled();
  await expect(page.locator("#sendPrinter")).toHaveAttribute("data-tip", /Prusa Link/);
  await page.locator("#tabPreview").click();
  await expect(page.locator("#beltMockTag")).toHaveCount(0);
  await expect(page.locator("#readHigh")).toHaveText(`Z ${beltCube.layers.at(-1).z.toFixed(2)}`);
  await expect(page.locator("#readHigh")).toHaveText("Z 40.00");

  await page.locator("#tabPrepare").click();
  await page.locator("#beltFloor").check();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect((bodies[1].belt as Record<string, unknown>).floorSupports).toBe(true);
  await page.locator("#beltFloor").uncheck();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2].belt).not.toHaveProperty("floorSupports");
  await expect(page.locator("#export")).toBeEnabled();
  await page.locator("#beltRaft").check();
  await expect(page.locator("#beltFloor")).toBeDisabled();
  await expect(page.locator("#beltRaftLayers")).toBeEnabled();
  await page.locator("#beltRaftLayers").fill("2");
  await page.locator("#beltRaftLayers").blur();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(4);
  const rafted = bodies[3].belt as Record<string, unknown>;
  expect(rafted.raftLayers).toBe(2);
  expect(rafted).not.toHaveProperty("floorSupports");
  await page.locator("#machineKind").selectOption("cartesian");
  await expect(page.locator("#beltFields")).toBeHidden();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "0");
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(5);
  expect(bodies[4]).not.toHaveProperty("belt");
  await expect(page.locator("#export")).toBeEnabled();
});

test("the generic belt printer is one pick in the printer list", async ({ page }) => {
  await quiet(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    await route.fulfill({ json: body.belt ? beltCube : cube });
  });
  await page.goto("/");
  await expect(page.locator("#beltFields")).toBeHidden();
  await page.locator("#machinePrinter").selectOption({ label: "Generic belt 45°" });
  await expect(page.locator("#machineKind")).toHaveValue("belt");
  await expect(page.locator("#beltFields")).toBeVisible();
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");

  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect((bodies[0].belt as Record<string, unknown>).angleDeg).toBe(45);

  await page.locator("#machinePrinter").selectOption("lime-220");
  await expect(page.locator("#beltFields")).toBeHidden();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "0");
});

test("a belt edit is one undo step", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.locator("#machineKind").selectOption("belt");
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await page.locator("#beltAngle").fill("35");
  await page.locator("#beltAngle").blur();
  await page.waitForTimeout(400);
  await expect(page.locator("#undoEdit")).toBeEnabled();
  await page.locator("#undoEdit").click();
  await expect(page.locator("#beltAngle")).toHaveValue("45");
  await page.locator("#redoEdit").click();
  await expect(page.locator("#beltAngle")).toHaveValue("35");
});

test.describe("belt fields stay in the sheet", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a belt printer keeps the prepare canvas", async ({ page }) => {
    await quiet(page);
    await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
    await page.goto("/?layout=compact");
    await expect(page.locator("html")).toHaveClass(/layout-compact/);
    const before = await share(page, "#prepare");
    expect(before).toBeGreaterThanOrEqual(0.7);

    await page.locator("#compactTabs [data-tab=settings]").click();
    await page.locator("#machineKind").selectOption("belt");
    await expect(page.locator("#beltFields")).toBeVisible();
    await page.locator("#compactTabs [data-tab=prepare]").click();
    await expect(page.locator("#compactSheet")).toHaveAttribute("data-detent", "peek");
    await page.waitForTimeout(250);
    await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "1");
    await expect(page.locator("#prepare")).toHaveAttribute("data-belt-plane", "1");
    const after = await share(page, "#prepare");
    expect(after, `prepare share ${after}`).toBeGreaterThanOrEqual(0.7);
  });
});
