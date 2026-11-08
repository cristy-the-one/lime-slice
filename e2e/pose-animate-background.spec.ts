import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { readGif } from "../tools/gif-read";
import { autoSliceOff } from "./auto-slice";

type TestWindow = { __limePluginLibrary: unknown; __limeRecipeRunner: unknown; __background?: string };

/** The scripted recipe runner: one animation whose background is whatever the test last set. */
async function scriptedAnimation(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as TestWindow;
    win.__limePluginLibrary = { invoke: async () => ({ dir: "test-library", files: [], presets: [], settings: null, imported: null }) };
    const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => { for (const handler of handlers.get(event) ?? []) handler({ payload }); }, 0);
    let run = "", step = 0;
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    win.__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/recipe", main: "/scripted/main.rs" };
        if (command === "recipe_start") { run = String(args.run); step = 0; return null; }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; result?: { members?: { name: string; joint?: { kind: string } }[] } };
          if (msg.v === 1) { say({ id: 1, call: "rig", args: {}, at: { line: 2 } }); return null; }
          if (step++ === 0) {
            const name = msg.result?.members?.find((m) => m.joint?.kind === "hinge")?.name ?? "missing";
            say({ id: 2, call: "animate", args: { fps: 4, camera: { direction: [1, -1, 0.5] }, ...(win.__background ? { background: win.__background } : {}), keys: [{ t: 0, rest: true }, { t: 1, set: { [name]: 60 } }] }, at: { line: 3 } });
            return null;
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
  doc.plugins = { [hash]: `//! ---\n//! plugin: pose-background\n//! title: Background test\n//! kind: animation\n//! api: 1.9\n//! source-sha256: ${hash}\n//! params: []\n//! ---\n${body}` };
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "animation.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await page.locator(`[data-plate-select='${child}']`).click();
  await page.locator("#tabPose").click();
  await page.locator("[data-pose-animation='choice']").selectOption("pose-background");
}

const setSwatch = (page: Page, color: string) => page.locator(".pose-animation-save").getByLabel("Animation background").evaluate((el: HTMLInputElement, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); }, color);
const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
/** The first pixel of a PNG, decoded by the browser. */
const firstPixel = (page: Page, png: Uint8Array) => page.evaluate(async (bytes) => {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: "image/png" }));
  const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
  return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
}, [...png]);
const corners = (frame: Uint8Array, side: number) => [0, side - 1, side * (side - 1), side * side - 1].map((i) => [...frame.subarray(i * 3, i * 3 + 3)]);

test("Save animation's background defaults to the script's, follows the swatch in the view, and is exact in the GIF and PNG frames", async ({ page }) => {
  await scriptedAnimation(page);
  const pose = page.locator("#pose");
  await page.evaluate(() => { (window as unknown as TestWindow).__background = "#336699"; });
  await page.locator("[data-pose-action='animation-play']").click();
  await page.locator("#pluginTrust [data-choice='run']").click();
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible();
  await expect(pose).toHaveAttribute("data-animation-background", "#336699");

  // The script's colour is the default; the swatch drives the view; Cancel puts it back.
  await page.locator("[data-pose-action='animation-save']").click();
  const dialog = page.locator(".pose-animation-save");
  await expect(dialog.getByLabel("Animation background")).toHaveValue("#336699");
  await setSwatch(page, "#ff8000");
  await expect(pose).toHaveAttribute("data-animation-background", "#ff8000");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pose).toHaveAttribute("data-animation-background", "#336699");
  // Not while the dialog is open: its modal backdrop dims what a screenshot sees.
  await expect.poll(async () => firstPixel(page, await pose.screenshot())).toEqual(rgb("#336699"));

  // A colour the fixed palette does not hold survives exactly, in every corner of every frame of the one palette.
  await page.locator("[data-pose-action='animation-save']").click();
  await setSwatch(page, "#12ab56");
  await dialog.getByLabel("Animation size").fill("320");
  const [gifFile] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Save", exact: true }).click()]);
  const gif = readGif(readFileSync((await gifFile.path())!));
  await expect(dialog).toHaveCount(0);
  expect(gif.frames.length).toBe(4);
  expect(gif.localPalettes).toBe(0);
  for (const frame of gif.frames) for (const corner of corners(frame, gif.width)) expect(corner).toEqual(rgb("#12ab56"));
  await expect(pose).toHaveAttribute("data-animation-background", "#12ab56");
  await expect.poll(async () => firstPixel(page, await pose.screenshot())).toEqual(rgb("#12ab56"));

  // PNG frames take the same colour.
  await page.locator("[data-pose-action='animation-save']").click();
  await expect(dialog.getByLabel("Animation background")).toHaveValue("#12ab56");
  await dialog.getByLabel("Animation format").selectOption("png");
  await dialog.getByLabel("Animation size").fill("320");
  const [zipFile] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Save", exact: true }).click()]);
  const png = unzipSync(readFileSync((await zipFile.path())!))["frame-001.png"]!;
  expect(await firstPixel(page, png)).toEqual(rgb("#12ab56"));

  // Stop gives the stage back. With no script colour the swatch starts at the stage colour and the view stays as it was.
  await page.locator("[data-pose-action='animation-stop']").click();
  await expect(pose).not.toHaveAttribute("data-animation-background");
  await page.evaluate(() => { delete (window as unknown as TestWindow).__background; });
  await page.locator("[data-pose-action='animation-play']").click();
  await expect(page.locator("[data-pose-animation-frame]")).toBeVisible();
  await expect(pose).not.toHaveAttribute("data-animation-background");
  await page.locator("[data-pose-action='animation-save']").click();
  const stage = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--stage").trim());
  expect(stage).toMatch(/^#[0-9a-f]{6}$/i);
  await expect(dialog.getByLabel("Animation background")).toHaveValue(stage.toLowerCase());
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(pose).not.toHaveAttribute("data-animation-background");

  // A script's colour in another form is refused with a sentence, and nothing plays.
  await page.locator("[data-pose-action='animation-stop']").click();
  await page.evaluate(() => { (window as unknown as TestWindow).__background = "red"; });
  await page.locator("[data-pose-action='animation-play']").click();
  await expect(page.locator("#posePanel")).toContainText("#rrggbb");
  await expect(page.locator("[data-pose-animation-frame]")).toHaveCount(0);
});
