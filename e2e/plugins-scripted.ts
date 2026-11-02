import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { BODY, FILE } from "./plugin-fixture";

/**
 * --- The Plugins panel's specs (plugin milestone 7) share these: a plugin library in the page standing in for the
 * desktop shell's folder (`__limePluginLibrary`, as `src/plugins/library.ts` reads it), and a scripted recipe runner
 * behind the app's Tauri runner (`__limeRecipeRunner`), since the browser build has neither. The scripted recipe cuts
 * `studs` boxes (or `notches`), each 2 × studs mm long, then ends; in describe mode it declares the fixture's values.
 */

const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

const header = (fields: Record<string, string | number>, params: unknown[], body: string) =>
  ["//! ---", ...Object.entries({ ...fields, "source-sha256": sha(body) }).map(([k, v]) => `//! ${k}: ${v}`), `//! params: ${JSON.stringify(params)}`, "//! ---", body].join("\n");

/** Stud row v4: the fixture's v3 with a wider range and a gap, and no edge choice. */
export const BODY_V4 = BODY.replace("range(1, 10)", "range(1, 12)").replace('let edge = s.choice("edge", &["fillet", "sharp"], "fillet").get();', 'let gap = s.number("gap", 4.0).range(2.0, 8.0).unit("mm").label("Gap").get();').replace("s.log(edge.as_str());", "s.log(&format!(\"{}\", gap));");
export const SHA_V4 = sha(BODY_V4);
export const FILE_V4 = header(
  { plugin: "stud-row", title: "Stud row", version: 4, description: "A row of studs along the top.", author: "Marius", "made-by": "claude-code", api: "1.1", target: "object" },
  [{ name: "studs", kind: "count", default: 3, min: 1, max: 12, label: "Studs" }, { name: "radius", kind: "number", default: 1, min: 0.5, max: 3, unit: "mm", label: "Stud radius" }, { name: "gap", kind: "number", default: 4, min: 2, max: 8, unit: "mm", label: "Gap" }],
  BODY_V4,
);
const NOTCH_BODY = BODY.replace('s.count("studs", 3).range(1, 10).label("Studs")', 's.count("notches", 2).range(1, 4).label("Notches")');
export const FILE_NOTCH = header(
  { plugin: "corner-notch", title: "Corner notch", version: 1, description: "Square notches cut along one edge, for a clip.", author: "unknown", api: "1.1", target: "object" },
  [{ name: "notches", kind: "count", default: 2, min: 1, max: 4, label: "Notches", help: "How many notches along the edge." }],
  NOTCH_BODY,
);
export const FILE_FLANGE = header(
  { plugin: "bolt-flange", title: "Bolt-circle flange", version: 2, description: "A round flange with bolt holes on a circle.", author: "Marius", api: "1.1", target: "new" },
  [{ name: "diameter", kind: "number", default: 80, min: 20, max: 250, unit: "mm", label: "Outer diameter" }],
  "use lime_recipe::{ops, Session};\nfn main() {\n    let mut s = Session::start();\n    let d = s.number(\"diameter\", 80.0).range(20.0, 250.0).unit(\"mm\").label(\"Outer diameter\").get();\n    let p = s.solid_new(ops::cylinder(d / 2.0, 6.0)).unwrap();\n    s.done(&p);\n}\n",
);

/** The library's files as the shell lists them: stud-row at v4 with v3 kept beside it, a notch plugin, a flange. */
export async function scriptedLibrary(page: Page) {
  const files: Record<string, string> = { "stud-row.rs": FILE_V4, "stud-row.v3.rs": FILE, "corner-notch.rs": FILE_NOTCH, "bolt-flange.rs": FILE_FLANGE };
  const presets = { "stud-row": JSON.stringify({ dense: { params: { studs: 6, radius: 0.8 }, created: "2026-11-02" } }) };
  await page.addInitScript(({ files, presets }) => {
    const store = { files: { ...files } as Record<string, string>, presets: { ...presets } as Record<string, string>, settings: null as string | null };
    const log: { command: string; args: Record<string, unknown> }[] = [];
    (window as unknown as { __libraryLog: typeof log; __libraryStore: typeof store }).__libraryLog = log;
    (window as unknown as { __libraryStore: typeof store }).__libraryStore = store;
    const version = (text: string) => Number(/^\/\/! version: (\d+)$/m.exec(text)?.[1] ?? 0);
    (window as unknown as { __limePluginLibrary: unknown }).__limePluginLibrary = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        log.push({ command, args });
        if (command === "plugin_library_list") {
          return { dir: "C:\\Users\\test\\AppData\\Roaming\\com.limeslice.slicer\\plugins", files: Object.entries(store.files).map(([name, text]) => ({ name, text })), presets: Object.entries(store.presets).map(([plugin, text]) => ({ plugin, text })), settings: store.settings };
        }
        if (command === "plugin_library_save") {
          const id = String(args.id);
          const text = String(args.text);
          const old = store.files[`${id}.rs`];
          if (old && version(old) !== version(text)) store.files[`${id}.v${version(old)}.rs`] = old;
          store.files[`${id}.rs`] = text;
          return `C:\\Users\\test\\AppData\\Roaming\\com.limeslice.slicer\\plugins\\${id}.rs`;
        }
        if (command === "plugin_library_write") {
          const name = String(args.name);
          if (name === "settings.json") store.settings = String(args.text);
          else store.presets[name.replace(/^presets\//, "").replace(/\.json$/, "")] = String(args.text);
          return null;
        }
        if (command === "plugin_library_remove") {
          const id = String(args.id);
          const names = Object.keys(store.files).filter((name) => name === `${id}.rs` || name.startsWith(`${id}.v`));
          for (const name of names) delete store.files[name];
          return names.length;
        }
        if (command === "plugin_library_reveal") return null;
        throw new Error(`no command ${command}`);
      },
    };
  }, { files, presets });
}

/**
 * The Tauri runner's commands and events, played in the page. `available` false plays the macOS app (no lust). A run
 * cuts `studs` (or `notches`) boxes; describe mode declares studs and reads its object.
 */
export async function scriptedRunner(page: Page, available = true) {
  await page.addInitScript((available) => {
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
    const cut = (n: number) => say({ id: n + 1, call: "model_apply", args: { object, op: { kind: "boolean", op: "cut", primitive: "box", dx: 2 * studs, dy: 20, dz: 20, origin: [0, 0, 0] }, probe: true }, at: { line: 10 } });
    (window as unknown as { __recipeLog: typeof log }).__recipeLog = log;
    (window as unknown as { __limeRecipeRunner: unknown }).__limeRecipeRunner = {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        log.push({ command, args });
        if (command === "recipe_available") return available ? { ok: true, lust: "scripted" } : { ok: false, reason: "Running plugins needs lust, which the macOS app does not ship yet." };
        if (command === "recipe_build") return { code: 0, stdout: "", stderr: "", exe: "/scripted/slot-0/recipe", main: "/scripted/slot-0/src/main.rs" };
        if (command === "recipe_start") {
          run = String(args.run);
          return null;
        }
        if (command === "recipe_send") {
          const msg = JSON.parse(String(args.line)) as { v?: number; ok?: boolean; error?: string; describe?: boolean; params?: { studs?: number; notches?: number }; context?: { object?: string } };
          if (msg.v === 1 && msg.describe) {
            say({ describe: { param: { name: "studs", kind: "count", default: 3, min: 1, max: 10, label: "Studs" }, line: 5 } });
            say({ describe: { object: true } });
            say({ describe: { end: true, line: 8 } });
            return null;
          }
          if (msg.v === 1) {
            object = String(msg.context?.object ?? "");
            studs = Number(msg.params?.studs ?? msg.params?.notches ?? msg.params?.holes ?? 3);
            made = 0;
            // With no part, the recipe makes its own first (a plugin that builds a new part).
            if (!object) {
              say({ id: 1, call: "solid_new", args: { primitive: "box", dx: 20, dy: 20, dz: 10, name: "bar" }, at: { line: 8 } });
              return null;
            }
            made = 1;
            cut(made);
            return null;
          }
          if (msg.ok === false) {
            emit("recipe-exit", { run, code: 101, reason: null, stderr: `thread 'main' (7) panicked at src/main.rs:10:5:\n${msg.error}\n` });
            return null;
          }
          if (!object) object = String((msg as { result?: { object?: string } }).result?.object ?? "");
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
  }, available);
}
