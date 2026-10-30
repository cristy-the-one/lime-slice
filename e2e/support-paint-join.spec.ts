import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";
import { expectSupports, setSupports } from "./supports";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

async function quiet(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lime-slice-closed-groups", "[]"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/slice", (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: cube });
  });
  return bodies;
}

async function sliceOnce(page: Page, bodies: unknown[]) {
  const sent = bodies.length;
  await page.locator("#slice").click();
  await expect.poll(() => bodies.length).toBe(sent + 1);
  await expect(page.locator("#slice")).toBeEnabled();
  return bodies[sent] as Record<string, unknown>;
}

test("fill between paint dabs shows with supports, is on by default, and is sent only for painted parts", async ({ page }) => {
  const bodies = await quiet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="lime_hull.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await page.waitForTimeout(400);

  const box = page.locator("#paintjoin");
  await expectSupports(page, "off");
  await expect(box).toBeHidden();
  await setSupports(page, "auto");
  await expect(box).toBeVisible();
  await expect(box).toBeChecked();
  const unpainted = await sliceOnce(page, bodies);
  expect(unpainted).toMatchObject({ supports: true });
  expect(unpainted).not.toHaveProperty("supportPaintJoin");

  await page.locator('#toolRail [data-tool="paint"]').click();
  const canvas = page.locator("#prepare");
  const at = (await canvas.boundingBox())!;
  await page.locator('#paintBar [data-kind="enforce"]').click();
  await page.mouse.click(at.x + at.width / 2, at.y + at.height * 0.45);
  await expect(canvas).toHaveAttribute("data-paint-disks", "1");
  await page.waitForTimeout(400);
  const painted = await sliceOnce(page, bodies);
  expect(painted).toMatchObject({ supports: true, supportPaintJoin: true });
  expect(painted.supportPaint).toHaveLength(1);

  await page.getByRole("tab", { name: "Prepare", exact: true }).click();
  await box.uncheck();
  const off = await sliceOnce(page, bodies);
  expect(off).not.toHaveProperty("supportPaintJoin");
  expect(off.supportPaint).toHaveLength(1);
});
