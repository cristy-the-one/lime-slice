/**
 * recipe_run: lust builds a recipe, each call it makes goes through the session as a plan step does, and the run is one transaction.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { randomUUID } from "node:crypto";
import { plainModelError } from "../../src/app/model-error.ts";
import type { Mat3 } from "../../src/mesh-place.ts";
import { evaluateMember, memberFields, memberPose, samePose } from "../../src/assembly.ts";
import { relativePose } from "../../src/model-space.ts";
import { formatMm } from "../../src/model-plane.ts";
import { editRequest } from "../../src/model-request.ts";
import { solidView } from "../../src/modeling/model-calls.ts";
import { dropped, pathTo, withNode, type ModelOp, type ModelTree, type NodeId, type PluginStamp } from "../../src/model-tree.ts";
import { replayedTree, replayOps } from "../../src/recipe/rebuild.ts";
import { markedRun, runEndingAt, runsOnPath, sameFingerprint, sameValues, stampValue, type StampedRun } from "../../src/plugin-step.ts";
import { partNames, runSiblings } from "../../src/plugin-parts.ts";
import { answerPick } from "../../src/recipe/picks.ts";
import { answerTextOutline } from "../../src/recipe/text-outline.ts";
import { fontById, isPenFont, isUserFont } from "../../src/modeling/text-fonts.ts";
import { apiLevel, bodyHash, isSlug, olderVersions, parsePlugin, pluginsDir, readPlugin, type PluginFile, type PluginParam, type PluginTarget } from "../plugins.ts";
import { splitPluginData } from "../../src/recipe/plugin-data.ts";
import { apiVerdict, type ApiLevel, type ApiRefusalCode } from "../../src/recipe/api-level.ts";
import { fixedReply } from "../line-diff.ts";
import { lineMap, lineText, locate, resolveIngredients, type KeptIngredient } from "../ingredients.ts";
import { presetProblem, readPreset } from "../nuggets.ts";
import { queueSummary, RecipeQueue, type QueuedOp } from "../../src/recipe/queue.ts";
import { builtText } from "../../src/recipe/host.ts";
import { unreadApplyLines } from "../../src/recipe/unread-applies.ts";
import { DEFAULT_LIMITS, lfOnly, RecipeHost, recipeCrateDir, recipeDataFile, recipeDataMissing, recipeSourceFile, type RecipeCallSite, type RecipeData, type RecipeReply } from "../recipe.ts";
import { CHORD, type CallMeta, type PlateObject, type PluginRebuild, type RustRecipe, type ToolHandler, UNKNOWN_OBJECT } from "./shared.ts";
import type { Session } from "../session.ts";
import { SESSION_URL } from "../session-url.ts";
import { NEXT, refuse } from "../refusals.ts";
import { checkpointJson, checkpointSignature, CHECKPOINT_MAX_BYTES, type CheckpointEvent, type RecipeCheckpoint } from "../recipe-checkpoint.ts";
import { autosavePath } from "../autosave.ts";
import { readFile } from "node:fs/promises";
import { environmentOf, proofData, proofText, startContext, type RunProof } from "./run-proof.ts";
import { addSink, ensureMeshes, kernelRow, newSink, newTap, skipsMesh, splitOf, type KernelSink } from "./mesh-end.ts";

/**
 * recipe_run: lust builds the recipe in a warm slot (applying its safe fixes), then runs it with each call it makes
 * going through runCall as a plan step does. The run is one transaction: a refusal the recipe does not handle, a
 * panic, a limit, a cancel, or dry mode takes back every object it made and every step it added; an apply that
 * reaches done commits what it touched, and each part it changed gets its steps as one undo step.
 */
/** --- docs/plan-native-recipes.md 7.1. Set on a run built again one by one after a queued boolean was refused late. */
const QUEUE_REPLAY = "__queueReplay";

async function recipeRun(this: Session, input: Record<string, unknown>, meta?: CallMeta): Promise<Record<string, unknown>> {
  const requested = typeof input.name === "string" ? input.name.replace(/[^A-Za-z0-9_-]/g, "_") : typeof input.plugin === "string" ? input.plugin : "";
  const saved = requested && this.objects.length === 0 ? this.previousAutosave?.checkpoints?.[requested] : undefined;
  if (saved && input.mode !== "check" && input.mode !== "dry") {
    const restored = await this.projectOpen(this.previousAutosave!.path);
    if (restored.ok !== true) return refuse("recipe-failed", `The checkpoint's autosave could not be opened: ${String(restored.reason ?? "unknown error")}`);
  }
  const pending = requested ? this.recipeCheckpoints.get(requested) : undefined;
  if (pending && input.source === undefined && input.path === undefined && input.plugin === undefined && input.object === undefined) input = { ...input, source: pending.source };
  if (!this.recipeHost) this.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(SESSION_URL), moduleUrl: SESSION_URL });
  const host = this.recipeHost;
  const ready = host.available();
  if (!ready.ok) return refuse("recipe-unavailable", ready.reason);
  const mode = input.mode === "check" || input.mode === "dry" ? input.mode : "apply";
  // --- I23. A partial run stops after this many applied ops; it is always taken back.
  const maxSteps = typeof input.maxSteps === "number" ? input.maxSteps : undefined;
  if (maxSteps !== undefined && mode !== "dry") return refuse("conflicting-arguments", "maxSteps is for mode:\"dry\": a run stopped part way is always taken back.");
  // --- R-A. The source from a .rs file in the workspace, so an edit and rerun sends only the path.
  if (typeof input.path === "string" && typeof input.source === "string") return refuse("conflicting-arguments", "Pass source or path, not both.");
  // --- Plugins (D14): a library plugin by id, built against this API level, under its id as the recipe name.
  let plugin: { id: string; version: number; sha256: string; title: string; target: PluginTarget; api: string; note?: string } | null = null;
  let pluginBody: string | null = null;
  let presetParams: Record<string, unknown> = {};
  if (typeof input.plugin === "string" && (typeof input.source === "string" || typeof input.path === "string")) return refuse("conflicting-arguments", "Pass plugin, source, or path: one of them.");
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
      if (input.preset !== undefined) return refuse("conflicting-arguments", "A preset starts a new run. To change this plugin step, pass params; its other values stay as stamped.");
      // A part a draft made reruns from its own entry even when the stamp's code is missing (#527's rerun).
      const looked = this.stampSource(stamp);
      if ("reason" in looked && (wanted !== undefined || pick.before !== null)) return refuse(looked.code ?? "recipe-source", looked.reason);
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
      // --- One run, several parts (O4 as built): they change together, by the rerun of the entry that made them all,
      // which replaces each in turn. A set the entry does not hold (the window made it, or the run changed a given
      // part too), or one with steps after the run, which that rerun would drop, is refused with the way round.
      const siblings = runSiblings(this.objects.map((obj) => ({ id: obj.id, tree: obj.tree ?? undefined })), pick.id, stepTarget.id);
      if (siblings.length > 0) {
        const entry = stepTarget.rustRecipe ? this.rustRecipes.get(stepTarget.rustRecipe) : undefined;
        const together = pick.before === null && !!entry && siblings.every((id) => entry.objects.includes(id));
        const names = partNames(siblings.map((id) => this.find(id)?.name ?? id));
        if (!together) return refuse("rebuild-refused", `${stamp.plugin} made this part in one run with ${names}, and only a set this session made can change its values together, so nothing changed. Run the plugin again (recipe_run {plugin, params}) to make a new set, then remove the old parts with object_remove.`);
        if (rebuild.later.length > 0) return refuse("rebuild-refused", `${stamp.plugin} made this part in one run with ${names}, and making them all again would drop the ${rebuild.later.length === 1 ? "step" : `${rebuild.later.length} steps`} after the run on this part, so nothing changed. Undo ${rebuild.later.length === 1 ? "that step" : "those steps"} first, or run the plugin again (recipe_run {plugin, params}) for a new set.`);
      }
      if (pick.before !== null && rebuild.later.some((id) => tree.nodes.get(id)?.op?.kind === "partition")) {
        return refuse("rebuild-refused", "A split to print follows this plugin step, and a rebuild cannot cut its pieces again. Undo to before the split, rebuild, then split again.");
      }
    }
  }
  if (typeof input.plugin === "string" && !rebuild) {
    if (input.plugin.startsWith("draft:")) return refuse("conflicting-arguments", `A draft runs again from its object (recipe_run {object, params}), or keep it first: nugget {action:"save", kind:"plugin", from:"${input.plugin.slice(6)}", title, description}.`);
    const got = await this.pluginFile(input.plugin);
    if ("reason" in got) return refuse("recipe-source", got.reason);
    const h = got.file.header;
    if (h.kind === "animation") return refuse("bad-argument", `"${h.plugin}" is an animation. Use pose_animate with an assembly member.`);
    // --- D12. A plugin of a newer API than this app's crate of its major, or of a major it no longer ships, is refused
    // before anything is built: a lust error about a missing function would read like the plugin's fault.
    const verdict = apiVerdict(h.api, this.crateLevels());
    if (!verdict.ok) return refuse(verdict.code, verdict.reason);
    if (h.target === "object" && typeof input.object !== "string") return refuse("missing-argument", `${h.title} needs a part: pass object, the part to run it on.`);
    plugin = { id: h.plugin, version: h.version, sha256: got.file.sha256, title: h.title, target: h.target, api: h.api, ...(got.note ? { note: got.note } : {}) };
    pluginBody = got.file.body;
    // --- I14. A preset's values under the given params, checked against the plugin's ranges again at use.
    if (typeof input.preset === "string") {
      const name = input.preset.includes("/") ? input.preset.split("/")[1]! : input.preset;
      const row = readPreset(h.plugin, name);
      if (!row) return refuse("preset-not-found", `No preset ${h.plugin}/${name}.${this.presetNames(h.plugin)}`);
      const problem = presetProblem(h.plugin, row.params, h.params);
      if (problem) return refuse("preset-invalid", `The preset ${h.plugin}/${name} no longer fits this version of the plugin: ${problem}`);
      presetParams = row.params;
    }
  } else if (input.preset !== undefined && !rebuild) return refuse("conflicting-arguments", "A preset runs with its plugin: recipe_run {plugin, preset}.");
  if (input.keep !== undefined && mode !== "apply") return refuse("conflicting-arguments", "keep keeps an apply that reached done; a check or dry run is never kept.");
  if (input.keep !== undefined && rebuild) return refuse("conflicting-arguments", "keep keeps a new run; a rebuild of a plugin step runs the code the step already names.");
  const file = typeof input.path === "string" ? recipeSourceFile(input.path) : null;
  if (file && "reason" in file) return refuse("recipe-source", file.reason);
  const framed = pluginBody ?? (file ? file.text : typeof input.source === "string" ? input.source : null);
  // --- Plugin data. A kept plugin's body carries the recipe data its run read after its code: the host builds the
  // code, and the data answers `data {name}` after the step's own kept data and before the workspace's files.
  const split = framed === null ? null : splitPluginData(framed);
  if (split?.problem) return refuse("plugin-invalid", split.problem);
  const typed = split ? split.code : null;
  const carried: Record<string, RecipeData> = { ...(input.discardCheckpoint === true ? {} : pending?.carried ?? {}), ...(split?.data ?? {}) };
  // --- A rerun: no source, and an object a recipe_run made. Its stored source runs again with the stored
  // parameters under the new ones.
  let rerun: { name: string; stored: RustRecipe } | null = null;
  if (typed === null) {
    const key = typeof input.object === "string" ? this.find(input.object)?.rustRecipe : undefined;
    const stored = key ? this.rustRecipes.get(key) : undefined;
    if (!key || !stored) return refuse("missing-argument", "Pass source or path, or the object of an earlier recipe_run to run its recipe again.");
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
  if (mode === "apply" && input.discardCheckpoint === true && this.recipeCheckpoints.has(name)) {
    const discarded = this.recipeCheckpoints.get(name)!;
    this.recipeCheckpoints.delete(name);
    this.autosaveDirty = true;
    this.flushAutosave(undefined, true);
    await this.autosaveSettled();
    let removed = false;
    try {
      const wire = JSON.parse(await readFile(autosavePath()!, "utf8")) as { mcpRecipeCheckpoints?: Record<string, unknown> };
      removed = !wire.mcpRecipeCheckpoints?.[name];
    } catch { /* A failed autosave cannot make discarding durable. */ }
    if (!removed) {
      this.recipeCheckpoints.set(name, discarded);
      return refuse("recipe-failed", "The checkpoint could not be discarded from the autosave. Check that the workspace is writable and try again.");
    }
    if (this.previousAutosave?.checkpoints) delete this.previousAutosave.checkpoints[name];
  }
  const checkpoint = mode === "apply" ? this.recipeCheckpoints.get(name) : undefined;
  // --- I10. The ingredients the source imports, from the library (a rerun: the copies its last apply built), built
  // after the recipe as inline modules, the same text under lust and rustc.
  const resolved = resolveIngredients(source, { kept: checkpoint?.ingredients ?? replacing?.stored.ingredients ?? rebuild?.ingredients, preferKept: !!checkpoint || !!rerun || !!rebuild });
  if ("reason" in resolved) return refuse("recipe-source", resolved.reason);
  const usedIngredients = Object.values(resolved.used);
  this.noteStage(`building recipe ${name}`, 0);
  // --- D12. A plugin builds against the crate of the API major it records, in that major's slots; anything else (a
  // draft, a source, a path) against the current crate.
  const major = plugin ? (apiLevel(plugin.api)?.[0] ?? undefined) : undefined;
  const built = await host.build(name, source, input.autofix !== false, resolved.suffix, undefined, major);
  if (meta?.signal?.aborted) return refuse("cancelled", "The recipe was cancelled while building; nothing changed.");
  const map = lineMap(built.source, resolved);
  const fixed = built.source !== source ? fixedReply(source, built.source, built.fixRounds, input.full === true) : {};
  const diagnostics = built.diagnostics.map((d) => ({ code: d.code, ...locate(map, d.line), col: d.col, message: d.message, ...(d.fix ? { fix: d.fix } : {}), ...(d.inCrate ? { inCrate: true } : {}) }));
  if (!built.ok || !built.exe) {
    return { ok: false, code: "recipe-compile", reason: built.reason ?? "The recipe did not build. Fix the diagnostics and call recipe_run again.", diagnostics, ...fixed, buildMs: built.ms, next: NEXT.fix };
  }
  const buildHash = bodyHash(`${built.source}\n${resolved.suffix}`);
  const environmentHash = environmentOf(this);
  // The parts on the plate beside the one the run is given, when it begins (run-proof.ts).
  const plateOthers = this.objects.filter((row) => row.id !== input.object).length;
  if (checkpoint) {
    if (checkpoint.buildHash !== buildHash || checkpointJson(checkpoint.params) !== checkpointJson(params) || input.object !== undefined || replacing || rebuild) return refuse("recipe-failed", "The saved checkpoint belongs to different source, ingredients, parameters, or a different target. Use the original run's values, or pass discardCheckpoint:true to start a new run and leave the saved parts on the plate.");
    if (checkpoint.environmentHash !== environmentHash) return refuse("recipe-failed", "The printer, settings, or project parameters changed since the checkpoint. Restore them, or pass discardCheckpoint:true to start a new run.");
    const changed = checkpoint.objects.find((row) => { const obj = this.find(row.id); return !obj || checkpointSignature(obj) !== row.signature; });
    if (changed || checkpointJson(this.liveAssemblies()) !== checkpointJson(checkpoint.assemblies)) return refuse("recipe-failed", `The checkpoint's ${changed ? `part ${changed.id}` : "assembly"} changed after it was saved. Restore it, or pass discardCheckpoint:true to start a new run.`);
  }
  if (mode === "check") return { ok: true, built: true, ...(diagnostics.length ? { diagnostics } : {}), ...fixed, buildMs: built.ms };

  // A rerun's or replace's object names the recipe, not a part for it to change.
  const objectArg = typeof input.object === "string" && !replacing ? input.object : undefined;
  if (objectArg !== undefined && !this.find(objectArg)) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  // --- API 1.2. A face index names a face of the part as shown now, as faces_find lists it; a rebuild starts from an
  // earlier step whose faces are numbered otherwise, so the pick reads the index on this solid.
  const shownSolid = objectArg !== undefined ? this.find(objectArg)?.solid ?? null : null;
  // --- Plugin steps (D8). A rebuild runs on the part as it stood before the run: a new branch from there.
  if (rebuild && branchRebuild) {
    const back = await this.gotoNode(rebuild.obj, rebuild.run.before!);
    if (back.ok === false) return refuse("build-failed", `The step before the plugin's run could not be shown: ${String(back.reason ?? "the engine refused it.")}`);
  }
  const created: string[] = checkpoint ? checkpoint.objects.map((row) => row.id) : [];
  /** Print and assembly poses are independent; a replace preserves each unless the run set it. */
  const placed = new Set<string>(checkpoint?.placed ?? []);
  const modelPlaced = new Set<string>(checkpoint?.modelPlaced ?? []);
  /** Parts that were on the plate before the run, with the step each stood at. */
  const touched = new Map<string, number | null>();
  const notes: string[] = [...(checkpoint?.notes ?? [])];
  /** --- R-A. Recipe data the run read, by name: kept with the recipe so a rerun builds the same elsewhere. */
  const dataUsed = new Map<string, RecipeData>(Object.entries(checkpoint?.data ?? {}) as [string, RecipeData][]);
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
  if (checkpoint?.selected && this.find(checkpoint.selected)) this.selected = checkpoint.selected;
  const ctx: CallMeta = { progressToken: meta?.progressToken, signal: meta?.signal };
  /** --- API 1.2. What each given face or outline resolved to, kept in the step's stamp in its place. */
  const picked: Record<string, unknown> = {};
  /** Mesh once at the end: set by recipe_run {meshAtEnd} or the recipe's s.mesh_at_end() (mesh-end.ts). */
  let meshAtEnd = input.meshAtEnd === true;
  const call = async (site: RecipeCallSite): Promise<RecipeReply> => {
    if (site.tool === "mesh_at_end") {
      meshAtEnd = true;
      return { ok: true, result: { ok: true } };
    }
    // A call that reads a part meshes it first; a plain model_apply carries on without (mesh-end.ts).
    const deferring = meshAtEnd && skipsMesh(site.tool, site.args);
    if (meshAtEnd && !deferring && this.meshPending.size > 0 && site.tool !== "native_geometry" && site.tool !== "log" && site.tool !== "data" && site.tool !== "text_outline") {
      const why = await ensureMeshes(this);
      if (why) return { ok: false, error: why };
    }
    if (site.tool === "native_geometry") {
      const result = JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify({ call: "nativeGeometry", args: site.args })))) as unknown;
      return Array.isArray(result) ? { ok: true, result } : { ok: false, error: "Native geometry is unavailable." };
    }
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
        if (!found) return { ok: false, error: `There is no font called ‘${args.font}’. The fonts are stroke, line, hershey-simplex, hershey-duplex, hershey-complex, hershey-script, hershey-gothic, sans, mono, serif, stencil, and the project's own: ${this.fonts.list().map((font) => font.name).join(", ") || "none yet (fontFile adds one)"}.` };
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
      const targets = site.tool === "model_place" && Array.isArray(site.args.objects) ? site.args.objects : [target];
      if (targets.some((id) => typeof id !== "string" || !created.includes(id)) || others.some((id) => !created.includes(id))) {
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
    this.meshDeferNow = deferring;
    try {
      value = await this.runCall(site.tool, site.args, ctx, true);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.meshDeferNow = false;
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
    if (site.tool === "model_place") {
      if (Array.isArray(site.args.objects)) {
        for (const id of site.args.objects) if (typeof id === "string") modelPlaced.add(id);
      } else modelPlaced.add(target);
    }
    if (site.tool === "model_apply") applied += 1;
    if (site.tool === "model_apply_batch") applied += Array.isArray(site.args.ops) ? site.args.ops.length : 1;
    if (maxSteps !== undefined && applied >= maxSteps) return { ok: true, result: value, halt: `The run stopped after ${applied} applied op${applied === 1 ? "" : "s"} (maxSteps ${maxSteps}), at line ${site.line}.` };
    return { ok: true, result: value };
  };
  let journal: CheckpointEvent[] = checkpoint ? structuredClone(checkpoint.events) : [];
  const mayCheckpoint = !!checkpoint || built.source.includes("checkpoint") || resolved.suffix.includes("checkpoint");
  let journalBytes = Buffer.byteLength(JSON.stringify(journal));
  let overflow = journalBytes > CHECKPOINT_MAX_BYTES;
  let replay = 0;
  let preserved = new Set(checkpoint?.objects.map((row) => row.id) ?? []);
  let baselineNodes = new Map<string, number | null>();
  let baselineFirst = new Map<string, number>();
  let baselinePoses = new Map<string, { modelPose: PlateObject["modelPose"]; frame: PlateObject["frame"]; orient: Mat3; scale: number; centered: boolean; offset: PlateObject["offset"] }>();
  let baselineAssemblies = structuredClone(this.assemblies);
  let baselineSelected = this.selected;
  const captureBaseline = () => {
    baselineNodes = new Map();
    baselineFirst = new Map();
    baselinePoses = new Map();
    for (const id of preserved) {
      const part = this.find(id);
      if (!part) continue;
      baselineNodes.set(id, part.tree?.current ?? null);
      if (part.tree) baselineFirst.set(id, part.tree.nextId);
      baselinePoses.set(id, { modelPose: structuredClone(part.modelPose), frame: part.frame, orient: [...part.orient] as Mat3, scale: part.scale, centered: part.centered, offset: { ...part.offset } });
    }
    baselineAssemblies = structuredClone(this.assemblies);
    baselineSelected = this.selected;
  };
  if (checkpoint) captureBaseline();
  const journalCall = async (site: RecipeCallSite): Promise<RecipeReply> => {
    if (checkpoint && replay < checkpoint.events.length) {
      const entry = checkpoint.events[replay++]!;
      if (site.tool !== entry.site.tool || site.line !== entry.site.line || checkpointJson(site.args) !== checkpointJson(entry.site.args)) return { ok: false, error: `The recipe diverged before its checkpoint at line ${site.line}. The saved parts were kept; use the original run or discardCheckpoint:true.`, fatal: true };
      if (entry.site.tool === "mesh_at_end") meshAtEnd = true;
      return structuredClone(entry.reply);
    }
    if (site.tool === "checkpoint") {
      // --- docs/plan-native-recipes.md 7.1: what is queued is built before the parts are kept.
      const flushed = await queue.flushAll(site);
      if (flushed) return flushed;
      if (meshAtEnd) {
        const why = await ensureMeshes(this);
        if (why) return { ok: false, error: why };
      }
      if (mode === "dry") return { ok: true, result: { ok: true } };
      if (!mayCheckpoint) return { ok: false, error: "Use s.checkpoint() directly so the run can be recorded from its start." };
      if (objectArg || replacing || rebuild) return { ok: false, error: "A checkpoint currently supports a new-part recipe without object or rebuild. Run it as a new recipe first." };
      if (overflow) return { ok: false, error: "The checkpoint journal exceeds 8 MB. Start a new recipe run after saving these parts." };
      if (!autosavePath()) return { ok: false, error: "A checkpoint needs LIME_MCP_WORKSPACE for its autosave." };
      if (created.some((id) => !this.find(id))) return { ok: false, error: "A checkpoint cannot keep a run that consumed one of its created parts." };
      for (const id of created) {
        const part = this.find(id)!;
        const reason = await this.commitObject(part);
        if (reason) return { ok: false, error: `The checkpoint could not commit ${id}: ${reason}` };
      }
      const reply: RecipeReply = { ok: true, result: { ok: true } };
      const nextEvents = [...journal, { site: structuredClone(site), reply }];
      const next: RecipeCheckpoint = {
        source, buildHash, environmentHash, params: structuredClone(params), events: nextEvents,
        objects: created.map((id) => ({ id, signature: checkpointSignature(this.find(id)!) })),
        placed: [...placed], modelPlaced: [...modelPlaced], selected: this.selected,
        assemblies: structuredClone(this.liveAssemblies()), notes: [...notes], data: Object.fromEntries(dataUsed), carried, ingredients: resolved.used,
      };
      if (Buffer.byteLength(JSON.stringify(next)) > CHECKPOINT_MAX_BYTES) return { ok: false, error: "The checkpoint journal exceeds 8 MB. Start a new recipe run after saving these parts." };
      const prior = this.recipeCheckpoints.get(name);
      this.recipeCheckpoints.set(name, next);
      this.autosaveDirty = true;
      this.flushAutosave();
      await this.autosaveSettled();
      let saved = false;
      try {
        const wire = JSON.parse(await readFile(autosavePath()!, "utf8")) as { mcpRecipeCheckpoints?: Record<string, unknown> };
        saved = checkpointJson(wire.mcpRecipeCheckpoints?.[name]) === checkpointJson(next);
      } catch { /* The checkpoint is not durable if the autosave could not be read. */ }
      if (!saved) {
        if (prior) this.recipeCheckpoints.set(name, prior); else this.recipeCheckpoints.delete(name);
        return { ok: false, error: "The checkpoint could not be saved. The run will be taken back to its last saved checkpoint." };
      }
      journal = nextEvents;
      journalBytes = Buffer.byteLength(JSON.stringify(journal));
      preserved = new Set(created);
      captureBaseline();
      return reply;
    }
    if (mode !== "apply" || !mayCheckpoint) return queued(site);
    const recordedSite = structuredClone(site);
    const reply = await queued(site);
    if (mode === "apply" && !overflow) {
      const entry = { site: recordedSite, reply: structuredClone(reply) };
      journalBytes += Buffer.byteLength(JSON.stringify(entry));
      if (journalBytes > CHECKPOINT_MAX_BYTES) { overflow = true; journal = []; }
      else journal.push(entry);
    }
    return reply;
  };
  const printer = this.printer();
  const limits = { ...DEFAULT_LIMITS, ...(typeof input.timeoutS === "number" ? { timeoutS: input.timeoutS } : {}) };
  // --- docs/plan-native-recipes.md 7.1. Queued booleans: lines whose apply reply the recipe does not read are held and
  // built together; `replay` (set by an earlier attempt) runs the recipe one by one, as it was before queuing.
  const replaying = input[QUEUE_REPLAY] as { line: number; reason: string } | undefined;
  const bakedOps = new WeakMap<object, { op: ModelOp; typed: Record<string, unknown> }>();
  const queue = new RecipeQueue({
    tool: async (object, op) => {
      const obj = this.find(object);
      if (!obj || (object !== objectArg && !created.includes(object))) return null;
      const found = await this.queueTool(obj, op);
      if (found) bakedOps.set(op, found.baked);
      return found ? { kind: found.kind, box: found.box, merge: found.merge } : null;
    },
    partBox: (object) => this.find(object)?.solid?.bounds ?? null,
    build: async (object, ops: QueuedOp[], groups) => {
      const obj = this.find(object);
      if (!obj) return { ok: false, code: "no-object", reason: UNKNOWN_OBJECT };
      touch(object);
      const lastSite = ops[ops.length - 1]!.site;
      this.noteStage(`recipe ${name}: call ${lastSite.id}, building ${ops.length} queued applies as ${groups.length} boolean${groups.length === 1 ? "" : "s"}, ${lineText(map, lastSite.line)}`);
      const rows = ops.map((q) => ({ op: bakedOps.get(q.op)!.op, ...(typeof q.op.label === "string" ? { label: q.op.label } : {}), ...(q.tool ? { box: q.tool.box } : {}) }));
      const done = await this.applyQueued(obj, rows, groups, () => queue.stopped());
      if (done.ok) applied += ops.length;
      return done;
    },
    applyOne: (site) => call(site),
  }, unreadApplyLines(builtText(built.source, resolved.suffix)), { silent: !replaying && maxSteps === undefined && process.env.LIME_RECIPE_QUEUE !== "0", timeLimitS: limits.timeoutS, selected: () => this.selected, signal: meta?.signal });
  const queued = (site: RecipeCallSite) => queue.call(site, call);
  const timings = new Map<string, { line: number; tool: string; calls: number; ms: number; sink: KernelSink }>();
  /** The kernel's timing for this run's tree calls (mesh-end.ts); the calls that follow the recipe's end are kept apart. */
  const tap = input.profile === true ? newTap() : null;
  const profiledCall = async (site: RecipeCallSite): Promise<RecipeReply> => {
    if (site.tool === "queue") return journalCall(site);
    const started = performance.now();
    const sink = newSink();
    if (tap) tap.current = sink;
    try { return await journalCall(site); }
    finally {
      if (tap) tap.current = null;
      const key = `${site.line}:${site.tool}`;
      const row = timings.get(key) ?? { line: site.line, tool: site.tool, calls: 0, ms: 0, sink: newSink() };
      row.calls += 1;
      row.ms += performance.now() - started;
      addSink(row.sink, sink);
      timings.set(key, row);
    }
  };
  const start = {
    params,
    context: startContext(this, { canCheckpoint: mode === "apply" && !objectArg && !replacing && !rebuild, timeLimitS: limits.timeoutS }, objectArg),
  };
  /** Takes the run back; a rebuild also shows the old branch again, where the part stood before it. */
  const rollback = async () => {
    const undone = await this.recipeRollback(created.filter((id) => !preserved.has(id)), new Map([...touched, ...baselineNodes]), new Map([...firstNew, ...baselineFirst]));
    for (const [id, node] of baselineNodes) {
      const part = this.find(id);
      if (part && node !== null && part.platedNode !== node) await this.commitObject(part).catch(() => null);
    }
    for (const [id, pose] of baselinePoses) {
      const part = this.find(id);
      if (!part) continue;
      part.modelPose = structuredClone(pose.modelPose);
      if (pose.frame === undefined) delete part.frame; else part.frame = pose.frame;
      part.orient = [...pose.orient] as Mat3; part.scale = pose.scale; part.centered = pose.centered; part.offset = { ...pose.offset };
    }
    if (preserved.size) { this.assemblies = structuredClone(baselineAssemblies); this.selected = baselineSelected; }
    if (rebuild && branchRebuild && rebuild.obj.tree?.current !== rebuild.from) await this.gotoNode(rebuild.obj, rebuild.from).catch(() => ({ ok: false }));
    return undone;
  };
  this.recipeDepth += 1;
  this.kernelTap = tap;
  let out;
  try {
    out = await host.run(built.exe, start, input.profile === true ? profiledCall : journalCall, limits, meta?.signal, (fraction, message) => this.noteStage(message || `recipe ${name}`, fraction));
    // --- docs/plan-native-recipes.md 7.1: `done` builds what is still queued, before the parts are kept.
    if (out.ok && out.done && queue.holding) {
      // The recipe's program has ended, so its clock (`out.ms`) has stopped: this build is timed here and added to
      // the run, and to the profile as the row `done`, so runMs, the split and a kept plugin's `built:` hold it.
      const began = performance.now();
      const sink = newSink();
      if (tap) tap.current = sink;
      let flushed: RecipeReply | null;
      try { flushed = await queue.flushAll(); }
      finally { if (tap) tap.current = null; }
      const took = performance.now() - began;
      out.ms += Math.round(took);
      if (tap) timings.set("done", { line: 0, tool: "done", calls: 1, ms: took, sink });
      // A cancel or the time limit that came while it built takes the whole run back, as during the run.
      const stop = flushed && !flushed.ok ? flushed.error : queue.stopped();
      if (stop) {
        out.ok = false;
        out.reason = stop;
      }
    }
  } finally {
    this.recipeDepth -= 1;
    this.kernelTap = null;
    this.meshDeferNow = false;
  }
  // --- Mesh at the end: the parts the run left without a mesh get it now, once, before they are kept (mesh-end.ts).
  let finish: { ms: number; sink: KernelSink } | null = null;
  if (meshAtEnd && this.meshPending.size > 0) {
    const closing = tap ? newTap() : null;
    this.kernelTap = closing;
    const started = performance.now();
    let why: string | null = null;
    if (out.ok) why = await ensureMeshes(this);
    else this.meshPending.clear();
    this.kernelTap = null;
    if (closing) finish = { ms: performance.now() - started, sink: closing.all };
    if (why) { out.ok = false; out.reason = why; }
  }
  // A queued boolean refused after the recipe moved on: the run is taken back and built again one by one, so the
  // recipe sees the refusal at its own line. A run is deterministic, so this is the run it would have been.
  if (queue.replay && !replaying && !meta?.signal?.aborted) {
    await rollback();
    return this.recipeRun({ ...input, [QUEUE_REPLAY]: queue.replay }, meta);
  }
  if (replaying) notes.push(`Built one by one: the tool at line ${locate(map, replaying.line).line} was refused inside a queued boolean (${replaying.reason}).`);
  for (const row of queue.unreported()) if (notes.length < 200) notes.push(`line ${locate(map, row.line).line}: apply_later was refused (${row.reason}); s.flush(&part) reports these.`);
  if (checkpoint && replay < checkpoint.events.length && out.ok) {
    out.ok = false;
    out.reason = "The recipe ended before reaching its saved checkpoint. The saved parts were kept; use the original run or discardCheckpoint:true.";
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
  const totalCallsMs = [...timings.values()].reduce((sum, row) => sum + row.ms, 0);
  const profile = input.profile === true && tap ? {
    // The program that ran: lust's optimised build (zig cc, mcp/recipe-opt.ts) or tinycc's.
    ...(built.compiler ? { build: built.compiler } : {}),
    callsMs: Math.round(totalCallsMs),
    outsideCallsMs: Math.max(0, Math.round(out.ms - totalCallsMs)),
    // Where the run's time went, in parts that add up to runMs, and the kernel's own counters (mesh-end.ts).
    split: splitOf(out.ms, totalCallsMs, tap.all),
    ...(kernelRow(tap.all) ? { kernel: kernelRow(tap.all) } : {}),
    ...(finish ? { meshAtEnd: { ms: Math.round(finish.ms * 10) / 10, ...(kernelRow(finish.sink) ?? {}) } } : {}),
    lines: [...timings.values()].sort((a, b) => b.ms - a.ms).map(({ sink, ...row }) => {
      const kernel = kernelRow(sink);
      return { ...row, ...locate(map, row.line), ms: Math.round(row.ms), ...(kernel && kernel.kernelMs !== undefined ? { kernelMs: kernel.kernelMs, booleanMs: kernel.booleanMs, meshMs: Math.round(((kernel.meshMs ?? 0) + (kernel.readoutMs ?? 0)) * 10) / 10 } : {}) };
    }),
  } : undefined;
  const savedCheckpoint = this.recipeCheckpoints.get(name);
  const report = { calls: out.calls, ...queueSummary(queue.report, (line) => locate(map, line).line), ...(replaying ? { replayed: { line: locate(map, replaying.line).line } } : {}), ...(checkpoint ? { resumed: true, replayedCalls: replay } : {}), ...(!out.ok && savedCheckpoint ? { checkpoint: { name, objects: savedCheckpoint.objects.map((row) => row.id), resume: { name } } } : {}), ...(profile ? { profile } : {}), ...(refused.length ? { refused } : {}), ...(usedIngredients.length ? { ingredients: usedIngredients.map((row) => `${row.id} v${row.version}`) } : {}), ...(notes.length ? { notes } : {}), ...(out.lateParams?.length ? { lateParams: out.lateParams } : {}), ...(diagnostics.length ? { diagnostics } : {}), ...fixed, buildMs: built.ms, runMs: out.ms, ...(plugin ? { plugin: { id: plugin.id, version: plugin.version } } : {}) };
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
    if (!out.ok) return { ok: false, code: "recipe-failed", reason: out.reason ?? "The recipe failed.", ...(out.line !== undefined ? { line: out.line } : {}), ...report, rolledBack: undone };
    if (name !== "plugin_check") this.recipePreviewHashes.set(name, bodyHash(built.source));
    return { ok: true, dry: true, object: out.done!.object, metrics: out.done!.metrics, ...report, rolledBack: undone };
  }
  // --- Plugin steps (D8). A run that made or changed one part is stamped on it: its first node names what ran and with
  // what, every node carries the run's id, and that run is one undo step, in the project too. A run over several
  // parts stamps each of them with the same run id and values, each with its own fingerprint, as the desktop app's
  // Plugins panel does (O4 as built, 2026-11-06). A part the run made and then joined into another (a tool, keepTool
  // false) left the plate: it is no part of its own.
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
  /** The parts a run of several stamped, all with one run id. */
  const stampedSet = new Set<string>();
  if (parts.length > 1 && name !== "plugin_check") {
    const runId = randomUUID().slice(0, 8);
    for (const id of parts) {
      const obj = this.find(id);
      if (obj && this.stampRun(obj, touched.get(id) ?? null, created.includes(id), stampFields, runId)) stampedSet.add(id);
    }
    notes.push(`${plugin?.title ?? name} made or changed ${parts.length} parts in one run; each carries the run's stamp. recipe_run {object} on one of the parts it made makes them all again together.`);
  }
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
      return { ok: false, code: "recipe-failed", reason: `The plugin ran, but the steps after it could not be built again: ${replay.reason} The rebuild was taken back.`, ...report, rolledBack: undone };
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
      return { ok: false, code: "recipe-commit", reason: `The recipe ran, but ${id} could not be committed to the plate: ${why} The run was taken back.`, object: id, metrics: out.done!.metrics, ...report, rolledBack: undone };
    }
    if (before !== undefined) committedTouched.push(id);
  }
  for (const [id, before] of touched) {
    const obj = this.find(id);
    const end = obj?.tree?.current ?? null;
    if (!obj || before === null || end === null || end === before) continue;
    // A rebuild is one undo step back to the old branch as it was shown; a stamped run is one by its run id.
    if (rebuild && branchRebuild && obj === rebuild.obj) obj.groups = [...(obj.groups ?? []), { start: rebuild.from, end, label }];
    else if ((!stamped || obj !== only) && !stampedSet.has(obj.id)) obj.groups = [...(obj.groups ?? []), { start: before, end, label }];
  }
  // --- I22. A rerun or a replace hands each old object's handle, place, and name to the new object in its turn, so
  // the part keeps its handle with a new history; old objects with no new one leave the plate.
  let object = out.done!.object;
  const replaced: string[] = [];
  const removed: string[] = [];
  const repositioned = new Set<string>();
  if (replacing) {
    const old = replacing.stored.objects.filter((id) => !created.includes(id) && this.find(id));
    for (const [i, oldId] of old.entries()) {
      const newId = created[i];
      if (newId === undefined) {
        if ((await this.objectRemove(oldId).catch(() => ({ ok: false }))).ok !== false) removed.push(oldId);
        continue;
      }
      await this.takeOver(oldId, newId, !placed.has(newId), !modelPlaced.has(newId), rebuild?.run.before === null && rebuild.obj.id === oldId);
      if (modelPlaced.has(newId)) repositioned.add(oldId);
      created[i] = oldId;
      if (object === newId) object = oldId;
      replaced.push(oldId);
    }
  }
  // A replaced part can have a new assembled pose. Refresh its stored parent offset (and its children's offsets)
  // after all replacements, so a later solve does not put it back at the previous recipe's pose.
  if (repositioned.size) {
    this.assemblies = this.assemblies.map((assembly) => ({ ...assembly, members: assembly.members.map((member) => {
      if (member.parent === null || (!repositioned.has(member.object) && !repositioned.has(member.parent))) return member;
      const part = this.find(member.object);
      const parent = this.find(member.parent);
      if (!part || !parent) return member;
      const actual = relativePose(parent.modelPose, part.modelPose);
      const evaluated = evaluateMember(member, this.params).member;
      if (samePose(memberPose(evaluated), actual)) return member;
      const fields = memberFields(actual);
      const keep = (old: number[], now: number[], texts: (string | null)[] | undefined): [string | null, string | null, string | null] | undefined => {
        if (!texts) return undefined;
        const result = texts.map((text, i) => Math.abs(old[i]! - now[i]!) < 1e-6 ? text : null) as [string | null, string | null, string | null];
        return result.some((text) => text !== null) ? result : undefined;
      };
      const offset = keep(evaluated.offset, fields.offset, member.exprs?.offset);
      const turn = keep(evaluated.turn, fields.turn, member.exprs?.turn);
      return { ...member, ...fields, exprs: offset || turn ? { ...(offset ? { offset } : {}), ...(turn ? { turn } : {}) } : undefined };
    }) }));
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
  this.recipePreviewHashes.delete(name);
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
  if (this.recipeCheckpoints.delete(name)) {
    if (this.previousAutosave?.checkpoints) delete this.previousAutosave.checkpoints[name];
    this.autosaveDirty = true;
    this.flushAutosave();
    await this.autosaveSettled();
  }
  // --- recipe_run {keep}: what this apply proves about the plugin it is kept as (run-proof.ts). A run that could
  // checkpoint, one asked to mesh at its end (its steps skip a guard), one with a late parameter (the check refuses
  // it), a resumed run and a rebuild prove nothing the check could use: the check then makes its dry run.
  const givenPart = objectArg !== undefined ? this.find(objectArg) : undefined;
  const proof: RunProof | undefined = input.keep !== undefined && !checkpoint && !mayCheckpoint && !rebuild && input.meshAtEnd !== true && !out.lateParams?.length
    ? {
        text: proofText(builtText(built.source, resolved.suffix)),
        params: structuredClone(params),
        data: Object.fromEntries([...dataUsed].map(([key, row]) => [key, proofData(row.value)])),
        ...(objectArg !== undefined ? { object: objectArg } : {}),
        ...(givenPart?.tree ? { treeKey: givenPart.tree.key } : {}),
        from: objectArg !== undefined ? touched.get(objectArg) ?? null : null,
        environment: environmentHash,
        plateOthers,
        context: JSON.stringify(start.context),
        runMs: out.ms,
      }
    : undefined;
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
    ...(await this.keepRun(input.keep, entryKey, built.source, name, objectArg, resolved.used, objectArg !== undefined ? touched.get(objectArg) ?? null : null, data, proof)),
  };
}

/** --- D1. recipe_run {keep}: the apply that just reached done, saved as a plugin. A failed check is a sentence. */
async function keepRun(this: Session, keep: unknown, entryKey: string | null, source: string, name: string, objectArg: string | undefined, ingredients: Record<string, KeptIngredient>, objectFrom: number | null, data?: Record<string, RecipeData>, proof?: RunProof): Promise<Record<string, unknown>> {
  if (keep === undefined) return {};
  const k = (keep && typeof keep === "object" ? keep : {}) as { title?: unknown; description?: unknown };
  const saved = await this.pluginSave({ source, title: k.title, description: k.description, name, objectHint: objectArg, objectFrom, ingredients, ...(data ? { data } : {}), ...(proof ? { proof } : {}) });
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

/**
 * --- Plugins (docs/plan-recipe-plugins.md D12). This host's crate API: the current crate's level, read from the crate
 * the recipes build against (1.1 when it cannot be read; the crate's absence is recipe_run's sentence).
 */
function crateApi(this: Session): [number, number] {
  if (!this.recipeHost) this.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(SESSION_URL), moduleUrl: SESSION_URL });
  const level = this.recipeHost.api();
  return [level[0], level[1]];
}

/** --- D12. The level of each major's crate this host builds against: the current one, and older majors shipped beside it. */
function crateLevels(this: Session): ApiLevel[] {
  if (!this.recipeHost) this.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(SESSION_URL), moduleUrl: SESSION_URL });
  return this.recipeHost.levels();
}

/**
 * --- D4. Describe mode: the recipe built and run with `describe: true`. Each typed parameter is declared and gets its
 * default; the run ends at its first call, so nothing reaches the engine. A recipe that read its object and then
 * stopped (an unwrap of None) needs a part.
 */
async function recipeDescribe(this: Session, body: string, limitMs?: number): Promise<{ params: PluginParam[]; target: PluginTarget } | { reason: string }> {
  if (!this.recipeHost) this.recipeHost = new RecipeHost({ crateDir: recipeCrateDir(SESSION_URL), moduleUrl: SESSION_URL });
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
  const start = { describe: true, params: {}, context: { units: "mm", host: "mcp", nativeGeometry: true, limits: { canAssemble: true, canCheckpoint: true, timeLimitS: 15 }, bedMm: [printer.bedX, printer.bedY, printer.bedZ], nozzleMm: this.library.nozzleMm } };
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
function stampRun(this: Session, obj: PlateObject, before: number | null, made: boolean, stamp: Omit<PluginStamp, "fingerprint">, runId = randomUUID().slice(0, 8)): StampedRun | null {
  const tree = obj.tree;
  if (!tree) return null;
  const path = pathTo(tree, tree.current);
  const at = before === null ? -1 : path.indexOf(before);
  const ids = made ? path : at >= 0 ? path.slice(at + 1) : [];
  if (ids.length === 0) return null;
  const fingerprint = tree.nodes.get(tree.current)?.fingerprint ?? obj.solid?.fingerprint ?? null;
  obj.tree = markedRun(tree, ids, runId, { ...stamp, fingerprint });
  return runEndingAt(obj.tree, tree.current);
}

/**
 * --- Plugin steps (D9). The code a stamp names, by its hash: the project's own copy, else the library's file of that
 * hash (the current version or an older `<plugin>.vN.rs`), else a draft's kept source. A sentence when none is there,
 * when the project's copy was edited, or when the code needs a newer recipe API.
 */
function stampSource(this: Session, stamp: PluginStamp): { body: string; notes: string[]; title?: string; target?: PluginTarget; api?: string; ingredients?: Record<string, KeptIngredient> } | { reason: string; code?: ApiRefusalCode } {
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
    const verdict = apiVerdict(file.header.api, this.crateLevels());
    if (!verdict.ok) return { reason: verdict.reason, code: verdict.code };
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
  crateLevels,
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
