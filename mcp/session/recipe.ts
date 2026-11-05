/**
 * recipe_run: lust builds a recipe, each call it makes goes through the session as a plan step does, and the run is one transaction.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { plainModelError } from "../../src/app/model-error.ts";
import type { Mat3 } from "../../src/mesh-place.ts";
import { formatMm } from "../../src/model-plane.ts";
import { editRequest } from "../../src/model-request.ts";
import { solidView } from "../../src/modeling/model-calls.ts";
import { dropped, pathTo, withNode, type ModelTree, type NodeId, type PluginStamp } from "../../src/model-tree.ts";
import { replayedTree, replayOps } from "../../src/recipe/rebuild.ts";
import { markedRun, runEndingAt, runsOnPath, sameFingerprint, sameValues, stampValue, type StampedRun } from "../../src/plugin-step.ts";
import { answerPick } from "../../src/recipe/picks.ts";
import { answerTextOutline } from "../../src/recipe/text-outline.ts";
import { fontById, isPenFont, isUserFont } from "../../src/modeling/text-fonts.ts";
import { apiRefusal, bodyHash, isSlug, olderVersions, parsePlugin, pluginsDir, readPlugin, type PluginFile, type PluginParam, type PluginTarget } from "../plugins.ts";
import { splitPluginData } from "../../src/recipe/plugin-data.ts";
import { lineMap, lineText, locate, resolveIngredients, type KeptIngredient } from "../ingredients.ts";
import { presetProblem, readPreset } from "../nuggets.ts";
import { DEFAULT_LIMITS, lfOnly, RecipeHost, recipeCrateDir, recipeDataFile, recipeDataMissing, recipeSourceFile, type RecipeCallSite, type RecipeData, type RecipeReply } from "../recipe.ts";
import { CHORD, type CallMeta, type PlateObject, type PluginRebuild, type RustRecipe, type ToolHandler, UNKNOWN_OBJECT } from "./shared.ts";
import type { Session } from "../session.ts";

/**
 * recipe_run: lust builds the recipe in a warm slot (applying its safe fixes), then runs it with each call it makes
 * going through runCall as a plan step does. The run is one transaction: a refusal the recipe does not handle, a
 * panic, a limit, a cancel, or dry mode takes back every object it made and every step it added; an apply that
 * reaches done commits what it touched, and each part it changed gets its steps as one undo step.
 */
async function recipeRun(this: Session, input: Record<string, unknown>, meta?: CallMeta): Promise<Record<string, unknown>> {
  if (!this.recipeHost) this.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(import.meta.url), moduleUrl: import.meta.url });
  const host = this.recipeHost;
  const ready = host.available();
  if (!ready.ok) return { ok: false, reason: ready.reason };
  const mode = input.mode === "check" || input.mode === "dry" ? input.mode : "apply";
  // --- I23. A partial run stops after this many applied ops; it is always taken back.
  const maxSteps = typeof input.maxSteps === "number" ? input.maxSteps : undefined;
  if (maxSteps !== undefined && mode !== "dry") return { ok: false, reason: "maxSteps is for mode:\"dry\": a run stopped part way is always taken back." };
  // --- R-A. The source from a .rs file in the workspace, so an edit and rerun sends only the path.
  if (typeof input.path === "string" && typeof input.source === "string") return { ok: false, reason: "Pass source or path, not both." };
  // --- Plugins (D14): a library plugin by id, built against this API level, under its id as the recipe name.
  let plugin: { id: string; version: number; sha256: string; title: string; target: PluginTarget; api: string; note?: string } | null = null;
  let pluginBody: string | null = null;
  let presetParams: Record<string, unknown> = {};
  if (typeof input.plugin === "string" && (typeof input.source === "string" || typeof input.path === "string")) return { ok: false, reason: "Pass plugin, source, or path: one of them." };
  // --- Plugin steps (D8). recipe_run {plugin, object} on a part whose history holds a stamped run of that plugin, or
  // {object} alone on a part a kept run changed, rebuilds that run with the code the stamp names (D9: the project's
  // copy, else the library's file of that hash, else the draft): from the step before it, the given values over the
  // stamped ones, the steps after it replayed, as one undo step. A run that made the part (stamped on the root) makes
  // it again as a new tree for the same object.
  const stepTarget = typeof input.object === "string" && typeof input.source !== "string" && typeof input.path !== "string" ? this.find(input.object) : undefined;
  let rebuild: PluginRebuild | null = null;
  const stepNotes: string[] = [];
  if (stepTarget?.tree && mode !== "check") {
    const wanted = typeof input.plugin === "string" ? input.plugin : undefined;
    const runs = runsOnPath(stepTarget.tree).filter((row) => row.stamp);
    const pick = wanted !== undefined
      ? [...runs].reverse().find((row) => row.stamp!.plugin === wanted)
      : stepTarget.rustRecipe ? runs.find((row) => row.before === null) : runs.at(-1);
    if (pick?.stamp) {
      const stamp = pick.stamp;
      if (input.preset !== undefined) return { ok: false, reason: "A preset starts a new run. To change this plugin step, pass params; its other values stay as stamped." };
      // A part a draft made reruns from its own entry even when the stamp's code is missing (#527's rerun).
      const looked = this.stampSource(stamp);
      if ("reason" in looked && (wanted !== undefined || pick.before !== null)) return { ok: false, reason: looked.reason };
      const found = "reason" in looked ? { body: "", notes: [] as string[], title: undefined, target: undefined, api: undefined, ingredients: undefined } : looked;
      stepNotes.push(...found.notes);
      const tree = stepTarget.tree;
      const shown = pathTo(tree, tree.current);
      rebuild = { obj: stepTarget, run: pick, stamp, from: tree.current, later: shown.slice(shown.indexOf(pick.last) + 1) };
      if (stamp.version > 0) {
        plugin = { id: stamp.plugin, version: stamp.version, sha256: stamp.sha256, title: found.title ?? stamp.plugin, target: found.target ?? "either", api: found.api ?? stamp.api };
        pluginBody = found.body;
      } else if (pick.before !== null) pluginBody = found.body;
      if (found.ingredients) rebuild.ingredients = found.ingredients;
      const printer = this.printer();
      const bed: [number, number, number] = [printer.bedX, printer.bedY, printer.bedZ];
      if (stamp.context.nozzleMm !== this.library.nozzleMm) stepNotes.push(`Built for a ${formatMm(stamp.context.nozzleMm)} mm nozzle; this rebuild uses ${formatMm(this.library.nozzleMm)} mm.`);
      if (stamp.context.bedMm.some((v, i) => v !== bed[i])) stepNotes.push(`Built for a ${stamp.context.bedMm.map(formatMm).join(" × ")} mm bed; this rebuild uses ${bed.map(formatMm).join(" × ")} mm.`);
      if (pick.before !== null && rebuild.later.some((id) => tree.nodes.get(id)?.op?.kind === "partition")) {
        return { ok: false, reason: "A split to print follows this plugin step, and a rebuild cannot cut its pieces again. Undo to before the split, rebuild, then split again." };
      }
    }
  }
  if (typeof input.plugin === "string" && !rebuild) {
    if (input.plugin.startsWith("draft:")) return { ok: false, reason: `A draft runs again from its object (recipe_run {object, params}), or keep it first: nugget {action:"save", kind:"plugin", from:"${input.plugin.slice(6)}", title, description}.` };
    const got = await this.pluginFile(input.plugin);
    if ("reason" in got) return { ok: false, reason: got.reason };
    const h = got.file.header;
    const tooNew = apiRefusal(h.api, this.crateApi());
    if (tooNew) return { ok: false, reason: tooNew };
    if (h.target === "object" && typeof input.object !== "string") return { ok: false, reason: `${h.title} needs a part: pass object, the part to run it on.` };
    plugin = { id: h.plugin, version: h.version, sha256: got.file.sha256, title: h.title, target: h.target, api: h.api, ...(got.note ? { note: got.note } : {}) };
    pluginBody = got.file.body;
    // --- I14. A preset's values under the given params, checked against the plugin's ranges again at use.
    if (typeof input.preset === "string") {
      const name = input.preset.includes("/") ? input.preset.split("/")[1]! : input.preset;
      const row = readPreset(h.plugin, name);
      if (!row) return { ok: false, reason: `No preset ${h.plugin}/${name}.${this.presetNames(h.plugin)}` };
      const problem = presetProblem(h.plugin, row.params, h.params);
      if (problem) return { ok: false, reason: `The preset ${h.plugin}/${name} no longer fits this version of the plugin: ${problem}` };
      presetParams = row.params;
    }
  } else if (input.preset !== undefined && !rebuild) return { ok: false, reason: "A preset runs with its plugin: recipe_run {plugin, preset}." };
  if (input.keep !== undefined && mode !== "apply") return { ok: false, reason: "keep keeps an apply that reached done; a check or dry run is never kept." };
  if (input.keep !== undefined && rebuild) return { ok: false, reason: "keep keeps a new run; a rebuild of a plugin step runs the code the step already names." };
  const file = typeof input.path === "string" ? recipeSourceFile(input.path) : null;
  if (file && "reason" in file) return { ok: false, reason: file.reason };
  const framed = pluginBody ?? (file ? file.text : typeof input.source === "string" ? input.source : null);
  // --- Plugin data. A kept plugin's body carries the recipe data its run read after its code: the host builds the
  // code, and the data answers `data {name}` after the step's own kept data and before the workspace's files.
  const split = framed === null ? null : splitPluginData(framed);
  if (split?.problem) return { ok: false, reason: split.problem };
  const typed = split ? split.code : null;
  const carried: Record<string, RecipeData> = split?.data ?? {};
  // --- A rerun: no source, and an object a recipe_run made. Its stored source runs again with the stored
  // parameters under the new ones.
  let rerun: { name: string; stored: RustRecipe } | null = null;
  if (typed === null) {
    const key = typeof input.object === "string" ? this.find(input.object)?.rustRecipe : undefined;
    const stored = key ? this.rustRecipes.get(key) : undefined;
    if (!key || !stored) return { ok: false, reason: "Pass source or path, or the object of an earlier recipe_run to run its recipe again." };
    rerun = { name: key, stored };
  }
  const given = plugin ? plugin.id : rebuild ? rebuild.stamp.plugin : typeof input.name === "string" ? input.name : file ? file.stem : "recipe";
  const name = rerun ? rerun.name : given.replace(/[^A-Za-z0-9_-]/g, "_");
  // --- I22. New source for an object an earlier run of this name made: the run makes the part again and replaces
  // that run's objects, as a rerun does. Any other object is a part for the recipe to work on.
  const branchRebuild = rebuild !== null && rebuild.run.before !== null;
  const madeBy = typeof input.object === "string" && !rerun && !branchRebuild ? this.find(input.object)?.rustRecipe : undefined;
  // An earlier part kept under `<name>@<object>` (a run of the same name without object) is that name's too.
  const sameName = madeBy !== undefined && (madeBy === name || madeBy.startsWith(`${name}@`)) && this.rustRecipes.has(madeBy);
  // A rebuild of the run that made the part replaces that part, whatever name the plugin now has.
  const madeKey = rebuild && !branchRebuild ? rebuild.obj.rustRecipe : undefined;
  const rootRebuild = madeKey !== undefined && this.rustRecipes.has(madeKey) ? { name: madeKey, stored: this.rustRecipes.get(madeKey)! } : null;
  const replacing = rerun ?? rootRebuild ?? (sameName ? { name: madeBy!, stored: this.rustRecipes.get(madeBy!)! } : null);
  /** The entry the run is kept under: the one it replaces, else its name. */
  const key = replacing?.name ?? name;
  const source = rerun ? rerun.stored.source : lfOnly(typed!);
  const params = { ...(replacing?.stored.params ?? {}), ...(rebuild?.stamp.params ?? {}), ...presetParams, ...(input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {}) };
  // --- I10. The ingredients the source imports, from the library (a rerun: the copies its last apply built), built
  // after the recipe as inline modules, the same text under lust and rustc.
  const resolved = resolveIngredients(source, { kept: replacing?.stored.ingredients ?? rebuild?.ingredients, preferKept: !!rerun || !!rebuild });
  if ("reason" in resolved) return { ok: false, reason: resolved.reason };
  const usedIngredients = Object.values(resolved.used);
  this.noteStage(`building recipe ${name}`, 0);
  const built = await host.build(name, source, input.autofix !== false, resolved.suffix);
  const map = lineMap(built.source, resolved);
  const fixed = built.source !== source ? { fixedSource: built.source, fixRounds: built.fixRounds } : {};
  const diagnostics = built.diagnostics.map((d) => ({ code: d.code, ...locate(map, d.line), col: d.col, message: d.message, ...(d.fix ? { fix: d.fix } : {}), ...(d.inCrate ? { inCrate: true } : {}) }));
  if (!built.ok || !built.exe) {
    return { ok: false, reason: built.reason ?? "The recipe did not build. Fix the diagnostics and call recipe_run again.", diagnostics, ...fixed, buildMs: built.ms };
  }
  if (mode === "check") return { ok: true, built: true, ...(diagnostics.length ? { diagnostics } : {}), ...fixed, buildMs: built.ms };

  // A rerun's or replace's object names the recipe, not a part for it to change.
  const objectArg = typeof input.object === "string" && !replacing ? input.object : undefined;
  if (objectArg !== undefined && !this.find(objectArg)) return { ok: false, reason: UNKNOWN_OBJECT };
  // --- API 1.2. A face index names a face of the part as shown now, as faces_find lists it; a rebuild starts from an
  // earlier step whose faces are numbered otherwise, so the pick reads the index on this solid.
  const shownSolid = objectArg !== undefined ? this.find(objectArg)?.solid ?? null : null;
  // --- Plugin steps (D8). A rebuild runs on the part as it stood before the run: a new branch from there.
  if (rebuild && branchRebuild) {
    const back = await this.gotoNode(rebuild.obj, rebuild.run.before!);
    if (back.ok === false) return { ok: false, reason: `The step before the plugin's run could not be shown: ${String(back.reason ?? "the engine refused it.")}` };
  }
  const created: string[] = [];
  /** Print and assembly poses are independent; a replace preserves each unless the run set it. */
  const placed = new Set<string>();
  const modelPlaced = new Set<string>();
  /** Parts that were on the plate before the run, with the step each stood at. */
  const touched = new Map<string, number | null>();
  const notes: string[] = [];
  /** --- R-A. Recipe data the run read, by name: kept with the recipe so a rerun builds the same elsewhere. */
  const dataUsed = new Map<string, RecipeData>();
  /**
   * New source run under a library plugin's id (an edit of that plugin, to keep as its next version): the data the
   * library's file carries, when the workspace lacks the file. Read once, on the first miss.
   */
  let libraryCarried: Record<string, RecipeData> | null = null;
  const libraryData = (wanted: string): RecipeData | undefined => {
    if (plugin || rebuild || rerun || !isSlug(given)) return undefined;
    if (libraryCarried === null) {
      const found = readPlugin(given, pluginsDir());
      libraryCarried = found && !("reason" in found) ? splitPluginData(found.body).data : {};
    }
    return libraryCarried[wanted];
  };
  /** The arguments of each refused call, by call id: what a harvested lesson is about (I13). */
  const refusedArgs = new Map<number, Record<string, unknown>>();
  let applied = 0;
  /** The first step id each touched part's tree would give the run: what a rollback drops. */
  const firstNew = new Map<string, number>();
  const touch = (id: string) => {
    if (id === "" || created.includes(id) || touched.has(id)) return;
    const obj = this.find(id);
    if (obj) touched.set(id, obj.tree?.current ?? null);
    if (obj?.tree) firstNew.set(id, obj.tree.nextId);
  };
  if (objectArg) touch(objectArg);
  const ctx: CallMeta = { progressToken: meta?.progressToken, signal: meta?.signal };
  /** --- API 1.2. What each given face or outline resolved to, kept in the step's stamp in its place. */
  const picked: Record<string, unknown> = {};
  const call = async (site: RecipeCallSite): Promise<RecipeReply> => {
    if (site.tool === "pick") {
      const on = typeof site.args.object === "string" ? site.args.object : undefined;
      if (site.args.kind === "face" && on !== undefined && on !== objectArg && !created.includes(on)) {
        return { ok: false, error: `A recipe can change only the part it was given and the parts it made; ${on} is neither. Pass it as object to run on it.` };
      }
      return answerPick(site.args, params, { ...this.pickReads(ctx), shownFaces: (id) => (id === objectArg ? shownSolid : null) }, picked);
    }
    // --- API 1.3. The letters of a text as a flat outline, laid out by the engine. A font of the project is named as the texts name it.
    if (site.tool === "text_outline") {
      const args = { ...site.args };
      if (typeof args.font === "string" && !isPenFont(args.font) && !fontById(args.font) && !isUserFont(args.font)) {
        const found = this.fonts.find(args.font);
        if (!found) return { ok: false, error: `There is no font called ‘${args.font}’. The fonts are stroke, line, sans, mono, serif, stencil, and the project's own: ${this.fonts.list().map((font) => font.name).join(", ") || "none yet (fontFile adds one)"}.` };
        args.font = found.id;
      }
      return answerTextOutline(args, async (request) => JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify(request)))) as Record<string, unknown>);
    }
    if (site.tool === "log") {
      if (notes.length < 200) notes.push(`line ${site.line}: ${String(site.args.message ?? site.args.text ?? "").slice(0, 400)}`);
      return { ok: true, result: { ok: true } };
    }
    if (site.tool === "data") {
      const wanted = typeof site.args.name === "string" ? site.args.name : "";
      const held = dataUsed.get(wanted);
      if (held) return { ok: true, result: held.value };
      // A rerun or a rebuild reads what its last apply kept; a kept plugin, the data it carries; a run with source
      // reads the workspace's file, so an edited file counts, and falls back on what the run it replaces kept.
      const kept = replacing?.stored.data?.[wanted];
      const stepKept = rerun || rebuild ? kept : undefined;
      const inWorkspace = stepKept || carried[wanted] ? null : recipeDataFile(wanted);
      const refused = inWorkspace && "reason" in inWorkspace ? inWorkspace.reason : null;
      const found: RecipeData | undefined = stepKept ?? carried[wanted] ?? (inWorkspace && !refused ? (inWorkspace as RecipeData) : kept ?? libraryData(wanted));
      if (!found) return { ok: false, error: refused ?? recipeDataMissing(wanted) };
      dataUsed.set(wanted, found);
      return { ok: true, result: found.value };
    }
    // Placing changes no history step, so a run could not take it back on a part it did not make.
    if (site.tool === "model_place" || site.tool === "object_place") {
      const target = typeof site.args.object === "string" ? site.args.object : this.selected;
      const align = site.args.align as { to?: unknown } | undefined;
      const others = [site.args.to, align?.to].filter((v): v is string => typeof v === "string" && v !== "bed");
      if (!created.includes(target) || others.some((id) => !created.includes(id))) {
        return { ok: false, error: `${site.tool} in a recipe places only the objects this run made (solid_new), relative to each other or the bed.` };
      }
    }
    // --- O8 (D11.1). A recipe touches only the part it was given and the parts it made, so a plugin from someone
    // else cannot reach the user's other parts.
    if (site.tool !== "solid_new") {
      const target = typeof site.args.object === "string" ? site.args.object : this.selected;
      if (target && target !== objectArg && !created.includes(target)) {
        return { ok: false, error: `A recipe can change only the part it was given and the parts it made; ${target} is neither. Pass it as object to run on it.` };
      }
    }
    if (site.tool !== "solid_new") touch(typeof site.args.object === "string" ? site.args.object : this.selected);
    // --- I21. How far along: the call count of the last run of this name stands in for the total.
    const about = this.recipeCallCounts.get(name);
    this.noteStage(`recipe ${name}: call ${site.id}${about !== undefined ? ` of about ${Math.max(about, site.id)}` : ""}, ${lineText(map, site.line)} (${site.tool})`);
    let value: Record<string, unknown>;
    try {
      value = await this.runCall(site.tool, site.args, ctx, true);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (site.tool === "solid_new" && typeof value.object === "string" && value.ok !== false) created.push(value.object);
    if (value.ok === false) {
      const { ok: _ok, reason, ...extra } = value;
      if (refusedArgs.size < 50) refusedArgs.set(site.id, site.args);
      // A composite op (a text, a pocket) that fails answers with the failed step's sentence, not a reason of its own.
      const failedStep = (extra as { failed?: { reason?: unknown } }).failed?.reason;
      return { ok: false, error: typeof reason === "string" ? reason : typeof failedStep === "string" ? failedStep : `${site.tool} was refused.`, extra };
    }
    const target = typeof site.args.object === "string" ? site.args.object : this.selected;
    if (site.tool === "object_place") placed.add(target);
    if (site.tool === "model_place") modelPlaced.add(target);
    if (site.tool === "model_apply") applied += 1;
    if (site.tool === "model_apply_batch") applied += Array.isArray(site.args.ops) ? site.args.ops.length : 1;
    if (maxSteps !== undefined && applied >= maxSteps) return { ok: true, result: value, halt: `The run stopped after ${applied} applied op${applied === 1 ? "" : "s"} (maxSteps ${maxSteps}), at line ${site.line}.` };
    return { ok: true, result: value };
  };
  const printer = this.printer();
  const start = {
    params,
    context: { units: "mm", ...(objectArg ? { object: objectArg } : {}), bedMm: [printer.bedX, printer.bedY, printer.bedZ], nozzleMm: this.library.nozzleMm },
  };
  const limits = { ...DEFAULT_LIMITS, ...(typeof input.timeoutS === "number" ? { timeoutS: input.timeoutS } : {}) };
  /** Takes the run back; a rebuild also shows the old branch again, where the part stood before it. */
  const rollback = async () => {
    const undone = await this.recipeRollback(created, touched, firstNew);
    if (rebuild && branchRebuild && rebuild.obj.tree?.current !== rebuild.from) await this.gotoNode(rebuild.obj, rebuild.from).catch(() => ({ ok: false }));
    return undone;
  };
  this.recipeDepth += 1;
  let out;
  try {
    out = await host.run(built.exe, start, call, limits, meta?.signal);
  } finally {
    this.recipeDepth -= 1;
  }
  if (out.calls > 0) this.recipeCallCounts.set(name, out.calls);
  for (const note of out.notes ?? []) if (notes.length < 200) notes.push(note);
  if (plugin?.note) notes.unshift(plugin.note);
  // A line in an ingredient is reported as that ingredient's line, not the built file's.
  if (map && out.line !== undefined && out.line > map.recipeLines) {
    if (out.reason) out.reason = out.reason.replace(`at line ${out.line}`, `at ${lineText(map, out.line)}`);
    out.line = locate(map, out.line).line;
  }
  const refused = out.refused.map((row) => ({ ...row, ...locate(map, row.line) }));
  const report = { calls: out.calls, ...(refused.length ? { refused } : {}), ...(usedIngredients.length ? { ingredients: usedIngredients.map((row) => `${row.id} v${row.version}`) } : {}), ...(notes.length ? { notes } : {}), ...(out.lateParams?.length ? { lateParams: out.lateParams } : {}), ...(diagnostics.length ? { diagnostics } : {}), ...fixed, buildMs: built.ms, runMs: out.ms, ...(plugin ? { plugin: { id: plugin.id, version: plugin.version } } : {}) };
  // --- I23. What the parts measured when a partial run stopped, before it is taken back.
  if (out.halted) {
    const sofar = Object.fromEntries([...created, ...touched.keys()].flatMap((id) => {
      const solid = this.find(id)?.solid;
      if (!solid) return [];
      const size = solid.bounds.max.map((value, axis) => Math.round((value - solid.bounds.min[axis]!) * 100) / 100);
      return [[id, { volumeMm3: Math.round(solid.volumeMm3 * 100) / 100, sizeMm: size }]];
    }));
    const undone = await rollback();
    return { ok: true, dry: true, partial: true, stopped: out.halted.reason, line: out.halted.line, applied, metrics: sofar, ...report, rolledBack: undone };
  }
  if (!out.ok || mode === "dry") {
    const undone = await rollback();
    if (!out.ok) return { ok: false, reason: out.reason ?? "The recipe failed.", ...(out.line !== undefined ? { line: out.line } : {}), ...report, rolledBack: undone };
    return { ok: true, dry: true, object: out.done!.object, metrics: out.done!.metrics, ...report, rolledBack: undone };
  }
  // --- Plugin steps (D8). A run that made or changed one part is stamped on it: its first node names what ran and with
  // what, every node carries the run's id, and that run is one undo step, in the project too. A run over several
  // parts keeps plain steps, each part's as one undo step for this session (O4). A part the run made and then joined
  // into another (a tool, keepTool false) left the plate: it is no part of its own, so the run still stamps.
  const label = `recipe ${name}`;
  const parts = [...created.filter((id) => this.find(id)), ...[...touched].filter(([id, before]) => (this.find(id)?.tree?.current ?? null) !== before).map(([id]) => id)];
  const api = this.crateApi();
  const stampFields: Omit<PluginStamp, "fingerprint"> = {
    plugin: plugin?.id ?? name.split("@")[0]!,
    version: plugin?.version ?? 0,
    sha256: plugin?.sha256 ?? bodyHash(built.source),
    api: plugin?.api ?? `${api[0]}.${api[1]}`,
    params: Object.fromEntries(Object.entries({ ...params, ...picked }).filter(([, v]) => stampValue(v))) as PluginStamp["params"],
    context: { bedMm: [printer.bedX, printer.bedY, printer.bedZ], nozzleMm: this.library.nozzleMm },
  };
  const only = parts.length === 1 && name !== "plugin_check" ? this.find(parts[0]!) : undefined;
  const stamped = only ? this.stampRun(only, touched.get(only.id) ?? null, created.includes(only.id), stampFields) : null;
  if (parts.length > 1) notes.push(`${plugin?.title ?? name} made or changed ${parts.length} parts in one run, so its steps stay plain steps; run it again to change them.`);
  // --- A rebuild: the steps that followed the old run, built again on the new one. With the same values the solid
  // should be the stamp's; the reply says when it is not.
  let rebuilt: { replayed: number; broken?: string; sameSolid?: boolean } | undefined;
  if (rebuild && stamped && only) {
    const oldTree = rebuild.obj.tree!;
    const renamed = new Map(rebuild.run.ids.length === stamped.ids.length ? rebuild.run.ids.map((id, i) => [id, stamped.ids[i]!] as const) : []);
    const sameSolid = sameValues(rebuild.stamp.params, stampFields.params) ? sameFingerprint(stamped.stamp?.fingerprint ?? null, rebuild.stamp.fingerprint) : undefined;
    if (sameSolid === false) notes.push("This plugin built a different solid from the same values; the plugin or the app changed since.");
    const replay = await this.replaySteps(only, oldTree, rebuild.later, renamed);
    if ("reason" in replay) {
      const undone = await rollback();
      return { ok: false, reason: `The plugin ran, but the steps after it could not be built again: ${replay.reason} The rebuild was taken back.`, ...report, rolledBack: undone };
    }
    rebuilt = { replayed: replay.replayed, ...(replay.broken ? { broken: replay.broken } : {}), ...(sameSolid !== undefined ? { sameSolid } : {}) };
  }
  if (stepNotes.length) notes.unshift(...stepNotes);
  // --- The apply: each changed part is committed to the plate. A commit the plate refuses (a mesh that does not close,
  // say) takes the whole run back, the parts committed before it too: those are committed again at the step they went
  // back to.
  const commitOne = (id: string) => this.runCall("model_commit", { object: id }, ctx, true).catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
  const committedTouched: string[] = [];
  for (const id of [...created, ...touched.keys()]) {
    const obj = this.find(id);
    if (!obj) continue;
    const before = touched.get(id);
    if (before !== undefined && (obj.tree?.current ?? null) === before) continue;
    // A replayed step that no longer builds leaves the part on the last step that did, uncommitted, as an edit does.
    if (rebuilt?.broken && obj === only) continue;
    const committed = await commitOne(id);
    if (committed.ok === false) {
      const undone = await rollback();
      for (const back of committedTouched) await commitOne(back);
      const why = String(committed.reason ?? "The commit was refused.");
      return { ok: false, reason: `The recipe ran, but ${id} could not be committed to the plate: ${why} The run was taken back.`, object: id, metrics: out.done!.metrics, ...report, rolledBack: undone };
    }
    if (before !== undefined) committedTouched.push(id);
  }
  for (const [id, before] of touched) {
    const obj = this.find(id);
    const end = obj?.tree?.current ?? null;
    if (!obj || before === null || end === null || end === before) continue;
    // A rebuild is one undo step back to the old branch as it was shown; a stamped run is one by its run id.
    if (rebuild && branchRebuild && obj === rebuild.obj) obj.groups = [...(obj.groups ?? []), { start: rebuild.from, end, label }];
    else if (!stamped || obj !== only) obj.groups = [...(obj.groups ?? []), { start: before, end, label }];
  }
  // --- I22. A rerun or a replace hands each old object's handle, place, and name to the new object in its turn, so
  // the part keeps its handle with a new history; old objects with no new one leave the plate.
  let object = out.done!.object;
  const replaced: string[] = [];
  const removed: string[] = [];
  if (replacing) {
    const old = replacing.stored.objects.filter((id) => !created.includes(id) && this.find(id));
    for (const [i, oldId] of old.entries()) {
      const newId = created[i];
      if (newId === undefined) {
        if ((await this.objectRemove(oldId).catch(() => ({ ok: false }))).ok !== false) removed.push(oldId);
        continue;
      }
      await this.takeOver(oldId, newId, !placed.has(newId), !modelPlaced.has(newId), rebuild?.run.before === null && rebuild.obj.id === oldId);
      created[i] = oldId;
      if (object === newId) object = oldId;
      replaced.push(oldId);
    }
  }
  const fresh = created.filter((id) => !replaced.includes(id));
  // --- Kept with the project when the run made objects: the source as it built, these parameters, its data, and
  // what it made. A run of the same name without object leaves an earlier run's parts as they were, under their own
  // entry, and says how to replace them.
  let earlier: string | undefined;
  if (created.length && !replacing) {
    const prior = this.rustRecipes.get(name);
    const left = prior?.objects.filter((id) => this.find(id)?.rustRecipe === name) ?? [];
    if (prior && left.length) {
      const key = `${name}@${left[0]}`;
      this.rustRecipes.set(key, { ...prior, objects: left });
      for (const id of left) this.find(id)!.rustRecipe = key;
      earlier = `${left.join(", ")} from an earlier run of ${name} ${left.length === 1 ? "is" : "are"} still on the plate. To replace ${left.length === 1 ? "it" : "them"} instead, pass object:"${left[0]}" with the source.`;
    }
  }
  const data = dataUsed.size ? Object.fromEntries(dataUsed) : undefined;
  // --- D1. Every apply that reached done is a draft: kept under its name with its source's hash and order, and the
  // parts it changed. One that made parts is the entry those parts name; one that only changed parts is kept beside
  // an entry whose parts are still on the plate, as `<name>@<part>`.
  const sha256 = bodyHash(built.source);
  const changed = [...touched].filter(([id, before]) => (this.find(id)?.tree?.current ?? null) !== before).map(([id]) => id);
  const entry: RustRecipe = { source: built.source, params, objects: [...created], ...(data ? { data } : {}), ...(file ? { path: file.path } : {}), sha256, at: (this.recipeSeq += 1), ...(changed.length ? { changed } : {}), ...(plugin ? { plugin: { id: plugin.id, version: plugin.version, sha256: plugin.sha256 } } : {}), ...(usedIngredients.length ? { ingredients: resolved.used } : {}) };
  let entryKey: string | null = null;
  if (created.length) entryKey = key;
  else if (changed.length) {
    const live = this.rustRecipes.get(key)?.objects.some((id) => this.find(id)?.rustRecipe === key);
    entryKey = live ? `${key}@${changed[0]}` : key;
  }
  if (entryKey && name !== "plugin_check") this.rustRecipes.set(entryKey, entry);
  // Only what the run made names it: a rerun replaces those. A part it changed keeps the steps as one undo step.
  for (const id of created) {
    const obj = this.find(id);
    if (obj) obj.rustRecipe = key;
  }
  const nuggets = rerun || rebuild ? [] : this.harvest(key, built.source, refused, refusedArgs, plugin, input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : undefined, typeof input.preset === "string" ? input.preset : undefined);
  return {
    ok: true,
    object,
    metrics: out.done!.metrics,
    ...(fresh.length ? { created: fresh } : {}),
    ...(replaced.length ? { replaced } : {}),
    ...(removed.length ? { removed } : {}),
    ...(data ? { data: Object.fromEntries([...dataUsed].map(([key, row]) => [key, { sha256: row.sha256, bytes: row.bytes }])) } : {}),
    ...(earlier ? { earlier } : {}),
    recipe: key,
    ...(stamped ? { step: { run: stamped.id, steps: stamped.ids.length } } : {}),
    ...(rebuilt ? { rebuilt } : {}),
    ...report,
    ...(nuggets.length && input.keep === undefined ? { nuggets } : {}),
    ...(await this.keepRun(input.keep, entryKey, built.source, name, objectArg, resolved.used, objectArg !== undefined ? touched.get(objectArg) ?? null : null, data)),
  };
}

/** --- D1. recipe_run {keep}: the apply that just reached done, saved as a plugin. A failed check is a sentence. */
async function keepRun(this: Session, keep: unknown, entryKey: string | null, source: string, name: string, objectArg: string | undefined, ingredients: Record<string, KeptIngredient>, objectFrom: number | null, data?: Record<string, RecipeData>): Promise<Record<string, unknown>> {
  if (keep === undefined) return {};
  const k = (keep && typeof keep === "object" ? keep : {}) as { title?: unknown; description?: unknown };
  const saved = await this.pluginSave({ source, title: k.title, description: k.description, name, objectHint: objectArg, objectFrom, ingredients, ...(data ? { data } : {}) });
  if ("reason" in saved) return { keepRefused: saved.reason };
  const row = entryKey ? this.rustRecipes.get(entryKey) : undefined;
  if (row) row.plugin = { id: saved.id, version: saved.version, sha256: saved.sha256 };
  if (row) this.promoteStamps(row, name, saved);
  return { kept: saved };
}

/**
 * --- Plugin steps (D8). A draft kept as a plugin: the steps it stamped on the parts it made or changed now name the
 * plugin, so a rebuild finds it. Another draft with the same code keeps its own name.
 */
function promoteStamps(this: Session, row: RustRecipe, name: string, saved: { id: string; version: number; sha256: string }): void {
  const recipe = name.split("@")[0]!;
  for (const id of new Set([...row.objects, ...(row.changed ?? [])])) {
    const obj = this.find(id);
    const tree = obj?.tree;
    if (!obj || !tree) continue;
    for (const node of tree.nodes.values()) {
      if (node.plugin?.version !== 0 || node.plugin.sha256 !== row.sha256 || node.plugin.plugin !== recipe) continue;
      obj.tree = withNode(obj.tree!, node.id, { plugin: { ...node.plugin, plugin: saved.id, version: saved.version, sha256: saved.sha256 } });
    }
  }
}

/** --- Plugins (docs/plan-recipe-plugins.md D12). This host's crate API, read from the crate the recipes build against. */
function crateApi(this: Session): [number, number] {
  if (this.recipeApi) return this.recipeApi;
  let found: [number, number] = [1, 1];
  try {
    const lib = readFileSync(join(recipeCrateDir(import.meta.url), "src", "lib.rs"), "utf8");
    const m = /pub const API: \(u32, u32\) = \((\d+), (\d+)\);/.exec(lib);
    if (m) found = [Number(m[1]), Number(m[2])];
  } catch {
    // The crate's absence is recipe_run's sentence; the level stays the one this server shipped with.
  }
  this.recipeApi = found;
  return found;
}

/**
 * --- D4. Describe mode: the recipe built and run with `describe: true`. Each typed parameter is declared and gets its
 * default; the run ends at its first call, so nothing reaches the engine. A recipe that read its object and then
 * stopped (an unwrap of None) needs a part.
 */
async function recipeDescribe(this: Session, body: string, limitMs?: number): Promise<{ params: PluginParam[]; target: PluginTarget } | { reason: string }> {
  if (!this.recipeHost) this.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(import.meta.url), moduleUrl: import.meta.url });
  const host = this.recipeHost;
  const ready = host.available();
  if (!ready.ok) return { reason: ready.reason };
  // The code alone: the data a plugin carries is never built.
  const code = splitPluginData(body).code;
  const resolved = resolveIngredients(code);
  if ("reason" in resolved) return resolved;
  const began = Date.now();
  const built = await host.build("plugin_check", code, true, resolved.suffix, limitMs);
  if (limitMs !== undefined && !built.ok && Date.now() - began >= limitMs) return { reason: `It took over ${limitMs / 1000} s to build, so the build was stopped: an imported plugin builds within ${limitMs / 1000} s.` };
  if (!built.ok || !built.exe) {
    const first = built.diagnostics[0];
    return { reason: built.reason ?? (first ? `line ${first.line}: ${first.message}` : "The recipe did not build.") };
  }
  const printer = this.printer();
  const start = { describe: true, params: {}, context: { units: "mm", bedMm: [printer.bedX, printer.bedY, printer.bedZ], nozzleMm: this.library.nozzleMm } };
  const out = await host.run(built.exe, start, async () => ({ ok: false, error: "Describe mode makes no calls." }), { ...DEFAULT_LIMITS, timeoutS: 15 });
  if (!out.ok || !out.described) return { reason: out.reason ?? "The recipe did not describe its parameters." };
  const params = out.described.params.map((row) => {
    const { line: _line, ...param } = row;
    return param as unknown as PluginParam;
  });
  const target: PluginTarget = !out.described.readObject ? "new" : out.described.ended ? "either" : "object";
  return { params, target };
}

/**
 * --- I22. The object `newId` takes the handle `oldId`: the old one leaves the plate, and the new one takes its handle,
 * its place in the list, its name and, unless the run placed it, its place on the plate and in the model.
 */
async function takeOver(this: Session, oldId: string, newId: string, keepPlace: boolean, keepModelPlace: boolean, keepOld = false): Promise<void> {
  const old = this.find(oldId);
  const made = this.find(newId);
  if (!old || !made) return;
  // A rebuilt plugin part keeps the old object, its tree open, for one model_undo.
  if (keepOld && made.tree) made.rebuiltFrom = { prior: old, tip: made.tree.current };
  else await this.closeTree(old);
  const at = this.objects.indexOf(old);
  this.objects.splice(this.objects.indexOf(made), 1);
  this.objects.splice(at, 1, made);
  made.id = oldId;
  made.name = old.name;
  if (keepPlace) {
    made.orient = [...old.orient] as Mat3;
    made.scale = old.scale;
    made.centered = old.centered;
    made.offset = { ...old.offset };
  }
  if (keepModelPlace) {
    made.modelPose = { m: [...old.modelPose.m] as PlateObject["modelPose"]["m"], t: [...old.modelPose.t] as PlateObject["modelPose"]["t"] };
    if (old.frame !== undefined) made.frame = old.frame;
  }
  if (this.selected === newId) this.selected = oldId;
}

/**
 * --- Plugin steps (D8). Marks a run's nodes on the one part it made or changed: the whole path when it made the part
 * (the stamp on the root), else the steps after `before`. Returns the run, or null when the path does not hold it.
 */
function stampRun(this: Session, obj: PlateObject, before: number | null, made: boolean, stamp: Omit<PluginStamp, "fingerprint">): StampedRun | null {
  const tree = obj.tree;
  if (!tree) return null;
  const path = pathTo(tree, tree.current);
  const at = before === null ? -1 : path.indexOf(before);
  const ids = made ? path : at >= 0 ? path.slice(at + 1) : [];
  if (ids.length === 0) return null;
  const fingerprint = tree.nodes.get(tree.current)?.fingerprint ?? obj.solid?.fingerprint ?? null;
  obj.tree = markedRun(tree, ids, randomUUID().slice(0, 8), { ...stamp, fingerprint });
  return runEndingAt(obj.tree, tree.current);
}

/**
 * --- Plugin steps (D9). The code a stamp names, by its hash: the project's own copy, else the library's file of that
 * hash (the current version or an older `<plugin>.vN.rs`), else a draft's kept source. A sentence when none is there,
 * when the project's copy was edited, or when the code needs a newer recipe API.
 */
function stampSource(this: Session, stamp: PluginStamp): { body: string; notes: string[]; title?: string; target?: PluginTarget; api?: string; ingredients?: Record<string, KeptIngredient> } | { reason: string } {
  const notes: string[] = [];
  const current = stamp.version > 0 && isSlug(stamp.plugin) ? readPlugin(stamp.plugin) : null;
  const library = current && !("reason" in current) ? current : null;
  if (library && library.sha256 !== stamp.sha256 && library.header.version > stamp.version) {
    notes.push(`v${library.header.version} of ${stamp.plugin} is in your library; this rebuild runs v${stamp.version}, the code the step was built with.`);
  }
  let file: PluginFile | null = null;
  const copy = this.projectPlugins.get(stamp.sha256);
  if (copy !== undefined) {
    const parsed = parsePlugin(copy);
    if ("reason" in parsed || parsed.sha256 !== stamp.sha256) return { reason: "This project's copy of the plugin was changed outside the app. The part is kept as built; its values cannot change until the plugin is run again." };
    file = parsed;
  }
  if (!file && library?.sha256 === stamp.sha256) file = library;
  if (!file && stamp.version > 0 && isSlug(stamp.plugin)) {
    for (const version of olderVersions(stamp.plugin)) {
      const old = readPlugin(stamp.plugin, pluginsDir(), version);
      if (old && !("reason" in old) && old.sha256 === stamp.sha256) {
        file = old;
        break;
      }
    }
  }
  if (file) {
    const tooNew = apiRefusal(file.header.api, this.crateApi());
    if (tooNew) return { reason: tooNew };
    return { body: file.body, notes, title: file.header.title, target: file.header.target, api: file.header.api };
  }
  const draft = [...this.rustRecipes.values()].filter((row) => row.sha256 === stamp.sha256).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
  if (draft) return { body: draft.source, notes, ...(draft.ingredients ? { ingredients: draft.ingredients } : {}) };
  return { reason: "The plugin source is not in this project or your library. The part is kept as built; its values cannot change." };
}

/**
 * --- Plugin steps (D8). The steps `ids` of `from` built again, in order, on `obj`'s shown step, as an edit replays the
 * steps after the one it changed: one engine call, and a step that no longer builds is kept broken with the ones
 * under it. `renamed` maps the old steps the ops name (an edge of a step) to the new ones. Each keeps its name, and a
 * later plugin step its stamp.
 */
async function replaySteps(this: Session, obj: PlateObject, from: ModelTree, ids: readonly NodeId[], renamed: ReadonlyMap<NodeId, NodeId>): Promise<{ replayed: number; broken?: string } | { reason: string }> {
  const tree = obj.tree;
  if (!tree || ids.length === 0) return { replayed: 0 };
  const parent = tree.current;
  const fresh = this.reserveOn(tree.key, ids.length);
  const ops = replayOps(from, ids, fresh, renamed);
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(editRequest(tree.key, parent, fresh[0]!, ops[0]!, fresh.slice(1).map((id, i) => ({ id, op: ops[i + 1]! })), obj.stepTolerance || CHORD), "edit", this.replayBudgetMs(ids.length));
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return { reason: String(lost.reason ?? "The engine stopped.") };
    throw err;
  }
  if (typeof reply.error === "string" && reply.error) return { reason: plainModelError(reply.error) };
  const { tree: next, broken } = replayedTree(obj.tree ?? tree, parent, fresh, ops, reply, from, ids);
  obj.tree = next;
  const solid = solidView(reply);
  if (solid) obj.solid = solid;
  obj.probes.clear();
  return { replayed: ids.length, ...(broken ? { broken: broken.error } : {}) };
}

/** Takes a recipe run back: objects it made leave the plate, parts it changed go back to the step they stood at. */
async function recipeRollback(this: Session, created: string[], touched: Map<string, number | null>, firstNew?: ReadonlyMap<string, number>): Promise<{ removed: string[]; restored: string[] }> {
  const removed: string[] = [];
  const restored: string[] = [];
  for (const id of [...created].reverse()) {
    if (!this.find(id)) continue;
    const value = await this.objectRemove(id).catch(() => ({ ok: false }));
    if (value.ok !== false) removed.push(id);
  }
  for (const [id, node] of touched) {
    const obj = this.find(id);
    if (!obj || node === null || (obj.tree?.current ?? null) === node) continue;
    const value = await this.gotoNode(obj, node).catch(() => ({ ok: false }));
    if (value.ok !== false) restored.push(id);
    // The steps the run added go too, so Redo does not walk into a run that was taken back.
    const from = firstNew?.get(id);
    if (value.ok === false || from === undefined || !obj.tree) continue;
    for (const child of [...obj.tree.nodes.values()].filter((row) => row.parent === node && row.id >= from)) obj.tree = dropped(obj.tree, child.id) ?? obj.tree;
  }
  return { removed, restored };
}

/** The methods this module adds to Session. */
export const recipeMethods = {
  recipeRun,
  keepRun,
  promoteStamps,
  crateApi,
  recipeDescribe,
  takeOver,
  stampRun,
  stampSource,
  replaySteps,
  recipeRollback,
};

export const recipeHandlers: Record<string, ToolHandler> = {
  recipe_run: (s, input, meta) => s.recipeRun(input, meta),
};
