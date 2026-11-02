/**
 * The app's answers to a recipe's calls (docs/plan-recipe-plugins.md D16, milestone 6). A plugin step rebuilt in the
 * window runs on one part, from the step before its run: each call is answered against that part's history in the
 * app's engine, through the same shared code the MCP session answers it with (`src/modeling/bake.ts` turns a typed op
 * into the stored op, `src/modeling/model-calls.ts` reads probes, guards steps and words the replies), so the same
 * values build the same solid either way.
 *
 * The run only grows a branch in a copy of the part's tree; nothing reaches the plate. The caller keeps the branch and
 * stamps it at `done`, or drops it.
 *
 * Not answered in the app yet, each with a sentence: composite ops (pattern, mirror, pocket, boss, texture, an array of
 * cells), a split, a join, a split to print and a print transition; model_check, measure and model_history; anchors
 * other than `part`; and new parts (solid_new, model_place, object_place), since a stamped run changes one part.
 */
import { AnchorError, hasAnchor, movedBox, resolveAnchors, type Box } from "../modeling/anchors.ts";
import { bakeOp, onFaceIndex, type BakeContext, type Baked } from "../modeling/bake.ts";
import { isComposite } from "../modeling/compose.ts";
import { appliedReply, describeReply, disjointRefusal, edgesReply, facesReply, nodeHandle, parseNode, partExpandContext, probeEcho, probeVerdict, solidSections, solidView, stepGuard, storedOp, typedPlaneOf, typedPointIn, type SolidView } from "../modeling/model-calls.ts";
import { plainModelError } from "../app/model-error.ts";
import { applyRequest, gotoRequest, probeRequest } from "../model-request.ts";
import { applyPose, type Affine } from "../model-space.ts";
import { dropped, jumped, opLabel, reserveId, withChild, type GroupOp, type ModelOp, type ModelTree, type NodeId } from "../model-tree.ts";
import type { Workplane } from "../workplane.ts";
import { cutPlanes, MAX_SECTION_POINTS, pointsIn } from "../../mcp/sections.ts";
import { surfaceAt } from "../../mcp/inspect.ts";
import type { RecipeCall, RecipeCallSite, RecipeReply } from "./host.ts";

/** The part a rebuild runs on, as the app holds it at the step before the run. */
export interface AppRecipePart {
  /** The plate object's id: the name the recipe's `object` and every call's `object` use. */
  id: string;
  /** Its history: `current` is the step the run starts on. */
  tree: ModelTree;
  /** That step's solid, as the engine last answered it. */
  solid: SolidView;
  /** The typed pose: ops are typed in model space and stored in the solid's own frame. */
  pose: Affine;
  /** The part's workplane, in its own frame. */
  workplane: Workplane;
  /** The frame a reply names: "model". */
  frame: string;
}

/** One request to the app's engine about the part's tree; `node` is the step it needs. */
export type AppTreeCall = (node: NodeId, request: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Recipe data a step's run kept (`data {name}`): the parsed value, by name. */
export type KeptData = Record<string, { value: unknown }>;

const NOT_IN_APP = (what: string) => `${what} is answered over MCP; a plugin rebuilt in the app cannot call it yet. Change this step's values with recipe_run {object, params} instead.`;

/** The app's answers for one run on one part. */
export class AppRecipeCalls {
  /** The run's own notes (`log`), as the MCP keeps them: `line N: text`. */
  readonly notes: string[] = [];
  /** The steps the run added, oldest first, on the branch it grew. */
  readonly added: NodeId[] = [];
  /** The first step id the run took, applied or not: what a caller drops from the engine when it takes the run back. */
  firstReserved: NodeId | null = null;
  private tree: ModelTree;
  private solid: SolidView;
  /** The engine's reply for the shown step, kept so the caller can show the solid without asking again. */
  private body: Record<string, unknown> | null = null;
  private readonly part: AppRecipePart;
  private readonly engine: AppTreeCall;
  private readonly chordMm: number;
  private readonly data: KeptData;

  constructor(part: AppRecipePart, engine: AppTreeCall, opts: { chordMm: number; data?: KeptData }) {
    this.part = part;
    this.tree = part.tree;
    this.solid = part.solid;
    this.engine = engine;
    this.chordMm = opts.chordMm;
    this.data = opts.data ?? {};
  }

  /** The part's tree as the run left it, its shown step the last step the run added. */
  get result(): { tree: ModelTree; solid: SolidView; body: Record<string, unknown> | null } {
    return { tree: this.tree, solid: this.solid, body: this.body };
  }

  /** The handler the shared host calls (`runRecipe`). */
  readonly call: RecipeCall = async (site) => this.answer(site);

  private async answer(site: RecipeCallSite): Promise<RecipeReply> {
    const args = site.args;
    if (site.tool === "log") {
      if (this.notes.length < 200) this.notes.push(`line ${site.line}: ${String(args.message ?? args.text ?? "").slice(0, 400)}`);
      return { ok: true, result: { ok: true } };
    }
    if (site.tool === "data") {
      const name = typeof args.name === "string" ? args.name : "";
      const kept = this.data[name];
      if (!kept) return { ok: false, error: `No recipe data named ${name || "(no name)"} is kept with this step. Rebuild it over MCP (recipe_run {object, params}), where the workspace's file is read.` };
      return { ok: true, result: kept.value };
    }
    if (site.tool === "solid_new" || site.tool === "model_place" || site.tool === "object_place") {
      return { ok: false, error: `A plugin step rebuilt in the app changes only its own part, and ${site.tool} would make or move another. Rebuild it over MCP (recipe_run {object, params}).` };
    }
    // --- O8 (D11.1). A recipe touches only the part it was given.
    const target = typeof args.object === "string" ? args.object : this.part.id;
    if (target !== this.part.id) return { ok: false, error: `A recipe can change only the part it was given and the parts it made; ${target} is neither. Pass it as object to run on it.` };
    let value: Record<string, unknown>;
    switch (site.tool) {
      case "model_describe": value = describeReply(this.solid, args, this.part.frame); break;
      case "faces_find": value = facesReply(this.solid, args, this.expand()); break;
      case "edges_find": value = edgesReply(this.solid, args, (filter) => onFaceIndex(filter, this.bakeContext())); break;
      case "surface_at": value = surfaceAt(this.solid, args); break;
      case "section": value = await this.section(args); break;
      case "model_probe": value = await this.probeTool(args); break;
      case "model_apply": value = await this.applyTool(args); break;
      case "model_apply_batch": value = await this.applyBatch(args); break;
      case "model_check": value = { ok: false, reason: NOT_IN_APP("model_check") }; break;
      case "measure": value = { ok: false, reason: NOT_IN_APP("measure") }; break;
      case "model_history": value = { ok: false, reason: NOT_IN_APP("model_history") }; break;
      default: value = { ok: false, reason: `${site.tool} is not a recipe call.` };
    }
    if (value.ok === false) {
      const { ok: _ok, reason, ...extra } = value;
      return { ok: false, error: typeof reason === "string" ? reason : `${site.tool} was refused.`, extra };
    }
    return { ok: true, result: value };
  }

  private expand() {
    return partExpandContext(this.solid, this.part.pose, this.part.workplane);
  }

  private bakeContext(): BakeContext {
    return {
      pose: this.part.pose,
      solid: this.solid,
      plane: typedPlaneOf(this.part.workplane, this.part.pose),
      expand: () => this.expand(),
      nodeOf: (value) => this.nodeOf(value),
      hasNode: (id) => this.tree.nodes.has(id),
    };
  }

  /** A step by its handle (`node_4`) or its label, as the session reads one. */
  private nodeOf(value: unknown): number | null {
    const parsed = parseNode(value);
    if (parsed !== null || typeof value !== "string") return parsed;
    const wanted = value.trim().toLowerCase();
    const rows = [...this.tree.nodes.values()].filter((node) => node.label.toLowerCase() === wanted);
    return rows.length > 0 ? rows[rows.length - 1]!.id : null;
  }

  /** Anchors resolved on the shown solid: `part` is its box; a step's label is the session's to read. */
  private anchored(raw: Record<string, unknown>): { op: Record<string, unknown> } | { reason: string } {
    if (!hasAnchor(raw)) return { op: raw };
    try {
      return { op: resolveAnchors(raw, (label) => this.labelBox(label)) as Record<string, unknown> };
    } catch (err) {
      if (err instanceof AnchorError) return { reason: err.message };
      throw err;
    }
  }

  private labelBox(label: string): Box | null {
    if (label.trim().toLowerCase() !== "part") throw new AnchorError(`The anchor ${label} names a step; a plugin rebuilt in the app reads only the part's own box (part). Rebuild it over MCP.`);
    const plane = typedPlaneOf(this.part.workplane, this.part.pose);
    return movedBox(this.solid.bounds as Box, (p) => typedPointIn(plane, applyPose(this.part.pose, p)));
  }

  private bake(raw: unknown): Baked | { reason: string } {
    if (raw && typeof raw === "object") {
      const kind = (raw as { kind?: unknown }).kind;
      if (isComposite(kind)) return { reason: `A ${String(kind)} in a plugin is rebuilt over MCP for now (recipe_run {object, params}); the app rebuilds plain steps.` };
      if (kind === "split") return { reason: "A split keeps both halves as parts; a plugin step rebuilt in the app changes only its own part. Rebuild it over MCP." };
      if (kind === "array") return { reason: "An array in a plugin is rebuilt over MCP for now (recipe_run {object, params}); the app rebuilds plain steps." };
    }
    return bakeOp(raw, this.bakeContext());
  }

  /** The kernel's check of a baked op on the shown step, worded as model_probe words it. */
  private async probeBaked(baked: Baked, measure: boolean, composite = false): Promise<Record<string, unknown>> {
    const answer = (body: Record<string, unknown>) => probeEcho(baked, body);
    if (baked.op.kind === "scale") return answer({ ok: true, reason: "This scale fits." });
    if (baked.op.kind === "root") return answer({ ok: true, reason: "This solid can be rebuilt from these sizes." });
    const missed = disjointRefusal(this.solid.bounds, baked.op);
    if (missed) return answer({ ok: false, reason: missed.reason, missed: true, frame: this.part.frame, ...(missed.gapMm > 0 ? { gapMm: missed.gapMm } : {}) });
    const blend = (baked.op.kind === "fillet" || baked.op.kind === "chamfer") && baked.op.edges.length > 1;
    const preview = measure || blend ? this.chordMm : undefined;
    const reply = await this.engine(this.tree.current, probeRequest(this.tree.key, this.tree.current, baked.op, preview));
    if (typeof reply.error === "string" && reply.error) return answer({ ok: false, reason: plainModelError(reply.error, baked.op.kind) });
    const verdict = probeVerdict(baked.op, reply, this.part.pose, composite);
    if (verdict.ok === false) return answer(verdict.body);
    return answer({ ok: true, reason: verdict.text, ...(verdict.firstFaces ? { firstFaces: verdict.firstFaces } : {}) });
  }

  private async probeTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const anchored = this.anchored((args.op ?? {}) as Record<string, unknown>);
    if ("reason" in anchored) return { ok: false, reason: anchored.reason };
    const baked = this.bake(anchored.op);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    return this.probeBaked(baked, true);
  }

  /** The baked op applied on the shown step, a new step at the end of the run's branch, as the session applies one. */
  private async applyBaked(baked: Baked): Promise<Record<string, unknown>> {
    const parent = this.tree.current;
    const [reserved, node] = reserveId(this.tree);
    this.tree = reserved;
    this.firstReserved ??= node;
    const reply = await this.engine(parent, applyRequest(this.tree.key, parent, node, baked.op, this.chordMm));
    if (typeof reply.error === "string" && reply.error) {
      // --- A9. The kernel's failedStep is the piece inside a group, counting from 1. ---
      const failedStep = Number.isInteger(reply.failedStep) ? { failedStep: reply.failedStep as number } : {};
      return { ok: false, reason: plainModelError(reply.error, baked.op.kind), ...failedStep };
    }
    const stored = storedOp(baked.op, reply);
    const after = solidView(reply);
    this.tree = withChild(this.tree, parent, { id: node, op: stored, label: opLabel(stored), fingerprint: after?.fingerprint ?? null });
    const guarded = baked.op.kind === "group" ? null : stepGuard(baked.op, this.solid, after, this.part.pose);
    if (guarded || !after) {
      await this.back(parent, node);
      return { ok: false, ...(guarded ?? { reason: "The solid this step built could not be read." }) };
    }
    this.solid = after;
    this.body = reply;
    this.added.push(node);
    return appliedReply(node, baked, reply);
  }

  /** Back to `to` in the engine and the tree, with `node` and what grew under it gone. */
  private async back(to: NodeId, node: NodeId): Promise<void> {
    const reply = await this.engine(to, gotoRequest(this.tree.key, to, this.chordMm));
    const view = solidView(reply);
    if (view) {
      this.solid = view;
      this.body = reply;
    }
    const without = this.tree.nodes.has(node) ? dropped(jumped(this.tree, to), node) : null;
    this.tree = without ?? jumped(this.tree, to);
    const at = this.added.indexOf(node);
    if (at >= 0) this.added.splice(at);
  }

  private async applyTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const anchored = this.anchored((args.op ?? {}) as Record<string, unknown>);
    if ("reason" in anchored) return { ok: false, reason: anchored.reason };
    const baked = this.bake(anchored.op);
    if ("reason" in baked) return { ok: false, reason: baked.reason };
    if (args.probe !== true) return { ok: false, reason: "Probe this edit first, or pass probe: true. It was not applied." };
    const probed = await this.probeBaked(baked, false);
    if (probed.ok !== true) return { ...probed, applied: false };
    const done = await this.applyBaked(baked);
    const label = typeof anchored.op.label === "string" ? anchored.op.label.trim() : "";
    if (done.ok === true && label) {
      const node = parseNode(done.node);
      if (node !== null && this.tree.nodes.has(node)) {
        const nodes = new Map(this.tree.nodes);
        nodes.set(node, { ...nodes.get(node)!, name: label.slice(0, 80) });
        this.tree = { ...this.tree, nodes };
      }
      return { ...done, label: label.slice(0, 80) };
    }
    return done;
  }

  /**
   * model_apply_batch: each op probed and applied in turn, the whole batch taken back when one is refused (or, with
   * onError stop or skip, kept so far or carried on without it); with combine, every op is a tool of one boolean.
   */
  private async applyBatch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ops = Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : [];
    if (ops.length === 0) return { ok: false, reason: "The batch needs at least one op." };
    if (args.combine === "cut" || args.combine === "fuse") return this.applyCombined(ops, args.combine, typeof args.label === "string" ? args.label : undefined);
    const mode = args.onError === "stop" || args.onError === "skip" ? args.onError : "rollback";
    const start = this.tree.current;
    const startAdded = this.added.length;
    const failures: Record<string, unknown>[] = [];
    const nodes: NodeId[] = [];
    for (const [index, raw] of ops.entries()) {
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
      const anchored = this.anchored(raw);
      const baked = "reason" in anchored ? anchored : this.bake(anchored.op);
      let done: Record<string, unknown>;
      if ("reason" in baked) done = { ok: false, reason: baked.reason };
      else {
        const probed = await this.probeBaked(baked, false);
        done = probed.ok === true ? await this.applyBaked(baked) : probed;
      }
      if (done.ok === true) {
        const node = parseNode(done.node);
        if (node !== null) nodes.push(node);
        continue;
      }
      const row = { index, ...(label ? { label } : {}), reason: String(done.reason ?? "This edit did not apply."), ...(done.where ? { where: done.where } : {}) };
      if (mode === "skip") {
        failures.push(row);
        continue;
      }
      if (mode === "rollback" && nodes.length > 0) {
        await this.back(start, nodes[0]!);
        this.added.splice(startAdded);
        return { ok: false, applied: 0, rolledBack: true, failed: row, node: nodeHandle(start) };
      }
      return { ok: false, applied: nodes.length, failed: row, ...(nodes.length ? { node: nodeHandle(nodes[nodes.length - 1]!) } : {}) };
    }
    return {
      ok: failures.length === 0,
      applied: nodes.length,
      ...(failures.length ? { failures, note: `${failures.length} op${failures.length === 1 ? " was" : "s were"} refused and left out; the rest applied.` } : {}),
      ...(nodes.length ? { first: nodeHandle(nodes[0]!), node: nodeHandle(nodes[nodes.length - 1]!) } : {}),
      ...(typeof args.label === "string" ? { label: args.label } : {}),
      fingerprint: this.solid.fingerprint ?? null,
      bounds: this.solid.bounds,
    };
  }

  /** I19, as the session builds it: every op a tool of one boolean, one step, the ops that do not fit listed. */
  private async applyCombined(raws: Record<string, unknown>[], combine: "cut" | "fuse", label: string | undefined): Promise<Record<string, unknown>> {
    const failures: Record<string, unknown>[] = [];
    const steps: ModelOp[] = [];
    const indexOf: number[] = [];
    const kinds = new Set(["boolean", "extrude", "revolve", "loft"]);
    for (const [index, raw] of raws.entries()) {
      const anchored = this.anchored(raw);
      if ("reason" in anchored) {
        failures.push({ index, reason: anchored.reason });
        continue;
      }
      const op = anchored.op;
      if (isComposite(op.kind) || !kinds.has(String(op.kind))) {
        failures.push({ index, reason: `A combined batch takes boolean, extrude, revolve, and loft ops; ${String(op.kind)} is not one. Apply it on its own.` });
        continue;
      }
      const baked = this.bake(structuredClone(op));
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
    const probed = await this.probeBaked(baked, false);
    const done = probed.ok === true ? await this.applyBaked(baked) : probed;
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
      fingerprint: this.solid.fingerprint ?? null,
      bounds: this.solid.bounds,
    };
  }

  private async section(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof args.saveAs === "string") return { ok: false, reason: "A recipe reads section's answer directly; saveAs is for a call from the chat." };
    const cuts = args.face === undefined ? cutPlanes(args) : null;
    if (cuts && "reason" in cuts) return { ok: false, reason: cuts.reason };
    if (args.face !== undefined && ["planes", "fan", "levels"].some((key) => args[key] !== undefined)) return { ok: false, reason: "Give a face or planes, not both." };
    const chordMm = typeof args.chordMm === "number" ? args.chordMm : 0.05;
    const node = this.tree.current;
    const cut = await solidSections(args, chordMm, cuts, this.part.pose, this.expand(), (request) => this.engine(node, { ...request, key: this.tree.key, node }));
    if ("reason" in cut) return { ok: false, reason: cut.reason };
    const points = cut.sections.reduce((sum, section) => sum + pointsIn(section), 0);
    if (points > MAX_SECTION_POINTS) return { ok: false, reason: `This answer would hold ${points} points, over ${MAX_SECTION_POINTS}. Cut fewer planes, pass resample, or a larger chordMm.` };
    return { ok: true, object: this.part.id, ...cut.extra, sections: cut.sections };
  }
}
