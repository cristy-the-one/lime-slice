/** The Plugins panel: Preview, Apply, Use vN, and Save as plugin. */
import { boundsOf, encodeStl, settleBy } from "../../mesh-place";
import { newSolidPose, typedPoseOf } from "../../model-space";
import { markProjectDirty } from "../../project-dirty";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { jumped, withNode, type ModelTree, type NodeId, type PlateMesh } from "../../model-tree";
import { gotoRequest } from "../../model-request";
import { bodySha256, pluginFileText, type PluginParamInfo, type PluginTarget } from "../../plugin-file";
import { RECIPE_API, runsOnPath } from "../../plugin-step";
import { freshRunId } from "../../recipe/rebuild";
import type { RunPart } from "../../recipe/app-calls";
import { builtText, inlineIngredients } from "../../recipe/ingredients";
import { carriedDataProblem, splitPluginData, withPluginData, type CarriedData } from "../../recipe/plugin-data";
import { recipeRuntime, RECIPES_NEED_APP } from "../../recipe/runtime";
import { runPluginFresh } from "../../recipe/apply";
import {
  loadLibrary,
  pluginAuthor,
  pluginLibrary,
  pluginsPanelOpen,
  setPluginAuthor,
  type PluginRunResult,
} from "../../ui/plugins-panel";
import {
  carriedValues,
  droppedSentence,
  libraryIo,
  oneLine,
  savePlan,
  DESCRIPTION_MAX,
  TITLE_MAX,
  type FormValue,
  type PanelPlugin,
} from "../../plugins/library";
import { setModelCardPreview } from "../../ui/model-chrome";
import { readRow, type RowKey } from "../../model-history";
import { addedSolid, meshTokenOf, modelPoseOf, setMeshSeat } from "../../plate";
import { place } from "../files";
import { flushEdit, markModelEdit, noteEdit } from "../history";
import { modelTrees } from "../model-trees";
import { applySelectedToState, syncPlateFromState } from "../plate-sync";
import { session, state } from "../state";
import { GLOBAL_WORKPLANE } from "../../workplane";
import { S } from "./shared";
import { keepSolid } from "./apply";
import { commitModel } from "./commit";
import { plateBoxes } from "./create";
import { treeOf } from "./edges";
import { dropInEngine, post, treeCall } from "./engine";
import { noteMadeObject } from "./history";
import { noteParametersBuilt } from "./parameters";
import { about, readout } from "./pick";
import { forgetPlaceSteps } from "./place";
import { foldHead, keepRunTrees, keptIngredients, platePlaceOf, rebuildPluginRow, recipeEnv } from "./plugins";
import { sentence } from "./run-edit";
import { type Opened, STILL_WORKING, VIEW_ONLY } from "./shared";
import { syncUndo } from "./undo";
import { present } from "./view";
import { forgetWorkplaneSteps, openObject } from "./workplane";

/** D9's Use vN: rebuild the row's plugin step with the library's current version of the plugin. Never automatic. */
export async function useLibraryVersion(row: RowKey): Promise<RowKey | null> {
  const tree = treeOf(S.open);
  const step = readRow(foldHead(row));
  const run = tree && step && step.via.length === 0 ? runsOnPath(tree).find((item) => item.ids.includes(step.id) && item.stamp) : undefined;
  const stamp = run?.stamp;
  if (!stamp) {
    readout("This step is no longer in the history.");
    return null;
  }
  const lib = pluginLibrary().plugins.get(stamp.plugin);
  if (!lib || lib.file.version <= stamp.version) {
    readout(`Your library has no newer version of ${stamp.plugin}. Open the Plugins panel to read the library again.`);
    return null;
  }
  const { params, dropped } = carriedValues(stamp.params, lib.file.params);
  return rebuildPluginRow(row, {}, false, { file: lib.file, sha256: lib.sha256, params, note: droppedSentence(dropped, lib.file.version) });
}

/** The panel's preview on screen: the step it was built on, so a new run or the card closing takes it off. */
let pluginPreviewOn = false;

export function clearPluginPreview() {
  if (!pluginPreviewOn) return;
  pluginPreviewOn = false;
  setModelCardPreview(null);
}

const NEEDS_PART = "This plugin changes a part, and none is open. Select a part in the objects list, then open it in Model.";

/**
 * The Plugins panel's run. A plugin that needs a part, or may take one, runs on the part on screen from its shown step;
 * one that makes its own part (or may, with nothing open) runs with no part. A preview shows the run's solid in place of
 * the part and takes the whole run back; an apply keeps it as one History row (or one new object), stamped, and the
 * project keeps the plugin's code. What the window cannot answer yet comes back as the call's own sentence.
 */
export async function runPanelPlugin(plugin: PanelPlugin, params: Record<string, FormValue>, mode: "preview" | "apply"): Promise<PluginRunResult> {
  const at = S.open;
  const tree = treeOf(at);
  const onPart = plugin.file.target === "object" || (plugin.file.target === "either" && !!at && !!tree);
  if (state.stage !== "model") return { ok: false, reason: "Plugins run in the Model tab. Open Model, then run it again." };
  if (onPart && (!at || !tree)) return { ok: false, reason: NEEDS_PART };
  if (S.busy || S.jumping || S.editing || S.rebuilding) return { ok: false, reason: STILL_WORKING };
  if (onPart && !at!.solid.editable) return { ok: false, reason: VIEW_ONLY };
  if (onPart && S.lens) return { ok: false, reason: "History shows an earlier step. Click the last step in History, then run the plugin." };
  // A kept plugin carries its ingredients inside (`mod ingredients`); one that imports them from the library runs over MCP.
  const resolved = inlineIngredients(splitPluginData(plugin.file.body).code, (ref) => ({ reason: `${plugin.file.title} imports the ingredient ${ref.module} from your library, which the window does not build in yet. Run it over MCP (recipe_run {plugin}).` }));
  if ("reason" in resolved) return { ok: false, reason: resolved.reason };
  const recipes = await recipeRuntime();
  if (!recipes) return { ok: false, reason: RECIPES_NEED_APP };
  const obj = onPart ? openObject() : undefined;
  if (onPart && !obj) return { ok: false, reason: NEEDS_PART };
  clearPluginPreview();
  const from = onPart ? tree!.current : null;
  const mine = S.ticket;
  const title = plugin.file.title;
  S.busy = true;
  syncUndo();
  readout(mode === "preview" ? `Previewing ${title}…` : `Running ${title}…`);
  const started = performance.now();
  let result: Awaited<ReturnType<typeof runPluginFresh>>;
  try {
    result = await runPluginFresh({
      part: onPart ? { id: at!.objectId, name: obj!.name, tree: tree!, pose: typedPoseOf({ modelPose: modelPoseOf(obj!), frame: obj!.frame }), modelPose: modelPoseOf(obj!), workplane: obj!.workplane ?? GLOBAL_WORKPLANE, frame: "model", place: platePlaceOf(obj!) } : null,
      plugin: { id: plugin.file.plugin, version: plugin.file.version, sha256: plugin.sha256, api: plugin.file.api },
      body: plugin.file.body,
      suffix: resolved.suffix,
      params,
      context: { bedMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ], nozzleMm: state.profile.nozzleDiameter ?? 0.4 },
      recipes,
      engine: { tree: (key, node, request) => treeCall(key, node, request), open: (request) => post(request) },
      env: recipeEnv(at?.objectId ?? "", false, plugin.sha256),
      runId: freshRunId(),
    });
  } finally {
    if (mine === S.ticket) S.busy = false;
    syncUndo();
  }
  const ms = performance.now() - started;
  /** The run leaves the engine: the given part's steps drop (their ids stay taken), and the trees it opened close. */
  const takeBack = async (trace: { dropFrom?: NodeId; nextId?: number; close?: string[] }) => {
    if (at && onPart) {
      const now = modelTrees.get(at.key);
      if (now && trace.nextId !== undefined && trace.nextId > now.nextId) modelTrees.set(at.key, { ...now, nextId: trace.nextId });
      if (from !== null) await treeCall(at.key, from, gotoRequest(at.key, from, state.stepTolerance));
      if (trace.dropFrom !== undefined) await dropInEngine(at.key, trace.dropFrom);
    }
    for (const key of trace.close ?? []) void post({ call: "close", key });
  };
  if (!result.ok) {
    await takeBack(result);
    const where = result.line !== undefined && !/line \d+/.test(result.reason) ? ` (line ${result.line})` : "";
    const reason = `${title} did not run: ${sentence(result.reason)}${where}${onPart ? " The part is as it was." : ""}`;
    readout(reason);
    return { ok: false, reason };
  }
  const parsed = decodeSolid(result.body);
  const moved = mine !== S.ticket || state.stage !== "model" || (onPart && S.open?.key !== at!.key);
  if (mode === "preview" || typeof parsed === "string" || moved) {
    // A preview, or a run the person moved away from: nothing is kept, and the run leaves the engine.
    await takeBack(result);
    if (typeof parsed === "string") return { ok: false, reason: parsed };
    if (mode !== "preview" || moved || !pluginsPanelOpen()) return { ok: false, reason: "The part changed while the plugin ran, so nothing was kept. Run it again." };
    pluginPreviewOn = true;
    setModelCardPreview(parsed);
    const text = `Preview of “${title}”${result.made ? ", a new part" : ""}: ${about(parsed)} Nothing is kept until you Apply.`;
    readout(text);
    return { ok: true, ms, text };
  }
  // D7: the project carries the code its plugin steps name, so it rebuilds where the library lacks it.
  if (!session.plugins?.[plugin.sha256]) session.plugins = { ...(session.plugins ?? {}), [plugin.sha256]: plugin.file.text };
  const values = Object.entries(params).map(([name, value]) => `${plugin.file.params.find((p) => p.name === name)?.label?.trim() || name} ${String(value)}`).join(", ");
  const notes = result.notes.filter((note) => !/^line \d+: /.test(note)).map((note) => ` ${sentence(note)}`).join("");
  if (result.made) {
    // A new part: a plate object of its own, stamped on its root, one Prepare step that Undo takes back.
    if (at && onPart) await takeBack({ ...(result.dropFrom !== undefined ? { dropFrom: result.dropFrom } : {}), ...(result.nextId !== undefined ? { nextId: result.nextId } : {}) });
    const name = result.made.name || title;
    const made = addMadeObject(result.made, result.tree, parsed, name);
    keepRunTrees(made, result.others);
    markProjectDirty();
    const text = `Applied “${title}” v${plugin.file.version}${values ? ` with ${values}` : ""}: ${name}, a new part, which Undo takes back. ${about(parsed)}${notes}`;
    present(parsed, text);
    return { ok: true, ms, text };
  }
  modelTrees.set(at!.key, result.tree);
  keepSolid(at!.key, parsed.id, state.stepTolerance, parsed);
  keepRunTrees(at!, result.others);
  S.open = { ...at!, solid: parsed };
  S.editBack = { key: at!.key, tip: parsed.id, back: from!, undone: false };
  markProjectDirty();
  const text = `Applied “${title}” v${plugin.file.version}${values ? ` with ${values}` : ""}: one step in History, which Undo takes back. ${about(parsed)}${notes}`;
  present(parsed, text);
  noteParametersBuilt();
  return { ok: true, ms, text };
}

/** A part a plugin made, as a new plate object beside the others (or where the run placed it), shown in Model. */
function addMadeObject(made: RunPart, tree: ModelTree, parsed: ParsedSolid, name: string): Opened {
  const others = plateBoxes();
  commitModel();
  forgetPlaceSteps();
  forgetWorkplaneSteps();
  flushEdit();
  noteEdit();
  syncPlateFromState();
  const first = state.plate.objects.length === 0;
  const unique = uniqueName(name, state.plate.objects.map((obj) => obj.name));
  const positions = new Float32Array(parsed.positions);
  const seat = settleBy(positions);
  const fileName = `${unique}.stl`;
  const bytes = encodeStl(positions, fileName);
  setMeshSeat(bytes, seat);
  const mesh: PlateMesh = { name: fileName, bytes, sourcePos: positions, token: meshTokenOf(bytes) };
  const pose = made.posed ? made.modelPose : newSolidPose(others, boundsOf(positions));
  const { bedX, bedY } = state.profile;
  state.plate = addedSolid(state.plate, { name: unique, fileName, bytes, sourcePos: positions, stepTolerance: state.stepTolerance }, made.id, tree.key, pose, bedX, bedY);
  applySelectedToState(state.plate);
  modelTrees.set(tree.key, { ...withNode(tree, tree.current, { mesh }), committed: tree.current });
  keepSolid(tree.key, tree.current, state.stepTolerance, parsed);
  place(first ? "load" : "transform");
  flushEdit();
  markModelEdit();
  noteMadeObject(made.id);
  S.ticket += 1;
  S.picks = [];
  S.parked = null;
  S.shownFor = made.id;
  S.open = { objectId: made.id, key: tree.key, solid: parsed };
  return S.open;
}

/** `name`, or `name 2`, `name 3`, … when the plate has it. */
function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n += 1) if (!taken.includes(`${name} ${n}`)) return `${name} ${n}`;
}

/**
 * --- D1, D3. Save as plugin…: a draft (a recipe run nobody kept) goes into the library. The save checks it as the MCP
 * does: a describe run for its parameters (declared before the first call), then a run with its defaults on the part
 * at the step before the draft's run, taken back. Then the file is written, the draft's stamps on the plate's parts
 * become the plugin's, and the project keeps the file.
 */
export async function savePluginRow(row: RowKey, words: { title: string; description: string; author: string }): Promise<{ text: string } | { reason: string }> {
  const at = S.open;
  const tree = treeOf(at);
  const step = readRow(foldHead(row));
  const run = tree && step && step.via.length === 0 ? runsOnPath(tree).find((item) => item.ids.includes(step.id) && item.stamp) : undefined;
  const stamp = run?.stamp;
  if (!at || !tree || !run || !stamp) return { reason: "This step is no longer in the history. Close the dialog and pick the step again." };
  if (stamp.version > 0) return { reason: "This step is already a plugin's. Its library file is in the Plugins panel." };
  const source = S.pluginEnvNow?.drafts.get(stamp.sha256);
  if (source === undefined) return { reason: "This project does not carry the recipe's code, so it cannot be kept. Run it again over MCP, then save it." };
  if (S.busy || S.jumping || S.editing || S.rebuilding) return { reason: STILL_WORKING };
  const title = oneLine(words.title, TITLE_MAX);
  if (!title) return { reason: "A plugin needs a title. Type one line, at most 60 characters." };
  // --- I11. A plugin stays one file: the ingredients the draft built with go inside it, as the MCP's keep puts them.
  const kept = keptIngredients(stamp.sha256);
  const lf = source.replace(/\r\n?/g, "\n").replace(/^\n+/, "");
  const inlined = inlineIngredients(lf, (ref, key) => kept[key] ?? { reason: `This recipe imports the ingredient ${ref.module}, and this project keeps no copy of it. Keep it over MCP: nugget {action: "save", kind: "plugin", from}.` });
  if ("reason" in inlined) return { reason: inlined.reason };
  const body = builtText(lf, inlined.suffix);
  const bad = body.split("\n").findIndex((line) => /^\s*(mod\s+\w+\s*;|#\s*\[\s*path\b|extern\s+crate\s+(?!lime_recipe\b))/.test(line));
  if (bad >= 0) return { reason: `A plugin is one file against lime_recipe, and line ${bad + 1} brings in another file or crate. Remove it, then save again.` };
  const io = await libraryIo();
  if (!io) return { reason: "Saving a plugin needs the desktop app, which reads your plugin library." };
  const recipes = await recipeRuntime();
  if (!recipes) return { reason: RECIPES_NEED_APP };
  // D3, part one: the describe run.
  const built = await recipes.build("plugin_check", body, false);
  if (!built.ok || !built.exe) {
    const first = built.diagnostics[0];
    return { reason: `This recipe does not build: ${built.reason ?? (first ? `line ${first.line}: ${first.message}` : "lust gave no reason.")} Change the code, then keep it.` };
  }
  const context = { units: "mm", bedMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ], nozzleMm: state.profile.nozzleDiameter ?? 0.4 };
  const described = await recipes.run(built.exe, { describe: true, params: {}, context }, async () => ({ ok: false, error: "Describe mode makes no calls." }));
  if (!described.ok || !described.described) return { reason: `This plugin does not describe its values: ${sentence(described.reason ?? "the run ended early.")} Change the code, then keep it.` };
  const params = described.described.params.map((p) => {
    const { line: _line, ...param } = p as Record<string, unknown> & { line?: number };
    return param as unknown as PluginParamInfo;
  });
  const target: PluginTarget = !described.described.readObject ? "new" : described.described.ended ? "either" : "object";
  // D3, part two: a run with the defaults, taken back: on the part as it stood before the draft's run, or with no part
  // for a plugin that makes its own.
  const onPart = target !== "new" && run.before !== null;
  const obj = openObject();
  if (onPart && !obj) return { reason: NEEDS_PART };
  const from = tree.current;
  S.busy = true;
  syncUndo();
  let dry: Awaited<ReturnType<typeof runPluginFresh>>;
  try {
    dry = await runPluginFresh({
      part: onPart ? { id: at.objectId, name: obj!.name, tree: jumped(tree, run.before!), pose: typedPoseOf({ modelPose: modelPoseOf(obj!), frame: obj!.frame }), modelPose: modelPoseOf(obj!), workplane: obj!.workplane ?? GLOBAL_WORKPLANE, frame: "model", place: platePlaceOf(obj!) } : null,
      plugin: { id: stamp.plugin, version: 0, sha256: stamp.sha256, api: stamp.api },
      body,
      params: {},
      context: { bedMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ], nozzleMm: state.profile.nozzleDiameter ?? 0.4 },
      recipes,
      engine: { tree: (key, node, request) => treeCall(key, node, request), open: (request) => post(request) },
      env: recipeEnv(at.objectId, false, stamp.sha256),
      runId: freshRunId(),
    });
  } finally {
    S.busy = false;
    syncUndo();
  }
  if (onPart) {
    const nextId = dry.nextId;
    const now = modelTrees.get(at.key);
    if (now && nextId !== undefined && nextId > now.nextId) modelTrees.set(at.key, { ...now, nextId });
    await treeCall(at.key, from, gotoRequest(tree.key, from, state.stepTolerance));
    if (dry.dropFrom !== undefined) await dropInEngine(at.key, dry.dropFrom);
  }
  for (const key of dry.close ?? []) void post({ call: "close", key });
  if (!dry.ok) return { reason: `This plugin does not build with its own defaults: ${sentence(dry.reason)} Change the defaults or the code, then keep it.` };
  // A plugin carries the recipe data its draft read, as the MCP's keep carries it, so it runs where the workspace is not.
  const data = keptDataRows(stamp.sha256);
  const tooLarge = carriedDataProblem(data);
  if (tooLarge) return { reason: tooLarge };
  const file = withPluginData(body, data);
  const sha256 = await bodySha256(file);
  const library = await loadLibrary();
  const plan = savePlan(library, title, sha256, stamp.plugin);
  const author = oneLine(words.author, 60) || pluginAuthor() || "unknown";
  if (words.author.trim() && !pluginAuthor()) await setPluginAuthor(words.author.trim());
  const text = pluginFileText({ plugin: plan.id, title, version: plan.version, description: oneLine(words.description, DESCRIPTION_MAX), author, api: RECIPE_API.join("."), sha256, created: new Date().toISOString().slice(0, 10), target, params }, file);
  let path: string;
  try {
    path = await io.save(plan.id, text);
  } catch (err) {
    return { reason: `The plugin could not be written: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The draft's stamps on the plate's parts become the plugin's (as the MCP's keep does), and the project keeps the file.
  for (const [key, each] of modelTrees) {
    let next = each;
    for (const node of each.nodes.values()) {
      if (node.plugin && node.plugin.version === 0 && node.plugin.sha256 === stamp.sha256) next = withNode(next, node.id, { plugin: { ...node.plugin, plugin: plan.id, version: plan.version, sha256, api: RECIPE_API.join(".") } });
    }
    if (next !== each) modelTrees.set(key, next);
  }
  session.plugins = { ...(session.plugins ?? {}), [sha256]: text };
  markProjectDirty();
  await loadLibrary();
  syncUndo();
  const said = `Saved “${title}” as plugin ${plan.id} v${plan.version}${plan.same ? " (the library already had this code)" : ""}: ${path}. The Plugins panel lists it, and agents find it with plugin list.`;
  readout(said);
  return { text: said };
}

/** The recipe data a draft of this code kept, with each file's hash and size: what a plugin saved from it carries. */
function keptDataRows(sha256: string): Record<string, CarriedData> {
  const out: Record<string, CarriedData> = {};
  for (const [name, row] of Object.entries(keptRecipeData(sha256) ?? {})) {
    const r = row as { value: unknown; sha256?: unknown; bytes?: unknown };
    if (typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) && typeof r.bytes === "number") out[name] = { sha256: r.sha256, bytes: r.bytes, value: r.value };
  }
  return out;
}

/** Recipe data a draft of this code kept (`data {name}`), for the plugin to read again. */
export function keptRecipeData(sha256: string): Record<string, { value: unknown }> | undefined {
  const rust = (session.mcpModel as { rustRecipes?: Record<string, { sha256?: unknown; data?: unknown }> } | undefined)?.rustRecipes;
  const row = rust ? Object.values(rust).find((entry) => entry?.sha256 === sha256 && entry.data && typeof entry.data === "object") : undefined;
  return row ? (row.data as Record<string, { value: unknown }>) : undefined;
}
