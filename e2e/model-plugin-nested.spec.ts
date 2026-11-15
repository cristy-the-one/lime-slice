import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { autoSliceOff } from "./auto-slice";
import { mockModelTree, type Body } from "./model-tree-mock";
import { boxSolid } from "./plugin-fixture";
import { scriptedLibrary } from "./plugins-scripted";

/**
 * --- Recipes that use plugins (recipe API 1.16, docs/plan-plugin-recipes.md) in the window. "Box pair" runs the kept
 * plugin "One box" twice from inside it (`s.run_plugin`), with nothing open: the Plugins panel's Apply keeps both boxes
 * as objects of their own, named as the nested plugin named them, one Undo takes them back, and each nested run started
 * with its own values and no part. A nested plugin marked imported, which no person has run here yet, does not run
 * hidden inside another: the run says so and nothing is kept.
 */

const readout = (page: Page) => page.locator("#modelReadout");
const card = (page: Page) => page.locator("#modelPlugins");
const objects = (page: Page) => page.locator("#objectList .obj");
const shots = "test-results/plugin-nested";

const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
const fileOf = (id: string, title: string, body: string, params = "[]") => [
  "//! ---",
  `//! plugin: ${id}`,
  `//! title: ${title}`,
  "//! version: 1",
  `//! description: ${title} for the nested-plugin spec.`,
  "//! author: Marius",
  "//! api: 1.16",
  `//! source-sha256: ${sha(body)}`,
  "//! target: new",
  `//! params: ${params}`,
  "//! ---",
  body,
].join("\n");
const ONE_BODY = [
  "use lime_recipe::{ops, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let size = s.number("size", 10.0).get();',
  '    let name = s.text("name", "box").get();',
  '    let p = s.solid_new(ops::cuboid(size, size, 4.0).set("name", name.as_str())).unwrap();',
  "    s.done(&p);",
  "}",
  "",
].join("\n");
const PAIR_BODY = [
  "use lime_recipe::{Json, Session};",
  "fn main() {",
  "    let mut s = Session::start();",
  '    let a = s.run_plugin("one-box", Json::obj().set("size", 10.0).set("name", "small box")).unwrap();',
  '    let b = s.run_plugin("one-box", Json::obj().set("size", 14.0).set("name", "big box")).unwrap();',
  "    s.done(&a.part);",
  "}",
  "",
].join("\n");
const ONE_FILE = fileOf("one-box", "One box", ONE_BODY, '[{"name":"size","kind":"number","default":10},{"name":"name","kind":"text","default":"box"}]');
const PAIR_FILE = fileOf("box-pair", "Box pair", PAIR_BODY);

/**
 * The Tauri runner, played in the page, for several runs at once: a program built from Box pair's code asks for One box
 * twice, then ends on the first box; one built from One box's makes its box from the values it was started with.
 */
async function nestedRunner(page: Page) {
  await page.addInitScript(() => {
    type Handler = (event: { payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const emit = (event: string, payload: unknown) => setTimeout(() => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    }, 0);
    const programs = new Map<string, "pair" | "one">();
    const runs = new Map<string, { program: "pair" | "one"; step: number; first: string; params: Record<string, unknown> }>();
    const starts: { program: string; params: Record<string, unknown>; context: Record<string, unknown> }[] = [];
    (window as unknown as { __recipeStarts: typeof starts }).__recipeStarts = starts;
    const say = (run: string, line: unknown) => emit("recipe-line", { run, line: JSON.stringify(line) });
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "recipe_available") return { ok: true, lust: "scripted" };
        if (command === "recipe_build") {
          const exe = `/scripted/slot-${String(args.slot)}/recipe`;
          programs.set(exe, String(args.source).includes("run_plugin") ? "pair" : "one");
          return { code: 0, stdout: "", stderr: "", exe, main: `/scripted/slot-${String(args.slot)}/src/main.rs` };
        }
        if (command === "recipe_start") {
          runs.set(String(args.run), { program: programs.get(String(args.exe)) ?? "one", step: 0, first: "", params: {} });
          return null;
        }
        if (command === "recipe_send") {
          const run = String(args.run);
          const state = runs.get(run)!;
          const msg = JSON.parse(String(args.line)) as { v?: number; ok?: boolean; error?: string; result?: { object?: string }; params?: Record<string, unknown>; context?: Record<string, unknown> };
          if (msg.v === 1) {
            state.params = msg.params ?? {};
            starts.push({ program: state.program, params: state.params, context: msg.context ?? {} });
          }
          if (msg.ok === false) {
            emit("recipe-exit", { run, code: 101, reason: null, stderr: `thread 'main' (7) panicked at src/main.rs:4:5:\n${msg.error}\n` });
            return null;
          }
          state.step += 1;
          if (state.program === "one") {
            if (state.step === 1) {
              const size = Number(state.params.size ?? 10);
              say(run, { id: 1, call: "solid_new", args: { primitive: "box", dx: size, dy: size, dz: 4, name: String(state.params.name ?? "box") }, at: { line: 6 } });
            } else say(run, { done: { object: String(msg.result?.object ?? ""), metrics: {} } });
            return null;
          }
          if (state.step === 1) say(run, { id: 1, call: "plugin_run", args: { plugin: "one-box", params: { size: 10, name: "small box" } }, at: { line: 4 } });
          else if (state.step === 2) {
            state.first = String(msg.result?.object ?? "");
            say(run, { id: 2, call: "plugin_run", args: { plugin: "one-box", params: { size: 14, name: "big box" } }, at: { line: 5 } });
          } else say(run, { done: { object: state.first, metrics: {} } });
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
  });
}

async function open(page: Page, imported: boolean) {
  mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("lime-slice-theme", "dark"));
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/jobs**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await mockModelTree(page, {
    open: (request: Body) => boxSolid(((request.primitive as { size?: number[] } | undefined)?.size ?? [10, 10, 4]) as [number, number, number]),
    apply: (_request: Body, parent) => parent,
  });
  await scriptedLibrary(page, false, { "one-box.rs": ONE_FILE, "box-pair.rs": PAIR_FILE });
  if (imported) {
    await page.addInitScript((mark) => {
      (window as unknown as { __libraryStore: { imported: string | null } }).__libraryStore.imported = mark;
    }, JSON.stringify({ "one-box": { sha256: sha(ONE_BODY), from: "file", at: "2026-11-15" } }));
  }
  await nestedRunner(page);
  await page.goto("/");
  await autoSliceOff(page);
  await expect(objects(page)).toHaveCount(0);
  await page.locator("#tabModel").click();
  await page.locator("#modelEmptyPlugins").click();
  await expect(card(page)).toBeVisible();
  await card(page).locator('.pp-pick[data-key="library:box-pair"]').click();
  await card(page).locator("#modelPluginsLive").uncheck();
}

test("a plugin runs another twice with nothing open: Apply keeps both parts, one Undo takes them back", async ({ page }) => {
  await open(page, false);
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Applied “Box pair” v1: 2 new parts (small box and big box), each an object on the plate, which one Undo takes back.");
  await expect(objects(page)).toHaveCount(2);
  await expect(objects(page).nth(0)).toContainText("small box");
  await expect(objects(page).nth(1)).toContainText("big box");
  const starts = await page.evaluate(() => (window as unknown as { __recipeStarts: { program: string; params: Record<string, unknown>; context: Record<string, unknown> }[] }).__recipeStarts);
  expect(starts.map((row) => [row.program, row.params.size ?? null])).toEqual([["pair", null], ["one", 10], ["one", 14]]);
  expect(starts.every((row) => row.context.object === undefined)).toBe(true);
  await page.screenshot({ path: `${shots}/applied-two-boxes.png` });
  await page.locator("#modelUndo").click();
  await expect(objects(page)).toHaveCount(0);
});

test("a nested plugin nobody approved here does not run hidden inside another", async ({ page }) => {
  await open(page, true);
  await page.locator("#modelApply").click();
  await expect(readout(page)).toContainText("Box pair did not run: The recipe panicked at line 4: One box has not been run here yet, so it does not run from inside another plugin.");
  await expect(objects(page)).toHaveCount(0);
  await page.screenshot({ path: `${shots}/nested-not-approved.png` });
});
