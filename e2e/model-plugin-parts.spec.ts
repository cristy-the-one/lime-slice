import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body } from "./model-tree-mock";
import { boxSolid } from "./plugin-fixture";
import { scriptedLibrary } from "./plugins-scripted";

/**
 * --- A plugin that makes several parts, run from the Plugins panel with nothing open (docs/plan-recipe-plugins.md O4
 * as built). An empty plate in Model offers Run a plugin…; plugins that change a part are greyed and say what they
 * need. Preview draws every part the run makes, where Apply puts it, and Cancel takes them back; Apply puts each on the
 * plate as its own object, named as the plugin named them, stamped with one run id, and one Undo takes them all back.
 * Changing the values of one part of the set says plainly that the window does not rebuild a set yet.
 */

const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelPlugins");
const objects = (page: Page) => page.locator("#objectList .obj");
const shots = "test-results/plugin-parts";

const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
const PARTS_BODY = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let n = s.count("parts", 3).range(1, 6).label("Parts").get();',
  '    let names = ["base", "lid", "peg", "pin", "dial", "key"];',
  "    let mut first = None;",
  "    for i in 0..n {",
  '        let p = s.solid_new(ops::cuboid(20.0, 20.0, 4.0 + i as f64).set("name", names[i as usize])).unwrap();',
  "        if first.is_none() { first = Some(p); }",
  "    }",
  "    s.done(&first.unwrap());",
  "}",
  "",
].join("\n");
const PARTS_FILE = [
  "//! ---",
  "//! plugin: parts-box",
  "//! title: Parts box",
  "//! version: 1",
  "//! description: A box in several parts, each its own object.",
  "//! author: Marius",
  "//! api: 1.1",
  `//! source-sha256: ${sha(PARTS_BODY)}`,
  "//! target: new",
  '//! params: [{"name":"parts","kind":"count","default":3,"min":1,"max":6,"label":"Parts"}]',
  "//! ---",
  PARTS_BODY,
].join("\n");

/** The Tauri runner, played in the page: the recipe makes `parts` boxes, 20 × 20 × (4 + i), named base, lid, peg…, then ends on the first. */
async function partsRunner(page: Page) {
  await page.addInitScript(() => {
    type Handler = (event: { payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    }, 0);
    const names = ["base", "lid", "peg", "pin", "dial", "key"];
    let run = "";
    let parts = 3;
    let made: string[] = [];
    const starts: Record<string, unknown>[] = [];
    (window as unknown as { __recipeStarts: typeof starts }).__recipeStarts = starts;
    const say = (line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    const next = () => {
      const i = made.length;
      if (i < parts) say({ id: i + 1, call: "solid_new", args: { primitive: "box", dx: 20, dy: 20, dz: 4 + i, name: names[i] }, at: { line: 8 } });
      else say({ done: { object: made[0], metrics: {} } });
    };
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/slot-0/recipe", main: "/scripted/slot-0/src/main.rs" };
        if (command === "recipe_start") {
          run = String(args.run);
          return null;
        }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; ok?: boolean; error?: string; result?: { object?: string }; params?: { parts?: number } };
          if (msg.v === 1) {
            starts.push(msg as Record<string, unknown>);
            parts = Number(msg.params?.parts ?? 3);
            made = [];
            next();
            return null;
          }
          if (msg.ok === false) {
            emit("recipe-exit", { run, code: 101, reason: null, stderr: `thread 'main' (7) panicked at src/main.rs:8:5:\n${msg.error}\n` });
            return null;
          }
          made.push(String(msg.result?.object ?? ""));
          next();
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

test("a plugin that makes several parts runs with nothing open: Preview shows them all, Apply puts each on the plate, one Undo takes them back", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: (request: Body) => boxSolid(((request.primitive as { size?: number[] } | undefined)?.size ?? [20, 20, 10]) as [number, number, number]),
    apply: (_request: Body, parent) => parent,
  });
  await scriptedLibrary(page, false, { "parts-box.rs": PARTS_FILE });
  await partsRunner(page);
  await page.goto("/");
  await autoSliceOff(page);

  // An empty plate: Model offers the Plugins panel, no throw-away part needed.
  await expect(objects(page)).toHaveCount(0);
  await page.locator("#tabModel").click();
  await expect(page.locator("#modelEmpty")).toBeVisible();
  await page.locator("#modelEmptyPlugins").click();
  await expect(page.locator("#modelPanelTitle")).toHaveText("Plugins");
  await expect(card(page)).toBeVisible();
  // A plugin that changes a part is greyed and says what it needs; one that builds its own parts is not.
  const stud = card(page).locator('.pp-pick[data-key="library:stud-row"]');
  await expect(stud).toHaveAttribute("data-needs-part", "");
  await expect(stud.locator(".pp-need")).toHaveText("Needs a part: open one in Model, then run it.");
  const box = card(page).locator('.pp-pick[data-key="library:parts-box"]');
  await expect(box).not.toHaveAttribute("data-needs-part", "");
  await page.screenshot({ path: `${shots}/empty-plate-plugins.png` });

  // Preview: all three parts, where Apply puts them; nothing on the plate yet.
  await box.click();
  await expect(card(page).locator("#modelPluginsTarget")).toHaveText("Builds a new part.");
  await card(page).locator("#modelPluginsLive").uncheck();
  await card(page).locator("#modelPluginsPreview").click();
  await expect(readout(page)).toContainText("Preview of “Parts box”: 3 new parts (base, lid and peg). Volume 6000 mm³ in all. Nothing is kept until you Apply.");
  await expect(page.locator("#model")).toHaveAttribute("data-preview", "6000.00");
  await expect(objects(page)).toHaveCount(0);
  await page.screenshot({ path: `${shots}/preview-three-parts.png` });

  // Another value previews again; Cancel takes the preview back and leaves the plate empty.
  await card(page).locator('.mh-plugin-control[data-name="parts"]').fill("4");
  await card(page).locator("#modelPluginsPreview").click();
  await expect(readout(page)).toContainText("4 new parts (base, lid, peg and 1 more)");
  await page.locator("#modelCancel").click();
  await expect(card(page)).toBeHidden();
  await expect(page.locator("#model")).not.toHaveAttribute("data-preview", /.*/);
  await expect(objects(page)).toHaveCount(0);

  // Apply: each part its own object, named as the plugin named them, the first open in Model with the plugin row.
  await page.keyboard.press("Control+Alt+L");
  await expect(card(page)).toBeVisible();
  await card(page).locator('.pp-pick[data-key="library:parts-box"]').click();
  await card(page).locator("#modelPluginsLive").uncheck();
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Parts box” v1: 3 new parts (base, lid and peg), each an object on the plate, which one Undo takes back.");
  await expect(objects(page)).toHaveCount(3);
  for (const [i, name] of ["base", "lid", "peg"].entries()) await expect(objects(page).nth(i)).toContainText(name);
  await expect(page.getByRole("treeitem", { name: /^Parts box · plugin v1/ })).toBeVisible();
  // The stand-in runner ran once per press, with no part.
  const starts = await page.evaluate(() => (window as unknown as { __recipeStarts: { context: Record<string, unknown> }[] }).__recipeStarts);
  expect(starts.every((start) => start.context.object === undefined)).toBe(true);
  await page.screenshot({ path: `${shots}/applied-three-objects.png` });

  // One Undo takes all three back; Redo (the plate is empty, so the shortcut) brings them again.
  await page.locator("#modelUndo").click();
  await expect(objects(page)).toHaveCount(0);
  await page.keyboard.press("Control+Shift+Z");
  await expect(objects(page)).toHaveCount(3);

  // A value change on one part of the set says what it does today, and changes nothing.
  const row = page.getByRole("treeitem", { name: /^Parts box · plugin v1/ });
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator(".mh-edit").click();
  const values = page.locator("#modelPluginCard");
  await expect(values).toBeVisible();
  await values.locator('.mh-plugin-control[data-name="parts"]').fill("4");
  await values.locator("#modelPluginRebuild").click();
  await expect(readout(page)).toContainText("Parts box made this part in one run with lid and peg, and the window cannot yet change the values of a run of several parts, so nothing changed. Run Parts box again from Plugins with the new values, then remove the old parts.");
  await expect(objects(page)).toHaveCount(3);
  await page.screenshot({ path: `${shots}/value-change-on-a-set.png` });
});
