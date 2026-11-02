import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { pluginProject, SHA, type Doc } from "./plugin-fixture";

/**
 * --- Plugin steps (docs/plan-recipe-plugins.md milestone 6). A plugin step's values change in History: the card's
 * fields take new values, Rebuild runs the plugin from the step before its run (here a scripted recipe behind the
 * app's runner, since the browser build has no Tauri), the step after it is built again, and one Undo goes back to the
 * old values. The scripted recipe cuts `studs` boxes, each 2 × studs mm long, then ends; at 7 studs it panics.
 */

const readout = (page: Page) => page.locator("#modelReadout");
const rows = (page: Page) => page.locator("#modelHistoryTree [role=treeitem]");
const shots = "test-results/plugin-rebuild";

/** The Tauri runner's commands and events, played in the page: `__limeRecipeRunner` (src/recipe/runtime.ts). */
async function scriptedRunner(page: Page) {
  await page.addInitScript(() => {
    type Handler = (event: { payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    }, 0);
    const log: { command: string; args: Record<string, unknown> }[] = [];
    let run = "";
    let object = "";
    let studs = 0;
    let made = 0;
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    const cut = (id: number) => say({ id, call: "model_apply", args: { object, op: { kind: "boolean", op: "cut", primitive: "box", dx: 2 * studs, dy: 20, dz: 20, origin: [0, 0, 0] }, probe: true }, at: { line: 10 } });
    (window as unknown as { __recipeLog: typeof log }).__recipeLog = log;
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        log.push({ command, args });
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/slot-0/recipe", main: "/scripted/slot-0/src/main.rs" };
        if (command === "recipe_start") {
          run = String(args.run);
          return null;
        }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; ok?: boolean; error?: string; params?: { studs?: number }; context?: { object?: string } };
          if (msg.v === 1) {
            object = String(msg.context?.object ?? "");
            studs = Number(msg.params?.studs ?? 3);
            made = 0;
            if (studs === 7) {
              emit("recipe-exit", { run, code: 101, reason: null, stderr: "thread 'main' (7) panicked at src/main.rs:12:9:\nseven studs do not fit on this part\n" });
              return null;
            }
            made += 1;
            cut(made);
            return null;
          }
          if (msg.ok === false) {
            emit("recipe-exit", { run, code: 101, reason: null, stderr: `thread 'main' (7) panicked at src/main.rs:10:5:\n${msg.error}\n` });
            return null;
          }
          if (made < studs) {
            made += 1;
            cut(made);
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

async function openCard(page: Page) {
  const plugin = page.getByRole("treeitem", { name: /^Stud row · plugin v3/ });
  await expect(plugin).toBeVisible();
  await plugin.hover();
  await plugin.locator(".mh-edit").click();
  const card = page.locator("#modelPluginCard");
  await expect(card).toBeVisible();
  return { plugin, card };
}

test("a plugin step's values change in History: Rebuild runs it again, the later step follows, Undo brings the old values back", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { after: [2], before: scriptedRunner });
  await expect(readout(page)).toBeVisible();
  const { card } = await openCard(page);
  const studs = card.locator('.mh-plugin-control[data-name="studs"]');
  await expect(studs).toHaveValue("5");
  await expect(studs).toHaveJSProperty("readOnly", false);
  await expect(card.locator('.mh-plugin-control[data-name="edge"]')).toBeEnabled();
  await expect(card.locator(".mh-plugin-hint")).toHaveText("Change a value, then Rebuild. The steps after it are built again, and Undo goes back to these values.");
  await expect(card.locator("#modelPluginRebuild")).toBeEnabled();
  await expect(card.locator("#modelPluginReset")).toBeDisabled();

  // A value out of its range is said before anything runs.
  await studs.fill("12");
  await expect(card.locator(".mh-plugin-hint")).toHaveText("Studs is 1 to 10.");
  await expect(card.locator("#modelPluginRebuild")).toBeDisabled();
  await card.locator("#modelPluginReset").click();
  await expect(studs).toHaveValue("5");

  // Four studs: the plugin runs from the step before its run, four cuts, and the cut after it is built again.
  await studs.fill("4");
  await expect(card.locator(".mh-plugin-unit").first()).toHaveText("changed");
  await page.screenshot({ path: `${shots}/plugin-values-edited.png` });
  await card.locator("#modelPluginRebuild").click();
  await expect(readout(page)).toContainText("Rebuilt “Stud row” with Studs 4 and rebuilt the step after it.");
  await expect(readout(page)).toContainText("Volume 800 mm³");
  await expect(studs).toHaveValue("4");
  await expect(card.locator(".mh-plugin-unit").first()).toHaveText("");
  const log = await page.evaluate(() => (window as unknown as { __recipeLog: { command: string; args: Record<string, unknown> }[] }).__recipeLog);
  const start = JSON.parse(String(log.find((row) => row.command === "recipe_send")!.args.line)) as { params: Record<string, unknown>; context: Record<string, unknown> };
  expect(start.params).toEqual({ studs: 4 });
  expect(start.context.object).toBeTruthy();
  expect(log.filter((row) => row.command === "recipe_build")).toHaveLength(1);
  // The new run is one row on a new branch, with the person's cut after it; the old branch stays beside it.
  const runs = page.getByRole("treeitem", { name: /^Stud row · plugin v3/ });
  await expect(rows(page)).toHaveCount(5);
  await expect(runs).toHaveCount(2);
  const shownRun = runs.and(page.locator('[data-state="past"]'));
  await expect(shownRun).toHaveCount(1);
  await shownRun.locator(".mh-fold").click();
  await expect(rows(page)).toHaveCount(8);
  await page.screenshot({ path: `${shots}/plugin-rebuilt.png` });

  // One Undo goes back to the old branch with the old values; Redo comes back to the new ones.
  await page.locator("#modelUndo").click();
  await expect(readout(page)).toContainText("Edit of the step undone.");
  await expect(studs).toHaveValue("5");
  await page.locator("#modelRedo").click();
  await expect(readout(page)).toContainText("Edit of the step redone.");
  await expect(studs).toHaveValue("4");

  // A run that fails leaves the part as it was and says why, with the line.
  await studs.fill("7");
  await card.locator("#modelPluginRebuild").click();
  await expect(readout(page)).toContainText("Stud row was not rebuilt: The recipe panicked at line 12: seven studs do not fit on this part.");
  await expect(readout(page)).toContainText("The part is as it was.");
  await expect(card.locator(".mh-plugin-hint")).toContainText("seven studs do not fit on this part");
  await expect(card.locator("#modelPluginRebuild")).toBeEnabled();
  await page.screenshot({ path: `${shots}/plugin-rebuild-refused.png` });
  await card.locator("#modelPluginReset").click();
  await expect(studs).toHaveValue("4");

  // A save keeps the new stamp, with its values and the run of four, and the old branch beside it.
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as Doc;
  const nodes = doc.objects[0]!.modelTree.nodes;
  const stamps = nodes.filter((node) => node.plugin).map((node) => node.plugin as { params: Record<string, unknown> });
  expect(stamps.map((stamp) => stamp.params)).toEqual([{ studs: 5 }, { studs: 4 }]);
  expect(nodes.filter((node) => (node.run as { n?: number } | undefined)?.n === 4)).toHaveLength(4);
  expect(doc.plugins?.[SHA]).toBeTruthy();
});

test("a project's edited copy asks before the changed code runs, and the step then names that code", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await pluginProject(page, { copy: (file) => file.replace("[-10.0 + 4.0", "[-12.0 + 4.0"), before: scriptedRunner });
  const { card } = await openCard(page);
  await expect(card.locator(".mh-plugin-note")).toHaveText("This project's copy of the plugin was changed outside the app.");
  await card.locator('.mh-plugin-control[data-name="studs"]').fill("3");
  await card.locator("#modelPluginRebuild").click();
  await expect(card.locator(".mh-plugin-hint")).toHaveText("The step was built with other code. Rebuild with the project's changed copy? Its stamp then names the changed code.");
  await expect(card.locator("#modelPluginRebuild")).toHaveText("Confirm");
  await page.screenshot({ path: `${shots}/plugin-edited-ask.png` });
  await card.locator("#modelPluginRebuild").click();
  await expect(readout(page)).toContainText("Rebuilt “Stud row” with Studs 3.");
  // The stamp now names the changed code, so the row has nothing to warn about.
  await expect(card.locator(".mh-plugin-note")).toBeHidden();
  await page.locator("#tabPrepare").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const doc = JSON.parse((await readFile((await download.path())!)).toString("utf8")) as Doc;
  const shas = Object.keys(doc.plugins ?? {});
  expect(shas).toHaveLength(2);
  const fresh = shas.find((sha) => sha !== SHA)!;
  expect(doc.plugins![fresh]).toContain(`//! source-sha256: ${fresh}`);
  const stamps = doc.objects[0]!.modelTree.nodes.filter((node) => node.plugin).map((node) => (node.plugin as { sha256: string }).sha256);
  expect(stamps).toContain(fresh);
});
