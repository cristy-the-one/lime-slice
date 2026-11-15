import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";

// docs/plan-animation-plugins.md A5: a kept animation plays on an assembly it was not written for, its member
// parameter a select of that assembly's members; and Keep in library… keeps a project's animation for any assembly.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const libraryBody = "fn main() { /* escapement */ }\n";
const projectBody = "fn main() { /* project */ }\n";
const wheel = { name: "wheel", kind: "text", default: "Escape wheel", label: "Escape wheel" };
const libraryFile = `//! ---\n//! plugin: escapement-motion\n//! kind: animation\n//! title: Escapement motion\n//! version: 1\n//! description: The escape wheel steps.\n//! author: Test\n//! api: 1.8\n//! source-sha256: ${sha(libraryBody)}\n//! target: object\n//! params: ${JSON.stringify([wheel])}\n//! member-params: ["wheel"]\n//! ---\n${libraryBody}`;

test("a kept animation plays on another assembly by its members, and Keep in library keeps a project's", async ({ page }) => {
  await page.addInitScript(({ file, describe }) => {
    const w = window as unknown as Record<string, unknown>;
    w.__libFiles = [{ name: "escapement-motion.rs", text: file }];
    w.__limePluginLibrary = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        const files = w.__libFiles as { name: string; text: string }[];
        if (command === "plugin_library_list") return { dir: "test-library", files: [...files], presets: [], settings: null, imported: null };
        if (command === "plugin_library_save") {
          const name = `${String(args.id)}.rs`;
          w.__libFiles = [...files.filter((row) => row.name !== name), { name, text: String(args.text) }];
          return `test-library/${name}`;
        }
        throw new Error(`Unexpected library command ${command}`);
      },
    };
    const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => { for (const handler of handlers.get(event) ?? []) handler({ payload }); }, 0);
    let run = "", step = 0, params: Record<string, unknown> = {};
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    w.__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/recipe", main: "/scripted/main.rs" };
        if (command === "recipe_start") { run = String(args.run); step = 0; return null; }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; describe?: boolean; params?: Record<string, unknown> };
          if (msg.v === 1 && msg.describe) { say({ describe: { param: describe, line: 3 } }); say({ describe: { end: true, line: 4 } }); return null; }
          if (msg.v === 1) { params = msg.params ?? {}; w.__animationParams = params; say({ id: 1, call: "rig", args: {}, at: { line: 5 } }); return null; }
          if (step++ === 0) {
            // The script keys the member its parameter names, as `Pose::new().set(&wheel, 60.0)` sends it.
            const name = String(params.wheel ?? "Escape wheel");
            say({ id: 2, call: "animate", args: { fps: 4, keys: [{ t: 0, rest: true, colors: { [name]: "#ff0000" } }, { t: 1, set: { [name]: 60 }, colors: { [name]: "#0000ff" } }] }, at: { line: 6 } }); return null;
          }
          say({ done: { object: "", metrics: {} } }); return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") { emit("recipe-exit", { run, code: 0, reason: null, stderr: "" }); return null; }
        throw new Error(`Unexpected command ${command}`);
      },
      listen: async (event: string, handler: (event: { payload: unknown }) => void) => { const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set); return () => set.delete(handler); },
    };
    localStorage.setItem("lime-slice-theme", "dark");
  }, { file: libraryFile, describe: wheel });
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
  // A clock whose parts are not named as the animation was written: no "Escape wheel" here.
  for (const row of doc.objects as { id: string; name: string }[]) row.name = row.id === child ? "Escapement" : "Frame";
  const member = doc.assemblies[0].members.find((m: { object: string }) => m.object === child);
  member.offset = [60, 0, 0]; member.joint = { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1], min: -90, max: 90, angle: 0 };
  doc.mcpModel = { ...(doc.mcpModel ?? {}), animations: { "tick-tock": { source: projectBody, params: { wheel: "Escapement" }, assembly: doc.assemblies[0].id } } };
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "clock.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await page.locator(`[data-plate-select='${child}']`).click();
  await page.locator("#tabPose").click();
  const pose = page.locator("#pose");

  // The library's animation, listed for this assembly, its member parameter a select of the assembly's members.
  const choice = page.locator("[data-pose-animation='choice']");
  await expect(choice.locator("option[value='escapement-motion']")).toHaveCount(1);
  await choice.selectOption("escapement-motion");
  const memberSelect = page.locator("[data-pose-animation-member='wheel']");
  await expect(memberSelect).toBeVisible();
  await expect(memberSelect.locator("option")).toHaveText(["Choose a member", "Frame", "Escapement"]);
  await expect(memberSelect).toHaveValue("");
  await expect(pose).toHaveAttribute("data-posed", /./);
  const before = (await pose.getAttribute("data-posed"))!;
  // Not set: refused before anything builds, naming the parameter and the members.
  await page.locator("[data-pose-action='animation-play']").click();
  await expect(page.locator("#posePanel")).toContainText('This assembly has no member matching "Escape wheel", which the parameter wheel names: set wheel to one of its members (Frame, Escapement).');
  await expect(page.locator("[data-pose-animation-frame]")).toHaveCount(0);
  mkdirSync("test-results/anim-plugins", { recursive: true });
  await page.locator("#posePanel").screenshot({ path: "test-results/anim-plugins/member-refused.png" });
  await memberSelect.selectOption("Escapement");
  await page.locator("[data-pose-action='animation-play']").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __animationParams?: { wheel?: string } }).__animationParams?.wheel)).toBe("Escapement");
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible();
  await page.locator("[data-pose-animation-frame]").evaluate((el: HTMLInputElement) => { el.value = "3"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await expect(pose).not.toHaveAttribute("data-posed", before);
  await expect(pose).toHaveAttribute("data-animation-colors", new RegExp(`${child}:#0000ff`));
  await expect(page.locator("[data-pose-action='animation-library']")).toHaveCount(0);
  await page.screenshot({ path: "test-results/anim-plugins/member-select-playing.png" });
  await page.locator("[data-pose-action='animation-stop']").click();
  await expect(pose).toHaveAttribute("data-posed", before);

  // A project's animation the library lacks: Keep in library… keeps it, with its member parameter.
  await choice.selectOption("tick-tock");
  await page.locator("[data-pose-action='animation-play']").click();
  const trust = page.locator("#pluginTrust [data-choice='run']");
  await expect(trust.or(page.locator("[data-pose-animation-frame]"))).toBeVisible();
  if (await trust.isVisible()) await trust.click();
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible();
  await page.locator("[data-pose-action='animation-library']").click();
  const dialog = page.locator(".pose-animation-keep");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Animation title").fill("Tick tock on any clock");
  await dialog.getByLabel("Animation description").fill("The escape wheel swings back and forth.");
  await page.screenshot({ path: "test-results/anim-plugins/keep-dialog.png" });
  await dialog.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#posePanel")).toContainText("Kept “Tick tock on any clock” as animation tick-tock-on-any-clock v1");
  const kept = await page.evaluate(() => ((window as unknown as { __libFiles: { name: string; text: string }[] }).__libFiles).find((row) => row.name === "tick-tock-on-any-clock.rs")?.text ?? "");
  expect(kept).toContain("//! kind: animation");
  expect(kept).toContain('//! member-params: ["wheel"]');
  expect(kept).toContain(`//! source-sha256: ${sha(projectBody)}`);
  expect(kept).toContain('"label":"Escape wheel"');
  await expect(choice).toHaveValue("tick-tock-on-any-clock");
  await expect(page.locator("[data-pose-animation-member='wheel']")).toHaveValue("Escapement");
  await page.locator("#posePanel").screenshot({ path: "test-results/anim-plugins/kept-in-library.png" });
});
