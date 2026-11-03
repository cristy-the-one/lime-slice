import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { pluginProject, type Doc } from "./plugin-fixture";

/**
 * --- Plugin steps: a part the plugin made rebuilds in the app too. The run is the part's whole history from its first
 * step; Rebuild runs the plugin with no part (a scripted recipe behind the app's runner: `solid_new` a 20 × 20 × 10
 * block, then `studs` cuts), the plate object keeps its place and takes the new history, the person's cut after the run
 * is built again on it, and one Undo goes back to the old history and its values.
 */

const readout = (page: Page) => page.locator("#modelReadout");
const shots = "test-results/plugin-made";

/** The Tauri runner, played in the page: the recipe makes its part, then cuts `studs` boxes in it. */
async function makingRunner(page: Page) {
  await page.addInitScript(() => {
    type Handler = (event: { payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    }, 0);
    const starts: Record<string, unknown>[] = [];
    let run = "";
    let object = "";
    let studs = 0;
    let made = 0;
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    const cut = (id: number) => say({ id, call: "model_apply", args: { object, op: { kind: "boolean", op: "cut", primitive: "box", dx: 2 * studs, dy: 20, dz: 20, origin: [0, 0, 0] }, probe: true }, at: { line: 10 } });
    (window as unknown as { __recipeStarts: typeof starts }).__recipeStarts = starts;
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/slot-0/recipe", main: "/scripted/slot-0/src/main.rs" };
        if (command === "recipe_start") {
          run = String(args.run);
          return null;
        }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; id?: number; ok?: boolean; error?: string; result?: { object?: string }; params?: { studs?: number } };
          if (msg.v === 1) {
            starts.push(msg as Record<string, unknown>);
            studs = Number(msg.params?.studs ?? 3);
            made = 0;
            object = "";
            say({ id: 1, call: "solid_new", args: { primitive: "box", dx: 20, dy: 20, dz: 10, name: "studded" }, at: { line: 8 } });
            return null;
          }
          if (msg.ok === false) {
            emit("recipe-exit", { run, code: 101, reason: null, stderr: `thread 'main' (7) panicked at src/main.rs:10:5:\n${msg.error}\n` });
            return null;
          }
          if (msg.id === 1) object = String(msg.result?.object ?? "");
          if (made < studs) {
            made += 1;
            cut(made + 1);
          } else say({ done: { object, metrics: {} } });
          return null;
        }
        if (command === "recipe_close_input" || command === "recipe_kill") {
          emit("recipe-exit", { run, code: command === "recipe_kill" ? null : 0, reason: null, stderr: "" });
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
  });
}

test("a part the plugin made rebuilds in place: a new history for the same object, the later step follows, one Undo goes back", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { after: [2], made: true, before: makingRunner });
  const plugin = page.getByRole("treeitem", { name: /^Stud row · plugin v3/ });
  await expect(plugin).toBeVisible();
  await plugin.hover();
  await plugin.locator(".mh-edit").click();
  const card = page.locator("#modelPluginCard");
  await expect(card).toBeVisible();
  const studs = card.locator('.mh-plugin-control[data-name="studs"]');
  await expect(studs).toHaveValue("5");
  // The part was made by the plugin, and its values change here now.
  await expect(card.locator(".mh-plugin-hint")).toHaveText("Change a value, then Rebuild. The steps after it are built again, and Undo goes back to these values.");
  await expect(card.locator("#modelPluginRebuild")).toBeEnabled();

  await studs.fill("4");
  await card.locator("#modelPluginRebuild").click();
  await expect(readout(page)).toContainText("Rebuilt “Stud row” with Studs 4 and rebuilt the step after it.");
  await expect(readout(page)).toContainText("Volume 800 mm³");
  await expect(studs).toHaveValue("4");
  // The plugin ran with no part: it made its own, as it did the first time.
  const starts = await page.evaluate(() => (window as unknown as { __recipeStarts: { params: Record<string, unknown>; context: Record<string, unknown> }[] }).__recipeStarts);
  expect(starts).toHaveLength(1);
  expect(starts[0]!.params).toEqual({ studs: 4 });
  expect(starts[0]!.context.object).toBeUndefined();
  // One object on the plate still, with the new history: the run of five (its first step and four cuts) and the cut.
  await expect(page.locator("#objectList .obj")).toHaveCount(1);
  await expect(page.getByRole("treeitem", { name: /^Stud row · plugin v3/ })).toHaveCount(1);
  await page.screenshot({ path: `${shots}/plugin-made-rebuilt.png` });

  // One Undo goes back to the old history with the old values; Redo comes back to the new one.
  await page.locator("#modelUndo").click();
  await expect(page.locator("#modelRedo")).toBeEnabled();
  await expect(readout(page)).toContainText("Volume 800 mm³");
  await page.getByRole("treeitem", { name: /^Stud row · plugin v3/ }).first().hover();
  await page.getByRole("treeitem", { name: /^Stud row · plugin v3/ }).first().locator(".mh-edit").click();
  await expect(card.locator('.mh-plugin-control[data-name="studs"]')).toHaveValue("5");
  await page.screenshot({ path: `${shots}/plugin-made-undone.png` });
  await page.locator("#modelRedo").click();
  await expect(page.locator("#modelUndo")).toBeEnabled();
  await page.getByRole("treeitem", { name: /^Stud row · plugin v3/ }).first().hover();
  await page.getByRole("treeitem", { name: /^Stud row · plugin v3/ }).first().locator(".mh-edit").click();
  await expect(card.locator('.mh-plugin-control[data-name="studs"]')).toHaveValue("4");

  // A save keeps the new history: the stamp on its first step with the new values, the run of five.
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as Doc;
  const nodes = doc.objects[0]!.modelTree.nodes;
  const root = nodes.find((node) => node.parent === null)!;
  expect((root.plugin as { params: Record<string, unknown> } | undefined)?.params).toEqual({ studs: 4 });
  expect(nodes.filter((node) => (node.run as { n?: number } | undefined)?.n === 5)).toHaveLength(5);
});
