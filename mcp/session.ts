/**
 * One stdio connection is one plate. The engine is behind `Engine`.
 * Feasibility refusals are `{ok:false, reason}` and are decided before apply.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { bytesToBase64 } from "../src/base64.ts";
import { fnv1aHex } from "../src/slice-action.ts";
import type { Mat3 } from "../src/mesh-place.ts";
import type { SolidView } from "../src/modeling/model-calls.ts";
import { expandOpsWithTexts, type PartDef } from "../src/modeling/macro.ts";
import { DEFAULT_PRESET, presetKeys, type PresetSettings } from "../src/presets.ts";
import type { LimeProject } from "../src/project.ts";
import { finishProject, prepareProject } from "../src/project-codec.ts";
import { emptyOverrides, type OverrideDocument } from "../src/overrides.ts";
import type { StressCells } from "../src/sim/stress-cells.ts";
import type { PrintOrder } from "../src/settings-rules.ts";
import type { LayerAction } from "../src/layer-actions.ts";
import { builtinLibrary, type MachineLibrary } from "../src/ui/machine-library.ts";
import { systemOpener, type AppOpener } from "./app-open.ts";
import { mirror, type BridgeLink } from "./bridge-client.ts";
import { ProtocolError, type Engine } from "./engine.ts";
import { imagesOf, withImages } from "./inline.ts";
import { RecipeHost } from "./recipe.ts";
import { blendOf } from "./request.ts";
import { guideByUri } from "./guides.ts";
import { GROUP_NAMES, groupOf, groupsOptedIn, SCHEMAS_REPLY_CAP, TOOL_GROUPS } from "./groups.ts";
import { annotationsFor, EXPRESSION_TOOLS, OP_WORDS, toolByName, validateTool } from "./schema.ts";
import { autosavePath, takePreviousAutosave, writeAutosave, type PlanRecovery, type PreviousAutosave } from "./autosave.ts";
import { withBoxAnchor, isComposite } from "../src/modeling/compose.ts";
import { expressionMentions, isPlainNumber } from "../src/modeling/params.ts";
import type { Assembly } from "../src/assembly.ts";
import { ExprError, resolveNumbers, resolveTexts, substituteNames } from "../src/modeling/expr.ts";
import { textsNeedingFonts, UserFontShelf } from "../src/modeling/user-fonts.ts";
import { type CallMeta, DETACHABLE, type Job, LONG_CALLS, type PickRow, type PlateObject, type PlateSnap, type Recipe, type RustRecipe, type ToolHandler, UNKNOWN_OBJECT, type WorkJob, changedValues, changesPlate, domainRefusal, edgePicksAsTyped, shownName, withPicks } from "./session/shared.ts";
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
import { animationMethods, animationHandlers } from "./session/animation.ts";
import { modelMethods, modelHandlers } from "./session/model.ts";
import { placeMethods } from "./session/place.ts";
import { probeMethods } from "./session/probe.ts";
import { applyMethods } from "./session/apply.ts";
import { paramsMethods } from "./session/params.ts";
import { historyMethods } from "./session/history.ts";
import { splitMethods } from "./session/split.ts";
import { paintMethods, paintHandlers } from "./session/paint.ts";
import { calibrationMethods, calibrationHandlers } from "./session/calibration.ts";
import { stressMethods, stressHandlers } from "./session/stress.ts";
import { refuse, withCode } from "./refusals.ts";
import type { RecipeCheckpoint } from "./recipe-checkpoint.ts";

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
  ...animationHandlers,
  ...modelHandlers,
  ...paintHandlers,
  ...calibrationHandlers,
  ...stressHandlers,
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
  /** Scratch checks share the engine but never mirror or autosave their temporary plate. */
  readonly isolated: boolean;
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
  lustId: string | undefined;
  /** I21: each recipe name's call count on its last run, for "call N of about M". */
  readonly recipeCallCounts = new Map<string, number>();
  /** Last successful dry run's source, to avoid silently saving an older applied draft. */
  readonly recipePreviewHashes = new Map<string, string>();
  /** Resumable runs belong to this session's autosave, never to an imported project. */
  readonly recipeCheckpoints = new Map<string, RecipeCheckpoint>();
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
  /** This session has successfully written its own snapshot, rather than another session's file at the same path. */
  autosaveSnapshot = false;
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

  constructor(engine: Engine, options: { isolated?: boolean } = {}) {
    this.engine = engine;
    this.isolated = options.isolated === true;
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
    if ("reason" in numbered) return Promise.resolve(refuse("bad-argument", numbered.reason));
    const picked = edgePicksAsTyped(numbered.args);
    if ("reason" in picked) return Promise.resolve(refuse("bad-argument", picked.reason));
    args = picked.args;
    const problem = validateTool(name, args ?? {});
    if (problem) throw new ProtocolError(problem);
    const input = (args ?? {}) as Record<string, unknown>;
    const changes = !annotationsFor(name).readOnlyHint && (changesPlate(name) || (name === "model_params" && input.rebuild === true));
    const activity = changes && !this.isolated ? crypto.randomUUID() : null;
    if (activity) void mirror({ activity: { id: activity, phase: "start", tool: name, ...(typeof input.object === "string" ? { object: input.object } : {}) } });
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
      if (activity) void mirror({ activity: { id: activity, phase: "end" } });
      throw err;
    }
    const work = Promise.resolve(result).then((value) => {
      if (!this.isolated) {
        const { payload, carriedAll } = this.bridgePayload(name, input, value);
        this.lastBridge = payload;
        void mirror(payload, this.bridgeLink, carriedAll);
      }
      return withPicks(withCode(this.withAutosaveHint(value)), picks);
    }).catch((err: unknown) => {
      if (err instanceof ProtocolError) {
        const refusal = domainRefusal(err.message);
        if (refusal) return withPicks(refusal, picks);
      }
      throw err;
    }).finally(() => {
      this.inflight -= 1;
      if (activity) void mirror({ activity: { id: activity, phase: "end" } });
      if (changes && !this.isolated) {
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
    // The note comes first: a client that sets a long reply aside still reads its start.
    const reply: Record<string, unknown> = {
      ok: true,
      note: "The tool list has changed. If these tools do not appear in yours, call them through plan_run {steps:[{tool, args}]}, or by name: a tool of any group opens its group.",
      enabled: GROUP_NAMES.filter((group) => this.toolGroups!.has(group)),
      added: added.flatMap((group) => TOOL_GROUPS[group]!.tools),
    };
    if (input.schemas === true) {
      const wanted = Array.isArray(input.tools) ? new Set(input.tools as string[]) : null;
      const rows = addedTools.filter((tool) => !wanted || wanted.has(tool));
      const schemas = rows.map((tool) => { const spec = toolByName(tool); return spec ? { name: tool, description: spec.description, inputSchema: spec.inputSchema } : { name: tool }; });
      // A whole group's schemas run to tens of kilobytes, more than a client shows. Past the cap, the reply names the
      // tools and asks for the few that are needed.
      if (JSON.stringify(schemas).length > SCHEMAS_REPLY_CAP) {
        reply.schemas = [];
        reply.schemasNote = `${rows.length} schemas are too long for one reply. Ask for the ones you need: tools_enable {groups, schemas:true, tools:["model_apply"]}.`;
      } else reply.schemas = schemas;
    }
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
  flushAutosave(plan?: PlanRecovery, forceEmpty = false): void {
    if (!this.autosaveDirty && !plan) return;
    const dirty = this.autosaveDirty;
    this.autosaveDirty = false;
    if (this.objects.length === 0 && !plan && this.recipeCheckpoints.size === 0 && !forceEmpty) return;
    try {
      const path = autosavePath();
      if (!path) return;
      // A read-only step changes only the recovery marker; reuse the packed snapshot instead of recompressing meshes.
      if (!dirty && plan && this.autosaveSnapshot && existsSync(path)) {
        const snapshot = structuredClone(plan);
        this.autosaveWriting = this.autosaveWriting.then(async () => {
          const wire = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
          wire.mcpPlanRecovery = snapshot;
          await writeAutosave(path, JSON.stringify(wire));
        }).catch(() => undefined);
        return;
      }
      // A solid never committed has no plate mesh yet: its kernel mesh stands in, so the file opens.
      const doc = this.withKernelMeshes(this.saveDocument());
      this.attachPreview(doc, false);
      // One write at a time, off the call's path; a failed write is not worth failing a call for. The binary records are
      // compressed in that chain too, so the call does not wait for them.
      // The document is taken now (a copy), so a write queued behind another still saves the plate as it is at this call.
      const prepared = prepareProject(doc);
      if (plan) prepared.wire.mcpPlanRecovery = structuredClone(plan);
      if (this.recipeCheckpoints.size) prepared.wire.mcpRecipeCheckpoints = structuredClone(Object.fromEntries(this.recipeCheckpoints));
      this.autosaveWriting = this.autosaveWriting.then(async () => {
        await writeAutosave(path, await finishProject(prepared));
        this.autosaveSnapshot = true;
      }).catch(() => undefined);
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
      return refused ? refuse("refused", refused) : this.dispatchNow(name, copy, meta);
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










}

type Installed = typeof animationMethods & typeof workMethods & typeof recipeMethods & typeof pluginMethods & typeof nuggetMethods & typeof fontsMethods & typeof infoMethods & typeof plateMethods & typeof projectMethods & typeof machineMethods & typeof settingsMethods & typeof sliceMethods & typeof layersMethods & typeof modelMethods & typeof placeMethods & typeof probeMethods & typeof applyMethods & typeof paramsMethods & typeof historyMethods & typeof splitMethods & typeof paintMethods & typeof calibrationMethods & typeof stressMethods;

/** The tool modules' methods run with this: Session; they are installed here, and typed through this merge. */
export interface Session extends Installed {}
Object.assign(Session.prototype, animationMethods, workMethods, recipeMethods, pluginMethods, nuggetMethods, fontsMethods, infoMethods, plateMethods, projectMethods, machineMethods, settingsMethods, sliceMethods, layersMethods, modelMethods, placeMethods, probeMethods, applyMethods, paramsMethods, historyMethods, splitMethods, paintMethods, calibrationMethods, stressMethods);

export { blendOf };
