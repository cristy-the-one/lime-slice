import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

// The IR3 V2's Klipper has no [gcode_arcs]: each G2/G3 was skipped and the next G1
// took its plastic, which stopped a print with "Move exceeds maximum extrusion".
const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));
const REASON = /^This printer's firmware doesn't accept G2\/G3 arcs/;

type Body = { arcFit: boolean; printer: { firmware?: string; firmwareArcs?: boolean } };

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: Body[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: beltCube });
  });
  return bodies;
}

async function open(page: Page, printerId?: string) {
  await page.goto("/");
  await autoSliceOff(page);
  if (printerId) {
    await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
    await page.locator("#machinePrinter").selectOption(printerId);
    await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = false; });
  }
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
}

const arcRow = (page: Page) => page.locator("label.setting", { has: page.locator("#arcs") });

async function expectLocked(page: Page) {
  const arcs = page.locator("#arcs");
  await expect(arcs).toHaveAttribute("aria-disabled", "true");
  await expect(arcs).toBeDisabled();
  await expect(arcs).not.toBeChecked();
  await expect(arcRow(page)).toHaveAttribute("data-tip", REASON);
  await expect(page.locator("#machineArcs")).not.toBeChecked();
}

async function expectFree(page: Page) {
  const arcs = page.locator("#arcs");
  await expect(arcs).toBeEnabled();
  await expect(arcs).not.toHaveAttribute("aria-disabled", "true");
  await expect(arcs).toBeChecked();
  await expect(arcRow(page)).not.toHaveAttribute("data-tip", REASON);
  await expect(page.locator("#machineArcs")).toBeChecked();
}

test("the IR3 V2 slices with arcs disallowed and Arc fit locked off, until its firmware is said to take them", async ({ page }) => {
  const bodies = await quiet(page);
  await open(page, "ideaformer-ir3-v2");
  await expectLocked(page);
  await expect(arcRow(page)).toHaveAttribute("data-tip", /\[gcode_arcs\]/);

  // A locked switch can be focused for its reason, but a click does not flip it.
  await page.locator("#arcs").click({ force: true });
  await expect(page.locator("#arcs")).not.toBeChecked();

  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.locator("#slice")).toBeEnabled();
  expect(bodies[0]!.printer).toMatchObject({ firmware: "klipper", firmwareArcs: false });
  // The user's Arc fit stays as it was, for a printer that allows it; the engine overrules it.
  expect(bodies[0]!.arcFit).toBe(true);

  // A printer.cfg with [gcode_arcs]: tick the box, and Arc fit is free and sent on.
  await page.locator("#machineArcs").check();
  await expect(page.locator("#stage")).toHaveClass(/stale/);
  await expectFree(page);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]!.printer).toMatchObject({ firmware: "klipper", firmwareArcs: true });
  expect(bodies[1]!.arcFit).toBe(true);

  // One undo step puts the box back, and Arc fit locks again.
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+z");
  await expectLocked(page);
});

test("a Klipper printer that does not say starts without arcs, and Marlin starts with them", async ({ page }) => {
  const bodies = await quiet(page);
  await open(page);
  await expect(page.locator("#machineFirmware")).toHaveValue("klipper");
  await expectLocked(page);

  await page.locator("#machineFirmware").selectOption("marlin");
  await expectFree(page);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.locator("#slice")).toBeEnabled();
  expect(bodies[0]!.printer.firmwareArcs).toBe(true);
  expect(bodies[0]!.printer.firmware).toBeUndefined();

  // The printer never gave an answer of its own, so it follows its firmware back.
  await page.locator("#machineFirmware").selectOption("klipper");
  await expectLocked(page);
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]!.printer).toMatchObject({ firmware: "klipper", firmwareArcs: false });
});
