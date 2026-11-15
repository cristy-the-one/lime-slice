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
