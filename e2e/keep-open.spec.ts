import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function mockEngine(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/api/slice", async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({ json: cube }).catch(() => {});
  });
}

test("a menu open in the settings panel stays open when a slice lands", async ({ page }) => {
  await mockEngine(page);
  await page.goto("/");
  await page.locator("#fileMenu > summary").click();
  await page.locator("#samples > summary").click();
  await page.getByRole("button", { name: "20 mm cube" }).click();
  await expect(page.locator("#objectList .obj").first()).toBeVisible();
  await page.locator("#slice").click();
  await page.locator("#machineMore > summary").click();
  await page.locator("#left .profile-more > summary").click();
  await expect(page.locator("#export")).toHaveAttribute("data-slice", "current");
  await expect(page.locator("#machineMore")).toHaveJSProperty("open", true);
  await expect(page.locator("#profileMore")).toHaveJSProperty("open", true);
});
