/** Plugin runs: the environment, the rebuild of a plugin row, and the swap back. */
import { type Mat3 } from "../../mesh-place";
import { typedPoseOf } from "../../model-space";
import { markProjectDirty } from "../../project-dirty";
import { decodeSolid, type ParsedSolid } from "../../model-reply";
import { pathTo, withNode, type ModelTree, type NodeId } from "../../model-tree";
import type { PluginValue } from "../../model-tree";
import { syncPluginSteps } from "../../ui/model-history";
import { bodySha256, checkedCopies, type PluginFileInfo } from "../../plugin-file";
import { runsOnPath } from "../../plugin-step";
import { freshRunId, rebuildPluginStep } from "../../recipe/rebuild";
import type { AppRunEnv, RunPart } from "../../recipe/app-calls";
import { inlineIngredients, keptCopy, type KeptIngredient } from "../../recipe/ingredients";
import { splitPluginData } from "../../recipe/plugin-data";
import type { PlatePlace } from "../../modeling/placing";
import { cleanOp } from "../../modeling/compose";
import { readPartition } from "../../../mcp/partition";
import { recipeRuntime, RECIPES_NEED_APP } from "../../recipe/runtime";
import { pluginLibrary } from "../../ui/plugins-panel";
import { approveFirstRun, needsFirstRun } from "../../ui/plugin-import";
import { type PluginLibrary } from "../../plugins/library";
import { draftSources, readRow, rowKey, stepLabel, type PluginEnv, type RowKey } from "../../model-history";
import { freshPlateId, modelPoseOf, withModelPose, type PlateObject } from "../../plate";
import { place } from "../files";
import { flushEdit, markModelEdit, newestEdits, noteEdit, redoUserEdit, undoUserEdit } from "../history";
import { freshTreeKey, modelTrees } from "../model-trees";
import { syncPlateFromState } from "../plate-sync";
import { session, state } from "../state";
import { evaluateTable } from "../../modeling/params.ts";
import { printerTarget, selection, targetPrinter } from "../../ui/machine-library.ts";
import { plateUp, storedPartition } from "../../split-print.ts";
import { loadMachineLibrary } from "../machine-library.ts";
import { GLOBAL_WORKPLANE } from "../../workplane";
import { S } from "./shared";
import { keepSolid } from "./apply";
import { commitModel, meshOf } from "./commit";
import { addPiece } from "./create";
import { treeOf } from "./edges";
import { dropInEngine, mm, post, treeCall } from "./engine";
import { setBrep } from "./export";
import { showModel } from "./lifecycle";
import { noteParametersBuilt } from "./parameters";
import { about, readout } from "./pick";
import { keptRecipeData } from "./plugin-panel";
import { sentence } from "./run-edit";
import { type LibrarySwap, type Opened, STILL_WORKING, VIEW_ONLY } from "./shared";
import { partitionContext } from "./split-print";
import { setTreeKey } from "./tree";
import { syncUndo } from "./undo";
import { present } from "./view";
import { openObject } from "./workplane";

export function syncPluginEnv() {
  const plugins = session.plugins;
  const mcpModel = session.mcpModel;
  if (S.pluginEnvFor && S.pluginEnvFor[0] === plugins && S.pluginEnvFor[1] === mcpModel) return;
  S.pluginEnvFor = [plugins, mcpModel];
  const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
  const library = pluginLibrary();
  void checkedCopies(plugins).then((copies) => {
    if (S.pluginEnvFor?.[0] !== plugins || S.pluginEnvFor?.[1] !== mcpModel) return;
    S.pluginEnvNow = { copies, drafts: draftSources(mcpModel), mac, ...(library.dir ? { library: libraryEnv(library) } : {}) };
    syncPluginSteps(S.pluginEnvNow);
  });
}

/** --- Milestone 7. What History reads of the library: every version by hash, and each plugin's current version. */
function libraryEnv(library: PluginLibrary): NonNullable<PluginEnv["library"]> {
  return { bySha: library.bySha, current: new Map([...library.plugins].map(([id, row]) => [id, { version: row.file.version, sha256: row.sha256 }])) };
}

/** The plugins this project carries, read, by hash: the Plugins panel's "In this project". */
export function projectPluginFiles(): Map<string, PluginFileInfo> {
  const out = new Map<string, PluginFileInfo>();
  for (const [sha, copy] of S.pluginEnvNow?.copies ?? []) if (copy.file && copy.intact) out.set(sha, copy.file);
  return out;
}

/**
 * --- Plugin steps (docs/plan-recipe-plugins.md D8, milestone 6). The card's Rebuild: the plugin runs again with the
 * changed values from the step before its run, through the app's recipe runner, the steps after it are built again,
 * and the part shows the new branch. The old branch stays as it was, so one Undo goes back to the old values. A run
 * that fails leaves the part as it was and says why.
 */
export async function rebuildPluginRow(row: RowKey, changes: Record<string, PluginValue | null>, edited: boolean, swap?: LibrarySwap): Promise<RowKey | null> {
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || state.stage !== "model") return null;
  if (S.busy || S.jumping || S.editing || S.rebuilding) {
    readout(STILL_WORKING);
    return null;
  }
  if (!at.solid.editable) {
    readout(VIEW_ONLY);
    return null;
  }
  const step = readRow(foldHead(row));
  const run = step && step.via.length === 0 ? runsOnPath(tree).find((item) => item.ids.includes(step.id) && item.stamp) : undefined;
  if (!run?.stamp) {
    readout("This step is no longer in the history.");
    return null;
  }
  const stamp = run.stamp;
  const env = S.pluginEnvNow;
  // --- Milestone 7, D9: a copy the project lacks may be in the library (the current file or `<id>.vN.rs`).
  const libraryCopy = env?.copies.has(stamp.sha256) ? undefined : env?.library?.bySha.get(stamp.sha256);
  const copy = env?.copies.get(stamp.sha256) ?? (libraryCopy ? { file: libraryCopy, intact: true } : undefined);
  const draft = env?.drafts.get(stamp.sha256);
  const title = swap?.file.title || copy?.file?.title || stamp.plugin;
  let body: string;
  if (swap) {
    body = swap.file.body;
  } else if (copy?.file) {
    if (!copy.intact && !edited) {
      readout("This project's copy of the plugin was changed outside the app. Rebuild asks before it runs the changed code.");
      return null;
    }
    body = copy.file.body;
  } else if (draft !== undefined) {
    body = draft;
  } else {
    readout("The plugin source is not in this project. The part is kept as built; its values cannot change.");
    return null;
  }
  // --- Milestone 8, D11.6: a plugin from someone else (marked imported, or a project's copy the library lacks) shows its
  // code before its first run here.
  const shown = swap ? { file: swap.file, sha: swap.sha256 } : copy?.file ? { file: copy.file, sha: stamp.sha256 } : null;
  if (shown && needsFirstRun(shown.file, shown.sha, pluginLibrary()) && !(await approveFirstRun(shown.file, shown.sha, libraryCopy ? undefined : "this project"))) {
    readout(`Not rebuilt: ${title} runs once you press Run in the view of its code.`);
    return null;
  }
  // --- I10. A draft's ingredients: the copies its last apply built, which the project keeps with it, inlined as the
  // MCP host inlines them (a kept plugin carries its own `mod ingredients`).
  const kept = keptIngredients(stamp.sha256);
  const resolved = inlineIngredients(splitPluginData(body).code, (ref, key) => kept[key] ?? { reason: `${title} imports the ingredient ${ref.module}${ref.version !== undefined ? ` v${ref.version}` : ""}, and this project keeps no copy of it. Change its values over MCP (recipe_run with this part), where the library is read.` });
  if ("reason" in resolved) {
    readout(resolved.reason);
    return null;
  }
  const recipes = await recipeRuntime();
  if (!recipes) {
    readout(RECIPES_NEED_APP);
    return null;
  }
  const obj = openObject();
  if (!obj) return null;
  const from = tree.current;
  const mine = S.ticket;
  const madeIt = run.before === null;
  S.busy = true;
  syncUndo();
  readout(`Rebuilding ${title}…`);
  let result: Awaited<ReturnType<typeof rebuildPluginStep>>;
  try {
    result = await rebuildPluginStep({
      part: { id: at.objectId, name: obj.name, tree, pose: typedPoseOf({ modelPose: modelPoseOf(obj), frame: obj.frame }), modelPose: modelPoseOf(obj), workplane: obj.workplane ?? GLOBAL_WORKPLANE, frame: "model", place: platePlaceOf(obj) },
      run: { ...run, stamp },
      body,
      suffix: resolved.suffix,
      // A null change drops a picked face or outline back to the plugin's default (API 1.2).
      params: swap ? swap.params : (Object.fromEntries(Object.entries({ ...stamp.params, ...changes }).filter(([, v]) => v !== null)) as Record<string, PluginValue>),
      context: { bedMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ], nozzleMm: state.profile.nozzleDiameter ?? stamp.context.nozzleMm },
      recipes,
      engine: { tree: (key, node, request) => treeCall(key, node, request), open: (request) => post(request) },
      env: recipeEnv(at.objectId, madeIt, stamp.sha256),
      runId: freshRunId(),
    });
  } finally {
    if (mine === S.ticket) S.busy = false;
    syncUndo();
  }
  if (!result.ok) {
    // The attempt's steps leave the engine, and their ids stay taken, as a cancelled edit's do; its new trees close.
    const now = modelTrees.get(at.key);
    if (now && result.nextId !== undefined && result.nextId > now.nextId) modelTrees.set(at.key, { ...now, nextId: result.nextId });
    if (result.dropFrom !== undefined) await dropInEngine(at.key, result.dropFrom);
    for (const key of result.close ?? []) void post({ call: "close", key });
  }
  if (mine !== S.ticket || S.open?.key !== at.key || state.stage !== "model") return null;
  if (!result.ok) {
    const where = result.line !== undefined && !/line \d+/.test(result.reason) ? ` (line ${result.line})` : "";
    readout(`${title} was not rebuilt: ${sentence(result.reason)}${where} The part is as it was.`);
    return null;
  }
  const parsed = decodeSolid(result.body);
  if (typeof parsed === "string") {
    readout(parsed);
    return null;
  }
  let next = result.tree;
  // --- D9. The changed copy ran: the stamp names that code, and the project keeps it under its own hash.
  if (edited && copy?.file && !copy.intact) {
    const sha = await bodySha256(copy.file.body);
    const first = next.nodes.get(result.ids[0]!);
    if (first?.plugin) next = withNode(next, first.id, { plugin: { ...first.plugin, sha256: sha } });
    session.plugins = { ...(session.plugins ?? {}), [sha]: copy.file.text.replace(/^\/\/! source-sha256: .*$/m, `//! source-sha256: ${sha}`) };
  }
  // --- Milestone 7. Use vN: the new run names the library's version, and the project keeps that code.
  if (swap) {
    const first = next.nodes.get(result.ids[0]!);
    if (first?.plugin) next = withNode(next, first.id, { plugin: { ...first.plugin, version: swap.file.version, sha256: swap.sha256, api: swap.file.api } });
    session.plugins = { ...(session.plugins ?? {}), [swap.sha256]: swap.file.text };
  } else if (libraryCopy) {
    // The code came from the library: the project keeps a copy, so it rebuilds where the library lacks it.
    session.plugins = { ...(session.plugins ?? {}), [stamp.sha256]: libraryCopy.text };
  }
  // Trees the new run's steps name (a split's half, a split to print's pieces, a joined tool) stay, as an Apply's do.
  keepRunTrees(at, result.others);
  if (result.made) swapMadeTree(at, result.made, next, parsed);
  else {
    modelTrees.set(at.key, next);
    keepSolid(at.key, parsed.id, state.stepTolerance, parsed);
    S.open = { ...at, solid: parsed };
    S.editBack = { key: at.key, tip: parsed.id, back: from, undone: false };
  }
  markProjectDirty();
  const label = (id: NodeId) => stepLabel(next.nodes.get(id)!);
  const after = result.replayed === 0 ? "" : result.replayed === 1 ? " and rebuilt the step after it" : ` and rebuilt ${result.replayed} steps after it`;
  const failure = result.broken ? ` Step ${pathTo(next, result.broken.id).length - 1}, “${label(result.broken.id)}”, could not be rebuilt: ${sentence(result.broken.error)} The view shows the last step that built.` : "";
  const values = Object.entries(changes).map(([name, value]) => `${copy?.file?.params.find((p) => p.name === name)?.label?.trim() || name} ${String(value)}`).join(", ");
  const context = stamp.context.nozzleMm !== state.profile.nozzleDiameter && state.profile.nozzleDiameter ? ` Built for a ${mm(stamp.context.nozzleMm)} mm nozzle; this rebuild used ${mm(state.profile.nozzleDiameter)} mm.` : "";
  const notes = result.notes.filter((note) => !/^line \d+: /.test(note)).map((note) => ` ${sentence(note)}`).join("");
  const moved = swap ? ` with v${swap.file.version} from your library` : "";
  present(parsed, `Rebuilt “${title}”${moved}${values ? ` with ${values}` : ""}${after}. ${about(parsed)}${failure}${context}${notes}${swap?.note ? ` ${swap.note}` : ""}`);
  noteParametersBuilt();
  // The run's own row: folded under its first step's key, or that step's row when it is one step.
  const head = rowKey([], result.ids[0]!);
  return result.ids.length > 1 ? `fold:${head}` : head;
}

/** What a plugin run in the window reads besides its part: the printer, the settings, and ids for what it makes. */
export function recipeEnv(objectId: string, madeIt: boolean, sha256: string): AppRunEnv {
  const picked = selection(loadMachineLibrary());
  const printer = picked?.printer;
  // A part the plugin made is made again under its own plate id, so its replies name the part they always named.
  let own = madeIt;
  return {
    chordMm: state.stepTolerance,
    ...(keptRecipeData(sha256) ? { data: keptRecipeData(sha256)! } : {}),
    params: evaluateTable(session.parameters).values,
    printer: { id: printer?.id ?? "plate", name: printer?.name ?? state.profile.name, bedMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ], nozzleMm: state.profile.nozzleDiameter, belt: printer?.kind === "belt" ? printer.belt : null },
    supportAngle: state.supportAngle,
    newPart: () => {
      const id = own ? objectId : freshPlateId();
      own = false;
      return { id, key: freshTreeKey(id) };
    },
    otherPart: (id) => {
      const obj = state.plate.objects.find((row) => row.id === id);
      const tree = obj?.modelTree ? modelTrees.get(obj.modelTree) : undefined;
      if (!obj || !tree) return null;
      return { id: obj.id, name: obj.name, tree, pose: typedPoseOf({ modelPose: modelPoseOf(obj), frame: obj.frame }), modelPose: modelPoseOf(obj), workplane: obj.workplane ?? GLOBAL_WORKPLANE, frame: "model", place: platePlaceOf(obj) };
    },
    pieceKey: (owner, _node, piece) => freshTreeKey(`${owner}-${piece === "half" ? "piece" : piece === "pins" ? "pins" : "part"}`),
    partition: (spec, part) => {
      const typed = readPartition(spec, (id) => {
        const row = targetPrinter(loadMachineLibrary(), id);
        return row ? printerTarget(row) : null;
      });
      if ("reason" in typed) return typed;
      if (!part.solid) return { reason: "This solid could not be read." };
      const stored = storedPartition(typed, partitionContext(part.solid as unknown as ParsedSolid), typedPoseOf(part), { positions: part.solid.positions, up: plateUp(part.place.orient) });
      if ("reason" in stored) return stored;
      return { op: stored.op, typed: cleanOp(spec), ...(stored.notes ? { notes: stored.notes } : {}) };
    },
  };
}

/** The plate place a run reads of `obj`: its mesh, turn, scale and spot. */
export function platePlaceOf(obj: PlateObject): PlatePlace {
  const selected = obj.id === state.plate.selectedId;
  return {
    source: new Float32Array(selected && state.sourcePos ? state.sourcePos : obj.sourcePos),
    orient: [...(selected ? state.orient : obj.orient)] as Mat3,
    scale: selected ? state.partScale : obj.partScale,
    centered: obj.centered,
    offset: { ...obj.offset },
  };
}

/** The copies of the ingredients a draft of this code built with, by key, as the project keeps them. */
export function keptIngredients(sha256: string): Record<string, KeptIngredient> {
  const rust = (session.mcpModel as { rustRecipes?: Record<string, { sha256?: unknown; ingredients?: unknown }> } | undefined)?.rustRecipes;
  const row = rust ? Object.values(rust).find((entry) => entry?.sha256 === sha256 && entry.ingredients && typeof entry.ingredients === "object") : undefined;
  const out: Record<string, KeptIngredient> = {};
  for (const [key, value] of Object.entries((row?.ingredients ?? {}) as Record<string, unknown>)) {
    const copy = keptCopy(value);
    if (copy) out[key] = copy;
  }
  return out;
}

/**
 * Trees a rebuilt run left that its steps name: a split's other half goes on the plate as a split's does; a split to
 * print's pieces wait in their trees with their meshes, and the plate takes them when the commit crosses the cut, as
 * after an edit; a joined tool's tree stays for the join, off the plate.
 */
export function keepRunTrees(at: Opened, others: readonly RunPart[]) {
  for (const part of others) {
    const solid = part.body ? decodeSolid(part.body) : null;
    if (!solid || typeof solid === "string") {
      modelTrees.set(part.tree.key, part.tree);
      continue;
    }
    if (part.origin === "half" && part.cut && addPiece(at, solid, part.tree.key, part.cut.node)) continue;
    const held = part.origin === "piece" || part.origin === "pins" || part.origin === "half";
    modelTrees.set(part.tree.key, held ? { ...withNode(part.tree, part.tree.current, { mesh: meshOf(solid, `${part.name}.stl`) }), committed: part.tree.current } : part.tree);
    keepSolid(part.tree.key, part.tree.current, state.stepTolerance, solid);
  }
}

/** --- A part a plugin made, rebuilt: its new tree, and the Prepare step that put it on the plate, for one Undo back. */
let swapBack: { id: string; key: string; tip: NodeId; step: object | null; undone: boolean } | null = null;

/**
 * A part the plugin made, rebuilt: the plate object keeps its id, name and place, and takes the new tree, shown at its
 * tip and on the plate in one Prepare step, so one Undo goes back to the old tree and its values (D8).
 */
function swapMadeTree(at: Opened, made: RunPart, next: ModelTree, parsed: ParsedSolid) {
  const key = next.key;
  commitModel();
  const mesh = meshOf(parsed);
  modelTrees.set(key, { ...withNode(next, next.current, { mesh }), committed: next.current });
  keepSolid(key, parsed.id, state.stepTolerance, parsed);
  noteEdit();
  syncPlateFromState();
  setTreeKey(at.objectId, key);
  if (made.posed) state.plate = withModelPose(state.plate, at.objectId, made.modelPose);
  state.mesh = { name: mesh.name, bytes: mesh.bytes };
  state.sourcePos = new Float32Array(mesh.sourcePos);
  state.supportEdits = [];
  state.supportPaint = [];
  state.seamPaint = [];
  state.reinforcement = [];
  setBrep(at.objectId, mesh.step);
  syncPlateFromState();
  place();
  flushEdit();
  markModelEdit();
  S.editBack = null;
  S.open = { objectId: at.objectId, key, solid: parsed };
  swapBack = { id: at.objectId, key, tip: next.current, step: newestEdits().undo, undone: false };
}

/** Whether Undo (or Redo) is the swap back to a rebuilt part's old tree (or forward to its new one). */
export function canSwapBack(way: "undo" | "redo"): boolean {
  const swap = swapBack;
  const edits = newestEdits();
  if (!swap || edits.pending || S.open?.objectId !== swap.id) return false;
  if (way === "undo") return !swap.undone && S.open.key === swap.key && treeOf(S.open)?.current === swap.tip && edits.undo === swap.step;
  return swap.undone && edits.redo === swap.step;
}

export function swapStep(way: "undo" | "redo"): boolean {
  if (!canSwapBack(way)) return false;
  const swap = swapBack!;
  if (!(way === "undo" ? undoUserEdit() : redoUserEdit())) return false;
  const edits = newestEdits();
  swapBack = { ...swap, undone: way === "undo", step: way === "undo" ? edits.redo : edits.undo };
  showModel();
  return true;
}

/** A folded run's row is keyed `fold:` and its first step's key: that step's row. */
export function foldHead(row: RowKey): RowKey {
  return row.startsWith("fold:") ? row.slice(5) : row;
}
