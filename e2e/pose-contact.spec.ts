import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * Until contact in Pose (docs/plan-contact-poses.md), with no script and no agent: an arm hinged at its near end and a
 * stop beside it (e2e/gear-train-project.ts --contact, built by the MCP session on the fake engine). "Until contact ▶"
 * turns the arm until its face meets the stop's corner; the Angle field shows the hand-worked angle to the tolerance and
 * the line names the stop; one Undo puts it back; "◀ Until contact" finds nothing before the hinge's limit, says so and
 * moves nothing.
 */
const shots = process.env.LIME_SHOTS ?? path.join("test-results", "contact");
type Ids = { frame: string; arm: string; stop: string };

test("Until contact turns a hinged arm onto a stop, one Undo puts it back, and the other way says nothing is met", async ({ page }, info) => {
  test.setTimeout(120_000);
  const file = info.outputPath("pose-contact.lime");
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/gear-train-project.ts", file, "--contact"], { encoding: "utf8" });
  const ids = JSON.parse(printed.trim().split("\n").at(-1)!) as Ids;

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#projectFile").setInputFiles(file);
  await expect(page.locator("[data-plate-select]")).toHaveCount(3, { timeout: 30_000 });
  const panel = page.locator("#posePanel");
  await expect(async () => {
    if ((await page.locator("#tabPose").getAttribute("aria-selected")) !== "true") await page.locator("#tabPose").click();
    await expect(panel.locator(`[data-object='${ids.stop}']`)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  // A fixed part has no joint to drive: no buttons.
  await panel.locator(`[data-object='${ids.stop}']`).click();
  await expect(panel.locator("[data-pose-contact]")).toHaveCount(0);
  await panel.locator(`[data-object='${ids.arm}']`).click();
  const on = panel.getByRole("button", { name: "Turn on until contact" });
  const back = panel.getByRole("button", { name: "Turn back until contact" });
  await expect(on).toHaveText("Until contact ▶");
  await expect(on).toHaveAttribute("data-tip", /until a part it moves first touches another part/);
  const angle = panel.getByLabel("Angle °");
  await expect(angle).toHaveValue("0");

  // By hand: the face y = 1 meets the corner (14, 5) at atan2(5, 14) - asin(1 / |(14, 5)|) degrees.
  const deg = 180 / Math.PI;
  const expected = Math.atan2(5, 14) * deg - Math.asin(1 / Math.hypot(14, 5)) * deg;
  const tolDeg = 0.01 / (Math.hypot(14, 5) / deg);
  await on.focus();
  await page.keyboard.press("Enter");
  const note = panel.locator("[data-pose-contact-note]");
  await expect(note).toContainText("Arm meets Stop at");
  await expect(note).toHaveAttribute("role", "status");
  const reached = Number(await angle.inputValue());
  expect(reached, "at the hand-worked angle, never past it").toBeLessThanOrEqual(expected + 1e-4);
  expect(reached).toBeGreaterThanOrEqual(expected - tolDeg - 1e-4);
  const left = Number(/, ([\d.]+) mm left/.exec((await note.textContent()) ?? "")?.[1]);
  expect(left, "the clearance left is at most the tolerance").toBeLessThanOrEqual(0.011);
  await expect(on).toBeEnabled();
  const ms = Number(await panel.getAttribute("data-contact-ms"));
  console.log(`pose-contact: the arm stops at ${reached} (by hand ${expected.toFixed(4)}), ${await note.textContent()} in ${ms} ms`);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "pose-contact.png") });

  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(angle, "one Undo puts the arm back").toHaveValue("0");

  // The other way, the hinge stops at -30 with nothing in reach: said, and nothing moves.
  await panel.getByRole("button", { name: "Turn back until contact" }).click();
  await expect(note).toHaveText("Nothing met turning Arm from 0° to -30°, where a joint limit stops it. Nothing moved.");
  await expect(angle).toHaveValue("0");
  await expect(back).toBeEnabled();
  await page.screenshot({ path: path.join(shots, "pose-contact-nothing.png") });
});

/**
 * A round pin (docs/plan-contact-poses.md section 6, e2e/contact-round-project.ts): a Model solid meshed as the kernel
 * meshes a cylinder, 18 facets inside the true one by up to 0.046 mm. The window has no kernel: it stops short of the
 * facets by the chord, so the arm is never inside the true pin, and the line says how close it may be, not "0.00x left".
 */
test("Until contact on a round pin stops short of the facets by the chord, and says the parts cannot overlap", async ({ page }, info) => {
  test.setTimeout(120_000);
  const file = info.outputPath("pose-contact-round.lime");
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/contact-round-project.ts", file], { encoding: "utf8" });
  const ids = JSON.parse(printed.trim().split("\n").at(-1)!) as { frame: string; arm: string; pin: string };

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.locator("#projectFile").setInputFiles(file);
  await expect(page.locator("[data-plate-select]")).toHaveCount(3, { timeout: 30_000 });
  const panel = page.locator("#posePanel");
  await expect(async () => {
    if ((await page.locator("#tabPose").getAttribute("aria-selected")) !== "true") await page.locator("#tabPose").click();
    await expect(panel.locator(`[data-object='${ids.arm}']`)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await panel.locator(`[data-object='${ids.arm}']`).click();
  const angle = panel.getByLabel("Angle °");
  await expect(angle).toHaveValue("0");

  // The true pin, radius 3 at (12, 6): the arm's face y = 1 meets it where (12, 6) in the arm's frame stands 4 above
  // the axis. The gap at an angle is 6 cos t - 12 sin t - 4 mm, and the face's lever there is about 12.8 mm.
  const deg = 180 / Math.PI;
  const truth = (Math.acos(4 / Math.hypot(12, 6)) - Math.atan2(12, 6)) * deg;
  const gap = (a: number) => 6 * Math.cos(a / deg) - 12 * Math.sin(a / deg) - 4;
  await panel.getByRole("button", { name: "Turn on until contact" }).click();
  const note = panel.locator("[data-pose-contact-note]");
  await expect(note).toContainText("Arm meets Pin at");
  await expect(note).toContainText("On curved faces it stops just short");
  await expect(note).toContainText("the parts cannot overlap");
  await expect(note, "no claim of a few thousandths left on a round face").not.toContainText("mm left.");
  const reached = Number(await angle.inputValue());
  expect(reached, "never inside the true pin").toBeLessThanOrEqual(truth + 1e-4);
  expect(gap(reached), "the true gap is at least 0").toBeGreaterThanOrEqual(-1e-4);
  expect(gap(reached), "and at most the chord and the tolerance").toBeLessThanOrEqual(0.05 + 0.011 + 1e-3);
  const most = Number(/clear by at most ([\d.]+) mm/.exec((await note.textContent()) ?? "")?.[1]);
  expect(gap(reached), "the line's bound holds for the true pin").toBeLessThanOrEqual(most + 1e-3);
  // No kernel in a browser: no exact button.
  await expect(panel.getByRole("button", { name: "Exact contact" })).toHaveCount(0);
  console.log(`pose-contact: the arm stops at ${reached} on the round pin (true contact ${truth.toFixed(4)}, gap ${gap(reached).toFixed(4)} mm): ${await note.textContent()}`);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "pose-contact-round.png") });
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(angle, "one Undo puts the arm back").toHaveValue("0");
});
