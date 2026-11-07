/**
 * The app's answers to a recipe's calls (docs/plan-recipe-plugins.md D16, milestones 6 and the app's rebuild of every
 * plugin). A run in the window holds its own small plate: the part it was given, if any, and every part it makes. Each
 * call is answered against those parts' histories in the app's engine, through the code the MCP session answers it
 * with (`src/modeling/`: `bake.ts` turns a typed op into the stored op, `composite-apply.ts` expands and gathers a
 * composite, `model-calls.ts` and `part-reads.ts` word the replies, `placing.ts` moves a part), so the same values build
 * the same solids either way.
 *
 * Nothing reaches the plate while the run goes: the parts' trees are copies, and the engine holds the new steps and
 * trees. The caller keeps what the run left at `done` (`parts`), or drops it.
 *
 * Refused in the app with a sentence, as the window has no place for them yet: a fit coupon (solid_new {coupon}), an
 * assembly (model_place {to} or {assembly}), model_check {interference}, and the planners (model_probe {plan}).
 */
import { AnchorError, hasAnchor, resolveAnchors, type Box } from "../modeling/anchors.ts";
import { bakeOp, bakeTransition, onFaceIndex, profilePlane as profilePlaneOf, type BakeContext, type Baked } from "../modeling/bake.ts";
import { bakeCells, isCellArray, runComposite, runsAsComposite, storeGroup, type CompositePort, type GroupPort } from "../modeling/composite-apply.ts";
import { cleanOp, expand, featureCopies, isComposite, MAX_PIECES, primitiveFrom, TOUCH_TRIM, type Piece } from "../modeling/compose.ts";
import { surfaceAt } from "../modeling/inspect.ts";
import { appliedReply, boundsOf, describeReply, disjointRefusal, edgesReply, facesReply, nodeHandle, parseNode, partExpandContext, probeEcho, probeVerdict, solidSections, solidView, stepGuard, storedOp, typedPlaneOf, typedPointIn, type SolidView } from "../modeling/model-calls.ts";
import { clampPieces } from "../modeling/partition.ts";
import { checkReply, historyReply, keptSide, labelBox, measureReply, splitCheck, splitKeep, type StepGroup } from "../modeling/part-reads.ts";
import { assembledBox, frameNote, frameWhere, placeFree, placeOnPlate, placedBounds, type PlatePlace } from "../modeling/placing.ts";
import { typedView } from "../modeling/typed-view.ts";
import { cutPlanes, MAX_SECTION_POINTS, pointsIn } from "../modeling/sections.ts";
import { plainModelError } from "../app/model-error.ts";
import { dataMissingInApp } from "./plugin-data.ts";
import { probeKey } from "../model-feasibility.ts";
import type { BeltSettings } from "../belt.ts";
import { isFeatureTool } from "../model-features.ts";
import { ID_MATRIX, type Mat3 } from "../mesh-place.ts";
import { rootSpec } from "../model-primitive.ts";
import { applyRequest, gotoRequest, joinOp, newSolidRequest, probeRequest } from "../model-request.ts";
import { applyPose, IDENTITY_POSE, typedPoseOf, type Affine, type ObjectFrame } from "../model-space.ts";
import { dropped, jumped, newTree, opLabel, pathTo, reserveId, withChild, withNode, type GroupOp, type ModelOp, type ModelTree, type NodeId, type PartitionModelOp } from "../model-tree.ts";
import { runEndingAt } from "../plugin-step.ts";
import { GLOBAL_WORKPLANE, planePrimitive, type Workplane } from "../workplane.ts";
import type { RecipeCall, RecipeCallSite, RecipeReply } from "./host.ts";
import { answerPick, sketchOutline, type PickReads } from "./picks.ts";
import { answerTextOutline } from "./text-outline.ts";

type Body = Record<string, unknown>;

/** The part a run is given, as the app holds it at the step the run starts on. */
export interface AppRecipePart {
  /** The plate object's id: the name the recipe's `object` and every call's `object` use. */
  id: string;
  /** Its name on the plate. */
  name?: string;
  /** Its history: `current` is the step the run starts on. */
  tree: ModelTree;
  /** That step's solid, as the engine last answered it. */
  solid: SolidView;
  /** The typed pose: ops are typed in model space and stored in the solid's own frame. */
  pose: Affine;
  /** Its pose in model space, when it differs from the typed pose (a part typed in its own frame). */
  modelPose?: Affine;
  /** The part's workplane, in its own frame. */
  workplane: Workplane;
  /** The frame a reply names: "model". */
  frame: string;
  /** Its place on the plate: what model_check reads (turn and scale) and object_place changes. */
  place?: PlatePlace;
}

/** The app's engine, as a run asks it. */
export interface AppEngine {
  /** One request about tree `key` that needs step `node`. */
  tree(key: string, node: NodeId, request: Body): Promise<Body>;
  /** A request that opens a new tree (solid_new). */
  open(request: Body): Promise<Body>;
}

/** Recipe data a step's run kept (`data {name}`): the parsed value, by name. */
export type KeptData = Record<string, { value: unknown }>;

/** What a run reads of the window besides its parts. */
export interface AppRunEnv {
  chordMm: number;
  /** The step's kept data (a draft's run, from the project's `rustRecipes`): read first. */
  data?: KeptData;
  /** The data a kept plugin's file carries (`./plugin-data.ts`): read when the step kept none. Set for a kept plugin's run. */
  carried?: KeptData;
  /** The project's parameters, for numbers typed as expressions (model_place). */
  params?: Record<string, number>;
  /** The plate's printer: model_check, a print transition, object_place. */
  printer?: { id: string; name: string; bedMm: [number, number, number]; nozzleMm: number; belt: BeltSettings | null };
  /** The support angle of the settings: a print transition's least angle. */
  supportAngle?: number;
  /** A plate id and a tree key for a part the run makes. */
  newPart?(): { id: string; key: string };
  /** A tree key for a piece a split (`half`) or a split to print (its part number, or `pins`) cuts off `owner`. */
  pieceKey?(owner: string, node: NodeId, piece: number | "half" | "pins"): string;
  /** A split to print as stored, read from the window's printers and settings. Without it, one is refused. */
  partition?(spec: Record<string, unknown>, part: RunPart): Baked | { reason: string };
  /** Another part on the plate at its shown step, for a picked outline that names it (API 1.2). */
  otherPart?(id: string): Omit<AppRecipePart, "solid"> | null;
}

/** One part in a run: the one it was given, one it made, or a piece a split cut off. */
export interface RunPart {
  id: string;
  name: string;
  /** given: the run's object; made: solid_new; half: a split's other half; piece and pins: a split to print's. */
  origin: "given" | "made" | "half" | "piece" | "pins";
  tree: ModelTree;
  solid: SolidView | null;
  /** The engine's reply for the shown step (for a piece, the cut's entry): the solid to show. */
  body: Body | null;
  modelPose: Affine;
  frame?: ObjectFrame;
  workplane: Workplane;
  place: PlatePlace;
  /** The step the run found it on (a part it made: its root). */
  start: NodeId;
  /** The first step id the run took on this part, applied or not: what a caller drops when it takes the run back. */
  firstReserved: NodeId | null;
  /** Runs of steps one undo takes back, made in this run (a batch, a composite). */
  groups: StepGroup[];
  /** model_place moved it in model space. */
  posed: boolean;
  /** object_place moved it on the plate. */
  placed: boolean;
  /** A join took it into another part (keepTool false): it leaves the plate. */
  consumed: boolean;
  /** The part and step a split or a split to print cut it off at. */
  cut?: { key: string; node: NodeId; index?: number };
}

/** A part the app holds, as a run holds it from its shown step. */
function runPartOf(part: Omit<AppRecipePart, "solid"> & { solid: SolidView | null }, origin: RunPart["origin"]): RunPart {
  return {
    id: part.id,
    name: part.name ?? part.id,
    origin,
    tree: part.tree,
    solid: part.solid,
    body: null,
    modelPose: part.modelPose ?? part.pose,
    ...(part.modelPose && part.pose !== part.modelPose && isIdentityPose(part.pose) ? { frame: "part" as const } : {}),
    workplane: part.workplane,
    place: part.place ? { ...part.place, offset: { ...part.place.offset }, orient: [...part.place.orient] as Mat3 } : IDENTITY_PLACE(),
    start: part.tree.current,
    firstReserved: null,
    groups: [],
    posed: false,
    placed: false,
    consumed: false,
  };
}

const IDENTITY_PLACE = (): PlatePlace => ({ source: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), orient: [...ID_MATRIX] as Mat3, scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 } });

const NAME_LIMIT = 120;

/** The steps a run added to a part, oldest first: those after its start on the way to its shown step (all of a made part's). */
export function runSteps(part: RunPart): NodeId[] {
  const path = pathTo(part.tree, part.tree.current);
  if (part.origin !== "given") return path;
  const at = path.indexOf(part.start);
  return at < 0 ? [] : path.slice(at + 1);
}

/** The app's answers for one run. */
export class AppRecipeCalls {
  /** The run's own notes (`log`), as the MCP keeps them: `line N: text`. */
  readonly notes: string[] = [];
  private readonly parts = new Map<string, RunPart>();
  private readonly order: string[] = [];
  private readonly givenId: string | null;
  private selected: string | null;
  private readonly engine: AppEngine;
  private readonly env: AppRunEnv;
  private seq = 0;
  /** Ops a model_probe found to fit, by part and step: what a model_apply without probe: true may apply. */
  private readonly probed = new Set<string>();

  constructor(part: AppRecipePart | null, engine: AppEngine, env: AppRunEnv) {
    this.engine = engine;
    this.env = env;
    this.givenId = part?.id ?? null;
    this.selected = this.givenId;
    if (part) this.add(runPartOf(part, "given"));
  }

  /** The values the run was given: what a `pick` resolves (API 1.2). */
  params: Record<string, unknown> = {};
  /** What each given face or outline resolved to, for the step's stamp in its place. */
  readonly picked: Record<string, unknown> = {};

  /** Every part of the run, in the order it was given or made. */
  get all(): RunPart[] {
    return this.order.map((id) => this.parts.get(id)!);
  }

  /** The part the run was given, as it stands now. */
  get given(): RunPart | null {
    return this.givenId ? this.parts.get(this.givenId) ?? null : null;
  }

  /** A part by id. */
  part(id: string): RunPart | undefined {
    return this.parts.get(id);
  }

  /** The handler the shared host calls (`runRecipe`). */
  readonly call: RecipeCall = async (site) => this.answer(site);

  private add(part: RunPart): RunPart {
    this.parts.set(part.id, part);
    if (!this.order.includes(part.id)) this.order.push(part.id);
    return part;
  }

  /** A part a call may name: the one given, or one the run made (D11.1). Halves and pieces are the MCP's too. */
  private addressable(id: string): RunPart | null {
    const part = this.parts.get(id);
    return part && (part.origin === "given" || part.origin === "made") && !part.consumed ? part : null;
  }

  private async answer(site: RecipeCallSite): Promise<RecipeReply> {
    const args = site.args;
    if (site.tool === "native_geometry") {
      const result = await this.engine.open({ call: "nativeGeometry", args });
      return Array.isArray(result) ? { ok: true, result } : { ok: false, error: "Native geometry is unavailable." };
    }
    if (site.tool === "checkpoint") return { ok: false, error: "Resumable checkpoints are available over MCP. Run this recipe over MCP to keep completed work." };
    if (site.tool === "log") {
      if (this.notes.length < 200) this.notes.push(`line ${site.line}: ${String(args.message ?? args.text ?? "").slice(0, 400)}`);
      return { ok: true, result: { ok: true } };
    }
    if (site.tool === "pick") {
      const on = typeof args.object === "string" ? args.object : undefined;
      if (args.kind === "face" && on !== undefined && !this.addressable(on)) return { ok: false, error: `A recipe can change only the part it was given and the parts it made; ${on} is neither. Pass it as object to run on it.` };
      return answerPick(args, this.params, this.pickReads(), this.picked);
    }
    // --- API 1.3: the letters of a text as a flat outline. The engine's stateless layout is asked as any request is.
    if (site.tool === "text_outline") return answerTextOutline(args, (request) => this.engine.open(request));
    if (site.tool === "data") {
      const name = typeof args.name === "string" ? args.name : "";
      // The step's kept data, then the data the plugin carries; the workspace's files are the MCP's alone.
      const kept = this.env.data?.[name] ?? this.env.carried?.[name];
      if (!kept) return { ok: false, error: this.env.carried ? dataMissingInApp(name) : `No recipe data named ${name || "(no name)"} is kept with this step. Rebuild it over MCP (recipe_run {object, params}), where the workspace's file is read.` };
      return { ok: true, result: kept.value };
    }
    let value: Body;
    if (site.tool === "solid_new") value = await this.solidNew(args);
    else {
      const target = typeof args.object === "string" ? args.object : this.selected ?? "";
      // Placing changes no history step, so a run places only the parts it made, relative to each other or the bed.
      if (site.tool === "model_place" || site.tool === "object_place") {
        const align = args.align as { to?: unknown } | undefined;
        const others = [args.to, align?.to].filter((v): v is string => typeof v === "string" && v !== "bed");
        if (this.parts.get(target)?.origin !== "made" || others.some((id) => this.parts.get(id)?.origin !== "made")) {
          return { ok: false, error: `${site.tool} in a recipe places only the objects this run made (solid_new), relative to each other or the bed.` };
        }
      }
      // --- O8 (D11.1). A recipe touches only the part it was given and the parts it made.
      const part = this.addressable(target);
      if (!part) return { ok: false, error: `A recipe can change only the part it was given and the parts it made; ${target || "(no part)"} is neither. Pass it as object to run on it.` };
      value = await this.partCall(part, site.tool, args);
    }
    if (value.ok === false) {
      const { ok: _ok, reason, ...extra } = value;
      const failedStep = (extra as { failed?: { reason?: unknown } }).failed?.reason;
      return { ok: false, error: typeof reason === "string" ? reason : typeof failedStep === "string" ? failedStep : `${site.tool} was refused.`, extra };
    }
    return { ok: true, result: value };
  }

  /** A part a pick reads: one of the run's, or another on the plate the person named (read only). */
  private readable(id: string): RunPart | null {
    const own = this.parts.get(id);
    if (own) return own;
    let other = this.others.get(id);
    if (!other) {
      const found = this.env.otherPart?.(id);
      if (!found) return null;
      other = runPartOf({ ...found, solid: null }, "half");
      this.others.set(id, other);
    }
    return other;
  }

  /** Parts a pick read that are not the run's, at their shown steps. */
  private readonly others = new Map<string, RunPart>();

  /** A part's shown solid for a pick: another part's is read from the engine once. */
  private async solidFor(p: RunPart): Promise<SolidView | null> {
    if (p.solid) return p.solid;
    const reply = await this.engine.tree(p.tree.key, p.tree.current, gotoRequest(p.tree.key, p.tree.current, this.env.chordMm));
    p.solid = typeof reply.error === "string" && reply.error ? null : solidView(reply);
    return p.solid;
  }

  /** --- API 1.2. What a pick reads, through this run's own answers. */
  private pickReads(): PickReads {
    return {
      faces: async (id) => {
        const p = this.readable(id);
        if (!p) return { reason: `${id} is not a part on the plate.` };
        return (await this.solidFor(p)) ?? { reason: "This solid could not be read." };
      },
      section: async (id, args) => {
        const p = this.readable(id);
        if (p) await this.solidFor(p);
        return p?.solid ? this.section(p, args) : { ok: false, reason: `${id} is not a part on the plate.` };
      },
      pose: (id) => {
        const p = this.readable(id);
        return p ? this.typed(p) : IDENTITY_POSE;
      },
      sketch: (id, step) => {
        const p = this.readable(id);
        return p ? sketchOutline(p.tree, step, this.typed(p)) : { reason: `${id} is not a part on the plate.` };
      },
      data: async (name) => {
        const kept = this.env.data?.[name];
        return kept ? { value: kept.value } : { reason: `No recipe data named ${name} is kept with this step. Pick a sketch or a face's outline instead.` };
      },
    };
  }

  private async partCall(p: RunPart, tool: string, args: Body): Promise<Body> {
    switch (tool) {
      // --- API 1.4. Reads answer in the frame ops are typed in, as the MCP session's do: a point read is where a cut at it lands.
      case "model_describe": return describeReply(this.need(p), args, p.frame ?? "model", {}, this.typed(p));
      case "faces_find": return facesReply(this.need(p), args, this.expand(p), this.typed(p), p.frame ?? "model");
      case "edges_find": return edgesReply(this.need(p), args, (filter) => onFaceIndex(filter, this.bakeContext(p)), this.typed(p), p.frame ?? "model");
      case "surface_at": return { ...surfaceAt(typedView(this.need(p), this.typed(p)), args), frame: p.frame ?? "model" };
      case "section": return this.section(p, args);
      case "model_probe": return this.probeTool(p, args);
      case "model_apply": return this.applyTool(p, args);
      case "model_apply_batch": return this.applyBatch(p, args);
      case "model_check": return this.check(p, args);
      case "measure": return this.measure(p, args);
      case "model_history": return historyReply(p.tree, args);
      case "model_place": return this.modelPlace(p, args);
      case "object_place": return this.objectPlace(p, args);
      default: return { ok: false, reason: `${tool} is not a recipe call.` };
    }
  }

  /** The shown solid; every part of a run has one once it opened. */
  private need(p: RunPart): SolidView {
    return p.solid as SolidView;
  }

  // --- New parts and where they stand. ---

  private async solidNew(args: Body): Promise<Body> {
    if (args.coupon !== undefined) return { ok: false, reason: "A fit coupon makes its plate and pins as parts of their own, which a plugin run in the app cannot place yet. Run it over MCP." };
    const typed = primitiveFrom(args);
    if ("reason" in typed) return { ok: false, reason: typed.reason };
    const kind = typed.primitive;
    this.seq += 1;
    const named = this.env.newPart?.() ?? { id: `run_${this.seq}`, key: `run-${Date.now().toString(36)}-${this.seq}` };
    const reply = await this.engine.open(newSolidRequest(named.key, typed, this.env.chordMm));
    const error = typeof reply.error === "string" ? reply.error : "";
    if (error) return { ok: false, reason: plainModelError(error, "create") };
    const solid = solidView(reply);
    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim().slice(0, NAME_LIMIT) : kind;
    this.add({
      id: named.id,
      name,
      origin: "made",
      tree: newTree(named.key, { kind: "primitive", solid: rootSpec(typed) }, kind, null),
      solid,
      body: reply,
      modelPose: IDENTITY_POSE,
      workplane: GLOBAL_WORKPLANE,
      place: IDENTITY_PLACE(),
      start: 0,
      firstReserved: null,
      groups: [],
      posed: false,
      placed: false,
      consumed: false,
    });
    this.selected = named.id;
    return { ok: true, object: named.id, fingerprint: solid?.fingerprint ?? null, bounds: solid?.bounds ?? null, frame: "part" };
  }

  private modelPlace(p: RunPart, input: Body): Body {
    if (input.frame !== undefined && input.frame !== "part" && input.frame !== "model") return { ok: false, reason: 'frame is "part" or "model".' };
    if (input.to !== undefined || input.assembly !== undefined) return { ok: false, reason: "An assembly is kept by the plate, which a plugin run in the app does not change. Place the part by x, y, z and turns, or run the plugin over MCP." };
    const free = placeFree(p, input, this.env.params ?? {});
    if ("reason" in free) return { ok: false, reason: free.reason };
    p.modelPose = free.pose.modelPose;
    if (free.pose.frame === "part") p.frame = "part";
    else delete p.frame;
    p.posed = true;
    const box = assembledBox(p.solid?.positions, p.modelPose);
    const once = free.texts ? " An expression here is read once; an offset from another part (to) follows the parameters." : "";
    const { ok: _ok, pose: _pose, frame, ...where } = free.reply;
    return { ok: true, pose: "assembled", ...where, frame, ...(box ? { assembledMm: box } : {}), note: `Assembled pose set. The print layout is unchanged.${once} ${frameNote(frame as ObjectFrame)}` };
  }

  private objectPlace(p: RunPart, input: Body): Body {
    const printer = this.env.printer;
    if (!printer) return { ok: false, reason: "object_place needs the plate's printer." };
    p.placed = true;
    return placeOnPlate(p.place, input, {
      bedMm: printer.bedMm,
      ...(p.solid ? { faces: p.solid.faces } : {}),
      boundsOf: (id) => {
        const other = this.parts.get(id);
        return other && other !== p ? placedBounds(other.place, printer.bedMm) : null;
      },
    });
  }

  // --- Reading a part. ---

  private check(p: RunPart, input: Body): Body {
    if (input.interference === true) return { ok: false, reason: "An interference check reads every part on the plate, which a plugin run in the app does not see. Run it over MCP." };
    const printer = this.env.printer;
    if (!printer) return { ok: false, reason: "model_check needs the plate's printer." };
    if (!p.solid || p.solid.positions.length < 9) return { ok: false, reason: "This solid could not be read." };
    return checkReply(p.solid.positions, p.place.orient, p.place.scale, { name: printer.name, bedMm: printer.bedMm, nozzleMm: printer.nozzleMm }, input);
  }

  private measure(p: RunPart, input: Body): Promise<Body> {
    return measureReply(p.solid, this.typedPlane(p), input, (faceA, faceB) => this.engine.tree(p.tree.key, p.tree.current, { call: "distance", key: p.tree.key, node: p.tree.current, aKind: "face", aIndex: faceA, bKind: "face", bIndex: faceB }));
  }

  private async section(p: RunPart, args: Body): Promise<Body> {
    if (typeof args.saveAs === "string") return { ok: false, reason: "A recipe reads section's answer directly; saveAs is for a call from the chat." };
    const cuts = args.face === undefined ? cutPlanes(args) : null;
    if (cuts && "reason" in cuts) return { ok: false, reason: cuts.reason };
    if (args.face !== undefined && ["planes", "fan", "levels"].some((key) => args[key] !== undefined)) return { ok: false, reason: "Give a face or planes, not both." };
    const chordMm = typeof args.chordMm === "number" ? args.chordMm : 0.05;
    const node = p.tree.current;
    const cut = await solidSections(args, chordMm, cuts, this.typed(p), this.expand(p), (request) => this.engine.tree(p.tree.key, node, { ...request, key: p.tree.key, node }));
    if ("reason" in cut) return { ok: false, reason: cut.reason };
    const points = cut.sections.reduce((sum, section) => sum + pointsIn(section), 0);
    if (points > MAX_SECTION_POINTS) return { ok: false, reason: `This answer would hold ${points} points, over ${MAX_SECTION_POINTS}. Cut fewer planes, pass resample, or a larger chordMm.` };
    return { ok: true, object: p.id, ...cut.extra, sections: cut.sections };
  }

  // --- Frames and baking. ---

  private typed(p: RunPart): Affine {
    return typedPoseOf(p);
  }

  private typedPlane(p: RunPart): Workplane {
    return typedPlaneOf(p.workplane, this.typed(p));
  }

  private expand(p: RunPart) {
    return partExpandContext(p.solid, this.typed(p), p.workplane);
  }

  private bakeContext(p: RunPart): BakeContext {
    const printer = this.env.printer;
    return {
      pose: this.typed(p),
      solid: p.solid,
      plane: this.typedPlane(p),
      expand: () => this.expand(p),
      nodeOf: (value) => this.nodeOf(p, value),
      hasNode: (id) => p.tree.nodes.has(id),
      join: (spec) => {
        const id = String(spec.toolObject ?? "");
        const tool = this.addressable(id);
        if (!tool || tool === p) return { reason: `A recipe joins only parts it made; ${id || "(no part)"} is not one.` };
        const op = joinOp(spec.op === "fuse" || spec.op === "common" ? spec.op : "cut", { object: tool.id, key: tool.tree.key, node: tool.tree.current, name: tool.name }, p.modelPose, tool.modelPose, spec.keepTool === true);
        return { op, typed: { kind: "join", toolObject: tool.id, keepTool: spec.keepTool === true } };
      },
      ...(this.env.partition ? { partition: (spec: Record<string, unknown>) => this.env.partition!(spec, p) } : {}),
      ...(printer ? { transition: (spec: Record<string, unknown>) => bakeTransition(spec, this.bakeContext(p), { supportAngle: this.env.supportAngle ?? 45, nozzleMm: printer.nozzleMm, printer: { id: printer.id, belt: printer.belt }, orient: p.place.orient }) } : {}),
    };
  }

  /** A step by its handle (`node_4`) or its label, as the session reads one. */
  private nodeOf(p: RunPart, value: unknown): number | null {
    const parsed = parseNode(value);
    if (parsed !== null || typeof value !== "string") return parsed;
    const wanted = value.trim().toLowerCase();
    const rows = [...p.tree.nodes.values()].filter((node) => node.label.toLowerCase() === wanted);
    return rows.length > 0 ? rows[rows.length - 1]!.id : null;
  }

  /** The runs one undo takes back, by label: the run's own groups, and each stamped plugin run as `recipe <name>`. */
  private stepGroups(p: RunPart): StepGroup[] {
    const runs = [...p.tree.nodes.values()].flatMap((node) => {
      const run = node.run && node.run.k === node.run.n ? runEndingAt(p.tree, node.id) : null;
      return run && run.before !== null ? [{ start: run.before, end: run.last, label: `recipe ${run.stamp?.plugin ?? "run"}` }] : [];
    });
    return [...p.groups, ...runs];
  }

  /** Anchors resolved on the part as the session resolves them: `part` is its box, a label the box of its steps' tools. */
  private anchored(p: RunPart, raw: Body): { op: Body } | { reason: string } {
    if (!hasAnchor(raw)) return { op: raw };
    const plane = this.typedPlane(p);
    const pose = this.typed(p);
    try {
      return { op: resolveAnchors(raw, (label) => labelBox(p.tree, (p.solid?.bounds as Box | undefined) ?? null, label, this.stepGroups(p), (q) => typedPointIn(plane, applyPose(pose, q)))) as Body };
    } catch (err) {
      if (err instanceof AnchorError) return { reason: err.message };
      throw err;
    }
  }

  /** --- D28. A feature typed with a face selector is stored with the face it found, as the session stores it. */
  private withFaceIndex(p: RunPart, raw: Body): Body {
    if (!isFeatureTool(raw.kind) || raw.face === undefined || raw.faceIndex !== undefined || !raw.face || typeof raw.face !== "object") return raw;
    const index = this.expand(p).faceBy(raw.face as Body);
    if (typeof index !== "number") return raw;
    const { face: _face, ...rest } = raw;
    return { ...rest, faceIndex: index };
  }

  private bake(p: RunPart, raw: unknown): Baked | { reason: string } {
    return bakeOp(raw, this.bakeContext(p));
  }

  // --- Probing and applying. ---

  /** The kernel's check of a baked op on the shown step, worded as model_probe words it. */
  private async probeBaked(p: RunPart, baked: Baked, measure: boolean, composite = false): Promise<Body> {
    const answer = (body: Body) => probeEcho(baked, body);
    const op = baked.op;
    if (op.kind === "scale") return answer({ ok: true, reason: "This scale fits." });
    if (op.kind === "root") return answer({ ok: true, reason: "This solid can be rebuilt from these sizes." });
    if (op.kind === "split") {
      const note = splitCheck(p.solid, op);
      return answer(note.bad ? { ok: false, reason: note.text } : { ok: true, reason: note.text });
    }
    if (op.kind === "partition") return answer(await this.probePartition(p, op, baked.notes ?? []));
    const missed = p.solid ? disjointRefusal(p.solid.bounds, op) : null;
    if (missed) return answer({ ok: false, reason: `${missed.reason}${frameWhere(p.modelPose, p.frame)}`, missed: true, frame: p.frame ?? "model", ...(missed.gapMm > 0 ? { gapMm: missed.gapMm } : {}) });
    const blend = (op.kind === "fillet" || op.kind === "chamfer" || op.kind === "transition") && op.edges.length > 1;
    const preview = measure || blend ? this.env.chordMm : undefined;
    const reply = await this.engine.tree(p.tree.key, p.tree.current, probeRequest(p.tree.key, p.tree.current, op, preview));
    if (typeof reply.error === "string" && reply.error) return answer({ ok: false, reason: plainModelError(reply.error, op.kind) });
    const verdict = probeVerdict(op, reply, this.typed(p), composite);
    if (verdict.ok === false) return answer(verdict.body);
    return answer({ ok: true, reason: verdict.text, ...(verdict.firstFaces ? { firstFaces: verdict.firstFaces } : {}) });
  }

  /** The kernel cuts a copy: every piece's volume and box in model space. The solid does not change. */
  private async probePartition(p: RunPart, op: PartitionModelOp, planned: readonly string[]): Promise<Body> {
    const reply = await this.engine.tree(p.tree.key, p.tree.current, probeRequest(p.tree.key, p.tree.current, op));
    if (reply.ok !== true) return { ok: false, reason: plainModelError(typeof reply.error === "string" ? reply.error : "This does not fit.") };
    const parts = Array.isArray(reply.parts) ? (reply.parts as { volumeMm3?: unknown; min?: unknown; max?: unknown }[]) : [];
    const mm = (value: number) => Math.round(value * 100) / 100;
    const pose = this.typed(p);
    const pieces = parts.map((part, index) => {
      const corners = Array.isArray(part.min) && Array.isArray(part.max) ? [part.min as number[], part.max as number[]] : null;
      const placed = corners ? boundsOf([0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => applyPose(pose, [corners[k & 1]![0]!, corners[(k >> 1) & 1]![1]!, corners[(k >> 2) & 1]![2]!]))) : null;
      return { part: index + 1, volumeMm3: mm(Number(part.volumeMm3)), ...(placed ? { min: placed.min.map(mm), max: placed.max.map(mm) } : {}) };
    });
    return { ok: true, reason: `This cut makes ${parts.length} pieces.`, parts: parts.length, pieces, ...(planned.length ? { notes: [...planned] } : {}) };
  }

  /** model_probe: a plain op, checked on the shown step with what it would change. */
  private async probeTool(p: RunPart, args: Body): Promise<Body> {
    if (args.plan === true) return { ok: false, reason: "The planners (plan: true) read the plate's printer library, which a plugin run in the app does not. Give the cut or the edges, or run the plugin over MCP." };
    const anchored = this.anchored(p, (args.op ?? {}) as Body);
    if ("reason" in anchored) return { ok: false, reason: anchored.reason };
    const probed = await this.probe(p, anchored.op, true);
    // A probe that fits lets a later model_apply of the same op go without probe: true, as the session's does.
    const baked = probed.ok === true ? this.bake(p, anchored.op) : null;
    if (baked && !("reason" in baked)) this.probed.add(`${p.id}#${probeKey(String(p.tree.current), baked.op)}`);
    return probed;
  }

  private async probe(p: RunPart, raw: Body, measure = false): Promise<Body> {
    if (isComposite(raw.kind)) return { ok: false, reason: "model_probe checks one step. Apply a pattern, mirror, pocket, boss, or texture with model_apply; it checks each step as it goes." };
    const baked = this.bake(p, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    return this.probeBaked(p, baked, measure);
  }

  /** A new step id on `p`, the first one the run took noted. */
  private reserve(p: RunPart): NodeId {
    const [reserved, node] = reserveId(p.tree);
    p.tree = reserved;
    p.firstReserved ??= node;
    return node;
  }

  /** The baked op applied on the shown step, a new step at the end of the part's branch, as the session applies one. */
  private async applyBaked(p: RunPart, baked: Baked, raw: unknown): Promise<Body> {
    if (baked.op.kind === "partition") return this.applyPartition(p, baked.op, baked.typed);
    if (baked.op.kind === "split") {
      const note = splitCheck(p.solid, baked.op);
      if (note.bad) return { ok: false, reason: note.text };
    }
    const parent = p.tree.current;
    const node = this.reserve(p);
    const keep = baked.op.kind === "split" ? splitKeep(raw) : "both";
    const otherKey = baked.op.kind === "split" && keep === "both" ? this.pieceKey(p, node, "half") : undefined;
    const reply = await this.engine.tree(p.tree.key, parent, applyRequest(p.tree.key, parent, node, baked.op, this.env.chordMm, otherKey));
    if (typeof reply.error === "string" && reply.error) {
      // --- A9. The kernel's failedStep is the piece inside a group, counting from 1. ---
      const failedStep = Number.isInteger(reply.failedStep) ? { failedStep: reply.failedStep as number } : {};
      return { ok: false, reason: plainModelError(reply.error, baked.op.kind), ...failedStep };
    }
    const stored = storedOp(baked.op, reply);
    const after = solidView(reply);
    p.tree = withChild(p.tree, parent, { id: node, op: stored, label: opLabel(stored), fingerprint: after?.fingerprint ?? null, ...(otherKey ? { piece: otherKey } : {}) });
    const prior = p.solid;
    const guarded = baked.op.kind === "group" ? null : stepGuard(baked.op, prior, after, this.typed(p));
    if (guarded || !after) {
      await this.back(p, parent, node);
      return { ok: false, ...(guarded ?? { reason: "The solid this step built could not be read." }) };
    }
    p.solid = after;
    p.body = reply;
    let toolLeftPlate: string | undefined;
    if (stored.kind === "join" && !stored.keepTool) {
      const tool = this.parts.get(stored.tool.object);
      if (tool) {
        tool.consumed = true;
        toolLeftPlate = tool.id;
      }
    }
    const other = otherKey ? this.keepOtherHalf(p, otherKey, reply.other, node) : undefined;
    const kept = baked.op.kind === "split" ? (keep === "both" ? "both" : keptSide(prior?.bounds, baked.op)) : undefined;
    return appliedReply(node, baked, reply, { ...(other ? { other } : {}), ...(kept ? { kept } : {}), ...(toolLeftPlate ? { toolLeftPlate } : {}) });
  }

  private pieceKey(p: RunPart, node: NodeId, piece: number | "half" | "pins"): string {
    return this.env.pieceKey?.(p.id, node, piece) ?? `${p.tree.key}-${piece === "half" ? "split" : piece === "pins" ? "pins" : `part-${piece}`}-${node}`;
  }

  /** A split's other half: a part of its own, rooted at the split, in the part's place. */
  private keepOtherHalf(p: RunPart, key: string, other: unknown, node: NodeId): string | undefined {
    if (!other || typeof other !== "object") return undefined;
    const solid = solidView(other as Body);
    if (!solid) return undefined;
    this.seq += 1;
    const id = this.env.newPart?.().id ?? `run_${this.seq}`;
    this.add({
      ...this.copyPlace(p, solid),
      id,
      name: `${p.name} split`,
      origin: "half",
      tree: newTree(key, { kind: "piece", tree: p.tree.key, node }, "Split", solid.fingerprint),
      solid,
      body: other as Body,
      cut: { key: p.tree.key, node },
    });
    return id;
  }

  /** What a piece cut off `p` takes of it: its poses, workplane and place, with its own mesh to place from. */
  private copyPlace(p: RunPart, solid: SolidView): Pick<RunPart, "modelPose" | "frame" | "workplane" | "place" | "start" | "firstReserved" | "groups" | "posed" | "placed" | "consumed"> {
    return {
      modelPose: { m: [...p.modelPose.m] as Affine["m"], t: [...p.modelPose.t] as Affine["t"] },
      ...(p.frame ? { frame: p.frame } : {}),
      workplane: { source: p.workplane.source, origin: [...p.workplane.origin] as Workplane["origin"], turn: [...p.workplane.turn] as Workplane["turn"] },
      place: { source: Float32Array.from(solid.positions), orient: [...p.place.orient] as Mat3, scale: p.place.scale, centered: p.place.centered, offset: { ...p.place.offset } },
      start: 0,
      firstReserved: null,
      groups: [],
      posed: false,
      placed: false,
      consumed: false,
    };
  }

  /** A split to print: the part keeps its tree; every other piece (and the pins of its dowels) is a tree of its own. */
  private async applyPartition(p: RunPart, op: PartitionModelOp, typed: Body): Promise<Body> {
    const parent = p.tree.current;
    const node = this.reserve(p);
    const keys = Array.from({ length: clampPieces(op.maxPieces ?? 12) - 1 }, (_, at) => this.pieceKey(p, node, at + 2));
    const dowels = op.cuts.some((cut) => cut.connectors?.on && (cut.connectors.placed ?? []).some((row) => row.type === "dowel"));
    const pinsKey = dowels ? this.pieceKey(p, node, "pins") : null;
    const reply = await this.engine.tree(p.tree.key, parent, applyRequest(p.tree.key, parent, node, op, this.env.chordMm, null, keys, pinsKey));
    if (typeof reply.error === "string" && reply.error) return { ok: false, reason: plainModelError(reply.error) };
    const made: (string | null)[] = [];
    const ids: string[] = [];
    const listed = Array.isArray(reply.pieces) ? (reply.pieces as unknown[]) : [];
    listed.forEach((entry, at) => {
      const id = entry && typeof entry === "object" ? this.cutPiece(p, entry as Body, node, at + 2, "piece") : null;
      made.push(id ? String((entry as { key?: unknown }).key) : null);
      if (id) ids.push(id);
    });
    const pins = reply.pins && typeof reply.pins === "object" ? this.cutPiece(p, reply.pins as Body, node, 0, "pins") : null;
    const stored = reply.op && typeof reply.op === "object" && (reply.op as ModelOp).kind === "partition" ? (reply.op as PartitionModelOp) : op;
    const after = solidView(reply);
    p.tree = withChild(p.tree, parent, { id: node, op: stored, label: opLabel(stored, made.length + 1), fingerprint: after?.fingerprint ?? null, pieces: made, ...(pins ? { pins: this.parts.get(pins)!.tree.key } : {}) });
    if (after) {
      p.solid = after;
      p.body = reply;
    }
    return { ok: true, node: nodeHandle(node), parts: made.length + 1, pieces: ids, ...(pins ? { pins } : {}), stored: cleanOp(stored as unknown as Body), typed };
  }

  private cutPiece(p: RunPart, entry: Body, node: NodeId, index: number, origin: "piece" | "pins"): string | null {
    const solid = solidView(entry);
    const key = typeof entry.key === "string" ? entry.key : "";
    if (!solid || !key) return null;
    this.seq += 1;
    const id = this.env.newPart?.().id ?? `run_${this.seq}`;
    const root = origin === "pins" ? { kind: "piece" as const, tree: p.tree.key, node, pins: true as const } : { kind: "piece" as const, tree: p.tree.key, node, index };
    this.add({
      ...this.copyPlace(p, solid),
      id,
      name: origin === "pins" ? `${p.name} pins` : `${p.name} part ${index}`,
      origin,
      tree: newTree(key, root, origin === "pins" ? "Pins" : `Part ${index}`, solid.fingerprint),
      solid,
      body: entry,
      cut: { key: p.tree.key, node, ...(origin === "piece" ? { index } : {}) },
    });
    return id;
  }

  /** Back to `to` in the engine and the tree, with `node` and what grew under it gone. */
  private async back(p: RunPart, to: NodeId, node: NodeId): Promise<string | null> {
    const reply = await this.engine.tree(p.tree.key, to, gotoRequest(p.tree.key, to, this.env.chordMm));
    const view = solidView(reply);
    if (view) {
      p.solid = view;
      p.body = reply;
    }
    const without = p.tree.nodes.has(node) ? dropped(jumped(p.tree, to), node) : null;
    p.tree = without ?? jumped(p.tree, to);
    return typeof reply.error === "string" && reply.error ? plainModelError(reply.error) : null;
  }

  /** A plain op: baked, applied, and named by its label. */
  private async apply(p: RunPart, raw: Body): Promise<Body> {
    const baked = this.bake(p, raw);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    const done = await this.applyBaked(p, baked, raw);
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (done.ok === true && label) {
      const node = parseNode(done.node);
      if (node !== null && p.tree.nodes.has(node)) p.tree = withNode(p.tree, node, { label: label.slice(0, 80) });
      return { ...done, label: label.slice(0, 80) };
    }
    return done;
  }

  /** model_apply: a plain op needs `probe: true` (a run probes as it goes); a composite checks each step as it goes. */
  private async applyTool(p: RunPart, args: Body): Promise<Body> {
    const anchored = this.anchored(p, (args.op ?? {}) as Body);
    if ("reason" in anchored) return { ok: false, reason: anchored.reason };
    const raw = anchored.op;
    if (isComposite(raw.kind)) {
      const { checkpoints: _checkpoints, ...ran } = await this.applyMany(p, [raw], { label: typeof raw.label === "string" ? raw.label : undefined });
      return ran;
    }
    if (args.probe !== true) {
      const baked = this.bake(p, structuredClone(raw));
      if ("reason" in baked) return { ok: false, reason: baked.reason };
      if (!this.probed.has(`${p.id}#${probeKey(String(p.tree.current), baked.op)}`)) return { ok: false, reason: "Probe this edit first, or pass probe: true. It was not applied." };
      return this.apply(p, structuredClone(raw));
    }
    const probed = await this.probe(p, raw);
    if (probed.ok !== true) return { ...probed, applied: false };
    return this.apply(p, structuredClone(raw));
  }

  private async applyBatch(p: RunPart, args: Body): Promise<Body> {
    const ops = Array.isArray(args.ops) ? (args.ops as Body[]) : [];
    if (ops.length === 0) return { ok: false, reason: "The batch needs at least one op." };
    if (args.combine === "cut" || args.combine === "fuse") return this.applyCombined(p, ops, args.combine, typeof args.label === "string" ? args.label : undefined);
    const { checkpoints: _checkpoints, ...ran } = await this.applyMany(p, ops, { label: typeof args.label === "string" ? args.label : undefined, onError: args.onError });
    return ran;
  }

  /** The port the shared composite runner applies a composite's pieces through. */
  private compositePort(p: RunPart): CompositePort {
    return {
      pose: () => this.typed(p),
      context: () => this.expand(p),
      profilePlane: (spec) => {
        const ctx = this.bakeContext(p);
        return profilePlaneOf(spec, ctx);
      },
      pieceOf: (raw) => pieceOf(raw, this.typedPlane(p)),
      applyCopy: async (copy) => {
        const probed = await this.probe(p, copy);
        return probed.ok === true ? this.apply(p, copy) : probed;
      },
      applyPiece: async (baked) => {
        const probed = await this.probeBaked(p, baked, false, true);
        const done = probed.ok === true ? await this.applyBaked(p, baked, {}) : probed;
        return { probed, done };
      },
      nodeOp: (node) => p.tree.nodes.get(node)?.op ?? undefined,
    };
  }

  /** The port the shared group store folds a composite's pieces through. */
  private groupPort(p: RunPart): GroupPort {
    return {
      fold: async (before, firstPiece, group) => {
        const tree = p.tree;
        if (!pathTo(tree, tree.current).includes(firstPiece)) return null;
        const [reserved, node] = reserveId(tree);
        const without = dropped(jumped(reserved, before), firstPiece);
        if (!without) return null;
        const reply = await this.engine.tree(tree.key, tree.current, { call: "fold", key: tree.key, parent: before, node, op: group, last: tree.current, chordMm: this.env.chordMm });
        if (typeof reply.error === "string" && reply.error) return null;
        p.tree = withChild(without, before, { id: node, op: group, label: opLabel(group), fingerprint: null });
        const solid = solidView(reply);
        if (solid) {
          p.solid = solid;
          p.body = reply;
        }
        return node;
      },
      back: (before, firstPiece) => this.back(p, before, firstPiece),
      probeApply: async (baked) => {
        const probed = await this.probeBaked(p, baked, false, false);
        const done = probed.ok === true ? await this.applyBaked(p, baked, {}) : probed;
        return { probed, done };
      },
      budgetMs: 0,
    };
  }

  /**
   * Several edits as one, as the session's applyMany runs them: each composite op expands to Boolean steps (one group
   * node), an array of loops cells is one extrude, every step is probed then applied, in order. On a refusal,
   * `rollback` takes the part back to where it started, `stop` leaves it at the last op that applied, and `skip` leaves
   * the refused op out and carries on. A run of more than one step is one undo step.
   */
  private async applyMany(p: RunPart, raws: Body[], options: { label?: string; onError?: unknown }): Promise<Body> {
    const mode = options.onError === "stop" || options.onError === "skip" ? options.onError : "rollback";
    const start = p.tree.current;
    const nodes: NodeId[] = [];
    const checkpoints: (NodeId | null)[] = [];
    const failures: Body[] = [];
    let skipped = 0;
    let touching = 0;
    let touchingAt: string | undefined;
    let made = 0;
    const cellReports: Body[] = [];
    const result = (body: Body) => ({ ...body, checkpoints });
    const fail = async (failed: Body): Promise<Body> => {
      if (mode === "rollback" && nodes.length > 0) {
        await this.back(p, start, nodes[0]!);
        return result({ ok: false, applied: 0, rolledBack: true, failed, node: nodeHandle(start) });
      }
      return result({ ok: false, applied: nodes.length, failed, ...(nodes.length ? { node: nodeHandle(nodes[nodes.length - 1]!) } : {}) });
    };
    for (let index = 0; index < raws.length; index += 1) {
      const label = typeof raws[index]!.label === "string" && (raws[index]!.label as string).trim() ? (raws[index]!.label as string).trim() : undefined;
      const before = p.tree.current;
      const anchored = this.anchored(p, raws[index]!);
      if ("reason" in anchored) {
        const row = { index, ...(label ? { label } : {}), reason: anchored.reason };
        if (mode !== "skip") return fail(row);
        failures.push(row);
        checkpoints.push(null);
        continue;
      }
      const raw = this.withFaceIndex(p, anchored.op);
      const ownNodes: NodeId[] = [];
      const refuse = async (failed: Body): Promise<Body | null> => {
        const row = { index, ...(label ? { label } : {}), ...failed };
        if (mode !== "skip") return fail(row);
        if (ownNodes.length > 0) {
          await this.back(p, before, ownNodes[0]!);
          nodes.splice(nodes.length - ownNodes.length, ownNodes.length);
        }
        failures.push(row);
        checkpoints.push(null);
        return null;
      };
      // --- I20. An array whose cell is loops is one extrude of cells: one step, one boolean.
      if (isCellArray(raw)) {
        if ((made += 1) > MAX_PIECES) return fail({ index, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` });
        const tree = p.tree;
        const baked = await bakeCells(raw, this.expand(p), this.typed(p), async (face, insetMm, frame) => {
          const outline = await this.engine.tree(tree.key, tree.current, { call: "faceOutline", key: tree.key, node: tree.current, face, insetMm, chordMm: 0.05, frame });
          if (typeof outline.error === "string" && outline.error) return { reason: plainModelError(outline.error) };
          return Array.isArray(outline.loops) ? (outline.loops as never) : [];
        });
        let done: Body;
        if ("reason" in baked) done = { ok: false, reason: baked.reason };
        else {
          const probed = await this.probeBaked(p, baked, false);
          done = probed.ok === true ? await this.applyBaked(p, baked, {}) : probed;
          const node = parseNode(done.node);
          if (done.ok === true && label && node !== null) p.tree = withNode(p.tree, node, { label: label.slice(0, 80) });
        }
        if (done.ok !== true) {
          const ended = await refuse({ reason: String(done.reason ?? "This array did not apply.") });
          if (ended) return ended;
          continue;
        }
        const node = parseNode(done.node);
        if (node !== null) nodes.push(node);
        if (done.cells && typeof done.cells === "object") cellReports.push({ index, ...(done.cells as Body) });
        checkpoints.push(p.tree.current);
        continue;
      }
      if (!runsAsComposite(raw)) {
        if ((made += 1) > MAX_PIECES) return fail({ index, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` });
        const probed = await this.probe(p, raw);
        const done = probed.ok === true ? await this.apply(p, raw) : probed;
        if (done.ok !== true) {
          const ended = await refuse({ reason: String(done.reason ?? "This edit did not apply."), ...(done.where ? { where: done.where } : {}) });
          if (ended) return ended;
          continue;
        }
        const node = parseNode(done.node);
        if (node !== null) nodes.push(node);
        checkpoints.push(p.tree.current);
        continue;
      }
      const context = this.expand(p);
      const copies = featureCopies(raw, context.plane, (spec) => profilePlaneOf(spec, this.bakeContext(p)));
      const expanded = copies === null ? expand(raw, context, (op) => pieceOf(op, this.typedPlane(p))) : copies;
      const count = "reason" in expanded ? 0 : expanded.length;
      if ((made += count) > MAX_PIECES) return fail({ index, reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller batches.` });
      const ran = await runComposite(raw, this.compositePort(p));
      ownNodes.push(...ran.ownNodes);
      nodes.push(...ran.ownNodes);
      if ("aborted" in ran) return fail({ index, reason: "The run was stopped." });
      skipped += ran.skipped;
      touching += ran.touching;
      if (ran.touchingAt !== undefined) touchingAt ??= ran.touchingAt;
      if ("refused" in ran) {
        const ended = await refuse(ran.refused);
        if (ended) return ended;
        continue;
      }
      if (ownNodes.length > 0) {
        const stored = await storeGroup(this.groupPort(p), before, ownNodes[0]!, ran.steps, label, raw);
        if (stored.ok !== true) {
          const ended = await refuse(stored.failed);
          if (ended) return ended;
          continue;
        }
        nodes.splice(nodes.length - ownNodes.length, ownNodes.length);
        nodes.push(stored.node);
      }
      checkpoints.push(p.tree.current);
    }
    // --- A9. One group node is still one undo step, the same as a run of several pieces was. ---
    const end = nodes[nodes.length - 1];
    const storedGroup = nodes.some((id) => p.tree.nodes.get(id)?.op?.kind === "group");
    if (end !== undefined && (nodes.length > 1 || storedGroup)) {
      const endOp = p.tree.nodes.get(end)?.op;
      const groupLabel = options.label ?? (endOp?.kind === "group" ? endOp.label : `${nodes.length} steps`);
      p.groups.push({ start, end, label: groupLabel });
    }
    return result({
      ok: failures.length === 0,
      applied: nodes.length,
      ...(failures.length ? { failures, note: `${failures.length} op${failures.length === 1 ? " was" : "s were"} refused and left out; the rest applied. Fix them and call model_build again: it reuses every op before the first one changed.` } : {}),
      ...(skipped ? { skipped, missedNote: `${skipped} step${skipped === 1 ? "" : "s"} missed the solid and were left out.` } : {}),
      ...(touching ? { leftOut: touching, leftOutNote: `${touching} step${touching === 1 ? "" : "s"} would have left pieces meeting only along an edge, even ${TOUCH_TRIM} mm shorter at each end, and ${touching === 1 ? "was" : "were"} left out. The first: ${touchingAt}` } : {}),
      ...(nodes.length ? { first: nodeHandle(nodes[0]!), node: nodeHandle(nodes[nodes.length - 1]!) } : {}),
      ...(cellReports.length ? { cells: cellReports.length === 1 ? cellReports[0] : cellReports } : {}),
      ...(options.label ? { label: options.label } : {}),
      fingerprint: p.solid?.fingerprint ?? null,
      bounds: p.solid?.bounds ?? null,
    });
  }

  /** I19, as the session builds it: every op a tool of one boolean, one step, the ops that do not fit listed. */
  private async applyCombined(p: RunPart, raws: Body[], combine: "cut" | "fuse", label: string | undefined): Promise<Body> {
    const failures: Body[] = [];
    const steps: ModelOp[] = [];
    const indexOf: number[] = [];
    const kinds = new Set(["boolean", "extrude", "revolve", "loft"]);
    for (const [index, raw] of raws.entries()) {
      const anchored = this.anchored(p, raw);
      if ("reason" in anchored) {
        failures.push({ index, reason: anchored.reason });
        continue;
      }
      const op = anchored.op;
      if (isComposite(op.kind) || !kinds.has(String(op.kind))) {
        failures.push({ index, reason: `A combined batch takes boolean, extrude, revolve, and loft ops; ${String(op.kind)} is not one. Apply it on its own.` });
        continue;
      }
      const baked = this.bake(p, structuredClone(op));
      if ("reason" in baked) {
        failures.push({ index, reason: baked.reason });
        continue;
      }
      if ((baked.op as { op?: unknown }).op !== combine) {
        failures.push({ index, reason: `This batch combines ${combine}s; this op is a ${String((baked.op as { op?: unknown }).op)}.` });
        continue;
      }
      steps.push(baked.op);
      indexOf.push(index);
    }
    if (steps.length === 0) return { ok: false, applied: 0, failures, reason: "No op of the batch can be combined." };
    const name = label?.trim() || `${steps.length} ${combine}s in one boolean`;
    const group: GroupOp = { kind: "group", label: name.slice(0, 80), source: { kind: "batch", combine, ops: raws.length }, steps, combine };
    const baked: Baked = { op: group, typed: { kind: "batch", combine, ops: raws.length } };
    const probed = await this.probeBaked(p, baked, false);
    const done = probed.ok === true ? await this.applyBaked(p, baked, {}) : probed;
    if (done.ok === true && label?.trim()) {
      const node = parseNode(done.node);
      if (node !== null) p.tree = withNode(p.tree, node, { label: label.trim().slice(0, 80) });
    }
    if (done.ok !== true) return { ...done, applied: 0, ...(failures.length ? { failures } : {}) };
    const report = (done.combined ?? {}) as { failed?: { index: number; reason: string }[] };
    for (const row of report.failed ?? []) failures.push({ index: indexOf[row.index] ?? row.index, reason: row.reason });
    failures.sort((a, b) => Number(a.index) - Number(b.index));
    const { combined: _combined, ...rest } = done;
    return {
      ...rest,
      applied: steps.length - (report.failed?.length ?? 0),
      combined: steps.length,
      ...(failures.length ? { failures, note: `${failures.length} op${failures.length === 1 ? " was" : "s were"} left out; the rest applied in one step.` } : {}),
      fingerprint: p.solid?.fingerprint ?? null,
      bounds: p.solid?.bounds ?? null,
    };
  }
}

/** A plain Boolean op typed in the part's workplane (`plane`, in model space), as a part-frame piece. */
function pieceOf(raw: Body, plane: Workplane): Piece | { reason: string } {
  const local = primitiveFrom(raw, "box");
  if ("reason" in local) return local;
  const op = raw.op === "fuse" || raw.op === "common" ? raw.op : "cut";
  return { op, spec: planePrimitive(local, plane), merge: true };
}

function isIdentityPose(pose: Affine): boolean {
  const m = pose.m;
  return pose.t.every((v) => v === 0) && m.every((v, i) => v === (i % 4 === 0 ? 1 : 0));
}
