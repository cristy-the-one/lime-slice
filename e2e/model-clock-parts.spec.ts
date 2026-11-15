import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body } from "./model-tree-mock";
import { boxSolid } from "./plugin-fixture";

/**
 * --- The clock parts that ship with the app (docs/plan-clock-parts.md), in the window with no recipe and no agent. From
 * an empty project with nothing open, the Plugins panel lists the five clock parts as Built in (the library folder is
 * empty); a person applies Ratchet wheel, then Ratchet click, each a new part standing where it belongs. They put both
 * on a frame in Prepare, give each a hinge in Pose, and couple the wheel as a ratchet: the form shows the wheel's teeth,
 * tip and root as read from the wheel, the click made for it already chosen and the free way as the wheel was cut. The
 * wheel turned its free way lifts the click and drops it in the next notch after one tooth; turned back, it holds.
 *
 * The recipe runner is played in the page: each shipped plugin's program sends the calls it sends under lust with its
 * defaults (`e2e/fixtures/clock-parts-calls.json`, kept by `mcp/clock-parts.test.ts`); the engine is the tree mock.
 */
const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelPlugins");
const objects = (page: Page) => page.locator("#objectList .obj");
const shots = process.env.LIME_SHOTS ?? path.join("test-results", "clock-parts");
const CALLS = JSON.parse(fs.readFileSync(path.join("e2e", "fixtures", "clock-parts-calls.json"), "utf8")) as Record<string, [string, Record<string, unknown>][]>;

interface Doc { assemblies: { couplings?: { kind?: string; click?: { phase: number; teeth: number; tip: number; root: number } }[]; members: { object: string; joint?: { kind: string; angle?: number } }[] }[] }

/** An empty plugin library, as the desktop shell lists a new person's folder. */
async function emptyLibrary(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __limePluginLibrary: unknown }).__limePluginLibrary = {
      invoke: async (command: string) => {
        if (command === "plugin_library_list") return { dir: "C:\\Users\\test\\AppData\\Roaming\\com.limeslice.slicer\\plugins", files: [], presets: [], settings: null, imported: null, ingredients: [], lessons: null };
        if (command === "plugin_library_write") return null;
        throw new Error(`no command ${command}`);
      },
    };
  });
}

/** The Tauri runner played in the page: a program built from a shipped plugin sends that plugin's recorded calls. */
async function replayRunner(page: Page) {
  await page.addInitScript((calls) => {
    type Handler = (event: { payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => { for (const handler of handlers.get(event) ?? []) handler({ payload }); }, 0);
    const programs = new Map<string, string>();
    const runs = new Map<string, { plugin: string; step: number; made: string[] }>();
    const starts: { plugin: string; context: Record<string, unknown> }[] = [];
    (window as unknown as { __recipeStarts: typeof starts }).__recipeStarts = starts;
    const say = (run: string, line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    const next = (run: string) => {
      const state = runs.get(run)!;
      const list = calls[state.plugin] ?? [];
      if (state.step >= list.length) { say(run, { done: { object: state.made[0] ?? "", metrics: {} } }); return; }
      const [tool, args] = list[state.step]!;
      // The recording names the parts obj_1, obj_2…: here they are the ids the window gave them.
      const text = JSON.stringify(args).replace(/"obj_(\d+)"/g, (_m, n: string) => JSON.stringify(state.made[Number(n) - 1] ?? ""));
      state.step += 1;
      say(run, { id: state.step, call: tool, args: JSON.parse(text), at: { line: 10 + state.step } });
    };
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") {
          const exe = `/scripted/slot-${String(args.slot)}/recipe`;
          const source = String(args.source ?? "");
          programs.set(exe, source.includes("ratchet.click(") ? "clock-ratchet-click" : source.includes("Ratchet::new") ? "clock-ratchet-wheel" : "unknown");
          return { code: 0, stdout: "", stderr: "", exe, main: `/scripted/slot-${String(args.slot)}/src/main.rs` };
        }
        if (command === "recipe_start") { runs.set(String(args.run), { plugin: programs.get(String(args.exe)) ?? "unknown", step: 0, made: [] }); return null; }
        if (command === "recipe_send") {
          const run = String(args.run);
          const state = runs.get(run)!;
          const msg = JSON.parse(String(args.line)) as { v?: number; ok?: boolean; error?: string; result?: { object?: string }; context?: Record<string, unknown> };
          if (msg.v === 1) starts.push({ plugin: state.plugin, context: msg.context ?? {} });
          else if (msg.ok === false) { emit("recipe-exit", { run, code: 101, reason: null, stderr: `thread 'main' (7) panicked at src/main.rs:4:5:\n${msg.error}\n` }); return null; }
          else if (typeof msg.result?.object === "string" && calls[state.plugin]?.[state.step - 1]?.[0] === "solid_new") state.made.push(msg.result.object);
          next(run);
          return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") { emit("recipe-exit", { run: String(args.run), code: command === "recipe_kill" ? null : 0, reason: null, stderr: "" }); return null; }
        throw new Error(`no command ${command}`);
      },
      listen: async (event: string, handler: Handler) => {
        const set = handlers.get(event) ?? new Set<Handler>();
        handlers.set(event, set);
        set.add(handler);
        return () => set.delete(handler);
      },
    };
  }, CALLS);
}

async function downloadProject(page: Page): Promise<Doc> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const [file] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  return JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as Doc;
}
const angleOf = (doc: Doc, id: string) => doc.assemblies[0]!.members.find((row) => row.object === id)?.joint?.angle ?? 0;

/** The plate object named `name`: its id. */
async function idOf(page: Page, name: string): Promise<string> {
  const id = await page.evaluate((wanted) => [...document.querySelectorAll<HTMLElement>("#objectList .obj")].find((row) => row.querySelector(".obj-name")?.textContent?.trim() === wanted || row.textContent?.includes(wanted))?.querySelector<HTMLElement>("[data-plate-select]")?.dataset.plateSelect ?? "", name);
  expect(id, `${name} is on the plate`).toBeTruthy();
  return id;
}

test("apply Ratchet wheel and Ratchet click with nothing open, then couple them in Pose with the numbers read from the parts", async ({ page }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: (request: Body) => boxSolid(((request.primitive as { size?: number[] } | undefined)?.size ?? [20, 20, 3]) as [number, number, number]),
    apply: (_request: Body, parent) => parent,
  });
  await emptyLibrary(page);
  await replayRunner(page);
  await page.goto("/");
  await autoSliceOff(page);
  await expect(objects(page)).toHaveCount(0);

  // The Plugins panel with nothing open: the clock parts are built in, though the library folder is empty.
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptyPlugins").click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator(".pp-section-title")).toHaveText(["Built in"]);
  for (const id of ["clock-ratchet-wheel", "clock-ratchet-click", "clock-escape-wheel", "clock-graham-anchor", "clock-wheel-pinion"]) {
    await expect(card(page).locator(`.pp-pick[data-key="library:${id}"] .pp-badge[data-badge="built in"]`)).toBeVisible();
  }
  await page.screenshot({ path: path.join(shots, "plugins-built-in.png") });

  // Ratchet wheel, applied with its defaults: a new part, no first-run view (it is the app's own code).
  await card(page).locator('.pp-pick[data-key="library:clock-ratchet-wheel"]').click();
  await card(page).locator("#modelPluginsLive").uncheck();
  await expect(card(page).locator('.mh-plugin-control[data-name="teeth"]')).toHaveValue("20");
  await page.screenshot({ path: path.join(shots, "ratchet-wheel-form.png") });
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Ratchet wheel” v1: Ratchet wheel, a new part");
  await expect(objects(page)).toHaveCount(1);

  // Ratchet click, its defaults the wheel's: it stands at horology's pivot, seated in a notch.
  await card(page).locator("#modelPluginsBack").click();
  await card(page).locator('.pp-pick[data-key="library:clock-ratchet-click"]').click();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Ratchet click” v1: Click, a new part");
  await expect(objects(page)).toHaveCount(2);
  const starts = await page.evaluate(() => (window as unknown as { __recipeStarts: { plugin: string; context: Record<string, unknown> }[] }).__recipeStarts);
  expect(starts.map((row) => row.plugin)).toEqual(["clock-ratchet-wheel", "clock-ratchet-click"]);
  expect(starts.every((row) => row.context.object === undefined), "each ran with no part").toBe(true);

  // A frame under them, in Prepare: both attached to it, keeping where they stand.
  await page.keyboard.press("Escape");
  await page.locator("#tabPrepare").click();
  const wheel = await idOf(page, "Ratchet wheel");
  const click = await idOf(page, "Click");
  await page.locator("#plateAddFile").setInputFiles("samples/calibration_cube_20mm.stl");
  await expect(objects(page)).toHaveCount(3);
  const frame = (await page.locator("#prepare").getAttribute("data-plate-selected"))!;
  await page.locator(`[data-plate-attach='${wheel}']`).click();
  await page.locator(`[data-plate-select='${frame}']`).click();
  await page.locator(`[data-plate-attach='${click}']`).click();
  await expect(page.locator(".obj-member")).toHaveCount(3);

  // Pose: a hinge each, the one Pose gives (about +Z at the part's own origin, which the plugins put on the axis and the pivot).
  await page.locator("#tabPose").click();
  const panel = page.locator("#posePanel");
  for (const id of [wheel, click]) {
    await panel.locator(`[data-object='${id}']`).click();
    await panel.getByLabel("Joint kind").selectOption("hinge");
  }

  // Couple: the form shows the wheel's numbers as read, the click made for it chosen, the free way as it was cut.
  await panel.locator(`[data-object='${wheel}']`).click();
  const couplings = panel.locator("[data-pose-couplings]");
  await couplings.getByLabel("Other part").selectOption({ index: 1 });
  await couplings.getByLabel("Kind", { exact: true }).selectOption("ratchet");
  const read = couplings.locator("[data-pose-couple-read]");
  await expect(read).toHaveText("Read from the parts: 20 teeth, tip 12 mm and root 10.2 mm, read from Ratchet wheel (Ratchet wheel v1).");
  await expect(couplings.getByLabel("Teeth", { exact: true })).toHaveCount(0);
  await expect(couplings.getByLabel("Click", { exact: true }).locator("option:checked")).toHaveText("Click (made for this wheel)");
  await expect(couplings.getByLabel("Runs free turning", { exact: true }).locator("option:checked")).toHaveText("back");
  await page.screenshot({ path: path.join(shots, "couplings-read.png") });
  await couplings.getByRole("button", { name: "Couple", exact: true }).click();
  await expect(panel.locator("[data-pose-couple-note]")).toContainText("Coupled: Ratchet wheel turns back only under Click (20 teeth");

  // Turned its free way half a tooth, the click stands lifted; after a whole tooth it is back in a notch.
  await panel.getByLabel("Angle °").fill("-9");
  await panel.getByLabel("Angle °").press("Tab");
  let doc = await downloadProject(page);
  expect(Math.abs(angleOf(doc, click)), "half a tooth on, the click is lifted").toBeGreaterThan(1);
  expect(doc.assemblies[0]!.couplings!.find((row) => row.kind === "ratchet")!.click).toMatchObject({ teeth: 20, tip: 12, root: 10.2 });
  await page.screenshot({ path: path.join(shots, "ratchet-lifted.png") });
  await panel.getByLabel("Angle °").fill("-18");
  await panel.getByLabel("Angle °").press("Tab");
  doc = await downloadProject(page);
  expect(angleOf(doc, click), "one tooth on, the click dropped into the next notch").toBeCloseTo(0, 6);
  // Turned the other way from its notch, the click holds it.
  await panel.getByLabel("Angle °").fill("-12");
  await panel.getByLabel("Angle °").press("Tab");
  await expect(panel).toContainText("turns only back: its click on");
  doc = await downloadProject(page);
  expect(angleOf(doc, wheel)).toBeCloseTo(-18, 6);
  await page.screenshot({ path: path.join(shots, "ratchet-held.png") });
});
