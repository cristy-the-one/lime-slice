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

  await page.locator("#bflow").fill("");
  await page.locator("#bspeed").fill("");
  await page.locator("#bfan").fill("");
  await sliceMatching(page, bodies, omitted);

  await page.locator("#bflow").fill("0.85");
  await page.locator("#overhang").click();
  await sliceMatching(page, bodies, (body) => body.overhangControl === false && omitted(body));
});

test("the bridge fields show Auto, and a flow outside 0.2–2 is not used and says so", async ({ page }) => {
  const bodies = await quiet(page);
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#levelPick").selectOption("advanced");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("#slice")).toBeEnabled();

  for (const id of ["bflow", "bspeed", "bfan"]) {
    await expect(page.locator(`#${id}`)).toHaveValue("");
    await expect(page.locator(`#${id}`)).toHaveAttribute("placeholder", "Auto");
  }
  await expect(page.locator("#bflow")).toHaveAttribute("min", "0.2");
  await expect(page.locator("#bflow")).toHaveAttribute("max", "2");
  await expect(page.locator("#bspeed")).toHaveAttribute("min", "5");
  await expect(page.locator("#bfan")).toHaveAttribute("min", "1");
  const tip = await page.locator('[data-label="bridge flow"]').getAttribute("data-tip");
  expect(tip).toContain("ratio of normal flow");
  expect(tip).toContain("0.8–1.0");

  // The owner's case: 0.1 typed as a small tweak. It is refused, the box goes back to Auto, and the note names the range.
  const flow = page.locator("#bflow");
  await flow.fill("0.1");
  await flow.blur();
  await expect(flow).toHaveValue("");
  await expect(flow).toHaveAttribute("aria-invalid", "true");
  const note = page.locator("#bflowNote");
  await expect(note).toHaveText("Takes 0.2–2. 0.1 was not used.");
  await expect(note).toBeVisible();
  await sliceMatching(page, bodies, omitted);
  await expect(note).toBeVisible();

  // A value in range is kept and sent, and the note goes.
  await flow.fill("0.9");
  await expect(note).toHaveCount(0);
  await expect(flow).not.toHaveAttribute("aria-invalid", "true");
  await sliceMatching(page, bodies, (body) => body.bridgeFlowRatio === 0.9);

  // Above the range: the kept 0.9 stays, and so does the slice.
  await flow.fill("5");
  await flow.blur();
  await expect(flow).toHaveValue("0.9");
  await expect(note).toHaveText("Takes 0.2–2. 5 was not used.");
  await sliceMatching(page, bodies, (body) => body.bridgeFlowRatio === 0.9);

  await page.locator("#bspeed").fill("0");
  await page.locator("#bspeed").blur();
  await expect(page.locator("#bspeed")).toHaveValue("");
  await expect(page.locator("#bspeedNote")).toHaveText("Takes 5–200. 0 was not used.");

  await flow.fill("");
  await sliceMatching(page, bodies, omitted);
  await expect(flow).toHaveValue("");
});
