import { createHash } from "node:crypto";
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body, type MockSolid } from "./model-tree-mock";
import { boxSolid } from "./plugin-fixture";
import { scriptedLibrary } from "./plugins-scripted";
import type { Affine } from "../src/model-space.ts";

/**
 * --- A recipe assembles its parts in the app (docs/plan-plugin-recipes.md, section 6). "Gear train" (the plugin of
 * mcp/plugin-recipes.test.ts) makes a plate, runs "Gear on arbor" three times from inside it, attaches each gear to the
 * plate, hinges it and couples the train. A person in the window, with no agent and nothing open, applies it from the
 * Plugins panel: four parts, one assembly, the couplings in Pose's Gears section; the centre wheel turned in Pose turns
 * the others at the tooth ratios; one Undo takes everything back; Rebuild at another module keeps the same handles,
 * still coupled; saved and reopened it is still coupled, and rebuilds again.
 */

interface Doc {
  objects: { id: string; name: string; modelPose?: Affine; modelTree?: string }[];
  assemblies?: { id: string; name: string; couplings?: { driver: string; driven: string; ratio: number }[]; members: { object: string; parent: string | null; joint?: { kind: string; angle?: number } }[] }[];
}

const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelPlugins");
const objects = (page: Page) => page.locator("#objectList .obj");
const shots = "test-results/app-assembly";
const TEETH = [50, 9, 54];

const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
const fileOf = (id: string, title: string, body: string, params: string) => [
  "//! ---",
  `//! plugin: ${id}`,
  `//! title: ${title}`,
  "//! version: 1",
  `//! description: ${title} for the app-assembly spec.`,
  "//! author: Marius",
  "//! api: 1.16",
  `//! source-sha256: ${sha(body)}`,
  "//! target: new",
  `//! params: ${params}`,
  "//! ---",
  body,
].join("\n");
// The bodies only name the program the scripted runner plays (it reads `run_plugin`); the calls are in `trainRunner`.
const GEAR_BODY = "use lime_recipe::{gears, ops, Json, Session};\nfn main() {\n    let mut s = Session::start();\n    // gear on arbor\n}\n";
const TRAIN_BODY = "use lime_recipe::{gears, Json, Session};\nfn main() {\n    let mut s = Session::start();\n    // s.run_plugin(\"gear-on-arbor\", ..), s.attach, s.hinge, s.couple_gears\n}\n";
const GEAR_FILE = fileOf("gear-on-arbor", "Gear on arbor", GEAR_BODY, '[{"name":"teeth","kind":"count","default":24},{"name":"module","kind":"number","default":1},{"name":"phase","kind":"number","default":0},{"name":"name","kind":"text","default":"wheel"}]');
const TRAIN_FILE = fileOf("gear-train", "Gear train", TRAIN_BODY, '[{"name":"module","kind":"number","default":1,"min":0.5,"max":3,"unit":"mm","label":"Module"}]');

/**
 * The Tauri runner, played in the page. Gear train sends the calls the real program sends (mcp/plugin-recipes.test.ts:
 * lust and rustc agree on these 11): a plate, then for each gear a nested run of Gear on arbor, an attach at its centre
 * distance (`gears::pitch_radius`) with the mating phase (`gears::mate_phase`), a hinge; then Couple gears. Gear on arbor
 * makes its gear.
 */
async function trainRunner(page: Page) {
  await page.addInitScript((teeth) => {
    type Handler = (event: { payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    }, 0);
    const programs = new Map<string, "train" | "gear">();
    type Run = { program: "train" | "gear"; step: number; params: Record<string, unknown>; plate: string; gears: string[]; calls: Record<string, unknown>[] };
    const runs = new Map<string, Run>();
    const starts: { program: string; params: Record<string, unknown>; context: Record<string, unknown> }[] = [];
    (window as unknown as { __recipeStarts: typeof starts }).__recipeStarts = starts;
    const say = (run: string, line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    const pr = (z: number, m: number) => (z * m) / 2;
    const matePhase = (own: number, ownZ: number, dir: number, mateZ: number) => {
      const f = ((((dir - own) / (360 / ownZ)) % 1) + 1) % 1;
      return dir + 180 - ((0.5 - f) * 360) / mateZ;
    };
    /** Gear train's calls for module `m`, the plate's and gears' handles filled in as the replies name them. */
    const trainCalls = (m: number, run: Run): (() => Record<string, unknown>)[] => {
      const names = ["centre wheel", "third pinion", "third wheel"];
      const x = [0, 0, 0], phase = [0, 0, 0];
      for (let i = 1; i < 3; i += 1) {
        x[i] = x[i - 1]! + pr(teeth[i - 1]!, m) + pr(teeth[i]!, m);
        phase[i] = matePhase(phase[i - 1]!, teeth[i - 1]!, 0, teeth[i]!);
      }
      const tip = pr(teeth[0]!, m) + m;
      const length = x[2]! + pr(teeth[2]!, m) + m + tip + 4;
      const calls: (() => Record<string, unknown>)[] = [() => ({ call: "solid_new", args: { primitive: "box", dx: length, dy: 2 * tip + 4, dz: 3, name: "plate" } })];
      for (let i = 0; i < 3; i += 1) {
        calls.push(() => ({ call: "plugin_run", args: { plugin: "gear-on-arbor", params: { teeth: teeth[i], module: m, phase: phase[i], name: names[i] } } }));
        calls.push(() => ({ call: "model_place", args: { object: run.gears[i], to: run.plate, x: x[i]! - length / 2 + tip + 2, y: 0, z: 6, turnX: 0, turnY: 0, turnZ: 0 } }));
        calls.push(() => ({ call: "model_place", args: { object: run.gears[i], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } } }));
      }
      calls.push(() => ({ call: "model_place", args: { object: run.gears[0], gears: "couple" } }));
      return calls;
    };
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") {
          const exe = `/scripted/slot-${String(args.slot)}/recipe`;
          programs.set(exe, String(args.source).includes("run_plugin") ? "train" : "gear");
          return { code: 0, stdout: "", stderr: "", exe, main: `/scripted/slot-${String(args.slot)}/src/main.rs` };
        }
        if (command === "recipe_start") {
          runs.set(String(args.run), { program: programs.get(String(args.exe)) ?? "gear", step: 0, params: {}, plate: "", gears: [], calls: [] });
          return null;
        }
        if (command === "recipe_send") {
          const id = String(args.run);
          const run = runs.get(id)!;
          const msg = JSON.parse(String(args.line)) as { v?: number; ok?: boolean; error?: string; result?: { object?: string }; params?: Record<string, unknown>; context?: Record<string, unknown> };
          if (msg.v === 1) {
            run.params = msg.params ?? {};
            starts.push({ program: run.program, params: run.params, context: msg.context ?? {} });
          } else if (msg.ok === false) {
            emit("recipe-exit", { run: id, code: 101, reason: null, stderr: `thread 'main' (7) panicked at src/main.rs:27:5:\n${msg.error}\n` });
            return null;
          }
          if (run.program === "gear") {
            if (run.step === 0) {
              const p = run.params;
              say(id, { id: 1, call: "solid_new", args: { gear: { teeth: Number(p.teeth ?? 24), module: Number(p.module ?? 1), thickness: 4, bore: 0, phaseDeg: Number(p.phase ?? 0) }, name: String(p.name ?? "wheel") }, at: { line: 10 } });
            } else say(id, { done: { object: String(msg.result?.object ?? ""), metrics: {} } });
            run.step += 1;
            return null;
          }
          // Gear train: the reply to the call before names the plate or a gear.
          const calls = trainCalls(Number(run.params.module ?? 1), run);
          if (run.step === 1) run.plate = String(msg.result?.object ?? "");
          if (run.step >= 2 && (run.step - 2) % 3 === 0 && run.gears.length < 3) run.gears.push(String(msg.result?.object ?? ""));
          if (run.step < calls.length) say(id, { id: run.step + 1, ...calls[run.step]!(), at: { line: 20 + run.step } });
          else say(id, { done: { object: run.plate, metrics: {} } });
          run.step += 1;
          return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") {
          emit("recipe-exit", { run: String(args.run), code: command === "recipe_kill" ? null : 0, reason: null, stderr: "" });
          return null;
        }
        throw new Error(`no command ${command}`);
      },
      listen: async (event: string, handler: Handler) => {
        const set = handlers.get(event) ?? new Set<Handler>();
        handlers.set(event, set);
        set.add(handler);
        return () => set.delete(handler);
      },
    };
  }, TEETH);
}

/** A box `size`, centred on X and Y as the kernel's box and gear stand. */
function centredBox(size: [number, number, number]): MockSolid {
  const solid = boxSolid(size);
  return { ...solid, positions: solid.positions.map((v, i) => (i % 3 === 0 ? v - size[0] / 2 : i % 3 === 1 ? v - size[1] / 2 : v)) };
}

async function downloadProject(page: Page): Promise<{ doc: Doc; text: string }> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const text = fs.readFileSync((await file.path())!, "utf8");
  return { doc: JSON.parse(text) as Doc, text };
}

/** The train in a saved project: its ids by name, its assembly, the angles, and the centre wheel to pinion spacing. */
function trainOf(doc: Doc) {
  const id = (name: string) => doc.objects.find((row) => row.name === name)?.id ?? "";
  const ids = { plate: id("plate"), centre: id("centre wheel"), pinion: id("third pinion"), wheel: id("third wheel") };
  const assemblies = doc.assemblies ?? [];
  const asm = assemblies[0];
  const angle = (object: string) => asm?.members.find((row) => row.object === object)?.joint?.angle ?? 0;
  const x = (object: string) => doc.objects.find((row) => row.id === object)?.modelPose?.t[0] ?? 0;
  return { ids, assemblies, asm, angle, spacing: Math.abs(x(ids.pinion) - x(ids.centre)) };
}

/** The train is one assembly of the four parts, each gear hinged on the plate, coupled at the tooth ratios. */
function expectCoupled(doc: Doc, label: string) {
  const t = trainOf(doc);
  expect(t.assemblies.length, `${label}: one assembly`).toBe(1);
  expect(t.asm!.members.map((row) => row.object).sort(), `${label}: its members are the four parts`).toEqual(Object.values(t.ids).sort());
  expect(t.asm!.members.find((row) => row.parent === null)?.object, `${label}: the plate is the root`).toBe(t.ids.plate);
  for (const gear of [t.ids.centre, t.ids.pinion, t.ids.wheel]) expect(t.asm!.members.find((row) => row.object === gear)?.joint?.kind, `${label}: hinged`).toBe("hinge");
  const rows = (t.asm!.couplings ?? []).map((row) => [row.driver, row.driven, Math.round(Math.abs(row.ratio) * 1e6) / 1e6]);
  expect(rows, `${label}: coupled at the tooth ratios`).toEqual([[t.ids.centre, t.ids.pinion, Math.round((TEETH[0]! / TEETH[1]!) * 1e6) / 1e6], [t.ids.pinion, t.ids.wheel, Math.round((TEETH[1]! / TEETH[2]!) * 1e6) / 1e6]]);
  return t;
}

async function open(page: Page) {
  fs.mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: (request: Body) => {
      const spec = (request.primitive ?? {}) as { primitive?: string; size?: number[]; teeth?: number; module?: number; height?: number };
      if (spec.primitive === "gear") {
        const r = ((spec.teeth ?? 24) * (spec.module ?? 1)) / 2 + (spec.module ?? 1);
        return centredBox([2 * r, 2 * r, spec.height ?? 4]);
      }
      return centredBox((spec.size ?? [20, 20, 3]) as [number, number, number]);
    },
    apply: (_request: Body, parent) => parent,
  });
  await scriptedLibrary(page, false, { "gear-on-arbor.rs": GEAR_FILE, "gear-train.rs": TRAIN_FILE });
  await trainRunner(page);
  await page.goto("/");
  await autoSliceOff(page);
}

async function rebuildAt(page: Page, module: string) {
  const row = page.getByRole("treeitem", { name: /^Gear train · plugin v1/ });
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator(".mh-edit").click();
  const values = page.locator("#modelPluginCard");
  await expect(values).toBeVisible();
  await values.locator('.mh-plugin-control[data-name="module"]').fill(module);
  await values.locator("#modelPluginRebuild").click();
}

async function showPose(page: Page, select: string) {
  await expect(async () => {
    if ((await page.locator("#tabPose").getAttribute("aria-selected")) !== "true") await page.locator("#tabPose").click();
    await expect(page.locator(`#posePanel [data-object='${select}']`)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.locator(`#posePanel [data-object='${select}']`).click();
}

test("Gear train applied from the Plugins panel with nothing open: assembled, coupled, turning; one Undo; rebuilt under the same handles; reopened", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  await expect(objects(page)).toHaveCount(0);
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptyPlugins").click();
  await expect(card(page)).toBeVisible();
  await card(page).locator('.pp-pick[data-key="library:gear-train"]').click();
  await card(page).locator("#modelPluginsLive").uncheck();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Gear train” v1: 4 new parts (plate, centre wheel, third pinion and 1 more), each an object on the plate, which one Undo takes back. They stand assembled in plate assembly, coupled; Pose turns them.");
  await expect(objects(page)).toHaveCount(4);
  const starts = await page.evaluate(() => (window as unknown as { __recipeStarts: { program: string; context: { limits?: { canAssemble?: boolean }; object?: string } }[] }).__recipeStarts);
  expect(starts.map((row) => row.program), "Gear train ran Gear on arbor three times from inside it").toEqual(["train", "gear", "gear", "gear"]);
  expect(starts.every((row) => row.context.limits?.canAssemble === true && row.context.object === undefined), "the app says it can assemble, and no part was open").toBe(true);
  await page.screenshot({ path: `${shots}/applied-train-model.png` });

  const applied = expectCoupled((await downloadProject(page)).doc, "applied");
  expect(applied.spacing, "module 1: centre wheel to pinion is (50 + 9) / 2").toBeCloseTo(29.5, 9);
  const handles = applied.ids;

  // One Undo takes it all back: the four parts and the assembly. Redo brings them again, still coupled.
  // Prepare's Print layout / Assembly chip shows while the project has an assembly.
  const chip = page.locator("#assemblyViewChip");
  await expect(chip, "the project has an assembly").toHaveJSProperty("hidden", false);
  await page.locator("#modelUndo").click();
  await expect(objects(page)).toHaveCount(0);
  await expect(chip, "no assembly is left").toHaveJSProperty("hidden", true);
  await page.keyboard.press("Control+Shift+Z");
  await expect(objects(page)).toHaveCount(4);
  expectCoupled((await downloadProject(page)).doc, "redone");

  // Pose: the Gears section lists the couplings; the centre wheel's Angle turns the others at the tooth ratios.
  await showPose(page, handles.centre);
  const gears = page.locator("#posePanel [data-pose-gears]");
  await expect(gears).toContainText("centre wheel drives third pinion");
  await expect(gears).toContainText("third pinion drives third wheel");
  const angle = page.locator("#posePanel").getByLabel("Angle °");
  await angle.fill("30");
  await angle.press("Tab");
  await expect.poll(async () => trainOf((await downloadProject(page)).doc).angle(handles.pinion)).toBeCloseTo((-30 * TEETH[0]!) / TEETH[1]!, 6);
  const turned = trainOf((await downloadProject(page)).doc);
  expect(turned.angle(handles.centre)).toBeCloseTo(30, 9);
  expect(turned.angle(handles.wheel), "the third wheel at +30 · 50/54").toBeCloseTo((30 * TEETH[0]!) / TEETH[2]!, 6);
  await page.screenshot({ path: `${shots}/applied-train-pose-turned.png` });
  await angle.fill("0");
  await angle.press("Tab");

  // Rebuild at module 1.5 from the plate's History: the same four handles, one assembly, still coupled, wider.
  await page.locator(`#posePanel [data-object='${handles.plate}']`).click();
  await page.locator("#tabModel").click();
  await rebuildAt(page, "1.5");
  await expect(readout(page)).toContainText("Rebuilt “Gear train” with Module 1.5: its 4 parts (plate, centre wheel, third pinion and 1 more) under the same handles, which one Undo takes back. plate assembly keeps its parts, hinged and coupled.");
  const rebuilt = expectCoupled((await downloadProject(page)).doc, "rebuilt at 1.5");
  expect(rebuilt.ids, "the same handles").toEqual(handles);
  expect(rebuilt.spacing, "module 1.5: 1.5 · 59 / 2").toBeCloseTo(44.25, 9);
  await showPose(page, handles.centre);
  await angle.fill("30");
  await angle.press("Tab");
  await expect.poll(async () => trainOf((await downloadProject(page)).doc).angle(handles.wheel)).toBeCloseTo((30 * TEETH[0]!) / TEETH[2]!, 6);
  await page.screenshot({ path: `${shots}/rebuilt-train-pose.png` });
  await angle.fill("0");
  await angle.press("Tab");

  // Saved and reopened: the train is coupled from the file alone, and rebuilds again (module 2).
  const saved = await downloadProject(page);
  await page.reload();
  await autoSliceOff(page);
  await page.locator("#projectFile").setInputFiles({ name: "train.lime", mimeType: "application/json", buffer: Buffer.from(saved.text) });
  await expect(page.locator("[data-plate-select]")).toHaveCount(4, { timeout: 30_000 });
  await showPose(page, handles.centre);
  await expect(gears, "reopened, the couplings are read from the file").toContainText("centre wheel drives third pinion");
  await page.locator(`#posePanel [data-object='${handles.plate}']`).click();
  await page.locator("#tabModel").click();
  await rebuildAt(page, "2");
  await expect(readout(page)).toContainText("Rebuilt “Gear train” with Module 2");
  const reopened = expectCoupled((await downloadProject(page)).doc, "reopened and rebuilt at 2");
  expect(reopened.ids).toEqual(handles);
  expect(reopened.spacing).toBeCloseTo(59, 9);
  await page.screenshot({ path: `${shots}/reopened-rebuilt-model.png` });
  // One Undo takes the rebuild back to module 1.5.
  await page.locator("#modelUndo").click();
  await expect.poll(async () => trainOf((await downloadProject(page)).doc).spacing).toBeCloseTo(44.25, 9);
  expectCoupled((await downloadProject(page)).doc, "rebuild undone");
});

