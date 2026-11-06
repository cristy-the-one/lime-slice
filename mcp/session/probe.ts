/**
 * Baking and probing an op before it is applied.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { plainModelError } from "../../src/app/model-error.ts";
import { probeFromBody, probeKey } from "../../src/model-feasibility.ts";
import { plateUp, readPartition, storedPartition } from "../partition.ts";
import { formatMm } from "../../src/model-plane.ts";
import { gotoRequest, joinOp, probeRequest } from "../../src/model-request.ts";
import { disjointRefusal, probeEcho, probeVerdict, solidView } from "../../src/modeling/model-calls.ts";
import { bakeOp, bakeTransition, type BakeContext, type Baked } from "../../src/modeling/bake.ts";
import { thinWalls } from "../../src/modeling/thin.ts";
import { splitCheck } from "../../src/modeling/part-reads.ts";
import { applyPose, toSolidOp, turnDir, typedPoseOf } from "../../src/model-space.ts";
import type { ModelOp, ModelTree } from "../../src/model-tree.ts";
import { readTransitionRows, transitionSentence, transitionSkinWarns, TRANSITION_SKIN_NOTE } from "../../src/model-transition.ts";
import { cleanOp, expand, isComposite } from "../../src/modeling/compose.ts";
import { CHORD, type PlateObject, UNKNOWN_OBJECT } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

function bake(this: Session, obj: PlateObject, raw: unknown): Baked | { reason: string } {
  return bakeOp(raw, this.bakeContext(obj));
}

/** What baking an op reads of `obj` (src/modeling/bake.ts, shared with the app), with the kinds only a session bakes. */
function bakeContext(this: Session, obj: PlateObject): BakeContext {
  return {
    pose: typedPoseOf(obj),
    solid: obj.solid,
    plane: this.typedPlane(obj),
    expand: () => this.expandContext(obj),
    nodeOf: (value) => this.nodeOf(obj, value),
    hasNode: (id) => !!obj.tree?.nodes.has(id),
    // --- Split to print. Defaults are filled from the plate's printer and settings now, as at Apply (D11).
    partition: (spec) => {
      const typed = readPartition(spec, (id) => this.partitionTarget(id));
      if ("reason" in typed) return typed;
      const stored = storedPartition(typed, this.partitionContext(obj), typedPoseOf(obj), obj.solid ? { positions: obj.solid.positions, up: plateUp(obj.orient) } : undefined);
      if ("reason" in stored) return stored;
      return { op: stored.op, typed: cleanOp(spec), notes: stored.notes };
    },
    join: (spec) => {
      const tool = this.find(String(spec.toolObject ?? ""));
      if (!tool) return { reason: UNKNOWN_OBJECT };
      if (!tool.tree) return { reason: "The tool object has no solid yet." };
      const op = joinOp((spec.op === "fuse" || spec.op === "common" ? spec.op : "cut"), { object: tool.id, key: tool.tree.key, node: tool.tree.current, name: tool.name }, obj.modelPose, tool.modelPose, spec.keepTool === true);
      return { op, typed: { kind: "join", toolObject: tool.id, keepTool: spec.keepTool === true } };
    },
    // --- Print transitions. The build direction is worked out now, from this pose on the plate's printer, and kept.
    transition: (spec) => this.bakeTransition(obj, spec),
  };
}

/**
 * --- Print transitions (docs/plan-belt-transitions.md, step 2). The op in the solid's frame, and as typed with every
 * default filled, so a model_edit of the echo keeps the build direction it was made for; `build: null` aims it from
 * this pose again.
 */
function bakeTransitionMethod(this: Session, obj: PlateObject, spec: Record<string, unknown>): { op: ModelOp; typed: Record<string, unknown> } | { reason: string } {
  const printer = this.printer();
  return bakeTransition(spec, this.bakeContext(obj), { supportAngle: this.settings.supportAngle, nozzleMm: this.library.nozzleMm, printer: { id: printer.id, belt: printer.kind === "belt" ? printer.belt : null }, orient: obj.orient });
}

/**
 * --- Print transitions. The kernel's rows for a probe, read in model space: the new face's normal there, and its
 * angle to the belt (or the bed), the plate's up being the third row of the plate orientation.
 */
function transitionRows(this: Session, obj: PlateObject, raw: unknown): { rows: Record<string, unknown>[]; text: string; reach: number } | null {
  const read = readTransitionRows(raw, obj.orient);
  if (!read || !Array.isArray(raw)) return null;
  const pose = typedPoseOf(obj);
  const belt = this.printer().kind === "belt";
  const kernel = raw.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && Array.isArray((row as Record<string, unknown>).normal));
  // A lip's triangles are for the app's ghost, not a caller: they stay out of the reply.
  const rows = read.map((row, i) => {
    const { soup: _soup, ...kept } = kernel[i] ?? {};
    return { ...kept, normal: turnDir(pose, row.normal).map((value) => Math.round(value * 1000) / 1000 + 0), [belt ? "angleToBeltDeg" : "angleToBedDeg"]: row.angleToPlateDeg };
  });
  // The Skin on shallow slopes warning is about a corner's wedge thickening a roof; a lip's depth is not a wedge's size.
  const corners = read.filter((row) => row.case === "corner");
  return { rows, text: read.map((row) => transitionSentence(row, belt)).join(" "), reach: corners.length > 0 ? Math.max(...corners.map((row) => row.reachMm)) : 0 };
}

function splitCheckMethod(this: Session, obj: PlateObject, op: Extract<ModelOp, { kind: "split" }>): { text: string; bad: boolean } {
  return splitCheck(obj.solid, op);
}

async function openJoinTool(this: Session, raw: unknown): Promise<string | null> {
  if (!raw || typeof raw !== "object") return null;
  const spec = raw as { kind?: unknown; toolObject?: unknown };
  if (spec.kind !== "join") return null;
  const tool = this.find(typeof spec.toolObject === "string" ? spec.toolObject : "");
  if (!tool) return UNKNOWN_OBJECT;
  if (tool.tree && !tool.treeStale) return null;
  const opened = await this.opened(tool);
  return "reason" in opened ? opened.reason : null;
}

/**
 * --- Text milestone 5. model_probe of a text op that is one lettering step (a font, or a curved face): the same check as an
 * apply, with what the letters are: `inkMm2`, how they were built, and `thin`, the letters a nozzle-wide line cannot print.
 * A text with no font is a box a stroke, which is several steps: it is applied, not probed.
 */
async function probeText(this: Session, obj: PlateObject, raw: Record<string, unknown>, nodeHandleValue: unknown): Promise<Record<string, unknown>> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  const asked = this.nodeOf(obj, nodeHandleValue);
  const at = asked ?? tree.current;
  if (asked !== null && !tree.nodes.has(asked)) return refuse("step-not-found", "That step is not in the history.", undefined, NEXT.hist);
  const work = async (): Promise<Record<string, unknown>> => {
    const context = this.expandContext(obj);
    const expanded = expand(this.withFaceIndex(obj, structuredClone(raw)), context, (op) => this.pieceOf(obj, op));
    if ("reason" in expanded) return refuse("bad-argument", expanded.reason);
    const only = expanded.length === 1 ? expanded[0]! : null;
    if (!only?.step) return refuse("wrong-kind", "model_probe checks one step, and a text with no font is a box for every stroke. Name a font (stroke is the single-stroke one) to probe it, or apply it with model_apply.");
    const op = toSolidOp(only.step as unknown as ModelOp, obj.modelPose);
    return this.probeBaked(obj, tree, at, { op, typed: raw }, true, true);
  };
  return at !== tree.current ? this.atStep(obj, tree, at, work) : work();
}

/** The letters a nozzle-wide line cannot print, for a lettering step: the engine's own layout, judged against the nozzle. */
async function thinLetters(this: Session, op: Extract<ModelOp, { kind: "lettering" }>): Promise<{ char: string; lostPct: number }[]> {
  const request: Record<string, unknown> = { call: "textLayout", text: op.text, font: op.font, height: op.height, lineMm: this.library.nozzleMm, stepMm: 0.5 };
  for (const key of ["style", "spacing", "lineSpacing", "align", "angleDeg", "weight", "strokeWidth"] as const) if (op[key] !== undefined) request[key] = op[key];
  try {
    const reply = JSON.parse(await this.ask(this.engine.modelTree(JSON.stringify(request)))) as { thin?: { ch?: string; lostPct?: number }[] };
    return (reply.thin ?? []).map((t) => ({ char: String(t.ch ?? ""), lostPct: Number(t.lostPct ?? 0) }));
  } catch {
    return [];
  }
}

async function probe(this: Session, obj: PlateObject, raw: unknown, nodeHandleValue?: unknown, measure = false): Promise<Record<string, unknown>> {
  if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "text") return this.probeText(obj, raw as Record<string, unknown>, nodeHandleValue);
  if (raw && typeof raw === "object" && isComposite((raw as { kind?: unknown }).kind)) {
    return refuse("wrong-kind", "model_probe checks one step. Apply a pattern, mirror, pocket, boss, or texture with model_apply; it checks each step as it goes.");
  }
  const toolReason = await this.openJoinTool(raw);
  if (toolReason) return refuse("needs-solid-tool", toolReason);
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  const asked = this.nodeOf(obj, nodeHandleValue);
  const at = asked ?? tree.current;
  if (asked !== null && !tree.nodes.has(asked)) return refuse("step-not-found", "That step is not in the history.", undefined, NEXT.hist);
  if (at !== tree.current) return this.atStep(obj, tree, at, () => this.bakeAndProbe(obj, tree, at, raw, measure));
  return this.bakeAndProbe(obj, tree, at, raw, measure);
}

async function bakeAndProbe(this: Session, obj: PlateObject, tree: ModelTree, at: number, raw: unknown, measure: boolean): Promise<Record<string, unknown>> {
  const baked = this.bake(obj, raw);
  if ("reason" in baked) return refuse("bad-op", baked.reason);
  return this.probeBaked(obj, tree, at, baked, measure);
}

/**
 * --- 3.1 F14. Work on step `at`'s solid: face and edge selectors, a hole's depth through the part, and the checks
 * read `obj.solid`, which is the current step's. The engine shows `at` for the work and the current step again after,
 * and the history does not move.
 */
async function atStep(this: Session, obj: PlateObject, tree: ModelTree, at: number, work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const current = tree.current;
  const prior = obj.solid;
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(gotoRequest(tree.key, at, CHORD), "edit", this.replayBudgetMs(this.stepsTo(tree, at)));
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  if (typeof reply.error === "string" && reply.error) return refuse("kernel-refused", plainModelError(reply.error));
  const solid = solidView(reply);
  if (!solid) return refuse("solid-unreadable", "That step's solid could not be read.");
  obj.solid = solid;
  try {
    return await work();
  } finally {
    obj.solid = prior;
    if (!obj.treeStale) {
      try {
        await this.treeCall(gotoRequest(tree.key, current, CHORD), "edit", this.replayBudgetMs(this.stepsTo(tree, current)));
      } catch {
        // A modeler restarted under the work rebuilds the history at its current step on next use.
      }
    }
  }
}

/**
 * The check before an apply, for an op already in the solid's frame. A probe that passes is remembered for `at`.
 * `measure` asks the modeler for the built shape too, for model_probe's metrics; a batch step does not need it.
 */
async function probeBaked(this: Session, obj: PlateObject, tree: ModelTree, at: number, baked: { op: ModelOp; typed: Record<string, unknown>; notes?: string[] }, measure = false, composite = false, budgetMs?: number): Promise<Record<string, unknown>> {
  const answer = (body: Record<string, unknown>) => probeEcho(baked, body);
  if (baked.op.kind === "scale") {
    obj.probes.set(probeKey(String(at), baked.op), true);
    return answer({ ok: true, reason: "This scale fits." });
  }
  if (baked.op.kind === "root") {
    obj.probes.set(probeKey(String(at), baked.op), true);
    return answer({ ok: true, reason: "This solid can be rebuilt from these sizes." });
  }
  if (baked.op.kind === "split") {
    const note = this.splitCheck(obj, baked.op);
    if (note.bad) return answer(refuse("does-not-fit", note.text));
    obj.probes.set(probeKey(String(at), baked.op), true);
    return answer({ ok: true, reason: note.text });
  }
  if (baked.op.kind === "partition") return answer(await this.probePartition(obj, tree, at, baked.op, budgetMs, baked.notes ?? []));
  const missed = obj.solid ? disjointRefusal(obj.solid.bounds, baked.op) : null;
  if (missed) return answer({ ok: false, code: "does-not-fit", reason: `${missed.reason}${this.frameWhere(obj)}`, missed: true, frame: obj.frame ?? "model", ...(missed.gapMm > 0 ? { gapMm: missed.gapMm } : {}) });
  const blend = (baked.op.kind === "fillet" || baked.op.kind === "chamfer" || baked.op.kind === "transition") && baked.op.edges.length > 1;
  const preview = measure || blend ? (obj.stepTolerance || CHORD) : undefined;
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(probeRequest(tree.key, at, baked.op, preview), baked.op.kind, budgetMs);
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  this.lastPreview = reply.preview && typeof reply.preview === "object" ? solidView(reply.preview as Record<string, unknown>) : null;
  const verdict = probeVerdict(baked.op, reply, typedPoseOf(obj), composite);
  if (verdict.ok === false && verdict.tooThick && baked.op.kind === "shell") {
    const advice = await this.shellAdvice(obj, tree, at, baked.op, budgetMs);
    if (advice.lost) return answer(advice.lost);
    return answer({ ok: false, code: "does-not-fit", reason: `${verdict.tooThick} ${advice.text}`, ...(advice.maxMm !== undefined ? { maxMm: advice.maxMm } : {}), ...(advice.where ? { where: advice.where } : {}) });
  }
  if (verdict.ok === false) return answer(verdict.body);
  obj.probes.set(probeKey(String(at), baked.op), true);
  if (verdict.firstFaces) return answer({ ok: true, reason: verdict.text, firstFaces: verdict.firstFaces });
  // --- Text milestone 5: what the letters are, from the engine's own report and layout.
  if (baked.op.kind === "lettering") {
    const built = (reply.text ?? {}) as Record<string, unknown>;
    const thin = await this.thinLetters(baked.op);
    const note = thin.length ? ` ${thin.map((t) => t.char).join(", ")} ${thin.length === 1 ? "is" : "are"} thinner than your ${formatMm(this.library.nozzleMm)} mm line.` : "";
    return answer({
      ok: true,
      reason: `${verdict.text}${note}`,
      inkMm2: typeof built.inkMm2 === "number" ? Math.round(built.inkMm2 * 100) / 100 : null,
      thin,
      text: { font: built.font, letters: built.letters, build: built.build, surface: built.surface, ...(built.crossesSeam ? { crossesSeam: true } : {}) },
    });
  }
  const wedges = this.transitionRows(obj, reply.transition);
  if (wedges) {
    const warn = transitionSkinWarns(this.settings.shallowSkins, wedges.reach) ? ` ${TRANSITION_SKIN_NOTE}` : "";
    return answer({ ok: true, reason: `${verdict.text} ${wedges.text}${warn}`, transition: wedges.rows });
  }
  return answer({ ok: true, reason: verdict.text });
}

/**
 * --- 3.1 F10. Where a shell that is too thick runs out of room, and the thickest wall that fits. Inward offsets of t
 * from two sides meet where the part is thinner than 2t, so the thinnest places are measured from the solid's mesh;
 * a curved face of smaller radius than the wall cannot be offset either. The largest wall that fits is found by
 * halving, a probe each, within about 20 s; the solid does not change.
 */
async function shellAdvice(this: Session, obj: PlateObject, tree: ModelTree, at: number, op: Extract<ModelOp, { kind: "shell" }>, budgetMs?: number): Promise<{ text: string; maxMm?: number; where?: Record<string, unknown>; lost?: Record<string, unknown> }> {
  const t = op.thickness;
  const parts: string[] = [];
  let where: Record<string, unknown> | undefined;
  const solid = obj.solid;
  const pose = (p: readonly number[]) => applyPose(typedPoseOf(obj), p as [number, number, number]).map((v) => Math.round(v * 100) / 100);
  if (solid && solid.positions.length >= 9) {
    const thin = thinWalls(solid.positions, 2 * t);
    const worst = [...thin.regions].sort((a, b) => a.thinnestMm - b.thinnestMm)[0];
    if (worst) {
      where = { thinnestMm: Math.round(worst.thinnestMm * 100) / 100, at: pose(worst.centre), min: pose(worst.min), max: pose(worst.max) };
      parts.push(`The part is ${where.thinnestMm} mm thick at (${(where.at as number[]).join(", ")}), and a ${t} mm wall needs ${2 * t} mm there.`);
    }
    const tight = solid.faces.filter((face) => (face.kind === "cylinder" || face.kind === "sphere" || face.kind === "cone") && typeof face.radiusMm === "number" && face.radiusMm < t).sort((a, b) => a.radiusMm! - b.radiusMm!)[0];
    if (tight) {
      where = { ...(where ?? {}), radiusMm: Math.round(tight.radiusMm! * 100) / 100, radiusAt: pose(tight.centre), face: tight.index };
      parts.push(`Face ${tight.index}, a ${tight.kind} of radius ${where.radiusMm} mm at (${(where.radiusAt as number[]).join(", ")}), is rounder than the wall is thick.`);
    }
  }
  let fits = 0;
  let fails = t;
  const until = Date.now() + 20_000;
  for (let round = 0; round < 6 && Date.now() < until; round += 1) {
    const trial = Math.round(((fits + fails) / 2) * 100) / 100;
    if (!(trial > fits) || !(trial < fails)) break;
    let reply: Record<string, unknown>;
    try {
      reply = await this.treeCall(probeRequest(tree.key, at, { ...op, thickness: trial }), "shell", budgetMs);
    } catch (err) {
      const lost = this.lostReply(err);
      if (lost) return { text: parts.join(" "), lost };
      break;
    }
    const view = probeFromBody(reply);
    if (view?.phase === "done" && view.ok) fits = trial;
    else fails = trial;
  }
  if (fits > 0) parts.push(`A ${fits} mm wall fits.`);
  else parts.push(`Nothing from ${Math.round((fails) * 100) / 100} mm up fits; try a much thinner wall, or open a face near there.`);
  return { text: parts.join(" "), ...(fits > 0 ? { maxMm: fits } : {}), ...(where ? { where } : {}) };
}

/** The methods this module adds to Session. */
export const probeMethods = {
  bake,
  bakeContext,
  bakeTransition: bakeTransitionMethod,
  transitionRows,
  splitCheck: splitCheckMethod,
  openJoinTool,
  probeText,
  thinLetters,
  probe,
  bakeAndProbe,
  atStep,
  probeBaked,
  shellAdvice,
};
