import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

/**
 * An animation on a coupled gear train (docs/plan-gear-coupling.md): a free compound train, ten to one, coupled in the
 * window, then an animation plugin that turns only the driver. Play builds and plays, from rest and again from a turned
 * train with another gear selected. What counts as "changed while the animation was building" is `animationStale`
 * (src/pose-anim.test.ts).
 */
test("An animation that turns the driver plays on a coupled compound train", async ({ page }, info) => {
  await page.addInitScript(() => {
    (window as unknown as { __limePluginLibrary: unknown }).__limePluginLibrary = {
      invoke: async (command: string) => {
        if (command === "plugin_library_list") return { dir: "test-library", files: [], presets: [], settings: null, imported: null };
        throw new Error(`Unexpected library command ${command}`);
      },
    };
    const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => { for (const handler of handlers.get(event) ?? []) handler({ payload }); }, 0);
    let run = "", step = 0;
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/recipe", main: "/scripted/main.rs" };
        if (command === "recipe_start") { run = String(args.run); step = 0; return null; }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; params?: Record<string, unknown>; result?: { members?: { name: string; joint?: { kind: string } }[] } };
          if (msg.v === 1) { (window as unknown as { __animationParams: unknown }).__animationParams = msg.params; say({ id: 1, call: "rig", args: {}, at: { line: 2 } }); return null; }
          if (step++ === 0) {
            const name = (window as unknown as { __failAnimation?: boolean }).__failAnimation ? "missing" : "Driver";
            say({ id: 2, call: "animate", args: { fps: 4, camera: { direction: [1, -1, 0.5] }, keys: [{ t: 0, rest: true }, { t: 1, set: { [name]: 100 } }] }, at: { line: 3 } }); return null;
          }
          say({ done: { object: "", metrics: {} } }); return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") { emit("recipe-exit", { run, code: 0, reason: null, stderr: "" }); return null; }
        throw new Error(`Unexpected command ${command}`);
      },
      listen: async (event: string, handler: (event: { payload: unknown }) => void) => { const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set); return () => set.delete(handler); },
    };
  });
  const file = info.outputPath("compound.lime");
  const ids = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "e2e/gear-train-project.ts", file, "--compound"], { encoding: "utf8" }).trim().split("\n").at(-1)!) as { driver: string; wheel: string; pinion: string; output: string };
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const body = "fn main() {}\n", hash = createHash("sha256").update(body).digest("hex");
  doc.plugins = { [hash]: `//! ---\n//! plugin: ten-to-one\n//! title: Ten to one\n//! kind: animation\n//! api: 1.8\n//! source-sha256: ${hash}\n//! params: [{"name":"fps","kind":"count","default":4,"min":1,"max":30}]\n//! ---\n${body}` };
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/"); await autoSliceOff(page);
  await page.locator("#projectFile").setInputFiles({ name: "compound.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("#left [data-plate-select]")).toHaveCount(4, { timeout: 30_000 });
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel"), gears = panel.locator("[data-pose-gears]");
  await panel.locator(`[data-object='${ids.pinion}']`).click();
  await panel.getByRole("button", { name: "Couple gears" }).click();
  await expect(gears).toContainText("Compound pinion drives Output, ×−0.25.");
  await page.locator("[data-pose-animation='choice']").selectOption("ten-to-one");
  const play = page.locator("[data-pose-action='animation-play']"), frame = page.locator("[data-pose-animation-frame]");

  // Play: the first run of a plugin asks, then the animation is built and plays.
  await play.click();
  await page.locator("#pluginTrust [data-choice='run']").click();
  await expect(frame).toBeVisible();
  await expect(panel).not.toContainText("while the animation was building");
  await page.locator("[data-pose-action='animation-stop']").click();
  await expect(frame).toHaveCount(0);

  // Played again from a turned train, with another gear selected: it builds from where the train stands.
  await panel.locator(`[data-object='${ids.driver}']`).click();
  await panel.getByLabel("Angle °").fill("37");
  await panel.getByLabel("Angle °").press("Tab");
  await panel.locator(`[data-object='${ids.output}']`).click();
  await play.click();
  await expect(frame).toBeVisible();
  await expect(panel).not.toContainText("while the animation was building");
});
