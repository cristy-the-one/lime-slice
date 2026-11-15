import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * Run in Pose (docs/plan-hinge-dynamics.md, stage D), with no agent in the loop: a project holding a Graham escapement
 * built from horology's outlines, a rod and a bob on its anchor (e2e/gear-train-project.ts --escapement). A person picks
 * the drive (a torque on the escape wheel), names the escapement's wheel and anchor and horology's numbers, and presses
 * Run: the panel shows the run's progress with Cancel, then says in sentences whether it starts, its swing, period,
 * energy per beat and the friction sweep, and the motion plays. A second, long run is cancelled and nothing changes.
 */
type Ids = { frame: string; wheel: string; anchor: string; rod: string; bob: string };
const shots = process.env.LIME_SHOTS ?? path.join("test-results", "dynamics");

/** Open a project and show Pose, once its parts are on the plate (a click made before the load ends is undone). */
async function openOnPose(page: Page, file: string, parts: number, last: string): Promise<void> {
  await page.locator("#projectFile").setInputFiles(file);
  await expect(page.locator("[data-plate-select]")).toHaveCount(parts, { timeout: 30_000 });
  await expect(async () => {
    if ((await page.locator("#tabPose").getAttribute("aria-selected")) !== "true") await page.locator("#tabPose").click();
    await expect(page.locator(`#posePanel [data-object='${last}']`)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/** Type a number into a Run field as a person does: fill it, then leave it. */
async function typeIn(page: Page, key: string, value: string): Promise<void> {
  const input = page.locator(`#posePanel [data-pose-motion='${key}']`);
  await input.fill(value);
  await input.press("Tab");
}

test("Run an escapement in Pose: progress and Cancel, then the answers in sentences and the motion playing", async ({ page }, info) => {
  test.setTimeout(330_000);
  const file = info.outputPath("pose-escapement.lime");
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/gear-train-project.ts", file, "--escapement"], { encoding: "utf8" });
  const ids = JSON.parse(printed.trim().split("\n").at(-1)!) as Ids;
  fs.mkdirSync(shots, { recursive: true });

  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await openOnPose(page, file, 5, ids.bob);
  await page.locator(`#posePanel [data-object='${ids.wheel}']`).click();

  const section = page.locator("#posePanel [data-pose-motion='section']");
  await expect(section.getByRole("heading", { name: "Run" })).toBeVisible();
  await section.locator("[data-pose-motion='drive']").selectOption(ids.wheel);
  await section.locator("[data-pose-motion='kind']").selectOption("torque");
  await typeIn(page, "amount", "0.25");
  await section.locator("[data-pose-motion='wheel']").selectOption(ids.wheel);
  await section.locator("[data-pose-motion='anchor']").selectOption(ids.anchor);
  for (const [key, value] of [["teeth", "30"], ["tip", "22.5"], ["root", "17.5"], ["lean", "12"], ["span", "7.5"], ["friction", "0.3"], ["seconds", "120"]] as const) await typeIn(page, key, value);

  // A long run: its progress block, in place, with Cancel; Cancel stops it and nothing changes.
  await section.locator("[data-pose-action='motion-run']").click();
  const progress = section.locator("[data-pose-motion-progress]");
  await expect(progress).toBeVisible();
  await expect(progress.locator("[data-pose-motion-stage]")).toContainText("from rest", { timeout: 30_000 });
  await expect.poll(async () => Number(await progress.locator("[data-pose-motion-bar]").getAttribute("aria-valuenow")), { timeout: 30_000 }).toBeGreaterThan(0);
  await progress.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, "run-progress.png") });
  await progress.locator("[data-pose-action='motion-cancel']").click();
  await expect(progress).toHaveCount(0);
  await expect(section.locator("[data-pose-motion-report]")).toContainText("Run cancelled: nothing changed.");

  // A short run to the end: the verdict, the sentences, and the motion playing.
  // 20 s: long enough for the period to agree at dt and dt/2 (8 s gives 1.15 s a day apart: "Not converged").
  await typeIn(page, "seconds", "20");
  await section.locator("[data-pose-action='motion-run']").click();
  const report = section.locator("[data-pose-motion-report]");
  await expect(report.locator(".pose-motion-verdict")).toHaveText("It runs", { timeout: 240_000 });
  await expect(report).toContainText("From rest as posed it does not run: it never starts; a tooth rests on the entry pallet's impulse face");
  await expect(report).toContainText("From a 3° push it runs: the swing settles at");
  await expect(report).toContainText("Each beat the drive gives 26.18 µJ");
  await expect(report).toContainText("the answer depends on friction the app does not know");
  await expect(report).toContainText("Left out:");
  await expect(section.locator("[data-pose-action='motion-play']")).toHaveText("Pause");
  const count = section.locator("[data-pose-animation-count]");
  // 20 s at 10 frames a second: frame times are the sampler's (200 frames over [0, 20], or 201 at k/10 once that rule lands).
  await expect(count).toContainText(/\/ 20[01]$/);
  const first = await count.textContent();
  await expect.poll(async () => await count.textContent(), { timeout: 10_000 }).not.toBe(first);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, "run-report.png") });
  await page.locator("#posePanel").screenshot({ path: path.join(shots, "run-panel.png") });
});
