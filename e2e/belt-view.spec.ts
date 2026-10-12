import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const beltCube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-belt.json"), "utf8"));

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", (route) => route.fulfill({ json: beltCube }));
}

async function chooseIr3(page: Page) {
  await page.locator("#printerChip").evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await page.locator("#machinePrinter").selectOption("ideaformer-ir3-v2");
}

test("the IR3 V2 scene says the belt carries the part toward -Y, in Prepare and in Preview", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await chooseIr3(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();

  await page.locator("#tabPrepare").click();
  const prepare = page.locator("#prepare");
  await expect(prepare).toHaveAttribute("data-belt", "1");
  await expect(prepare).toHaveAttribute("data-belt-out", "-y");
  await expect(prepare).toHaveAttribute("data-belt-plane-lean", "-y");

  await page.locator("#slice").click();
  await page.locator("#tabPreview").click();
  const preview = page.locator("#view3d");
  await expect(preview).toHaveAttribute("data-belt", "1");
  await expect(preview).toHaveAttribute("data-belt-plane-lean", "-y");
});

test("a reversed firmware axis does not turn the belt around in the scene", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await chooseIr3(page);
  await page.locator("#beltDirection").selectOption("-1");
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-out", "-y");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-plane-lean", "-y");
});

test("a cartesian printer draws no belt direction", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#tabPrepare").click();
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt", "0");
  await expect(page.locator("#prepare")).toHaveAttribute("data-belt-out", "");
});

test("the belt direction tips say which end prints first and leaves first", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await chooseIr3(page);
  const sentence = "The part's front end (nearest the arrow head in Prepare) prints first and leaves the printer first.";
  await expect(page.locator("label.setting", { has: page.locator("#beltDirection") })).toHaveAttribute("data-tip", new RegExp(sentence.replace(/[()]/g, "\\$&")));
  await expect(page.locator("label.setting", { has: page.locator("#machineKind") })).toHaveAttribute("data-tip", new RegExp(sentence.replace(/[()]/g, "\\$&")));
});
