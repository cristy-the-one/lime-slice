import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

type TestWindow = { __limePluginLibrary: unknown; __limeRecipeRunner: unknown; __seconds: number; __starts: number };

/**
 * The scripted recipe runner (as e2e/pose-animate.spec.ts): an animation of `__seconds` at 30 frames a second whose
 * hinge swings every second, so every frame poses the parts anew. `__starts` counts the scripts started.
 */
async function longAnimation(page: Page, seconds: number) {
  await page.addInitScript((initial) => {
    const win = window as unknown as TestWindow;
    win.__seconds = initial; win.__starts = 0;
    win.__limePluginLibrary = { invoke: async () => ({ dir: "test-library", files: [], presets: [], settings: null, imported: null }) };
    const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => { for (const handler of handlers.get(event) ?? []) handler({ payload }); }, 0);
    let run = "", step = 0;
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    win.__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/recipe", main: "/scripted/main.rs" };
        if (command === "recipe_start") { run = String(args.run); step = 0; win.__starts += 1; return null; }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; result?: { members?: { name: string; joint?: { kind: string } }[] } };
          if (msg.v === 1) { say({ id: 1, call: "rig", args: {}, at: { line: 2 } }); return null; }
          if (step++ === 0) {
            const name = msg.result?.members?.find((m) => m.joint?.kind === "hinge")?.name ?? "missing";
            const keys = Array.from({ length: win.__seconds + 1 }, (_, t) => ({ t, set: { [name]: t % 2 ? 60 : -60 } }));
            say({ id: 2, call: "animate", args: { fps: 30, keys }, at: { line: 3 } });
            return null;
          }
          say({ done: { object: "", metrics: {} } }); return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") { emit("recipe-exit", { run, code: 0, reason: null, stderr: "" }); return null; }
        throw new Error(`Unexpected command ${command}`);
      },
      listen: async (event: string, handler: (event: { payload: unknown }) => void) => { const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set); return () => set.delete(handler); },
    };
  }, seconds);
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.goto("/"); await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="lime_hull.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.locator("#plateAddFile").setInputFiles("samples/dragon_2_5.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const child = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.locator("[data-plate-select='part']").click();
  await page.locator(`[data-plate-attach='${child}']`).click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(readFileSync((await download.path())!, "utf8"));
  const member = doc.assemblies[0].members.find((m: { object: string }) => m.object === child);
  // Hinged beside its parent, so the two hulls' boxes meet in every frame and each frame runs the crossing check.
  member.offset = [20, 0, 0]; member.joint = { kind: "hinge", pivot: [-20, 0, 0], axis: [0, 0, 1], min: -90, max: 90, angle: 0 };
  const body = "fn main() {}\n", hash = createHash("sha256").update(body).digest("hex");
  doc.plugins = { [hash]: `//! ---\n//! plugin: pose-long\n//! title: Long animation\n//! kind: animation\n//! api: 1.9\n//! source-sha256: ${hash}\n//! params: []\n//! ---\n${body}` };
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "animation.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await page.locator(`[data-plate-select='${child}']`).click();
  await page.locator("#tabPose").click();
  await page.locator("[data-pose-animation='choice']").selectOption("pose-long");
}

/** The frame the bar says is ready, from its own value. */
const frameNow = (page: Page) => page.locator("[data-pose-progress-bar]").evaluate((bar) => Number(bar.getAttribute("aria-valuenow") ?? -1));

test("Preparing a long animation shows its stages and frames, stays responsive, cancels, and the finished one plays", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await longAnimation(page, 600);
  const play = page.locator("[data-pose-action='animation-play']");
  await play.click();
  await page.locator("#pluginTrust [data-choice='run']").click();

  // The frames stage: the words, the count, and the app's own bar (no <progress> element).
  const progress = page.locator("[data-pose-progress]");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("data-stage", "frames", { timeout: 30_000 });
  await expect(page.locator("[data-pose-progress-text]")).toHaveText(/^Preparing frame \d+ of 18000$/);
  await expect(page.locator("#posePanel progress")).toHaveCount(0);
  const bar = page.locator("[data-pose-progress-bar]");
  await expect(bar).toHaveAttribute("role", "progressbar");
  await expect(bar).toHaveAttribute("aria-valuemax", "18000");
  await expect(page.locator(".pose-progress-steps li[data-state='done']")).toHaveCount(2);
  await expect(page.locator(".pose-progress-steps li[data-state='active']")).toHaveText("Prepare frames");

  // It advances, and the window answers while it does: the frames are made off its thread.
  const first = await frameNow(page);
  await expect.poll(() => frameNow(page)).toBeGreaterThan(first);
  const lag = await page.evaluate(async () => {
    const started = performance.now();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return performance.now() - started;
  });
  expect(lag).toBeLessThan(500);
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => /pose-anim-worker/.test(entry.name)))).toBe(true);
  // The bar fills as the frames do (it eases over 120 ms, so it is read until it has moved).
  await expect.poll(() => bar.locator("span").evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(0);

  // One at a time: no Play while it prepares, and Space does not start another.
  await expect(play).toHaveCount(0);
  await page.locator("#pose").focus().catch(() => {});
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => (window as unknown as TestWindow).__starts)).toBe(1);

  // Cancel stops it and leaves the panel as it was.
  await page.locator("[data-pose-action='animation-cancel']").click();
  await expect(progress).toHaveCount(0);
  await expect(page.locator("#posePanel")).toContainText("Animation cancelled.");
  await expect(play).toBeVisible();
  await expect(page.locator("[data-pose-animation-frame]")).toHaveCount(0);
  const stopped = await page.evaluate(() => (window as unknown as TestWindow).__starts);
  expect(stopped).toBe(1);

  // A short one runs to the end and plays.
  await page.evaluate(() => { (window as unknown as TestWindow).__seconds = 4; });
  const pose = page.locator("#pose"), before = await pose.getAttribute("data-posed");
  await play.click();
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible({ timeout: 30_000 });
  await expect(progress).toHaveCount(0);
  await expect(page.locator("[data-pose-animation-count]")).toHaveText(/^Frame \d+ \/ 120$/);
  await expect(pose).not.toHaveAttribute("data-posed", before!);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__starts)).toBe(2);
});

test("Without a worker the frames are prepared on the window's thread in slices: progress still shows, and Cancel stops it", async ({ page }) => {
  test.setTimeout(180_000);
  await page.route("**/pose-anim-worker*", (route) => route.abort());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await longAnimation(page, 600);
  await page.locator("[data-pose-action='animation-play']").click();
  await page.locator("#pluginTrust [data-choice='run']").click();
  const progress = page.locator("[data-pose-progress]");
  await expect(progress).toHaveAttribute("data-stage", "frames", { timeout: 30_000 });
  const first = await frameNow(page);
  await expect.poll(() => frameNow(page)).toBeGreaterThan(first);
  await expect(page.locator("[data-pose-progress-text]")).toHaveText(/^Preparing frame \d+ of 18000$/);
  await page.locator("[data-pose-action='animation-cancel']").click();
  await expect(progress).toHaveCount(0);
  await expect(page.locator("#posePanel")).toContainText("Animation cancelled.");
  // Stopped between slices: the bar is gone and no frames arrive later.
  await page.waitForTimeout(500);
  await expect(page.locator("[data-pose-animation-frame]")).toHaveCount(0);
});
