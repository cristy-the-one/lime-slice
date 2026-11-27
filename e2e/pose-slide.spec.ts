import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import type { Member } from "../src/assembly.ts";
import type { Affine } from "../src/model-space.ts";

interface TestObject { id: string; name: string; modelPose?: Affine; placement: unknown; [key: string]: unknown }
interface TestDocument { objects: TestObject[]; assemblies: { id: string; name: string; members: Member[] }[]; plugins?: Record<string, string>; [key: string]: unknown }

const shotDir = path.join("docs", "screenshots", "l1-slides");

/** The scripted recipe runner, keying the assembly's slide from 0 to 20 mm. */
async function scriptSlide(page: Page): Promise<void> {
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
          const msg = JSON.parse(String(args.line)) as { v?: number; result?: { members?: { name: string; joint?: { kind: string } }[] } };
          if (msg.v === 1) { say({ id: 1, call: "rig", args: {}, at: { line: 2 } }); return null; }
          if (step++ === 0) {
            const name = msg.result?.members?.find((member) => member.joint?.kind === "slide")?.name ?? "missing";
            say({ id: 2, call: "animate", args: { fps: 4, keys: [{ t: 0, set: { [name]: 0 } }, { t: 1, set: { [name]: 20 } }] }, at: { line: 3 } });
            return null;
          }
          say({ done: { object: "", metrics: {} } });
          return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") { emit("recipe-exit", { run, code: 0, reason: null, stderr: "" }); return null; }
        throw new Error(`Unexpected command ${command}`);
      },
      listen: async (event: string, handler: (event: { payload: unknown }) => void) => { const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set); return () => set.delete(handler); },
    };
  });
}

async function loadSlide(page: Page, plugin: boolean): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await autoSliceOff(page);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click());
  await expect(page.locator("[data-plate-id='part']")).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as TestDocument;
  const cube = doc.objects.find((part) => part.id === "part")!;
  const identity: Affine["m"] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pose = (x: number): Affine => ({ m: identity, t: [x, 0, 0] });
  doc.objects = [
    { ...structuredClone(cube), id: "body", name: "body.stl", modelPose: pose(0) },
    { ...structuredClone(cube), id: "ram", name: "ram.stl", modelPose: pose(40) },
  ];
  doc.assemblies = [{ id: "press", name: "Press", members: [
    { object: "body", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: "ram", parent: "body", offset: [40, 0, 0], turn: [0, 0, 0], joint: { kind: "slide", pivot: [0, 0, 0], axis: [1, 0, 0], travel: 0, min: -40, max: 80 } },
  ] }];
  if (plugin) {
    const body = "fn main() {}\n", hash = createHash("sha256").update(body).digest("hex");
    doc.plugins = { [hash]: `//! ---\n//! plugin: slide-travel\n//! title: Slide travel\n//! kind: animation\n//! api: 1.8\n//! source-sha256: ${hash}\n//! params: []\n//! ---\n${body}` };
  }
  await page.reload();
  await page.locator("#projectFile").setInputFiles({ name: "slide.lime", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator("[data-assembly-head]")).toHaveCount(1);
  await page.locator("#tabPose").click();
  await expect(page.locator("#posePanel")).toBeVisible();
}

function axisX(raw: string | null, id: string): { min: number; max: number } {
  const row = (raw ?? "").split(" ").find((part) => part.startsWith(`${id}:`));
  if (!row) throw new Error(`no posed box for ${id}`);
  const nums = row.slice(id.length + 1).split(",").map(Number);
  return { min: nums[0]!, max: nums[3]! };
}

function numbers(raw: string | null): [number, number] {
  const row = (raw ?? "").split(",").map(Number);
  return [row[0]!, row[1]!];
}

test("pose_animate keys a slide in millimetres and a frame shows that travel", async ({ page }) => {
  await scriptSlide(page);
  await loadSlide(page, true);
  await page.locator("#posePanel [data-object='ram']").click();
  await page.locator("[data-pose-animation='choice']").selectOption("slide-travel");
  await page.locator("[data-pose-action='animation-play']").click();
  await page.locator("#pluginTrust [data-choice='run']").click();
  const frame = page.locator("[data-pose-animation-frame]");
  await expect(frame).toBeVisible();
  await page.locator("[data-pose-action='animation-play']").click();
  const pose = page.locator("#pose");
  const seek = async (index: string) => {
    await frame.evaluate((el: HTMLInputElement, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); }, index);
    await expect(frame).toHaveValue(index);
  };
  await seek("0");
  const start = axisX(await pose.getAttribute("data-posed"), "ram");
  await seek("2");
  await expect.poll(async () => axisX(await pose.getAttribute("data-posed"), "ram").min - start.min).toBeCloseTo(10, 1);
  const mid = axisX(await pose.getAttribute("data-posed"), "ram");
  expect(mid.max - start.max).toBeCloseTo(10, 1);
  await seek("4");
  await expect.poll(async () => axisX(await pose.getAttribute("data-posed"), "ram").min - start.min).toBeCloseTo(20, 1);
});

test("dragging the slide arrow moves travel, and Ctrl+Z restores it", async ({ page }) => {
  await loadSlide(page, false);
  const panel = page.locator("#posePanel");
  await panel.locator("[data-object='ram']").click();
  await page.locator("[data-pose-tool='turn']").click();
  await page.locator("[data-pose-view='top']").click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const canvas = page.locator("#pose");
  await expect(canvas).toHaveAttribute("data-turn-kind", "slide");
  await expect(canvas).toHaveAttribute("data-turn-handles", /0:/);
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, "slide-arrow.png") });
  const handle = numbers((await canvas.getAttribute("data-turn-handles"))!.split(":")[1] ?? "");
  const centre = numbers(await canvas.getAttribute("data-turn-center"));
  const dx = handle[0] - centre[0], dy = handle[1] - centre[1];
  const length = Math.hypot(dx, dy) || 1;
  await expect(panel.getByLabel("Travel mm")).toHaveValue("0");
  await page.mouse.move(handle[0], handle[1]);
  await page.mouse.down();
  await page.mouse.move(handle[0] + (dx / length) * 90, handle[1] + (dy / length) * 90, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await panel.getByLabel("Travel mm").inputValue()))).toBeGreaterThan(1);
  const travel = Number(await panel.getByLabel("Travel mm").inputValue());
  expect(travel).toBeGreaterThanOrEqual(-40.001);
  expect(travel).toBeLessThanOrEqual(80.001);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+z");
  await expect(panel.getByLabel("Travel mm")).toHaveValue("0");
});
