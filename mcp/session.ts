/**
 * One stdio connection is one plate. The engine is behind `Engine`.
 * Feasibility refusals are `{ok:false, reason}` and are decided before apply.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { bytesToBase64 } from "../src/base64.ts";
import { fnv1aHex } from "../src/slice-action.ts";
import { ID_MATRIX, placeMesh, type Mat3, type RigidPose } from "../src/mesh-place.ts";
import { boundsOf, type SolidView } from "../src/modeling/model-calls.ts";
import { expandOpsWithTexts, type PartDef } from "../src/modeling/macro.ts";
import { DEFAULT_PRESET, presetKeys, type PresetSettings } from "../src/presets.ts";
import type { LimeProject } from "../src/project.ts";
import { finishProject, prepareProject } from "../src/project-codec.ts";
import { emptyOverrides, type OverrideDocument } from "../src/overrides.ts";
import { parseStressCells, type StressCells } from "../src/sim/stress-cells.ts";
import { patternBlend } from "../src/sim/pattern-patch.ts";
import { resolved } from "../src/strategy.ts";
import { recipeRefusal, simRecipe } from "../src/sim/recipe.ts";
import { chooseStudyMesh, STUDY_MESH_REFUSAL, type StudyMesh } from "../src/sim/study-mesh.ts";
import { beltLayerNormal, cloneStudy, namesFaces, placeRegion, readRegion, type ObjectStudy, type SimRepresentation, type StudyConstraint, type StudyHold, type StudyLoad, type StudyRegion, type Vec3 as SimVec } from "../src/sim/study.ts";
import { LABEL } from "../src/sim/label.ts";
import { readBeadSection, withBeads } from "../src/sim/cards.ts";
import { BEAM_SIZE, OPEN_MESH, SLICED_FIELD, SLICED_SWEEP, RESLICE_BEAM, RESLICE_PARAMETERS, RESLICE_PATTERN_KEEP, SWEEP_CAP, SWEEP_REFUSAL, ZERO_AXIS, axisLength, boxPositions, constraintVerdict, elementRefusal, pageCursor, pageLimit, readLimits, readPatch, representationOf, runSolver, scaleLoads, setupSentence, solverJob, vec3Of, type ConstraintLimits, type SweepPatch } from "./sim.ts";
import type { PrintOrder } from "../src/settings-rules.ts";
import type { LayerAction } from "../src/layer-actions.ts";
import { advanceFor, builtinLibrary, cardsOf, enginePrinter, saveMaterialCard, setAdvance, setFlow, setNozzleTemp, setRetract, type MachineLibrary } from "../src/ui/machine-library.ts";
import { systemOpener, type AppOpener } from "./app-open.ts";
import { mirror, type BridgeLink } from "./bridge-client.ts";
import { ProtocolError, withMesh, type Engine } from "./engine.ts";
import { imagesOf, withImages } from "./inline.ts";
import { RecipeHost } from "./recipe.ts";
import { blendOf, stlBytes } from "./request.ts";
import { guideByUri } from "./guides.ts";
import { GROUP_NAMES, groupOf, groupsOptedIn, TOOL_GROUPS } from "./groups.ts";
import { applyObjectSetting } from "./settings-rows.ts";
import { annotationsFor, EXPRESSION_TOOLS, OP_WORDS, toolByName, validateTool } from "./schema.ts";
import { autosavePath, takePreviousAutosave, writeAutosave, type PreviousAutosave } from "./autosave.ts";
import { withBoxAnchor, isComposite } from "../src/modeling/compose.ts";
import { expressionMentions, isPlainNumber } from "../src/modeling/params.ts";
import type { Assembly } from "../src/assembly.ts";
import { ExprError, resolveNumbers, resolveTexts, substituteNames } from "../src/modeling/expr.ts";
import { resolveWrite } from "./workspace.ts";
import { textsNeedingFonts, UserFontShelf } from "../src/modeling/user-fonts.ts";
import { BAND_KINDS, BEADS_REFUSAL, type CallMeta, DETACHABLE, type Job, LONG_CALLS, PLACE_ON_SMEAR, type PickRow, type PlateObject, type PlateSnap, REGION_SHAPE, type Recipe, type RustRecipe, STALE_FACES, STIFFNESS_KINDS, TARGET_KINDS, type ToolHandler, UNKNOWN_OBJECT, type WorkJob, changedValues, changesPlate, domainRefusal, edgePicksAsTyped, isObject, roundTo, shownName, slicedRunReply, stlFileName, withPicks } from "./session/shared.ts";
import { workMethods } from "./session/work.ts";
import { recipeMethods, recipeHandlers } from "./session/recipe.ts";
import { pluginMethods, pluginHandlers } from "./session/plugin.ts";
import { nuggetMethods, nuggetHandlers } from "./session/nugget.ts";
import { fontsMethods } from "./session/fonts.ts";
import { infoMethods, infoHandlers } from "./session/info.ts";
import { plateMethods, plateHandlers } from "./session/plate.ts";
import { projectMethods, projectHandlers } from "./session/project.ts";
import { machineMethods, machineHandlers } from "./session/machine.ts";
import { settingsMethods, settingsHandlers } from "./session/settings.ts";
import { sliceMethods, sliceHandlers } from "./session/slice.ts";
import { layersMethods, layersHandlers } from "./session/layers.ts";
import { modelMethods, modelHandlers } from "./session/model.ts";
import { placeMethods } from "./session/place.ts";
import { probeMethods } from "./session/probe.ts";
import { applyMethods } from "./session/apply.ts";
import { paramsMethods } from "./session/params.ts";
import { historyMethods } from "./session/history.ts";
import { splitMethods } from "./session/split.ts";
import { paintMethods, paintHandlers } from "./session/paint.ts";

export { typedExprs, STALE_FACES, meshHash } from "./session/shared.ts";
export type { CallMeta, PlateObject, RustRecipe, Recipe } from "./session/shared.ts";

const HANDLERS: Record<string, ToolHandler> = {
  ...recipeHandlers,
  ...pluginHandlers,
  ...nuggetHandlers,
  ...infoHandlers,
  ...plateHandlers,
  ...projectHandlers,
  ...machineHandlers,
  ...settingsHandlers,
  ...sliceHandlers,
  ...layersHandlers,
  ...modelHandlers,
  ...paintHandlers,
  calibration_tower: (s, input) => s.calibrationTower(input),
  calibration_apply: (s, input) => s.calibrationApply(input),
  blend_compare: (s, input) => s.blendCompare(input),
  blend_apply: (s, input) => s.blendApply(input),
  sim_setup: (s, input) => s.simSetup(input),
  sim_run: (s, input) => s.simRun(input),
  sim_field: (s, input) => s.simField(input),
  sim_sweep: (s, input) => s.simSweep(input),
  sim_cancel: () => ({ ok: true, label: LABEL }),
  tools_enable: (s, input) => s.toolsEnable(input),
};

export class Session {
  readonly objects: PlateObject[] = [];
  selected = "";
  settings: PresetSettings = { ...DEFAULT_PRESET };
  actions: LayerAction[] = [];
  library: MachineLibrary = builtinLibrary();
  jobs: Job[] = [];
  running: Job | null = null;
  latest: Job | null = null;
  /** Long calls that went on in the background, newest last; a few finished ones are kept for their wait. */
  workJobs: WorkJob[] = [];
  seq = 0;
  jobSeq = 0;
  readonly engine: Engine;
  sourceProject: LimeProject | null = null;
  sourceHash = "";
  sourcePath = "";
  profileTouched = false;
  lastBridge: Record<string, unknown> | null = null;
  /** The last sliced study's cells, for `layer_image`'s stress and safety colours. */
  stressCells: StressCells | null = null;
  lastPreview: SolidView | null = null;
  undoStack: PlateSnap[] = [];
  redoStack: PlateSnap[] = [];
  bridgeSeq = 0;
  /** This process on the bridge. The desktop starts its sequence again when it changes. */
  readonly bridgeSession = randomUUID();
  readonly bridgeLink: BridgeLink = { known: new Set(), resync: () => this.resyncBridge() };
  readonly meshHashes = new WeakMap<Uint8Array, string>();
  /** STEP solids from projects saved before version 3 that a commit already tried to write again in the binary format. */
  readonly legacySolids = new WeakSet<Uint8Array>();
  /** STEP roots a commit already tried to write as the engine's binary solid, so an engine that cannot is asked once. */
  readonly triedRoots = new WeakSet<ArrayBuffer>();
  generation = 0;
  lastProgressAt = 0;
  overrides: OverrideDocument = emptyOverrides();
  pareto: { label: string; toughness: number; seconds: number; grams: number; score: number }[] = [];
  printOrder: PrintOrder["printOrder"] = "all-at-once";
  clearanceMm = 0;
  gantryMm = 0;
  onProgress: ((job: string, fraction: number, stage: string, token?: string | number) => void) | null = null;
  /** The tool groups enabled, when the server lists groups (the default; LIME_MCP_TOOL_GROUPS=0 lists every tool). */
  toolGroups: Set<string> | null = groupsOptedIn() ? new Set() : null;
  /** Called when tools_enable changes the tool list, so the client is told. */
  onToolsChanged: (() => void) | null = null;
  /** Names model ops may use in place of numbers. Set with model_params; the evaluated values. */
  params: Record<string, number> = {};
  /**
   * --- A6. The same table as typed: a number, or an expression. Saved as the project's `parameters`.
   * `params` is this table evaluated, which is what ops and `model_params` return.
   */
  paramText: Record<string, string | number> = {};
  /** Plate objects held at poses relative to each other, as the project file keeps them (`src/assembly.ts`). */
  assemblies: Assembly[] = [];
  /** Parts model_define stored, which an op list places with {kind: "use"}. */
  parts = new Map<string, PartDef>();
  /**
   * Tools a join took off the plate, as the desktop does: not printed, not listed, but their trees stay open, since
   * an edit that replays the join builds the tool again, and a save keeps them as the project's modelTools.
   */
  toolsOffPlate: PlateObject[] = [];
  /**
   * --- Split to print. Pieces of a split to print that is not on the way to its part's current step: model_undo above
   * it takes them off the plate, and a redo brings them back (D9). Not saved.
   */
  piecesOffPlate: PlateObject[] = [];
  /** recipe_run's builder and runner, made on its first call. */
  recipeHost: RecipeHost | null = null;
  /** recipe_run sources by name, with the parameters and objects of their last apply. Saved with the project. */
  rustRecipes = new Map<string, RustRecipe>();
  /**
   * --- Plugin steps (D7). The project's own copy of each plugin its stamped steps name, by the body's SHA-256: the
   * whole file as the project carried it. Read on open, written on save with the copies the library still has.
   */
  projectPlugins = new Map<string, string>();
  /**
   * --- Text milestone 4. The fonts of the person's this project's texts use: added by a text's `fontFile`, or carried by the
   * project that was opened (`projectFonts`, as its file held them). A text names one by id, or by its name.
   */
  readonly fonts = new UserFontShelf(async (request) => JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify(request)))) as Record<string, unknown>);
  projectFonts: LimeProject["fonts"];
  /** Recipes running now: their calls are recipe_run's, so the tool groups do not gate them. */
  recipeDepth = 0;
  /** The MCP client's name from initialize: a kept plugin's made-by. */
  clientName: string | undefined;
  /** Applies of recipe_run in this session, counted: a draft's `at`. */
  recipeSeq = 0;
  recipeApi: [number, number] | null = null;
  lustId: string | undefined;
  /** I21: each recipe name's call count on its last run, for "call N of about M". */
  readonly recipeCallCounts = new Map<string, number>();
  /** The recipe of the model_build being called, kept from before its ops were expanded. */
  pendingRecipe: Recipe | null = null;
  /**
   * --- D25, gaps A1–A3. The call's ops as typed, each a twin of its resolved op with every expression kept as text in
   * the project's names (`resolveTexts`), by op index after each and use expand; the base's for model_build. Set before
   * the numbers resolve, read by whatever applies the ops, so each stored step links to what it was typed with.
   */
  pendingTexts: unknown[] = [];
  pendingBaseText: unknown = undefined;
  /** Expressions of the call being run that no stored number could follow, and the op being linked. */
  notLinked: { op?: number; field: string; text: string }[] = [];
  linkingOp: number | undefined = undefined;
  /** --- Gaps A4. Call-level params a model_build gave for names the project already has: this call only. */
  pendingOneOff: string[] = [];

  /** How app_open reaches the desktop app. Tests replace it. */
  appOpener: AppOpener = systemOpener;

  /** The autosave a previous server left in the workspace, offered until this session has a plate of its own. */
  previousAutosave: PreviousAutosave | null = null;
  startupChecked = false;
  autosaveDirty = false;
  autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  autosaveWriting: Promise<void> = Promise.resolve();
  inflight = 0;
  /** The progress token and cancel signal of the call each piece of work belongs to. */
  readonly callContext = new AsyncLocalStorage<CallMeta>();
  /** --- I8. The faces each call's selectors resolved to, for its reply and its refusal. */
  readonly pickLog = new AsyncLocalStorage<PickRow[]>();

  /** When this server started, for a reply about a job an earlier server ran. */
  readonly startedAt = new Date().toISOString();

  /** Each object Joint down turned, by id, and the orientation it had before: Keep, and a step above the cut, put it back. */
  keptOrients = new Map<string, Mat3>();

  jointed = new Set<string>();

  constructor(engine: Engine) {
    this.engine = engine;
  }

  call(name: string, args: unknown, meta?: CallMeta): Promise<Record<string, unknown>> {
    if (!this.startupChecked) {
      this.startupChecked = true;
      this.previousAutosave = takePreviousAutosave();
    }
    const busy = this.busyRefusal(name);
    if (busy) return Promise.resolve(busy);
    if (name === "plan_run") return this.planRun(args, meta);
    return this.runCall(name, args, meta, false);
  }

  /**
   * One tool call: numbers, validation, the autosave, the bridge mirror. A step of a plan runs here too, with inPlan:
   * it never detaches on its own (the plan does, as a whole) and is not refused for the plan's own background job.
   */
  runCall(name: string, args: unknown, meta: CallMeta | undefined, inPlan: boolean): Promise<Record<string, unknown>> {
    const opened = this.openGroupFor(name);
    const done = this.runOpenCall(name, args, meta, inPlan);
    // The spread drops the non-enumerable inline images (layer_image, render_view), so carry them over.
    return opened ? done.then((value) => withImages({ ...value, groupOpened: opened }, imagesOf(value))) : done;
  }

  runOpenCall(name: string, args: unknown, meta: CallMeta | undefined, inPlan: boolean): Promise<Record<string, unknown>> {
    const numbered = this.withNumbers(name, args);
    if ("reason" in numbered) return Promise.resolve({ ok: false, reason: numbered.reason });
    const picked = edgePicksAsTyped(numbered.args);
    if ("reason" in picked) return Promise.resolve({ ok: false, reason: picked.reason });
    args = picked.args;
    const problem = validateTool(name, args ?? {});
    if (problem) throw new ProtocolError(problem);
    const input = (args ?? {}) as Record<string, unknown>;
    const changes = !annotationsFor(name).readOnlyHint && (changesPlate(name) || (name === "model_params" && input.rebuild === true));
    // The plate as it stood before a call that can run long is on disk before it starts; others rely on the save after.
    const long = LONG_CALLS.has(name) || (name === "model_apply" && isComposite((input.op as { kind?: unknown } | undefined)?.kind));
    if (changes && this.inflight === 0 && long) this.flushAutosave();
    this.inflight += 1;
    // A detachable call's work stops only for slice_cancel: the request's own cancel, which a client also sends when it
    // gives up waiting, hands the work to a background job instead of throwing it away.
    const detachable = !inPlan && DETACHABLE.has(name);
    const stop = new AbortController();
    const ctx: CallMeta = detachable ? { progressToken: meta?.progressToken, signal: stop.signal } : (meta ?? {});
    let result: ReturnType<Session["dispatch"]>;
    const picks: PickRow[] = [];
    try {
      result = this.callContext.run(ctx, () => this.pickLog.run(picks, () => this.dispatch(name, input, ctx)));
    } catch (err) {
      this.inflight -= 1;
      throw err;
    }
    const work = Promise.resolve(result).then((value) => {
      const { payload, carriedAll } = this.bridgePayload(name, input, value);
      this.lastBridge = payload;
      void mirror(payload, this.bridgeLink, carriedAll);
      return withPicks(this.withAutosaveHint(value), picks);
    }).catch((err: unknown) => {
      if (err instanceof ProtocolError) {
        const refusal = domainRefusal(err.message);
        if (refusal) return withPicks(refusal, picks);
      }
      throw err;
    }).finally(() => {
      this.inflight -= 1;
      if (changes) {
        this.autosaveDirty = true;
        this.scheduleAutosave();
      }
    });
    if (!detachable) return work;
    return this.detachable(name, input, work, ctx, stop, meta?.signal);
  }


  /**
   * With groups on, a call to a tool of a group not enabled opens the group and runs. A client that never re-reads the
   * tool list after list_changed can still reach the tool through plan_run, and one that does sees the tool from now on.
   * Returns the group opened, or null.
   */
  openGroupFor(name: string): string | null {
    const group = this.toolGroups && this.recipeDepth === 0 ? groupOf(name) : null;
    if (group === null || this.toolGroups!.has(group)) return null;
    this.toolGroups!.add(group);
    this.onToolsChanged?.();
    return group;
  }

  /** tools_enable: adds groups to the list and tells the client it changed. With groups off, every tool is already listed. */
  toolsEnable(input: Record<string, unknown>): Record<string, unknown> {
    const asked = (input.groups as string[]).filter((group) => group in TOOL_GROUPS);
    if (!this.toolGroups) return { ok: true, enabled: [...GROUP_NAMES], note: "Every tool is already listed." };
    const added = asked.filter((group) => !this.toolGroups!.has(group));
    for (const group of added) this.toolGroups.add(group);
    if (added.length > 0) this.onToolsChanged?.();
    const addedTools = asked.flatMap((group) => TOOL_GROUPS[group]!.tools);
    const reply: Record<string, unknown> = {
      ok: true,
      enabled: GROUP_NAMES.filter((group) => this.toolGroups!.has(group)),
      added: added.flatMap((group) => TOOL_GROUPS[group]!.tools),
      note: "The tool list has changed. If these tools do not appear in yours, call them through plan_run {steps:[{tool, args}]}, or by name: a tool of any group opens its group.",
    };
    if (input.schemas === true) reply.schemas = addedTools.map((tool) => { const spec = toolByName(tool); return spec ? { name: tool, description: spec.description, inputSchema: spec.inputSchema } : { name: tool }; });
    return reply;
  }

  /** An unknown handle right after a restart: the reply says where the last session's plate is. */
  withAutosaveHint(value: Record<string, unknown>): Record<string, unknown> {
    if (value.ok !== false || value.reason !== UNKNOWN_OBJECT || !this.previousAutosave || this.objects.length > 0) return value;
    return { ...value, reason: `${UNKNOWN_OBJECT} ${this.previousAutosave.note}`, autosave: this.previousAutosave.path };
  }

  /** Write the autosave a second after the last change, when no call is running. */
  scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      if (this.inflight > 0) this.scheduleAutosave();
      else this.flushAutosave();
    }, 1000);
    this.autosaveTimer.unref?.();
  }

  /** The plate and its histories to this server's autosave in the workspace, without committing anything. Never throws. */
  flushAutosave(): void {
    if (!this.autosaveDirty) return;
    this.autosaveDirty = false;
    if (this.objects.length === 0) return;
    try {
      const path = autosavePath();
      if (!path) return;
      // A solid never committed has no plate mesh yet: its kernel mesh stands in, so the file opens.
      const doc = this.withKernelMeshes(this.saveDocument());
      this.attachPreview(doc, false);
      // One write at a time, off the call's path; a failed write is not worth failing a call for. The binary records are
      // compressed in that chain too, so the call does not wait for them.
      // The document is taken now (a copy), so a write queued behind another still saves the plate as it is at this call.
      const prepared = prepareProject(doc);
      this.autosaveWriting = this.autosaveWriting.then(async () => writeAutosave(path, await finishProject(prepared))).catch(() => undefined);
    } catch {
      // An autosave that cannot be built is not worth failing a call for either.
    }
  }

  /** The autosave being written, for a test or a shutdown that wants it on disk. */
  autosaveSettled(): Promise<void> {
    return this.autosaveWriting;
  }

  /**
   * Model tools take text such as "wallH / 2" where a number goes. Each one becomes its number before the schema
   * check, from the session's parameters and the call's own `params`.
   */
  withNumbers(name: string, args: unknown): { args: unknown } | { reason: string } {
    this.pendingTexts = [];
    this.pendingBaseText = undefined;
    this.pendingOneOff = [];
    this.notLinked = [];
    this.linkingOp = undefined;
    if (!EXPRESSION_TOOLS.has(name) || !args || typeof args !== "object") return { args };
    const input = { ...(args as Record<string, unknown>) };
    if (name === "workplane_set") return this.workplaneNumbers(input);
    // Ops typed in this call get the box anchor written in; a recipe rerun keeps what its ops were saved with.
    if (input.op !== undefined) input.op = withBoxAnchor(input.op);
    if (Array.isArray(input.ops)) input.ops = input.ops.map((op) => withBoxAnchor(op));
    if (name === "model_define") return { args: input };
    const given = input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params as Record<string, unknown> : {};
    // model_build {object, params} with no ops reruns the recipe that object was built from, with those parameters. The
    // recipe's own names come first; a project parameter of the same name, set since, wins over them.
    if (name === "model_build" && typeof input.object === "string" && input.ops === undefined && input.base === undefined) {
      const recipe = this.find(input.object)?.recipe;
      if (!recipe) return { reason: "That object has no recipe to rerun. Pass base and ops." };
      input.base = structuredClone(recipe.base);
      input.ops = structuredClone(recipe.ops);
      const kept = Object.fromEntries(Object.entries(recipe.params ?? {}).filter(([key]) => !Object.hasOwn(this.paramText, key)));
      input.params = { ...kept, ...given };
      if (input.name === undefined && recipe.name) input.name = recipe.name;
    }
    const callParams = input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params as Record<string, unknown> : {};
    if (name === "model_build") {
      // --- Gaps A4. A call-level value for a project parameter is for this call only: the recipe keeps the names the
      // project does not have, which a rerun needs, so a later model_params set is never hidden behind it.
      const local = Object.fromEntries(Object.entries(callParams).filter(([key]) => !Object.hasOwn(this.paramText, key)));
      this.pendingOneOff = Object.keys(callParams).filter((key) => Object.hasOwn(this.paramText, key));
      this.pendingRecipe = { base: structuredClone(input.base), ops: structuredClone(input.ops ?? []), params: structuredClone(local), name: typeof input.name === "string" ? input.name : undefined };
    }
    let params = this.params;
    if (Object.keys(callParams).length > 0) {
      const merged = this.mergeParams(callParams);
      if ("reason" in merged && typeof merged.reason === "string") return { reason: merged.reason };
      params = merged as Record<string, number>;
    }
    const scope = this.nameScope(callParams);
    try {
      if (input.op !== undefined) this.pendingTexts = [resolveTexts(input.op, scope, OP_WORDS)];
      if (input.base !== undefined) this.pendingBaseText = resolveTexts(input.base, scope, OP_WORDS);
      for (const key of ["op", "base"]) {
        if (input[key] !== undefined) input[key] = resolveNumbers(input[key], params, key, OP_WORDS);
      }
      if (Array.isArray(input.ops)) {
        const expanded = expandOpsWithTexts(input.ops, params, scope, this.parts, OP_WORDS);
        input.ops = expanded.map((row) => row.op);
        this.pendingTexts = expanded.map((row) => row.text);
      }
    } catch (err) {
      if (err instanceof ExprError) return { reason: err.message };
      throw err;
    }
    return { args: input };
  }

  /**
   * --- Gaps A2. The names an op of this call may use, each as text in the project's names: a project parameter stands for
   * itself, and a call-level one for the text it was given, so a step typed `w` under call params {w: 50} is the number 50.
   */
  nameScope(callParams: Record<string, unknown>): Record<string, string> {
    const scope: Record<string, string> = {};
    for (const key of Object.keys(this.params)) scope[key] = key;
    for (const [key, value] of Object.entries(callParams)) scope[key] = typeof value === "number" ? String(value) : substituteNames(String(value).trim(), scope);
    return scope;
  }

  /** Expression text that names a project parameter: what a stored number may follow. */
  readonly followsParameters = (text: string): boolean => !isPlainNumber(text) && Object.keys(this.params).some((key) => expressionMentions(text, key));

  /** --- Gaps A3. workplane_set's origin and turn may be expressions: resolved here, their text kept for the object. */
  workplaneNumbers(input: Record<string, unknown>): { args: unknown } | { reason: string } {
    const scope = this.nameScope({});
    const text: Record<string, unknown> = {};
    try {
      for (const key of ["origin", "turn"]) {
        if (!Array.isArray(input[key])) continue;
        text[key] = resolveTexts(input[key], scope, OP_WORDS);
        input[key] = resolveNumbers(input[key], this.params, key, OP_WORDS);
      }
    } catch (err) {
      if (err instanceof ExprError) return { reason: err.message };
      throw err;
    }
    this.pendingTexts = [text];
    return { args: input };
  }

  /** The last mirror sent to the desktop, including a place or settings result. */
  bridgeSnapshot(): Record<string, unknown> | null {
    return this.lastBridge;
  }

  async ask<T>(value: T | Promise<T>): Promise<T> {
    return await value;
  }

  pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, ms);
      const stop = () => finish();
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve();
      }
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  /**
   * The plate after `name`, for the desktop. A mesh the desktop has not been sent rides along once.
   * A new solid that was never committed has no file yet, so it is not on the desktop's plate.
   */
  bridgePayload(name: string, input: Record<string, unknown>, value: Record<string, unknown>): { payload: Record<string, unknown>; carriedAll: boolean } {
    const objectId = typeof input.object === "string" ? input.object : "";
    const obj = objectId ? this.find(objectId) : null;
    const settings = (name === "settings_apply" || name === "settings_set") && value.ok === true && value.dryRun !== true
      ? {
          layerHeight: this.settings.layerHeight,
          supports: this.settings.supports,
          blendKind: this.settings.blendKind,
          strategy: this.settings.strategy,
          toughness: this.settings.toughness,
          ...(name === "settings_set" && Array.isArray(value.changed) ? { values: changedValues(value.changed) } : {}),
        }
      : undefined;
    const shown = this.objects.filter((row) => row.bytes.byteLength > 0);
    const known = this.bridgeLink.known;
    const carriedAll = known.size === 0;
    const meshes: Record<string, unknown> = {};
    for (const row of shown) {
      const hash = this.meshHashOf(row.bytes);
      if (known.has(hash) || hash in meshes) continue;
      meshes[hash] = {
        fileName: row.fileName,
        bytesB64: bytesToBase64(row.bytes),
        positionsB64: bytesToBase64(new Uint8Array(row.source.buffer, row.source.byteOffset, row.source.byteLength)),
        seatMm: row.seatMm,
      };
    }
    // The desktop keeps a mesh only while an object on its plate uses it, so an undone remove sends it again.
    known.clear();
    for (const row of shown) known.add(this.meshHashOf(row.bytes));
    const commit = name === "model_commit" && value.ok === true && obj && obj.bytes.byteLength > 0
      ? { object: obj.id, meshHash: this.meshHashOf(obj.bytes) }
      : null;
    this.bridgeSeq += 1;
    const payload = {
      tool: name === "object_select" && typeof input.name === "string" ? "plate_sync" : name,
      session: this.bridgeSession,
      seq: this.bridgeSeq,
      plate: shown.map((row) => ({
        object: row.id,
        name: shownName(row.name),
        scalePercent: row.scale * 100,
        centered: row.centered,
        offset: { ...row.offset },
        orient: [...row.orient],
        meshHash: this.meshHashOf(row.bytes),
        ...(row.sim ? { sim: row.sim } : {}),
      })),
      ...(Object.keys(meshes).length > 0 ? { meshes } : {}),
      ...(obj ? { objectId: obj.id, objectName: obj.name } : {}),
      ok: value.ok === true,
      ...(settings ? { settings } : {}),
      ...(commit ? { commit } : {}),
    };
    return { payload, carriedAll };
  }

  /** A new desktop answered: send it the whole plate with every mesh. */
  resyncBridge(): void {
    this.bridgeLink.known.clear();
    const { payload } = this.bridgePayload("plate_sync", {}, { ok: true });
    void mirror(payload, this.bridgeLink, true);
  }

  meshHashOf(bytes: Uint8Array): string {
    let hash = this.meshHashes.get(bytes);
    if (!hash) {
      hash = fnv1aHex(bytes);
      this.meshHashes.set(bytes, hash);
    }
    return hash;
  }

  /**
   * --- Text milestone 4. A text op with `fontFile` has the file read and added to the project, and one whose `font` is a name
   * is matched to a font already in the project; the op then names the font by id. Calls with no such text take the
   * synchronous path they always did.
   */
  dispatch(name: string, input: Record<string, unknown>, meta?: CallMeta): Record<string, unknown> | Promise<Record<string, unknown>> {
    const texts = textsNeedingFonts(input);
    if (texts.length === 0) return this.dispatchNow(name, input, meta);
    const copy = structuredClone(input);
    return (async () => {
      const refused = await this.resolveTextFonts(textsNeedingFonts(copy));
      return refused ? { ok: false, reason: refused } : this.dispatchNow(name, copy, meta);
    })();
  }

  dispatchNow(name: string, input: Record<string, unknown>, meta?: CallMeta): Record<string, unknown> | Promise<Record<string, unknown>> {
    const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
    return handler ? handler(this, input, meta) : this.model(name, input);
  }

  resource(uri: string): Record<string, unknown> | Promise<Record<string, unknown>> {
    const guide = guideByUri(uri);
    if (guide) return { name: guide.name, tools: guide.tools, text: guide.text };
    if (uri === "lime://session") {
      return { workspace: process.env.LIME_MCP_WORKSPACE ?? "", selected: this.selected, objects: this.objects.map((obj) => obj.id), printer: this.library.printerId, filament: this.library.filamentId, running: this.running?.handle ?? null };
    }
    if (uri === "lime://machines") {
      return { printers: this.library.printers.map((row) => ({ id: row.id, name: row.name, bedMm: [row.bedX, row.bedY, row.bedZ] })), filaments: this.library.filaments.map((row) => ({ id: row.id, name: row.name, material: row.material })) };
    }
    if (uri === "lime://project") {
      const changed = presetKeys().filter((key) => this.settings[key] !== DEFAULT_PRESET[key]);
      return { objects: this.objects.map((obj) => ({ object: obj.id, name: shownName(obj.name) })), changed };
    }
    if (uri === "lime://slice/latest") {
      if (!this.latest?.wire) return { ready: false };
      const stale = this.staleReason(this.latest);
      const summary = this.summarize(this.latest);
      if (stale) return { ready: true, stale: true, reason: stale, seconds: summary.seconds, grams: summary.grams, warnings: summary.warnings };
      return { seconds: summary.seconds, grams: summary.grams, warnings: summary.warnings, stale: false };
    }
    if (uri === "lime://gcode/latest/summary") return this.gcodeSummary();
    const history = /^lime:\/\/object\/([^/]+)\/history$/.exec(uri);
    if (history) return this.model("model_history", { object: history[1]! });
    throw new ProtocolError("That resource is not on this server.");
  }










  async calibrationTower(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const kind = input.kind === "pa" || input.kind === "flow" || input.kind === "temp" || input.kind === "retract" ? input.kind : null;
    if (!kind) return { ok: false, reason: "kind is pa, flow, temp, or retract." };
    const start = Number(input.start);
    const end = Number(input.end);
    const step = Number(input.step);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(step > 0) || end + 1e-9 < start) {
      return { ok: false, reason: "The tower needs a start, an end, and a positive step." };
    }
    const bandHeight = typeof input.bandHeightMm === "number" && input.bandHeightMm > 0 ? input.bandHeightMm : kind === "pa" ? 2 : 5;
    const bands = Math.floor((end - start) / step + 1e-9) + 1;
    if (bands > 40) return { ok: false, reason: `That tower has ${bands} bands. The limit is 40.` };
    const height = bands * bandHeight;
    const printer = this.printer();
    if (height > printer.bedZ) return { ok: false, reason: `That tower is ${roundTo(height, 1)} mm. The bed is ${printer.bedZ} mm tall.` };
    if (kind === "pa" && !printer.firmware) return { ok: false, reason: "The PA tower needs a firmware." };
    const body = {
      kind,
      firmware: printer.firmware,
      start,
      end,
      step,
      layerHeight: typeof input.layerHeight === "number" ? input.layerHeight : this.settings.layerHeight,
      bandHeight,
      slowMmS: 40,
      fastMmS: 200,
      accel: 3000,
      speedMmS: kind === "retract" ? 30 : 40,
      printer: enginePrinter(printer, this.filament(), this.library.nozzleMm),
    };
    if (input.dryRun === true) return { ok: true, dryRun: true, bands, heightMm: roundTo(height, 2) };
    let reply: { bands?: { index?: number; value?: number; k?: number; flow?: number; temp?: number; length?: number; z0?: number; z1?: number }[]; gcode?: string; error?: string };
    try {
      reply = JSON.parse(await this.ask(this.engine.calibrate(JSON.stringify(body)))) as typeof reply;
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "The tower was not built." };
    }
    if (!reply.gcode || !Array.isArray(reply.bands)) return { ok: false, reason: reply.error ?? "The tower was not built." };
    const path = resolveWrite(`${kind}-tower.gcode`, ".gcode");
    writeFileSync(path, reply.gcode);
    const listed = reply.bands.map((band, index) => ({
      index: band.index ?? index,
      value: band.value ?? band.k ?? band.flow ?? band.temp ?? band.length ?? 0,
      z0: band.z0 ?? 0,
      z1: band.z1 ?? 0,
    }));
    return { ok: true, bands: listed, gcodePath: path, bytes: Buffer.byteLength(reply.gcode) };
  }

  calibrationApply(input: Record<string, unknown>): Record<string, unknown> {
    const kind = input.kind === "pa" || input.kind === "flow" || input.kind === "temp" || input.kind === "retract" ? input.kind : null;
    if (!kind) return { ok: false, reason: "kind is pa, flow, temp, or retract." };
    const value = Number(input.value);
    if (!Number.isFinite(value)) return { ok: false, reason: "value is the number to save on the filament." };
    const filament = this.filament();
    this.remember("Calibration");
    if (kind === "pa") this.library = setAdvance(this.library, value, advanceFor(filament.linearAdvance, this.library.nozzleMm));
    else if (kind === "flow") this.library = setFlow(this.library, value);
    else if (kind === "temp") this.library = setNozzleTemp(this.library, value);
    else this.library = setRetract(this.library, value, null);
    return { ok: true, kind, value, stale: true, label: "Calibration" };
  }

  async blendCompare(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const obj = this.wanted(input);
    if (!isObject(obj)) return obj;
    const committed = await this.commitObject(obj);
    if (committed) return { ok: false, reason: committed };
    const built = this.sliceBody(obj, "object");
    let reply: { label?: string; toughness?: number; seconds?: number; filamentG?: number; score?: number; error?: string }[];
    try {
      const parsed = JSON.parse(await this.ask(this.engine.pareto(withMesh(JSON.stringify(built.body), built.mesh)))) as typeof reply | { error?: string };
      if (!Array.isArray(parsed)) return { ok: false, reason: parsed.error ?? "The blends were not compared." };
      reply = parsed;
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "The blends were not compared." };
    }
    this.pareto = reply.filter((point) => typeof point.toughness === "number").map((point) => ({
      label: point.label ?? "",
      toughness: point.toughness ?? 0,
      seconds: point.seconds ?? 0,
      grams: point.filamentG ?? 0,
      score: point.score ?? 0,
    }));
    if (this.pareto.length === 0) return { ok: false, reason: "The blends were not compared." };
    return { ok: true, points: this.pareto };
  }

  blendApply(input: Record<string, unknown>): Record<string, unknown> {
    const index = typeof input.index === "number" ? input.index : -1;
    const point = this.pareto[index];
    if (!point) return { ok: false, reason: "Call blend_compare first, then pass a point index." };
    this.remember("Blend");
    if (point.toughness <= 0.001) {
      this.settings = { ...this.settings, blendKind: "single", strategy: "speed" };
    } else if (point.toughness >= 0.999) {
      this.settings = { ...this.settings, blendKind: "single", strategy: "toughness" };
    } else {
      this.settings = { ...this.settings, blendKind: "weight", toughness: point.toughness };
    }
    return { ok: true, index, toughness: point.toughness, stale: true, label: "Blend" };
  }

  /** The file Export writes, so the review sees the printer's start and end text. */
  printerBuildAxis(): SimVec {
    const printer = this.printer();
    return printer.kind === "belt" ? beltLayerNormal(printer.belt.angleDeg) : [0, 0, 1];
  }

  readFixtures(value: unknown): StudyHold[] | { reason: string } {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return { reason: "Fixtures are a list." };
    const holds: StudyHold[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A fixture is an object." };
      const row = item as Record<string, unknown>;
      if (row.kind === "bed") {
        holds.push({ kind: "bed", faces: [] });
        continue;
      }
      if (row.kind === "faces") {
        if (!Array.isArray(row.faces) || !row.faces.every((face) => Number.isInteger(face) && (face as number) >= 0)) return { reason: "Face indexes are whole numbers." };
        holds.push({ kind: "faces", faces: [...row.faces] as number[] });
        continue;
      }
      if (row.kind === "plane") {
        const normal = vec3Of(row.normal);
        const origin = vec3Of(row.origin);
        if (!normal || !origin) return { reason: "A plane needs a normal and an origin." };
        holds.push({ kind: "plane", faces: [], normal, origin });
        continue;
      }
      if (row.kind === "region") {
        const region = readRegion(row.region);
        if (!region) return { reason: REGION_SHAPE };
        holds.push("faces" in region ? { kind: "faces", faces: region.faces } : { kind: "faces", faces: [], place: region });
        continue;
      }
      return { reason: "A fixture is a bed, faces, a plane, or a region." };
    }
    return holds;
  }

  readLoads(value: unknown): StudyLoad[] | { reason: string } {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return { reason: "Loads are a list." };
    const loads: StudyLoad[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A load is an object." };
      const row = item as Record<string, unknown>;
      if (row.kind !== "force" && row.kind !== "pressure") return { reason: "A load is a force or a pressure." };
      if (typeof row.magnitude !== "number" || !Number.isFinite(row.magnitude)) return { reason: "The load magnitude has to be a number." };
      const direction = vec3Of(row.direction) ?? [0, 0, -1];
      if (row.region !== undefined) {
        if (row.faces !== undefined) return { reason: "A load is on faces or on a region, not both." };
        const region = readRegion(row.region);
        if (!region) return { reason: REGION_SHAPE };
        if ("faces" in region) loads.push({ kind: row.kind, faces: region.faces, magnitude: row.magnitude, direction });
        else loads.push({ kind: row.kind, faces: [], magnitude: row.magnitude, direction, place: region });
        continue;
      }
      if (!Array.isArray(row.faces) || !row.faces.every((face) => Number.isInteger(face) && (face as number) >= 0)) return { reason: "Face indexes are whole numbers." };
      loads.push({ kind: row.kind, faces: [...row.faces] as number[], magnitude: row.magnitude, direction });
    }
    return loads;
  }

  simCard(value: unknown) {
    const cards = cardsOf(this.library);
    const fallback = cards.find((card) => card.id === "inhouse-petg") ?? cards[0];
    if (!fallback) return { reason: "That card is not in the library." } as const;
    if (value === undefined) return fallback;
    if (typeof value === "string") return cards.find((card) => card.id === value) ?? ({ reason: "That card is not in the library." } as const);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "That card is not in the library." } as const;
    const row = value as Record<string, unknown>;
    const base = (typeof row.id === "string" ? cards.find((card) => card.id === row.id) : undefined) ?? fallback;
    const num = (key: string, current: number) => (typeof row[key] === "number" && Number.isFinite(row[key] as number) ? (row[key] as number) : current);
    const beads = row.beads === undefined ? base.beads : readBeadSection(row.beads);
    if (beads === null) return { reason: BEADS_REFUSAL } as const;
    return {
      ...base,
      id: typeof row.id === "string" && row.id.trim() ? row.id : base.id,
      polymer: typeof row.polymer === "string" && row.polymer.trim() ? row.polymer : base.polymer,
      provisional: row.provisional === false ? false : row.provisional === true ? true : base.provisional,
      EInPlaneMPa: num("EInPlaneMPa", base.EInPlaneMPa),
      EAcrossLayersMPa: num("EAcrossLayersMPa", base.EAcrossLayersMPa),
      nu: num("nu", base.nu),
      strengthInPlaneMPa: num("strengthInPlaneMPa", base.strengthInPlaneMPa),
      strengthAcrossLayersMPa: num("strengthAcrossLayersMPa", base.strengthAcrossLayersMPa),
      compressionInPlaneMPa: num("compressionInPlaneMPa", base.compressionInPlaneMPa),
      compressionAcrossLayersMPa: num("compressionAcrossLayersMPa", base.compressionAcrossLayersMPa),
      shearAcrossLayersMPa: num("shearAcrossLayersMPa", base.shearAcrossLayersMPa),
      densityGCm3: num("densityGCm3", base.densityGCm3),
      specimen: typeof row.specimen === "string" ? row.specimen : base.specimen,
      source: typeof row.source === "string" ? row.source : base.source,
      isotropic: row.isotropic === undefined ? base.isotropic : row.isotropic === true,
      beads,
    };
  }

  beamOf(value: unknown): ObjectStudy["beam"] | { reason: string } | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: BEAM_SIZE };
    const box = value as Record<string, unknown>;
    if (typeof box.lengthMm !== "number" || typeof box.widthMm !== "number" || typeof box.heightMm !== "number") return { reason: BEAM_SIZE };
    if (!(box.lengthMm > 0) || !(box.widthMm > 0) || !(box.heightMm > 0)) return { reason: BEAM_SIZE };
    return { lengthMm: box.lengthMm, widthMm: box.widthMm, heightMm: box.heightMm };
  }

  simSetup(input: Record<string, unknown>): Record<string, unknown> {
    const element = elementRefusal(input.element);
    if (element) return { ok: false, reason: element };
    const beam = this.beamOf(input.beam);
    if (beam && "reason" in beam) return { ok: false, reason: beam.reason };
    const fixtures = this.readFixtures(input.fixtures);
    if ("reason" in fixtures) return { ok: false, reason: fixtures.reason };
    const loads = this.readLoads(input.loads);
    if ("reason" in loads) return { ok: false, reason: loads.reason };
    const card = this.simCard(input.card);
    if ("reason" in card) return { ok: false, reason: card.reason };
    const printer = input.printer === true;
    let buildAxis: SimVec = printer ? this.printerBuildAxis() : [0, 0, 1];
    if (!printer && input.buildAxis !== undefined) {
      const axis = vec3Of(input.buildAxis);
      if (!axis) return { ok: false, reason: ZERO_AXIS };
      buildAxis = axis;
    }
    if (axisLength(buildAxis) <= 1e-12) return { ok: false, reason: ZERO_AXIS };
    let edge = 5;
    if (input.hMm !== undefined) {
      if (typeof input.hMm !== "number" || !(input.hMm > 0)) return { ok: false, reason: BEAM_SIZE };
      edge = input.hMm;
    }
    let representation: SimRepresentation | undefined;
    if (input.representation !== undefined) {
      if (input.representation !== "sliced" && input.representation !== "smear") return { ok: false, reason: "representation is sliced or smear." };
      representation = input.representation;
    }
    const constraints = this.readSimConstraints(input.constraints);
    if (constraints && "reason" in constraints) return { ok: false, reason: constraints.reason };
    const requested = typeof input.object === "string" ? input.object : "";
    let obj = requested ? this.find(requested) : this.selectedObject();
    if (requested && !obj) return { ok: false, reason: UNKNOWN_OBJECT };
    if (!obj && !beam) return { ok: false, reason: "Load a mesh first." };
    this.remember("Stress");
    if (!obj && beam) {
      const source = boxPositions(beam.lengthMm, beam.widthMm, beam.heightMm);
      obj = this.addObject({
        name: "beam",
        fileName: "beam.stl",
        bytes: stlBytes(source, "beam.stl"),
        source,
        triangles: source.length / 9,
        orient: [...ID_MATRIX] as Mat3,
        scale: 1,
        centered: false,
        offset: { x: 0, y: 0, z: 0 },
        seatMm: 0,
      });
    }
    if (!obj) return { ok: false, reason: "Load a mesh first." };
    if (input.card && typeof input.card === "object") this.library = saveMaterialCard(this.library, card);
    const study: ObjectStudy = {
      holds: fixtures,
      loads,
      cardId: card.id,
      printer,
      buildAxis,
      gravity: input.gravity === true,
      edgeMm: edge,
      ...(beam ? { beam } : {}),
      ...(obj.sim?.pattern ? { pattern: obj.sim.pattern } : {}),
      ...(representation ? { representation } : {}),
      ...(constraints ? { constraints } : {}),
    };
    if (namesFaces(study)) study.facesKey = this.shapeKey(obj);
    obj.sim = study;
    return { ok: true, object: obj.id, study, sentence: setupSentence(study, card.polymer, card.provisional), label: LABEL };
  }

  smearOf(obj: PlateObject, patch?: SweepPatch) {
    return simRecipe({
      toughness: this.settings.toughness,
      layerHeightMm: this.settings.layerHeight,
      lineWidthMm: Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125)),
      blendKind: this.settings.blendKind === "weight" || this.settings.blendKind === "byLayer" || this.settings.blendKind === "byRegion" ? this.settings.blendKind : "single",
      strategy: this.settings.strategy === "toughness" ? "toughness" : "speed",
      object: { walls: patch?.walls ?? obj.objectSettings.walls, infill: patch?.infill ?? obj.objectSettings.infill },
      overrides: this.overrides,
      reinforcementDensities: obj.reinforcement.map((region) => region.density),
    });
  }

  solveCopy(obj: PlateObject, patch: SweepPatch | undefined, op: "run" | "field", field?: Record<string, unknown>): Record<string, unknown> {
    const saved = obj.sim;
    if (!saved) return { ok: false, reason: "Set up a study first." };
    const stale = this.staleFaces(obj, saved);
    if (stale) return { ok: false, reason: stale };
    if (saved.holds.some((hold) => hold.place) || saved.loads.some((load) => load.place)) return { ok: false, reason: PLACE_ON_SMEAR };
    const study = cloneStudy(saved);
    if (study.printer) study.buildAxis = this.printerBuildAxis();
    if (patch?.loadScale) study.loads = scaleLoads(study.loads, patch.loadScale);
    if (patch?.pattern) study.pattern = patch.pattern;
    const recipe = this.smearOf(obj, patch);
    const refused = recipeRefusal(recipe);
    if (refused) return { ok: false, reason: refused };
    const card = cardsOf(this.library).find((row) => row.id === study.cardId);
    if (!card) return { ok: false, reason: "That card is not in the library." };
    const pattern = study.pattern ?? recipe.pattern;
    const job = solverJob({
      op,
      study,
      card,
      walls: recipe.walls,
      infill: recipe.infill,
      pattern: pattern === "lines" || pattern === "grid" || pattern === "gyroid" || pattern === "lightning" ? pattern : undefined,
      field: typeof field?.field === "string" ? field.field : undefined,
      points: field?.points as SimVec[] | undefined,
      box: field?.box as { min: SimVec; max: SimVec } | undefined,
      face: typeof field?.face === "number" ? field.face : undefined,
      stride: typeof field?.stride === "number" ? field.stride : undefined,
      limit: typeof field?.limit === "number" ? field.limit : undefined,
      cursor: typeof field?.cursor === "number" ? field.cursor : undefined,
    });
    if ("reason" in job) return { ok: false, reason: job.reason };
    const reply = runSolver(job);
    if (Array.isArray(reply.triangles)) delete reply.triangles;
    if (Array.isArray(reply.nodes)) delete reply.nodes;
    if ("stiffness" in reply) delete reply.stiffness;
    return reply;
  }

  async simRun(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const obj = this.simTarget(input);
    if ("reason" in obj) return { ok: false, reason: obj.reason };
    const saved = obj.sim;
    if (!saved) return { ok: false, reason: "Set up a study first." };
    const reply = this.representationFor(obj, saved) === "sliced"
      ? await this.solveSliced(obj, saved, input.checkResolution !== false)
      : this.solveCopy(obj, undefined, "run");
    if (reply.ok === true && input.includeSlicerMass === true) {
      const estimate = this.freshEstimate();
      if (estimate) reply.slicerGrams = estimate.grams;
    }
    return reply;
  }

  representationFor(obj: PlateObject, study: ObjectStudy): SimRepresentation {
    return representationOf({
      asked: study.representation,
      beam: study.beam !== undefined,
      printerId: this.library.printerId,
      fileName: obj.fileName,
    });
  }

  /** The solver's kinds and its refusal sentences (`lime-sim` sliced_study.rs), so a refusal reads the same either way. */
  readSimConstraints(value: unknown): StudyConstraint[] | { reason: string } | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return { reason: "Constraints are a list of targets." };
    if (value.length > 8) return { reason: "A study takes up to 8 targets." };
    const out: StudyConstraint[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { reason: "A target is an object." };
      const row = item as Record<string, unknown>;
      if (typeof row.kind !== "string" || !TARGET_KINDS.includes(row.kind)) return { reason: `A target is ${TARGET_KINDS.join(", ")}.` };
      const band = BAND_KINDS.has(row.kind);
      let pair: [number, number] | undefined;
      if (band) {
        const lo = Array.isArray(row.band) ? row.band[0] : undefined;
        const hi = Array.isArray(row.band) ? row.band[1] : undefined;
        if (!Array.isArray(row.band) || row.band.length !== 2 || typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) || !(lo >= 0) || !(hi > lo)) {
          return { reason: "A band needs two numbers, the lower first." };
        }
        pair = [lo, hi];
      } else if (typeof row.value !== "number" || !(row.value > 0) || !Number.isFinite(row.value)) return { reason: "A target has to be a positive number." };
      const region = row.region === undefined ? undefined : readRegion(row.region);
      const other = row.other === undefined ? undefined : readRegion(row.other);
      if (region === null || other === null) return { reason: REGION_SHAPE };
      if (STIFFNESS_KINDS.has(row.kind) && !region) return { reason: "A stiffness target needs the region it reads." };
      if (row.kind === "relativeDeflectionMm" && (!region || !other)) return { reason: "A relative deflection needs two regions, region and other." };
      out.push({
        kind: row.kind,
        value: band ? 0 : (row.value as number),
        ...(pair ? { band: pair } : {}),
        ...(region ? { region } : {}),
        ...(other ? { other } : {}),
      });
    }
    return out;
  }

  /** The solid the face indexes are picked on, as a key. A Model edit changes it. */
  shapeKey(obj: PlateObject): string {
    const positions = obj.solid && obj.solid.positions.length >= 9 ? obj.solid.positions : obj.source;
    return fnv1aHex(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
  }

  /** A study that names faces, run on a solid edited since it was set up. Never solve on renumbered faces. */
  staleFaces(obj: PlateObject, study: ObjectStudy): string | null {
    if (!study.facesKey || !namesFaces(study)) return null;
    return study.facesKey === this.shapeKey(obj) ? null : STALE_FACES;
  }

  /**
   * The mesh the study slices: the solid the faces were picked on, scaled the
   * same way, or the committed plate mesh when that is the same shape.
   * A triangle-count difference is not the test. A box parameter keeps the count.
   */
  studyMesh(obj: PlateObject): StudyMesh | { reason: string } {
    const committed = !obj.treeStale && obj.bytes.byteLength > 0 && (!obj.tree || obj.platedNode === obj.tree.current);
    const solid = obj.solid;
    const choice = chooseStudyMesh({
      picked: solid && solid.positions.length >= 9 ? solid.positions : null,
      pickedTriangles: solid?.triangles ?? null,
      plate: obj.source.length >= 9 ? obj.source : null,
      scale: obj.scale,
      committed,
    });
    if (!choice) return { reason: STUDY_MESH_REFUSAL };
    if ("reason" in choice) return choice;
    return choice;
  }

  /** The pose of the tessellation being sliced, when it is not the plate mesh. */
  studyPose(obj: PlateObject, unscaled: Float32Array): RigidPose | null {
    if (unscaled === obj.source) return null;
    const printer = this.printer();
    return placeMesh(unscaled, obj.orient, obj.scale, printer.bedX, printer.bedY, obj.centered, obj.offset).pose;
  }

  /** Face index of each triangle. A generated beam with no solid pairs triangles into faces. */
  faceIds(obj: PlateObject, study: ObjectStudy, count: number, triangleIds: ArrayLike<number> | null): number[] | null {
    if (triangleIds && triangleIds.length === count) return Array.from(triangleIds);
    if (study.beam && !obj.solid) return Array.from({ length: count }, (_, index) => Math.floor(index / 2));
    return null;
  }

  /**
   * A region's triangles in the mesh frame, before the pose. A generated beam
   * stores clockwise corners, so those are reversed to face outward.
   */
  slicedRegion(
    obj: PlateObject,
    study: ObjectStudy,
    faces: number[],
    role: "hold" | "load" | "target",
    corners: Float32Array,
    triangleIds: ArrayLike<number> | null,
  ): Record<string, unknown> | { reason: string } {
    if (faces.length === 0) {
      if (role === "hold") return { reason: "A hold's region touches no surface of the sliced part." };
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < corners.length; i += 3) {
        const x = corners[i] ?? 0;
        const y = corners[i + 1] ?? 0;
        const z = corners[i + 2] ?? 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      if (!Number.isFinite(minX)) return { reason: "Pick a face to load, or type its index." };
      const span = Math.max(1e-3, maxX - minX);
      const thick = Math.min(1, span * 0.05);
      return { kind: "box", min: [maxX - thick, minY, minZ], max: [maxX, maxY, maxZ] };
    }
    const count = Math.floor(corners.length / 9);
    const ids = this.faceIds(obj, study, count, triangleIds);
    if (!ids) return { reason: "That face is not on this part." };
    const want = new Set(faces);
    const reverse = study.beam !== undefined && obj.solid === null;
    const triangles: [number, number, number][][] = [];
    for (let tri = 0; tri < count; tri += 1) {
      if (!want.has(ids[tri] ?? -1)) continue;
      const at = tri * 9;
      const corner = (offset: number): [number, number, number] => [corners[at + offset] ?? 0, corners[at + offset + 1] ?? 0, corners[at + offset + 2] ?? 0];
      const a = corner(0);
      const b = corner(3);
      const c = corner(6);
      triangles.push(reverse ? [a, c, b] : [a, b, c]);
    }
    if (triangles.length === 0) {
      return { reason: `A ${role}'s region touches no surface of the sliced part.` };
    }
    return { kind: "faces", triangles };
  }

  /**
   * Solve the object as it is sliced. A sweep `patch` changes that one slice (walls, infill, the pattern) and
   * scales the loads, without touching the plate.
   */
  async solveSliced(obj: PlateObject, saved: ObjectStudy, checkResolution = true, patch?: SweepPatch): Promise<Record<string, unknown>> {
    const stale = this.staleFaces(obj, saved);
    if (stale) return { ok: false, reason: stale };
    const study = cloneStudy(saved);
    if (patch?.loadScale !== undefined && patch.loadScale !== 1) study.loads = scaleLoads(study.loads, patch.loadScale);
    if (study.printer) study.buildAxis = this.printerBuildAxis();
    if (study.holds.some((hold) => hold.kind === "plane")) return { ok: false, reason: "A plane hold is not on a sliced study. Hold the bed or faces." };
    if (!study.holds.some((hold) => hold.kind === "bed" || hold.faces.length > 0 || hold.place)) return { ok: false, reason: "Nothing is held." };
    const card = cardsOf(this.library).find((row) => row.id === study.cardId);
    if (!card) return { ok: false, reason: "That card is not in the library." };
    const { body } = this.sliceBody(obj, "object");
    body.includePreview = false;
    body.includeGcode = false;
    delete body.sim;
    const mesh = this.studyMesh(obj);
    if ("reason" in mesh) return { ok: false, reason: mesh.reason };
    const encoded = bytesToBase64(stlBytes(mesh.positions, stlFileName(obj.fileName)));
    const pose = this.studyPose(obj, mesh.unscaled);
    if (Array.isArray(body.objects)) {
      const first = body.objects[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const row = first as Record<string, unknown>;
        row.dataB64 = encoded;
        if (pose) row.pose = pose;
      }
    } else {
      body.dataB64 = encoded;
      if (pose) body.pose = pose;
    }
    if (obj.objectSettings.walls !== undefined && !Array.isArray(body.objects)) body.walls = obj.objectSettings.walls;
    if (obj.objectSettings.infill !== undefined && !Array.isArray(body.objects)) body.infill = obj.objectSettings.infill;
    if (patch) this.patchSliceBody(body, obj, patch);
    // A place is in the model frame; the sliced mesh is scaled about its source's centre.
    const box = boundsOf(mesh.unscaled);
    const centre: SimVec = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const regionOf = (region: StudyRegion, role: "hold" | "load" | "target") =>
      "faces" in region ? this.slicedRegion(obj, study, region.faces, role, mesh.positions, mesh.triangles) : placeRegion(region, centre, obj.scale);
    const holds: Record<string, unknown>[] = [];
    for (const hold of study.holds) {
      if (hold.kind === "bed") {
        holds.push({ kind: "bed" });
        continue;
      }
      const region = regionOf(hold.place ?? { faces: hold.faces }, "hold");
      if ("reason" in region) return { ok: false, reason: region.reason as string };
      holds.push({ kind: "region", region });
    }
    const loads: Record<string, unknown>[] = [];
    for (const load of study.loads) {
      const region = load.place
        ? placeRegion(load.place, centre, obj.scale)
        : this.slicedRegion(obj, study, load.faces, "load", mesh.positions, mesh.triangles);
      if ("reason" in region) return { ok: false, reason: region.reason as string };
      if (load.kind === "pressure") {
        loads.push({ kind: "pressure", region, mpa: load.magnitude });
        continue;
      }
      const n = Math.hypot(load.direction[0], load.direction[1], load.direction[2]);
      if (!(n > 1e-12)) return { ok: false, reason: "The load direction has zero length." };
      loads.push({
        kind: "force",
        region,
        force: [load.direction[0] / n * load.magnitude, load.direction[1] / n * load.magnitude, load.direction[2] / n * load.magnitude],
      });
    }
    if (loads.length === 0) return { ok: false, reason: "This study has no load." };
    const targets: Record<string, unknown>[] = [];
    for (const row of study.constraints ?? []) {
      const target: Record<string, unknown> = { kind: row.kind, value: row.value, ...(row.band ? { band: row.band } : {}) };
      for (const key of ["region", "other"] as const) {
        const given = row[key];
        if (!given) continue;
        const region = regionOf(given, "target");
        if ("reason" in region) return { ok: false, reason: region.reason as string };
        target[key] = region;
      }
      targets.push(target);
    }
    const sent: Record<string, unknown> = { ...withBeads(card) };
    for (const [key, value] of Object.entries(sent)) if (value === null || value === undefined) delete sent[key];
    const payload = JSON.stringify({
      request: body,
      study: {
        ...(study.edgeMm > 0 ? { hXy: study.edgeMm } : {}),
        card: sent,
        holds,
        loads,
        ...(targets.length > 0 ? { constraints: targets } : {}),
        checkResolution,
      },
    });
    let text: string;
    try {
      text = await Promise.resolve(this.engine.simStudy(payload));
    } catch (err) {
      return { ok: false, reason: err instanceof Error && err.message ? err.message : "The stress solve did not finish." };
    }
    this.stressCells = parseStressCells(text, obj.id) ?? this.stressCells;
    return slicedRunReply(text, study.constraints ?? []);
  }

  /**
   * A sweep variant's print settings on a one-object slice body: on the object's own settings when the body lists
   * it, else on the body. A pattern is a blend, which would also move walls and infill with its toughness, so they
   * are pinned to what the object prints now, as the desktop's sweep does.
   */
  patchSliceBody(body: Record<string, unknown>, obj: PlateObject, patch: SweepPatch): void {
    const row = Array.isArray(body.objects) && body.objects[0] && typeof body.objects[0] === "object"
      ? (body.objects[0] as Record<string, unknown>)
      : null;
    const target: Record<string, unknown> = row
      ? ((row.settings && typeof row.settings === "object" ? row.settings : (row.settings = {})) as Record<string, unknown>)
      : body;
    if (patch.walls !== undefined) target.walls = patch.walls;
    if (patch.infill !== undefined) target.infill = patch.infill;
    if (patch.pattern) {
      const width = Math.min(1.2, Math.max(0.2, this.library.nozzleMm * 1.125));
      const card = resolved(this.settings.toughness, this.settings.layerHeight, width);
      target.blend = patternBlend(patch.pattern);
      if (target.walls === undefined) target.walls = obj.objectSettings.walls ?? card.walls;
      if (target.infill === undefined) target.infill = obj.objectSettings.infill ?? card.density;
    }
  }

  /** A sliced sweep: each variant one slice of the object alone and one solve. */
  async slicedSweep(obj: PlateObject, patches: SweepPatch[], limits: ConstraintLimits, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (patches.some((patch) => patch.parameters)) return { ok: false, reason: RESLICE_PARAMETERS };
    const saved = obj.sim!;
    // One cell size per variant unless asked: a sweep compares variants, and a second size doubles each solve.
    const checkResolution = input.checkResolution === true;
    type SweepRow = Record<string, unknown> & { ok?: boolean; met: boolean; reason: string };
    const rows: SweepRow[] = [];
    for (const patch of patches) {
      const solved = await this.solveSliced(obj, saved, checkResolution, patch);
      if (solved.ok !== true) {
        rows.push({ ok: false, met: false, reason: typeof solved.reason === "string" ? solved.reason : "The stress solve did not finish." });
        continue;
      }
      const verdict = constraintVerdict({
        maxDisplacementMm: typeof solved.maxDisplacementMm === "number" ? solved.maxDisplacementMm : 0,
        minSafetyFactor: typeof solved.minSafetyFactor === "number" ? solved.minSafetyFactor : null,
        massG: typeof solved.massG === "number" ? solved.massG : 0,
      }, limits);
      rows.push({ ...solved, met: verdict.met, reason: verdict.reason });
    }
    let committed = false;
    if (input.commit === true) {
      const index = typeof input.variant === "number" ? input.variant : patches.length === 1 ? 0 : -1;
      if (!Number.isInteger(index) || index < 0 || index >= patches.length) return { ok: false, variants: rows, reason: "Name the variant to keep." };
      const chosen = rows[index];
      if (!chosen || chosen.ok === false) return { ok: false, variants: rows, reason: typeof chosen?.reason === "string" ? chosen.reason : "The stress solve did not finish." };
      if (patches[index]!.pattern) return { ok: false, variants: rows, reason: RESLICE_PATTERN_KEEP };
      this.remember("Sweep");
      this.applySweepPatch(obj, patches[index]!);
      committed = true;
    }
    return { ok: true, variants: rows, committed, note: "Each variant was sliced alone and solved. slicerSeconds and slicerGrams are that slice's." };
  }

  simField(input: Record<string, unknown>): Record<string, unknown> {
    const obj = this.simTarget(input);
    if ("reason" in obj) return { ok: false, reason: obj.reason };
    if (obj.sim && this.representationFor(obj, obj.sim) === "sliced") return { ok: false, reason: SLICED_FIELD };
    const field = typeof input.field === "string" ? input.field : "";
    const names = ["displacement", "von_mises", "stress", "safety_factor", "element_error"];
    if (!names.includes(field)) return { ok: false, reason: `Unknown field. This result has ${names.join(", ")}.` };
    let points: SimVec[] | undefined;
    if (input.points !== undefined) {
      if (!Array.isArray(input.points)) return { ok: false, reason: "A point is three numbers." };
      points = [];
      for (const item of input.points) {
        const point = vec3Of(item);
        if (!point) return { ok: false, reason: "A point is three numbers." };
        points.push(point);
      }
    }
    let box: { min: SimVec; max: SimVec } | undefined;
    if (input.box !== undefined) {
      if (!input.box || typeof input.box !== "object" || Array.isArray(input.box)) return { ok: false, reason: "A box needs a min and a max." };
      const row = input.box as { min?: unknown; max?: unknown };
      const min = vec3Of(row.min);
      const max = vec3Of(row.max);
      if (!min || !max) return { ok: false, reason: "A box needs a min and a max." };
      box = { min, max };
    }
    let face: number | undefined;
    if (input.face !== undefined) {
      if (!Number.isInteger(input.face) || (input.face as number) < 0) return { ok: false, reason: "That face is not on this beam." };
      face = input.face as number;
    }
    let stride: number | undefined;
    if (input.stride !== undefined) {
      if (!Number.isInteger(input.stride) || (input.stride as number) < 1) return { ok: false, reason: "A stride starts at 1." };
      stride = input.stride as number;
    }
    if (!points && !box && face === undefined && stride === undefined) return { ok: false, reason: "Name points, a box, a face, or a stride." };
    return this.solveCopy(obj, undefined, "field", { field, points, box, face, stride, limit: pageLimit(input.limit), cursor: pageCursor(input.cursor) });
  }

  simTarget(input: Record<string, unknown>): PlateObject | { reason: string } {
    const requested = typeof input.object === "string" ? input.object : "";
    const obj = requested ? this.find(requested) : this.selectedObject();
    if (!obj) return { reason: requested ? UNKNOWN_OBJECT : "Load a mesh first." };
    return obj;
  }

  sweepPatchProblem(patch: SweepPatch): string | null {
    if (patch.parameters) {
      const merged = this.mergeParams(patch.parameters);
      if ("reason" in merged && typeof merged.reason === "string") return merged.reason;
    }
    if (patch.walls !== undefined) {
      const applied = applyObjectSetting(this.settings, "walls", patch.walls, this.schemaContext());
      if ("reason" in applied) return applied.reason;
    }
    if (patch.infill !== undefined) {
      const applied = applyObjectSetting(this.settings, "infill", patch.infill, this.schemaContext());
      if ("reason" in applied) return applied.reason;
    }
    return null;
  }

  applySweepPatch(obj: PlateObject, patch: SweepPatch): void {
    if (patch.parameters) this.paramsTool({ set: patch.parameters });
    const next = { ...obj.objectSettings };
    if (patch.walls !== undefined) {
      const applied = applyObjectSetting(this.settings, "walls", patch.walls, this.schemaContext());
      if (!("reason" in applied)) next.walls = applied.value as number;
    }
    if (patch.infill !== undefined) {
      const applied = applyObjectSetting(this.settings, "infill", patch.infill, this.schemaContext());
      if (!("reason" in applied)) next.infill = applied.value as number;
    }
    obj.objectSettings = next;
    if (!obj.sim) return;
    const study = cloneStudy(obj.sim);
    if (patch.pattern) study.pattern = patch.pattern;
    if (patch.loadScale !== undefined && patch.loadScale !== 1) study.loads = scaleLoads(study.loads, patch.loadScale);
    obj.sim = study;
  }

  async simSweep(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!Array.isArray(input.variants)) return { ok: false, reason: SWEEP_REFUSAL };
    if (input.variants.length > SWEEP_CAP) return { ok: false, reason: SWEEP_REFUSAL };
    const patches: SweepPatch[] = [];
    for (const item of input.variants) {
      const patch = readPatch(item);
      if (typeof patch === "string") return { ok: false, reason: patch };
      const problem = this.sweepPatchProblem(patch);
      if (problem) return { ok: false, reason: problem };
      patches.push(patch);
    }
    const limits = readLimits(input.constraints);
    if (typeof limits === "string") return { ok: false, reason: limits };
    const obj = this.simTarget(input);
    if ("reason" in obj) return { ok: false, reason: obj.reason };
    const sliced = obj.sim !== undefined && this.representationFor(obj, obj.sim) === "sliced";
    if (sliced && input.reslice !== true) return { ok: false, reason: SLICED_SWEEP };
    if (!sliced && input.reslice === true) return { ok: false, reason: RESLICE_BEAM };
    if (sliced) return this.slicedSweep(obj, patches, limits as ConstraintLimits, input);
    type SweepRow = Record<string, unknown> & { ok?: boolean; met: boolean; reason: string; slicerSeconds?: number };
    const rows: SweepRow[] = patches.map((patch): SweepRow => {
      const solved = this.solveCopy(obj, patch, "run");
      if (solved.ok !== true) return { ok: false, met: false, reason: typeof solved.reason === "string" ? solved.reason : OPEN_MESH };
      const verdict = constraintVerdict({
        maxDisplacementMm: typeof solved.maxDisplacementMm === "number" ? solved.maxDisplacementMm : 0,
        minSafetyFactor: typeof solved.minSafetyFactor === "number" ? solved.minSafetyFactor : null,
        massG: typeof solved.massG === "number" ? solved.massG : 0,
      }, limits as ConstraintLimits);
      return { ...solved, met: verdict.met, reason: verdict.reason };
    });
    const commit = input.commit === true;
    let committed = false;
    if (commit) {
      const index = typeof input.variant === "number" ? input.variant : patches.length === 1 ? 0 : -1;
      if (!Number.isInteger(index) || index < 0 || index >= patches.length) return { ok: false, variants: rows, reason: "Name the variant to keep." };
      const chosen = rows[index];
      if (!chosen || chosen.ok === false) return { ok: false, variants: rows, reason: typeof chosen?.reason === "string" ? chosen.reason : OPEN_MESH };
      this.remember("Sweep");
      this.applySweepPatch(obj, patches[index]!);
      committed = true;
    }
    let note = "";
    if (input.includePrintTime === true) {
      const estimate = this.freshEstimate();
      if (estimate) {
        for (const row of rows) row.slicerSeconds = estimate.seconds;
        note = "The slicer's estimate.";
      } else note = "Print time was not estimated.";
    }
    return { ok: true, variants: rows, committed, ...(note ? { note } : {}) };
  }

}

type Installed = typeof workMethods & typeof recipeMethods & typeof pluginMethods & typeof nuggetMethods & typeof fontsMethods & typeof infoMethods & typeof plateMethods & typeof projectMethods & typeof machineMethods & typeof settingsMethods & typeof sliceMethods & typeof layersMethods & typeof modelMethods & typeof placeMethods & typeof probeMethods & typeof applyMethods & typeof paramsMethods & typeof historyMethods & typeof splitMethods & typeof paintMethods;

/** The tool modules' methods run with this: Session; they are installed here, and typed through this merge. */
export interface Session extends Installed {}
Object.assign(Session.prototype, workMethods, recipeMethods, pluginMethods, nuggetMethods, fontsMethods, infoMethods, plateMethods, projectMethods, machineMethods, settingsMethods, sliceMethods, layersMethods, modelMethods, placeMethods, probeMethods, applyMethods, paramsMethods, historyMethods, splitMethods, paintMethods);

export { blendOf };
