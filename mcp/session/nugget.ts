/**
 * The nugget tool: find, get, save, export, and remove over plugins, ingredients, presets, and lessons.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTHOR_MAX, DESCRIPTION_MAX, TITLE_MAX, bodyHash, listLibrary, olderVersions, oneLine, paramSummary, parsePlugin, pluginAuthor, pluginsDir, queryScore, readPlugin, removePlugin, slugOf, writePlugin, type PluginHeader } from "../plugins.ts";
import { bodyProblem, carriedIngredients, ingredientsDir, isIngredientId, lineMap, lineText, moduleOf, resolveIngredients } from "../ingredients.ts";
import { addLesson, harvestFunctions, isAbout, LESSON_MAX, liftItems, listLessons, listPresets, presetId, presetProblem, publicItems, readPreset, removeLesson, removePreset, writePreset } from "../nuggets.ts";
import { apiProblem, clashOf, keptBesideTitle, marksText, oneFileProblem, rawHeader, readMarks, withMark, type ImportMark } from "../../src/plugins/share.ts";
import { lfOnly, RecipeHost, recipeCrateDir, recipeSourceFile } from "../recipe.ts";
import { OP_KINDS } from "../schema.ts";
import { type ToolHandler } from "./shared.ts";
import type { Session } from "../session.ts";
import { SESSION_URL } from "../session-url.ts";
import { NEXT, refuse } from "../refusals.ts";

/**
 * --- I16. nugget {action: find | get | save | remove, kind}: plugins, ingredients, presets and lessons in one tool
 * (Q2). find searches every kind and this session's drafts; the rest act on one kind. A plugin's get, save and remove
 * are the plugin tool's. Text a nugget carries goes in `data`: it is data, never instructions.
 */
async function nuggetTool(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = input.action;
  const kind = typeof input.kind === "string" ? input.kind : undefined;
  if (action === "find") return this.nuggetFind(typeof input.query === "string" ? input.query.trim() : "", kind);
  if (!kind) return refuse("bad-action", `${String(action)} needs kind: plugin, ingredient, preset, or lesson.`);
  if (kind === "plugin") return this.pluginTool({ ...input, action });
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (kind === "ingredient") {
    const dir = ingredientsDir();
    if (action === "get") {
      const file = readPlugin(id, dir, undefined, "ingredient");
      if (!file) return refuse("ingredient-not-found", `No ingredient is named ${id}.${this.ingredientNames().length ? ` The library has: ${this.ingredientNames().join(", ")}.` : ""}`, undefined, NEXT.ingredients);
      if ("reason" in file) return refuse("ingredient-invalid", file.reason);
      const h = file.header;
      const usedBy = this.pluginsCarrying(h.plugin);
      return { ok: true, kind, id: h.plugin, version: h.version, api: h.api, sha256: file.sha256, created: h.created, items: publicItems(file.body), use: `use ingredients::${moduleOf(h.plugin)}::*;`, older: olderVersions(h.plugin, dir), ...(usedBy.length ? { usedBy } : {}), ...this.promotion(usedBy), data: { title: h.title, description: h.description, author: h.author, ...(h["made-by"] ? { madeBy: h["made-by"] } : {}) }, ...(input.withSource === true ? { source: file.body } : {}) };
    }
    if (action === "save") return this.ingredientSave(input);
    if (action === "remove") {
      const files = isIngredientId(id) ? removePlugin(id, dir) : 0;
      if (files === 0) return refuse("ingredient-not-found", `No ingredient is named ${id}.`, undefined, NEXT.ingredients);
      return { ok: true, kind, id, files, note: "Runs and plugins that used it keep their own copies." };
    }
  }
  if (kind === "preset") {
    const ref = presetId(id);
    if (!ref) return refuse("bad-name", "A preset's id is <plugin>/<name>, like honeycomb-tray/pp-5mm-wall: lower-case letters, digits and dashes.");
    if (action === "get") {
      const row = readPreset(ref.plugin, ref.name);
      return row ? { ok: true, kind, id, plugin: row.plugin, params: row.params, created: row.created, run: { plugin: row.plugin, preset: row.name } } : refuse("preset-not-found", `No preset ${id}.${this.presetNames(ref.plugin)}`);
    }
    if (action === "save") {
      const plugin = await this.pluginFile(ref.plugin);
      if ("reason" in plugin) return refuse("plugin-not-found", `A preset is for a plugin in the library: ${plugin.reason}`);
      const params = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : null;
      if (!params || Object.keys(params).length === 0) return refuse("missing-argument", "A preset needs params: the values it keeps.");
      const problem = presetProblem(ref.plugin, params, plugin.file.header.params);
      if (problem) return refuse("preset-invalid", `The preset was not kept: ${problem}`);
      writePreset({ plugin: ref.plugin, name: ref.name, params, created: new Date().toISOString().slice(0, 10) });
      return { ok: true, kind, id, params, run: { plugin: ref.plugin, preset: ref.name } };
    }
    if (action === "remove") return removePreset(ref.plugin, ref.name) ? { ok: true, kind, id } : refuse("preset-not-found", `No preset ${id}.`);
  }
  if (kind === "lesson") {
    if (action === "save") {
      const about = id;
      if (!isAbout(about)) return refuse("bad-name", "A lesson needs id: the op kind or helper it is about, like fillet or geom2d::offset.");
      const text = oneLine(input.text, LESSON_MAX);
      if (!text) return refuse("missing-argument", `A lesson needs text: one plain sentence, at most ${LESSON_MAX} characters.`);
      const lesson = addLesson(about, text, new Date().toISOString().slice(0, 10));
      return { ok: true, kind, id: `${lesson.about}/${lesson.n}`, ...(OP_KINDS.includes(lesson.about) ? { shown: `guide {kind:"${lesson.about}"} shows it under seenInPractice.` } : {}) };
    }
    const n = Number(/\/(\d+)$/.exec(id)?.[1]);
    if (!Number.isInteger(n)) return refuse("bad-name", "A lesson's id is <about>/<n>, as find lists it.");
    const row = listLessons().find((lesson) => lesson.n === n);
    if (action === "get") return row ? { ok: true, kind, id: `${row.about}/${row.n}`, about: row.about, created: row.created, data: { text: row.text } } : refuse("lesson-not-found", `No lesson ${id}.`);
    if (action === "remove") return removeLesson(n) ? { ok: true, kind, id } : refuse("lesson-not-found", `No lesson ${id}.`);
  }
  return refuse("bad-action", "action is find, get, save, or remove; kind is plugin, ingredient, preset, or lesson.");
}

function ingredientNames(this: Session): string[] {
  return listLibrary(ingredientsDir(), "ingredient").map((file) => file.header.plugin).slice(0, 20);
}

function presetNames(this: Session, plugin: string): string {
  const names = listPresets(plugin).map((row) => `${row.plugin}/${row.name}`);
  return names.length ? ` ${plugin} has: ${names.join(", ")}.` : "";
}

/** The library plugins that carry an ingredient inside them (I11), by id. */
function pluginsCarrying(this: Session, id: string): string[] {
  return listLibrary(pluginsDir()).filter((file) => carriedIngredients(file.body).some((row) => row.id === id)).map((file) => file.header.plugin);
}

/** --- I17. An ingredient several plugins carry is worth proposing for lime_recipe; the library keeps it as it is. */
function promotion(this: Session, usedBy: string[]): Record<string, unknown> {
  if (usedBy.length < 2) return {};
  return { promote: `${usedBy.length} plugins carry it: worth proposing for lime_recipe in a pull request (docs/plan-recipe-ingredients.md I17). This file and its versions stay, so recipes that import it keep building.` };
}

/** --- I16. One line per hit across every kind, best first, at most 20. With no query, the newest of each. */
function nuggetFind(this: Session, query: string, kind: string | undefined): Record<string, unknown> {
  const rows: { score: number; row: Record<string, unknown> }[] = [];
  const score = (hay: string) => (query ? queryScore({ plugin: hay, title: "", description: "" }, query) : 1);
  const want = (k: string) => kind === undefined || kind === k;
  if (want("plugin")) {
    const marks = this.importMarks();
    for (const file of listLibrary(pluginsDir())) {
      const h = file.header;
      const s = score(`${h.plugin} ${h.title} ${h.description}`);
      if (s) rows.push({ score: s + 0.5, row: { kind: "plugin", id: h.plugin, v: h.version, ...(h.kind === "animation" ? { pluginKind: "animation", run: "pose_animate" } : {}), target: h.target, params: paramSummary(h.params), ...(marks[h.plugin] ? { imported: true } : {}), data: { title: h.title, description: h.description } } });
    }
    const names = new Set([...this.rustRecipes.keys()].map((key) => key.split("@")[0]!).filter((n) => n !== "plugin_check"));
    for (const name of names) {
      const draft = this.latestDraft(name);
      const s = draft ? score(name) : 0;
      if (draft && s) rows.push({ score: s, row: { kind: "plugin", id: `draft:${name}`, ...(draft.row.plugin ? { from: draft.row.plugin.id } : {}), params: Object.entries(draft.row.params).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ") } });
    }
  }
  if (want("ingredient")) {
    const imported = this.ingredientMarks();
    for (const file of listLibrary(ingredientsDir(), "ingredient")) {
      const h = file.header;
      const items = publicItems(file.body, 12);
      const s = score(`${h.plugin} ${h.title} ${h.description} ${items.join(" ")}`);
      if (s) rows.push({ score: s + 0.5, row: { kind: "ingredient", id: h.plugin, v: h.version, use: `use ingredients::${moduleOf(h.plugin)}::*;`, items: items.join(", "), ...(imported[h.plugin] ? { imported: true } : {}), data: { title: h.title, description: h.description } } });
    }
  }
  if (want("preset")) {
    for (const p of listPresets()) {
      const s = score(`${p.plugin} ${p.name}`);
      if (s) rows.push({ score: s, row: { kind: "preset", id: `${p.plugin}/${p.name}`, params: Object.entries(p.params).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ") } });
    }
  }
  if (want("lesson")) {
    for (const l of listLessons().reverse()) {
      const s = score(`${l.about} ${l.text}`);
      if (s) rows.push({ score: s, row: { kind: "lesson", id: `${l.about}/${l.n}`, data: { text: l.text } } });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return { ok: true, nuggets: rows.slice(0, 20).map((r) => r.row), total: rows.length, ...(rows.length === 0 && query ? { note: "Nothing kept matches. Write the recipe; nugget {action:\"save\"} keeps what is worth keeping." } : {}) };
}

/** A refusal when `body` does not build alone under lust, as a recipe that imports it as `id` would build it; else null. */
async function ingredientBuilds(this: Session, id: string, body: string): Promise<Record<string, unknown> | null> {
  const problem = bodyProblem(body);
  if (problem) return refuse("ingredient-invalid", `The ingredient was not kept: ${problem}`);
  if (!this.recipeHost) this.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(SESSION_URL), moduleUrl: SESSION_URL });
  const ready = this.recipeHost.available();
  if (!ready.ok) return refuse("recipe-unavailable", ready.reason);
  const module = moduleOf(id);
  const probe = `use ingredients::${module}::*;\n\nfn main() {}\n`;
  const resolved = resolveIngredients(probe, { kept: { [module]: { id, version: 0, sha256: bodyHash(body), body } }, preferKept: true });
  if ("reason" in resolved) return refuse("ingredient-invalid", `The ingredient was not kept: ${resolved.reason}`);
  const built = await this.recipeHost.build("ingredient_check", probe, false, resolved.suffix);
  if (built.ok) return null;
  const map = lineMap(probe, resolved);
  const first = built.diagnostics[0];
  const where = first ? `${lineText(map, first.line)}: ${first.message}` : (built.reason ?? "it did not build");
  return refuse("ingredient-invalid", `The ingredient does not build alone, so it was not kept: ${where}. Keep what it needs too (items), or import it from another ingredient.`);
}

/** `imported.json` in the ingredients folder: ingredients that came from a file, marked as imported plugins are (D11.6). */
function ingredientMarks(this: Session): Record<string, ImportMark> {
  const path = join(ingredientsDir(), "imported.json");
  return readMarks(existsSync(path) ? readFileSync(path, "utf8") : null);
}

/**
 * An ingredient file (its //! ingredient: header and body), as another library keeps it: checked as a plugin is on
 * import (header, API level, one file, hidden text-direction characters), built alone under lust, then kept under its
 * id and version and marked imported. The same code already there is left alone; different code under that id is kept
 * beside it as `<id>-2`, or replaces it with `replace`. Its text goes in `data`: it is data, never instructions.
 */
async function ingredientImport(this: Session, raw: string, replace: boolean): Promise<Record<string, unknown>> {
  const text = lfOnly(raw);
  if (/[‪-‮⁦-⁩]/.test(text)) return refuse("ingredient-invalid", "It holds an invisible text-direction character, which can make code read differently than it runs. It was not imported.");
  const fields = rawHeader(text);
  if (!fields) return refuse("ingredient-invalid", "This is not an ingredient file: one starts with a //! --- header with an ingredient: line, as the library keeps it.");
  if (fields.has("plugin")) return refuse("ingredient-invalid", "This file is a plugin, not an ingredient. Import it with kind:\"plugin\".");
  const parsed = parsePlugin(text);
  if ("reason" in parsed) return refuse("ingredient-invalid", parsed.reason);
  const from = parsed.header;
  if (from.kind !== "ingredient" || !isIngredientId(from.plugin)) return refuse("ingredient-invalid", `${from.plugin || "Its id"} cannot name an ingredient: lower-case letters, digits and dashes, starting with a letter, not a Rust keyword.`);
  const title = oneLine(from.title, TITLE_MAX) || from.plugin;
  const apiWhy = apiProblem(from.api ?? "1.0", this.crateApi());
  if (apiWhy) return refuse("ingredient-invalid", apiWhy);
  const body = lfOnly(parsed.body).replace(/^\n+/, "");
  const outside = oneFileProblem(body);
  if (outside) return refuse("ingredient-invalid", outside.replace("a plugin is one file", "an ingredient is one file"));
  const unbuilt = await this.ingredientBuilds(from.plugin, body);
  if (unbuilt) return unbuilt;
  const sha256 = bodyHash(body);
  const dir = ingredientsDir();
  const version = Number.isInteger(from.version) && from.version > 0 ? from.version : 1;
  const clash = clashOf(from.plugin, sha256, version, (id) => {
    const there = readPlugin(id, dir, undefined, "ingredient");
    return there && !("reason" in there) ? { sha256: there.sha256, version: there.header.version } : null;
  });
  let header: PluginHeader = { ...from, kind: "ingredient", title, version, "source-sha256": sha256, target: "new", params: [] };
  let how: Record<string, unknown> = {};
  if (clash.kind === "same") {
    header = { ...header, version: clash.version };
    how = { same: true, note: "Your library already has this ingredient with this code." };
  } else if (clash.kind === "clash" && replace) {
    header = { ...header, version: Math.max(version, clash.version + 1) };
    how = { replaced: `v${clash.version}`, note: `It replaced ${from.plugin} v${clash.version}, which is kept beside it as an older version, so recipes that pin it keep building.` };
  } else if (clash.kind === "clash") {
    header = { ...header, plugin: clash.keepBoth, title: keptBesideTitle(title, clash.keepBoth) };
    how = { keptBeside: from.plugin, note: `Your library has another ${from.plugin} (v${clash.version}), so this one is kept beside it as ${clash.keepBoth}. To replace yours instead, import again with replace:true.` };
  }
  const id = header.plugin;
  try {
    if (clash.kind !== "same") writePlugin(header, body, dir);
    const marks = this.ingredientMarks();
    if (clash.kind !== "same" || marks[id]) writeFileSync(join(dir, "imported.json"), marksText(withMark(marks, id, { sha256, from: "file", at: new Date().toISOString().slice(0, 10) })));
  } catch (err) {
    return refuse("ingredient-write-failed", `The ingredient could not be written to ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    ok: true,
    kind: "ingredient",
    id,
    version: header.version,
    sha256,
    imported: true,
    items: publicItems(body),
    use: `use ingredients::${moduleOf(id)}::*;`,
    path: join(dir, `${id}.rs`),
    ...(from["source-sha256"] && from["source-sha256"] !== sha256 ? { edited: true } : {}),
    ...how,
    data: { title: header.title, description: header.description },
  };
}

/**
 * --- I12. Keeps an ingredient: the named items of a run (and what they use), or a whole body. It must build alone
 * under lust; one that does not is not kept, and the sentence says which line needs what.
 */
async function ingredientSave(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  // A kept ingredient file in the workspace (another library's, or one copied by hand) is imported as it is.
  if (typeof input.from === "string" && /\.rs$/i.test(input.from)) {
    const file = recipeSourceFile(input.from);
    if ("reason" in file) return refuse("ingredient-invalid", file.reason);
    return this.ingredientImport(file.text, input.replace === true);
  }
  const title = oneLine(input.title, TITLE_MAX);
  if (!title) return refuse("ingredient-invalid", "An ingredient needs a title: one line, at most 60 characters. Its id is the title's slug unless id is given.");
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : slugOf(title);
  if (!isIngredientId(id)) return refuse("ingredient-invalid", `${id} cannot name an ingredient: lower-case letters, digits and dashes, starting with a letter, not a Rust keyword.`);
  let body: string;
  let items: string[] | undefined;
  if (typeof input.from === "string") {
    const draft = this.latestDraft(input.from);
    if (!draft) return refuse("no-draft", `No run of ${input.from} is kept in this session: an apply that reached done is kept under its name.`);
    const preview = this.recipePreviewHashes.get(input.from);
    if (preview !== undefined && preview !== bodyHash(draft.row.source)) return refuse("stale-draft", `Nothing new to save: the last applied run of ${input.from} is older than its successful dry run. Apply the new recipe first, or give source explicitly.`);
    const wanted = Array.isArray(input.items) ? input.items.filter((item): item is string => typeof item === "string") : [];
    if (wanted.length === 0) return refuse("missing-argument", "Name the items to keep: items:[\"fn cells\", \"struct Cell\"]. What they use comes along.");
    const lifted = liftItems(draft.row.source, wanted);
    if ("reason" in lifted) return refuse("ingredient-invalid", lifted.reason);
    body = lifted.body;
    items = lifted.items;
  } else if (typeof input.source === "string") {
    body = lfOnly(input.source);
    const framed = body.startsWith("//! ---") ? parsePlugin(body) : null;
    if (framed && !("reason" in framed)) body = framed.body;
  } else return refuse("missing-argument", "Give from (a recipe name this session ran) with items, or source (the module's code).");
  const unbuilt = await this.ingredientBuilds(id, body);
  if (unbuilt) return unbuilt;
  const sha256 = bodyHash(body);
  const module = moduleOf(id);
  const dir = ingredientsDir();
  const existing = readPlugin(id, dir, undefined, "ingredient");
  const version = existing && !("reason" in existing) ? (existing.sha256 === sha256 ? existing.header.version : existing.header.version + 1) : 1;
  const header: PluginHeader = {
    plugin: id,
    kind: "ingredient",
    title,
    version,
    description: input.description === undefined && existing && !("reason" in existing) ? existing.header.description : oneLine(input.description, DESCRIPTION_MAX),
    author: pluginAuthor(),
    ...(this.clientName ? { "made-by": oneLine(this.clientName, AUTHOR_MAX) } : {}),
    api: this.crateApi().join("."),
    ...(this.lustBuild() ? { lust: this.lustBuild() } : {}),
    "source-sha256": sha256,
    created: new Date().toISOString().slice(0, 10),
    target: "new",
    params: [],
  };
  try {
    writePlugin(header, body, dir);
  } catch (err) {
    return refuse("ingredient-write-failed", `The ingredient could not be written to ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, kind: "ingredient", id, version, sha256, items: items ?? publicItems(body), use: `use ingredients::${module}::*;`, path: join(dir, `${id}.rs`) };
}

/**
 * --- I13. After an apply that reached done: at most three suggestions of what to keep, each with its ready-made
 * nugget call. Nothing is saved until that call is made (O1).
 */
function harvest(this: Session, name: string, source: string, refused: { id: number; tool: string; line: number; reason: string; ingredient?: string }[], refusedArgs: Map<number, Record<string, unknown>>, plugin: { id: string } | null, params: Record<string, unknown> | undefined, preset: string | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (name === "plugin_check" || name === "ingredient_check") return out;
  const fns = plugin ? [] : harvestFunctions(source);
  if (fns.length) {
    const list = fns.slice(0, 4);
    out.push({ offer: `${list.map((f) => `fn ${f.name} (${f.lines} lines)`).join(", ")} make${list.length === 1 ? "s" : ""} no session call: keep ${list.length === 1 ? "it" : "them"} as an ingredient for the next recipe.`, save: { action: "save", kind: "ingredient", from: name, items: list.map((f) => f.name), title: `${name.replace(/[_-]+/g, " ")} helpers` } });
  }
  const seen = new Set<string>();
  for (const row of refused) {
    const args = refusedArgs.get(row.id) ?? {};
    const opKind = (args.op as { kind?: unknown } | undefined)?.kind;
    const about = typeof opKind === "string" ? opKind : row.tool;
    if (seen.has(about) || out.length >= 2) continue;
    seen.add(about);
    out.push({ offer: `${about} was refused at ${row.ingredient ? `ingredient ${row.ingredient}, ` : ""}line ${row.line} and the recipe got past it: what worked is worth a lesson. The refusal: ${row.reason.slice(0, 160)}`, save: { action: "save", kind: "lesson", id: about, text: "<one sentence: what to do instead>" } });
  }
  if (plugin && !preset && params && Object.keys(params).length && out.length < 3) {
    out.push({ offer: `These values built: keep them as a preset of ${plugin.id}.`, save: { action: "save", kind: "preset", id: `${plugin.id}/<name>`, params } });
  }
  return out.slice(0, 3);
}

/** The methods this module adds to Session. */
export const nuggetMethods = {
  nuggetTool,
  ingredientNames,
  presetNames,
  pluginsCarrying,
  promotion,
  nuggetFind,
  ingredientSave,
  ingredientBuilds,
  ingredientMarks,
  ingredientImport,
  harvest,
};

export const nuggetHandlers: Record<string, ToolHandler> = {
  nugget: (s, input) => s.nuggetTool(input),
};
