import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoSliceOff } from "./auto-slice";

const cube = JSON.parse(fs.readFileSync(path.resolve("e2e/fixtures/cube-speed.json"), "utf8"));

type SliceBody = {
  overhangControl?: boolean;
  bridgeFlowRatio?: number;
  bridgeSpeedMmS?: number;
  bridgeFanPercent?: number;
};

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

function omitted(body: SliceBody) {
  return body.bridgeFlowRatio === undefined && body.bridgeSpeedMmS === undefined && body.bridgeFanPercent === undefined;
}

test("bridge flow, speed, and fan stay off a default slice and are sent when set", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();
  await sliceMatching(page, bodies, omitted);

  await expect(page.locator("#bflow")).toBeVisible();
  await page.locator("#bflow").fill("0.9");
  await sliceMatching(page, bodies, (body) => body.bridgeFlowRatio === 0.9 && body.bridgeSpeedMmS === undefined);

  await page.locator("#bspeed").fill("15");
  await sliceMatching(page, bodies, (body) => body.bridgeSpeedMmS === 15);

  await page.locator("#bfan").fill("80");
  await sliceMatching(page, bodies, (body) => body.bridgeFanPercent === 80 && body.bridgeFlowRatio === 0.9);

  await page.locator("#bflow").fill("0");
  await page.locator("#bspeed").fill("0");
  await page.locator("#bfan").fill("0");
  await sliceMatching(page, bodies, omitted);

  await page.locator("#bflow").fill("0.85");
  await page.locator("#overhang").click();
  await sliceMatching(page, bodies, (body) => body.overhangControl === false && omitted(body));
});
