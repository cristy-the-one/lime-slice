import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { autoSliceOff } from "./auto-slice";

test("Pose plays, scrubs and keeps an animation without changing the pose until kept", async ({ page }) => {
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
            const name = (window as unknown as { __failAnimation?: boolean }).__failAnimation ? "missing" : msg.result?.members?.find((m) => m.joint?.kind === "hinge")?.name ?? "missing";
            say({ id: 2, call: "animate", args: { fps: 4, camera: { direction: [1, -1, 0.5] }, keys: [{ t: 0, rest: true, colors: { [name]: "#ff0000" } }, { t: 1, set: { [name]: 60 }, colors: { [name]: "#0000ff" } }] }, at: { line: 3 } }); return null;
          }
          say({ done: { object: "", metrics: {} } }); return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") { emit("recipe-exit", { run, code: 0, reason: null, stderr: "" }); return null; }
        throw new Error(`Unexpected command ${command}`);
      },
      listen: async (event: string, handler: (event: { payload: unknown }) => void) => { const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set); return () => set.delete(handler); },
    };
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/"); await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.locator("#plateAddFile").setInputFiles("samples/overhang_ledge.stl");
  await expect(page.locator("#objectList .obj")).toHaveCount(2);
  const child = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.locator("[data-plate-select='part']").click();
  await page.locator(`[data-plate-attach='${child}']`).click();
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(readFileSync((await download.path())!, "utf8"));
  const member = doc.assemblies[0].members.find((m: { object: string }) => m.object === child);
  member.offset = [60, 0, 0]; member.joint = { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90, angle: 0 };
  const body = "fn main() {}\n", hash = createHash("sha256").update(body).digest("hex");
  doc.mcpModel = { ...(doc.mcpModel ?? {}), animations: { "saved-animation": { source: body, params: { speed: 3 }, assembly: doc.assemblies[0].id } } };
  doc.plugins = { [hash]: `//! ---\n//! plugin: pose-test\n//! title: Test animation\n//! kind: animation\n//! api: 1.8\n//! source-sha256: ${hash}\n//! params: [{"name":"fps","kind":"count","default":4,"min":1,"max":30}]\n//! ---\n${body}` };
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "animation.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await page.locator(`[data-plate-select='${child}']`).click();
  await page.locator("#tabPose").click();
  await expect(page.locator("[data-pose-animation='choice'] option[value='saved-animation']")).toHaveCount(1);
  await page.locator("[data-pose-animation='choice']").selectOption("pose-test");
  const pose = page.locator("#pose"), before = await pose.getAttribute("data-posed");
  const parameter = page.locator("[data-pose-animation-param='fps']");
  await parameter.fill("6"); await parameter.press("Tab");
  await page.locator("[data-pose-action='animation-play']").click();
  await expect(page.locator("#pluginTrust")).toBeVisible();
  await expect(page.locator("#pluginTrustCode")).toContainText("fn main()");
  await expect(page.locator("#pluginTrustMay")).toContainText("pose only the assembly");
  await page.locator("#pluginTrust").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-pose-animation-frame]")).toHaveCount(0);
  await page.locator("[data-pose-action='animation-play']").click();
  await page.locator("#pluginTrust [data-choice='run']").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __animationParams?: { fps?: number } }).__animationParams?.fps)).toBe(6);
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible();
  await page.locator("[data-pose-animation-frame]").evaluate((el: HTMLInputElement) => { el.value = "3"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await expect(pose).not.toHaveAttribute("data-posed", before!);
  await expect(pose).toHaveAttribute("data-animation-colors", new RegExp(`${child}:#0000ff`));
  await page.locator("[data-pose-action='animation-stop']").click();
  await expect(pose).toHaveAttribute("data-posed", before!);
  await page.locator("[data-pose-action='animation-play']").click();
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible();
  await page.locator("[data-pose-animation-frame]").evaluate((el: HTMLInputElement) => { el.value = "3"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  const kept = await pose.getAttribute("data-posed");
  await page.locator("[data-pose-action='animation-keep']").click();
  await expect(pose).toHaveAttribute("data-posed", kept!);
  const [savedProject] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const savedDoc = JSON.parse(readFileSync((await savedProject.path())!, "utf8"));
  expect(Object.values(savedDoc.plugins ?? {}).some((text) => String(text).includes("kind: animation"))).toBe(true);
  await page.locator("[data-pose-action='undo']").click();
  await expect(pose).toHaveAttribute("data-posed", before!);
  await page.locator("[data-pose-action='animation-play']").click();
  await expect(page.locator("[data-pose-action='animation-save']")).toBeVisible();
  await page.locator("[data-pose-action='animation-save']").click();
  const dialog = page.locator(".pose-animation-save");
  await dialog.getByLabel("Animation size").fill("320");
  await dialog.getByLabel("Use member colours").check();
  const [gif] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Save", exact: true }).click()]);
  expect(readFileSync((await gif.path())!).subarray(0, 6).toString()).toBe("GIF89a");
  await expect(dialog).toHaveCount(0);
  await page.locator("[data-pose-action='animation-save']").click();
  const pngDialog = page.locator(".pose-animation-save");
  await pngDialog.getByLabel("Animation format").selectOption("png");
  await pngDialog.getByLabel("Animation size").fill("320");
  const [zip] = await Promise.all([page.waitForEvent("download"), pngDialog.getByRole("button", { name: "Save", exact: true }).click()]);
  const files = unzipSync(readFileSync((await zip.path())!));
  expect(Object.keys(files)).toEqual(["frame-001.png", "frame-002.png", "frame-003.png", "frame-004.png"]);
  expect([...files["frame-001.png"]!.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
  await page.locator("[data-pose-action='animation-stop']").click();
  await expect(pose).toHaveAttribute("data-posed", before!);
  await page.evaluate(() => { (window as unknown as { __failAnimation: boolean }).__failAnimation = true; });
  await page.locator("[data-pose-action='animation-play']").click();
  await expect(page.locator("#posePanel")).toContainText("missing");
  await expect(pose).toHaveAttribute("data-posed", before!);
  await page.evaluate(() => { (window as unknown as { __failAnimation: boolean }).__failAnimation = false; });
  await page.locator("[data-pose-animation='choice']").selectOption("saved-animation");
  await page.locator("[data-pose-action='animation-play']").click();
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __animationParams?: { speed?: number } }).__animationParams?.speed)).toBe(3);
  await page.locator("[data-pose-action='animation-stop']").click();
  await expect(pose).toHaveAttribute("data-posed", before!);
});
