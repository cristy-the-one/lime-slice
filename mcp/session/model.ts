/**
 * The Model dispatch: tool table by object, the modeler's budget and trees, solid_new, and the reads on a solid.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { base64ToBytes } from "../../src/base64.ts";
import { plainModelError } from "../../src/app/model-error.ts";
import { ID_MATRIX } from "../../src/mesh-place.ts";
import { disjointBoolean } from "../../src/model-feasibility.ts";
import { facePlane, formatMm } from "../../src/model-plane.ts";
import { gearOf, rootSpec, type PrimitiveSpec } from "../../src/model-primitive.ts";
import { isBrep, newSolidRequest, openRequest, wholeTreeRequest } from "../../src/model-request.ts";
import { decodeSurfaceInspect } from "../../src/model-reply.ts";
import { listedContinuity, organicFirstProblem, organicProblem } from "../organic-checks.ts";
import { boundsOf, solidSections, describeReply, edgesReply, facesReply, nodeHandle, stepGuard } from "../../src/modeling/model-calls.ts";
import { solidView } from "./sheet.ts";
import { bakeOp, onFaceIndex } from "../../src/modeling/bake.ts";
import { checkReply } from "../../src/modeling/part-reads.ts";
import { exprLeaves } from "../../src/modeling/links.ts";
import { type Affine, IDENTITY_POSE, isIdentity, posedBounds, seatLift, thenPose, typedPoseOf } from "../../src/model-space.ts";
import { featureObjectName, isFeatureOp, newTree, pathTo, type ModelOp, type ModelTree, type NodeId } from "../../src/model-tree.ts";
import { OP_SCHEMA, validate } from "../schema.ts";
import { nurbsSurfaceProblem } from "../nurbs-surface-checks.ts";
import { sketchOutline, type PickReads } from "../../src/recipe/picks.ts";
import { transitionStaleBy } from "../../src/model-transition.ts";
import { CURVED_FACE, GLOBAL_WORKPLANE, workplaneOwn, isGlobalFrame, workplaneOnBed, workplaneOnFace } from "../../src/workplane.ts";
import { cutPlanes, MAX_SECTION_POINTS, meshSection, pointsIn } from "../sections.ts";
import { eulerOrient } from "../../src/mesh-place.ts";
import { EngineStopped, occtHint, ProtocolError } from "../engine.ts";
import { recipeDataFile, recipeDataMissing, writeRecipeData } from "../recipe.ts";
import { probeMetrics, solidMetrics, surfaceAt as surfaceAtSolid, toolMesh, type SolidMetrics } from "../inspect.ts";
import { primitiveFrom } from "../../src/modeling/compose.ts";
import { gearRefusal } from "../../src/model-gear.ts";
import { typedView } from "../../src/modeling/typed-view.ts";
import { gearPairRows, gearsInTree } from "../../src/gear-pair.ts";
import { CONTACT_MM, exactVerdict, interference, MESH_TOLERANCE_MM, SLIVER_MM3 } from "../../src/interference.ts";
import { assemblyOf, drives, solveAssembly, type Assembly } from "../../src/assembly.ts";
import { firstContactSteps, KERNEL_CALLS, kernelContact, pairClearance, type ContactPart, type KernelVerdict } from "../../src/contact.ts";
import { trainTurn } from "../../src/gear-train.ts";
import { featureSolidInModel } from "../../src/model-features.ts";
import { noteTreeCall } from "./mesh-end.ts";
import { eventLoopTurn } from "../animation-run.ts";
import { modelMass } from "./mass.ts";
import { CHORD, type CallMeta, type Ghost, MESH_EDIT, ModelRunaway, type ObjectToolHandler, PLACE_KEYS, type PlateObject, posedPositions, STEP, type ToolHandler, UNKNOWN_OBJECT, modelSteps, shownName, stepFileName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse, refusePartReason, type Refusal } from "../refusals.ts";

const MODEL_TOOLS: Record<string, ObjectToolHandler> = {
  model_describe: (s, obj, input) => s.describe(obj, input),
  faces_find: (s, obj, input) => s.facesFind(obj, input),
  edges_find: (s, obj, input) => s.edgesFind(obj, input),
  workplane_set: (s, obj, input) => s.workplaneSet(obj, input),
  workplane_print_up: (s, obj) => s.printUp(obj),
  model_place: (s, obj, input) => {
    const compacted = (result: Record<string, unknown>) => {
      if (input.compact !== true || result.ok !== true) return result;
      const { note: _note, ...compact } = result;
      return compact;
    };
    // Contact in poses (docs/plan-contact-poses.md): drive the joint until it touches. It may ask the kernel, so it waits.
    if (input.until !== undefined) return s.placeUntil(obj, input).then(compacted);
    return compacted(s.modelPlace(obj, input));
  },
  model_probe: (s, obj, input) => {
    const anchored = s.anchored(obj, input.op as Record<string, unknown>);
    if ("reason" in anchored) return refuse("bad-anchor", anchored.reason);
    // --- Split to print: plan runs the planner alone, with no kernel call.
    if (input.plan === true) return s.planTool(obj, anchored.op);
    return s.probeMeasured(obj, { ...input, op: anchored.op });
  },
  surface_at: (s, obj, input) => s.surfaceAt(obj, input),
  section: (s, obj, input) => s.sectionTool(obj, input),
  model_check: (s, obj, input) => s.modelCheck(obj, input),
  model_apply: (s, obj, input) => s.applyTool(obj, input),
  model_apply_batch: (s, obj, input) => s.applyBatch(obj, input),
  model_history: (s, obj, input) => s.history(obj, input),
  model_anchors: (s, obj, input) => s.anchorsTool(obj, input),
  model_goto: (s, obj, input) => s.gotoNode(obj, s.nodeOf(obj, input.node)),
  model_undo: (s, obj) => s.step(obj, "undo"),
  model_redo: (s, obj) => s.step(obj, "redo"),
  model_edit: (s, obj, input) => s.edit(obj, s.nodeOf(obj, input.node), input.op, input.probe === true),
  model_drop: (s, obj, input) => s.drop(obj, s.nodeOf(obj, input.node)),
  model_rename: (s, obj, input) => s.rename(obj, s.nodeOf(obj, input.node), String(input.label ?? "")),
  model_commit: (s, obj) => s.commit(obj),
  model_export_step: (s, obj, input) => {
    if (input.pieces === true && input.assembly === true) return refuse("conflicting-arguments", "Export the pieces or the assembly, not both.");
    if (input.assembly === true) return s.exportAssemblyStep(obj, String(input.name), input.flat === true);
    return input.pieces === true ? s.exportPieceStep(obj, String(input.name)) : s.exportStep(obj, String(input.name));
  },
  measure: (s, obj, input) => s.measure(obj, input),
  model_mass: (s, obj, input) => modelMass(s, obj, input),
};

/**
 * --- Assemblies M6. Every pair of parts in `obj`'s assembly, at their assembled poses: the mesh pass's answer, clear,
 * touch or crossing, and nested for a part wholly inside another. Pairs that are clear are counted, not listed.
 */
async function interferenceCheck(this: Session, obj: PlateObject, exact: boolean, crossingsOnly = false): Promise<Record<string, unknown>> {
  // The mesh pass at the meshes' own chord: faces that touch in the solids (an axle in a hole of its size) can overlap
  // that much in their meshes. pose_animate's check reads them the same way. The exact pass measures every pair the
  // mesh pass did not clear, touches included.
  const cheap = this.meshInterference(obj, MESH_TOLERANCE_MM);
  if (cheap.ok !== true) return cheap;
  if (!exact) return crossingsOnly ? { ...cheap, pairs: (cheap.pairs as Record<string, unknown>[]).filter((row) => row.verdict !== "touch" || row.nested) } : cheap;
  // --- Assemblies M7. Each pair the mesh pass did not clear is measured: the common volume of the two solids.
  const rows = cheap.pairs as Record<string, unknown>[];
  for (const row of rows) {
    const a = this.find(String(row.a));
    const b = this.find(String(row.b));
    if (!a || !b) continue;
    const measured = await this.commonVolume(a, b);
    if ("reason" in measured) {
      Object.assign(row, { exact: false, note: measured.reason });
      continue;
    }
    const verdict = exactVerdict(measured.volumeMm3, [measured.volumes[0], measured.volumes[1]]);
    Object.assign(row, { exact: true, volumeMm3: Math.round(measured.volumeMm3 * 1000) / 1000, verdict, ...(measured.boxMm ? { overlapMm: measured.boxMm } : {}) });
    if (verdict === "touch") delete row.nested;
  }
  const crossing = rows.filter((row) => row.verdict === "crossing" || row.nested).length;
  return {
    ...cheap,
    pass: "exact",
    ...(crossingsOnly ? { pairs: rows.filter((row) => row.verdict !== "touch" || row.nested || row.exact === false) } : {}),
    note: crossing > 0
      ? `${crossing} pair${crossing === 1 ? "" : "s"} share volume. Nothing is blocked: a press fit is meant to cross.`
      : `No pair shares volume. A common volume under ${SLIVER_MM3} mm³, or a millionth of the smaller part, is a touch.`,
  };
}

/**
 * The common volume of two parts at their assembled poses, by Open CASCADE: a join `common` with `b` as its tool,
 * probed on `a`'s current step with a preview, so `a`'s history does not change. An empty common is 0.
 */
async function commonVolume(this: Session, a: PlateObject, b: PlateObject): Promise<{ volumeMm3: number; volumes: [number, number]; boxMm?: { min: number[]; max: number[] } } | { reason: string }> {
  for (const part of [a, b]) {
    if (this.meshBlock(part)) return { reason: "Mesh crossing, not measured: a mesh has no solid to intersect." };
    const opened = await this.opened(part);
    if ("reason" in opened) return { reason: opened.reason };
    if (!part.solid || !part.solid.editable) return { reason: "Mesh crossing, not measured: this part has no solid." };
  }
  const volumes: [number, number] = [a.solid!.volumeMm3, b.solid!.volumeMm3];
  this.lastPreview = null;
  const probed = await this.probe(a, { kind: "join", op: "common", toolObject: b.id, keepTool: true }, undefined, true);
  const preview = this.lastPreview as { positions: Float32Array; volumeMm3: number } | null;
  // An empty common is refused as "The solids do not overlap.": the parts share no volume. Any other refusal is not
  // an answer about volume, and says so.
  if (probed.ok !== true) return /do not overlap/i.test(String(probed.reason)) ? { volumeMm3: 0, volumes } : { reason: `Not measured: ${String(probed.reason)}` };
  if (!preview || preview.positions.length < 9) return { volumeMm3: 0, volumes };
  const box = posedBounds(preview.positions, a.modelPose);
  const mm = (value: number) => Math.round(value * 100) / 100 + 0;
  return { volumeMm3: Math.abs(preview.volumeMm3), volumes, ...(box ? { boxMm: { min: box.min.map(mm), max: box.max.map(mm) } } : {}) };
}

/** Bisection stops when the crossing is pinned to this many degrees, unless the call gives its own tolerance. */
const SWEEP_REFINE_DEG = 0.5;
/** Most angles one sweep tries before it refines, so a call stays bounded. */
const SWEEP_MAX_STEPS = 1000;
/** The finest step a sweep takes, degrees. */
const SWEEP_MIN_STEP = 0.01;
/** A sweep or an until search gives the event loop a turn after this much work, ms. */
const SWEEP_SLICE_MS = 20;

/** `assembly` with no joint limits, so a sweep can find them. */
function unlimited(assembly: Assembly): Assembly {
  return { ...assembly, members: assembly.members.map((row) => {
    if (!drives(row.joint)) return row;
    const { min: _min, max: _max, ...open } = row.joint;
    return { ...row, joint: open };
  }) };
}

/** The members whose solved pose differs between two solves. */
function movedMembers(before: Map<string, Affine>, after: Map<string, Affine>, ids: readonly string[]): string[] {
  const same = (p: Affine | undefined, q: Affine | undefined) => !!p && !!q && p.m.every((v, k) => Math.abs(v - q.m[k]!) <= 1e-9) && p.t.every((v, k) => Math.abs(v - q.t[k]!) <= 1e-9);
  return ids.filter((id) => !same(before.get(id), after.get(id)));
}

/**
 * `model_check {sweep:{from, to, step, tolerance, ignore}}`: turn the part's hinge through the range, as model_place
 * {angle} would, its gear train with it (docs/plan-contact-poses.md: a coupled train follows; limits left out: this is
 * for finding them), and stop at the first angle where it or anything that moves with it shares volume with a part that
 * does not move. Only those pairs, a moving part with a still one, are compared. The mesh pass finds candidates; the
 * kernel measures them, as model_check {interference, exact} does. Pairs that already cross where the hinge stands (a
 * press or friction fit) are left out, as model_place {until} leaves them, and so are the pairs `ignore` names. The
 * crossing is then bisected to `tolerance` degrees. The sweep gives the event loop a turn every SWEEP_SLICE_MS, so a
 * long one sends progress, goes on as a job, and stops on cancel. Poses are put back as they were on every way out, and
 * nothing is undoable.
 */
async function jointSweep(this: Session, host: PlateObject, spec: Record<string, unknown>): Promise<Record<string, unknown>> {
  const part = typeof spec.object === "string" ? this.find(spec.object) : host;
  if (!part) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  const assemblies = this.liveAssemblies();
  const base = assemblyOf(assemblies, part.id);
  const poseOf = (id: string) => this.find(id)?.modelPose;
  const solved = base ? solveAssembly(base, poseOf, this.params).assembly : undefined;
  const member = solved?.members.find((row) => row.object === part.id);
  if (!base || !solved || !member || member.joint?.kind !== "hinge") return refuse("bad-placement", "A sweep needs a part with a hinge in an assembly: model_place {joint} makes one.", undefined, NEXT.assembly);
  const hinge = member.joint;
  const { from, to } = spec as { from?: unknown; to?: unknown };
  const step = spec.step === undefined ? 5 : spec.step;
  const refine = spec.tolerance === undefined ? SWEEP_REFINE_DEG : spec.tolerance;
  if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to) || typeof step !== "number" || !(step > 0) || !Number.isFinite(step)) return refuse("bad-argument", "A sweep needs finite from and to angles in degrees, and a positive step.");
  if (step < SWEEP_MIN_STEP) return refuse("bad-argument", `The finest sweep step is ${SWEEP_MIN_STEP} degrees; give tolerance to pin the crossing finer.`);
  if (typeof refine !== "number" || !Number.isFinite(refine) || refine < 0.001 || refine > 45) return refuse("bad-argument", "tolerance is degrees, from 0.001 to 45: the bisection pins the crossing to it.");
  const count = Math.floor(Math.abs(to - from) / step + 1e-9) + 1;
  if (count > SWEEP_MAX_STEPS) return refuse("bad-argument", `That is ${count} steps; a sweep tries at most ${SWEEP_MAX_STEPS}. Give a larger step.`);
  // sweep.ignore: pairs of parts of this assembly the sweep leaves out, in either order.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const named = new Map<string, [string, string]>();
  if (spec.ignore !== undefined) {
    const shape = "sweep.ignore is a list of pairs of parts: [[a, b], ...].";
    if (!Array.isArray(spec.ignore)) return refuse("bad-argument", shape);
    for (const row of spec.ignore as unknown[]) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string") return refuse("bad-argument", shape);
      const stranger = (row as string[]).find((id) => !base.members.some((m) => m.object === id));
      if (stranger !== undefined) return refuse("bad-argument", `sweep.ignore names ${stranger}, which is not a part of this assembly.`);
      if (row[0] === row[1]) return refuse("bad-argument", `sweep.ignore pairs ${row[0]} with itself: name two different parts.`);
      named.set(pairKey(row[0], row[1]), [row[0], row[1]]);
    }
  }
  const direction = to >= from ? 1 : -1;
  const angles = Array.from({ length: count }, (_, i) => from + direction * step * i);
  if (Math.abs(angles[angles.length - 1]! - to) > 1e-9) angles.push(to);
  const was = hinge.angle ?? 0;
  // The hinge turns its train (trainTurn), limits left out. A locked train is refused with its own sentence.
  const open = unlimited(solved);
  const turnTo = (angle: number) => trainTurn(open, part.id, angle - was);
  const ids = solved.members.map((row) => row.object);
  const start = solveAssembly(solved, poseOf).poses;
  // The parts that move are those whose pose changes, as trainTurn makes it: what rides on the part, and its train.
  const moving = new Set<string>([part.id]);
  let followers: string[] = [];
  for (const delta of [1, 37]) {
    const turned = turnTo(was + delta);
    if ("reason" in turned) return refuse("bad-placement", turned.reason);
    for (const id of movedMembers(start, solveAssembly(turned.assembly, poseOf).poses, ids)) moving.add(id);
    followers = turned.angles.filter((row) => row.object !== part.id).map((row) => row.object);
  }
  // The pairs compared, in the assembly's order as model_check {interference} lists them: one part that moves, one that
  // does not. A pair of two still parts cannot change along the sweep, and two that move together keep their fit.
  const meshes = (assemblyOf(this.liveAssemblies(), part.id) ?? base).members.flatMap((row) => {
    const obj = this.find(row.object);
    if (!obj) return [];
    const solid = !!obj.solid && obj.solid.positions.length >= 9;
    const positions = solid ? obj.solid!.positions : obj.source;
    return positions.length >= 9 ? [{ obj, solid, positions: positions instanceof Float32Array ? positions : new Float32Array(positions) }] : [];
  });
  type Mesh = (typeof meshes)[number];
  const checked: [Mesh, Mesh][] = [];
  for (let i = 0; i < meshes.length; i += 1) {
    for (let j = i + 1; j < meshes.length; j += 1) if (moving.has(meshes[i]!.obj.id) !== moving.has(meshes[j]!.obj.id)) checked.push([meshes[i]!, meshes[j]!]);
  }
  const placedMesh = (row: Mesh) => ({ positions: row.positions, pose: row.solid ? row.obj.modelPose : thenPose(seatLift(row.obj.seatMm), row.obj.modelPose) });
  const saved = new Map(solved.members.flatMap((row) => { const obj = this.find(row.object); return obj ? [[obj.id, { m: [...obj.modelPose.m], t: [...obj.modelPose.t] }] as const] : []; }));
  // A turn of the event loop every SWEEP_SLICE_MS: progress goes out, the reply timer can hand the call to a job, and
  // slice_cancel (or the plan's cancel) is heard.
  const signal = this.callContext.getStore()?.signal;
  let stage = "sweep: starting";
  let fraction = 0;
  let last = Date.now();
  const cancelled = { cancelled: true } as const;
  const breathe = async (): Promise<boolean> => {
    if (Date.now() - last <= SWEEP_SLICE_MS) return false;
    this.noteStage(stage, fraction);
    await eventLoopTurn();
    last = Date.now();
    return signal?.aborted === true;
  };
  const skipped = new Set<string>(named.keys());
  let evaluations = 0;
  const crossing = async (angle: number): Promise<{ pairs: Record<string, unknown>[] } | { reason: string } | typeof cancelled> => {
    if (await breathe()) return cancelled;
    evaluations += 1;
    const turned = turnTo(angle);
    if ("reason" in turned) return { reason: turned.reason };
    this.writeSolved(turned.assembly, "", false);
    const hits: Record<string, unknown>[] = [];
    for (const [ma, mb] of checked) {
      if (await breathe()) return cancelled;
      if (skipped.has(pairKey(ma.obj.id, mb.obj.id))) continue;
      const cheap = interference(placedMesh(ma), placedMesh(mb), { toleranceMm: CONTACT_MM });
      if (cheap.verdict !== "crossing" && !cheap.nested) continue;
      const row = { a: ma.obj.id, b: mb.obj.id, names: [shownName(ma.obj.name), shownName(mb.obj.name)] };
      const measured = await this.commonVolume(ma.obj, mb.obj);
      if ("reason" in measured) {
        hits.push({ ...row, exact: false, note: measured.reason });
        continue;
      }
      const verdict = exactVerdict(measured.volumeMm3, [measured.volumes[0], measured.volumes[1]]);
      if (verdict === "crossing") hits.push({ ...row, exact: true, volumeMm3: Math.round(measured.volumeMm3 * 1000) / 1000, ...(measured.boxMm ? { overlapMm: measured.boxMm } : {}) });
    }
    return { pairs: hits };
  };
  const decimals = refine < 0.01 ? 1e4 : 100;
  const round = (value: number) => Math.round(value * decimals) / decimals + 0;
  const r6 = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
  const total = angles.length;
  const stopped = (where: string) => refuse("cancelled", `The sweep was cancelled ${where}; the poses are as they were and nothing changed.`);
  try {
    // Where the hinge stands: a pair that already crosses here is a fit meant to cross (a press or friction fit), and is
    // left out of the sweep. When the sweep starts here, this pose is its first angle, now clear.
    stage = "sweep: the pose where the hinge stands";
    const atStart = await crossing(was);
    if ("cancelled" in atStart) return stopped("at the pose where the hinge stands");
    if ("reason" in atStart) return refuse("bad-placement", atStart.reason);
    const fits = atStart.pairs.filter((row) => !skipped.has(pairKey(String(row.a), String(row.b))));
    for (const row of fits) skipped.add(pairKey(String(row.a), String(row.b)));
    const startsHere = Math.abs(angles[0]! - was) <= 1e-9;
    let clear: number | null = startsHere ? angles[0]! : null;
    let hit: { angle: number; pairs: Record<string, unknown>[] } | null = null;
    for (let k = startsHere ? 1 : 0; k < total; k += 1) {
      const angle = angles[k]!;
      stage = `sweep: angle ${k + 1} of ${total} (${round(angle)} degrees)`;
      fraction = (0.9 * k) / total;
      const here = await crossing(angle);
      if ("cancelled" in here) return stopped(`at angle ${k + 1} of ${total} (${round(angle)} degrees)`);
      if ("reason" in here) return refuse("bad-placement", here.reason);
      if (here.pairs.length > 0) { hit = { angle, pairs: here.pairs }; break; }
      clear = angle;
    }
    if (hit && clear !== null) {
      let lo: number = clear;
      // Pin the first crossing between the last clear angle and the first crossing one.
      while (Math.abs(hit.angle - lo) > refine) {
        const mid: number = (hit.angle + lo) / 2;
        stage = `sweep: pinning the crossing between ${round(lo)} and ${round(hit.angle)} degrees`;
        fraction = 0.9;
        const here = await crossing(mid);
        if ("cancelled" in here) return stopped(`while it pinned the crossing between ${round(lo)} and ${round(hit.angle)} degrees`);
        if ("reason" in here) return refuse("bad-placement", here.reason);
        if (here.pairs.length > 0) hit = { angle: mid, pairs: here.pairs };
        else lo = mid;
      }
      clear = lo;
    }
    // How close the crossing was pinned: the bracket between the last clear angle and the first crossing one, which is
    // the step itself when the step was already within tolerance and no bisection ran.
    const pinned = hit && clear !== null ? r6(Math.abs(hit.angle - clear)) : null;
    const limits = { ...(hinge.min !== undefined ? { min: hinge.min } : {}), ...(hinge.max !== undefined ? { max: hinge.max } : {}) };
    const trainNote = followers.length ? ` Its gear train turned with it (${followers.map((id) => shownName(this.find(id)?.name ?? id)).join(", ")}).` : "";
    const nameOf = (id: string) => shownName(this.find(id)?.name ?? id);
    const ignored = [
      ...fits.map((row) => ({ a: row.a, b: row.b, names: row.names, why: "crosses where the hinge stands" })),
      ...[...named.values()].map(([a, b]) => ({ a, b, names: [nameOf(a), nameOf(b)], why: "named in sweep.ignore" })),
    ];
    const ignoredNote = ignored.length
      ? ` Left out: ${ignored.map((row) => `${(row.names as string[]).join(" with ")} (${row.why})`).join("; ")}.${fits.length ? " A pair that already crosses where the hinge stands is taken as a fit meant to cross." : ""}`
      : "";
    return {
      ok: true,
      object: part.id,
      assembly: base.name,
      sweep: { from, to, step, tolerance: pinned ?? refine },
      ...(followers.length ? { train: followers } : {}),
      ...(hit ? { firstCollisionDeg: round(hit.angle), collidesWith: hit.pairs.map((row) => ({ ...row, other: moving.has(String(row.a)) ? row.b : row.a })) } : { collision: null }),
      clearRange: clear === null ? null : { fromDeg: from, toDeg: round(clear) },
      ...(ignored.length ? { ignored } : {}),
      ...(Object.keys(limits).length ? { limits } : {}),
      evaluations,
      note: hit
        ? clear === null
          ? `The part already crosses at the first angle, ${from}: start the sweep from a clear pose, or name the pair in sweep.ignore.${ignoredNote}`
          : `Clear from ${from} to ${round(clear)}; it first crosses a fixed part by ${round(hit.angle)} (pinned to ${pinned} degrees). Parts that ride on this one are swept with it.${trainNote}${ignoredNote} Poses are as they were.`
        : `Clear over the whole sweep, ${from} to ${to}.${trainNote}${ignoredNote} Joint limits were not applied. Poses are as they were.`,
    };
  } finally {
    for (const [id, pose] of saved) { const obj = this.find(id); if (obj) obj.modelPose = pose as typeof obj.modelPose; }
  }
}

/** Each member's triangles in its own part frame: a solid's kernel mesh, or a mesh part with its seat lift. */
function contactParts(this: Session, assembly: Assembly): ContactPart[] {
  return assembly.members.flatMap((row) => {
    const part = this.find(row.object);
    if (!part) return [];
    const solid = !!part.solid && part.solid.positions.length >= 9;
    const positions = solid ? part.solid!.positions : posedPositions(part.source, seatLift(part.seatMm));
    // A solid's mesh is the kernel's, at the session's chord (or a STEP's own tolerance): its curved facets lie within
    // that of the true face. A mesh part is its own triangles.
    const chord = solid ? { chordMm: Math.max(CHORD, part.stepTolerance || CHORD) } : {};
    return positions.length >= 9 ? [{ object: part.id, positions: positions instanceof Float32Array ? positions : new Float32Array(positions), ...chord }] : [];
  });
}

const UNTIL_KEYS = ["contact", "dir", "max", "tolerance", "exact"];

/**
 * `model_place {object, until:{contact, dir, max?, tolerance?, exact?}}` (docs/plan-contact-poses.md section 2): drive
 * the part's joint, with its train, until a part it moves first touches `contact` (or any part that stays), by the
 * shared solve (src/contact.ts), and move it there as one Undo step. With `exact` (default), the kernel's common volume
 * of the touching pair is taken at the answer and just past it, and a disagreement with the mesh pass is reported.
 */
async function placeUntil(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const others = ["to", "assembly", "frame", "joint", "angle", "travel", "reach", "gears", "root", "reply", ...PLACE_KEYS];
  if (others.some((key) => input[key] !== undefined)) return refuse("conflicting-arguments", "Give until on its own: it drives the part's joint and sets nothing else.");
  const until = input.until as Record<string, unknown>;
  if (!until || typeof until !== "object" || Array.isArray(until)) return refuse("bad-argument", "until is {contact, dir, max, tolerance, exact}.");
  const extra = Object.keys(until).filter((key) => !UNTIL_KEYS.includes(key));
  if (extra.length) return refuse("bad-argument", `until takes contact, dir, max, tolerance and exact, not ${extra.join(", ")}.`);
  if (typeof until.contact !== "string" || until.contact === "") return refuse("missing-argument", "until needs contact: the part to touch, or any.");
  if (until.dir !== 1 && until.dir !== -1) return refuse("bad-argument", "until needs dir: 1 or -1, the joint's own sense or against it.");
  if (until.max !== undefined && (typeof until.max !== "number" || !Number.isFinite(until.max))) return refuse("bad-argument", "max is a number: degrees for a hinge, mm for a slide.");
  if (until.tolerance !== undefined && (typeof until.tolerance !== "number" || !Number.isFinite(until.tolerance))) return refuse("bad-argument", "tolerance is a number of mm.");
  if (until.exact !== undefined && typeof until.exact !== "boolean") return refuse("bad-argument", "exact is true or false.");
  const assemblies = this.liveAssemblies();
  const base = assemblyOf(assemblies, obj.id);
  if (!base) return refuse("no-assembly", "This part is in no assembly. model_place {to} puts it in one, and {joint} gives it a hinge or a slide.", undefined, NEXT.assembly);
  let against = "any";
  if (until.contact !== "any") {
    const other = this.find(until.contact);
    if (!other) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
    against = other.id;
  }
  const poseOf = (id: string) => this.find(id)?.modelPose;
  const solved = solveAssembly(base, poseOf, this.params).assembly;
  const name = (id: string) => shownName(this.find(id)?.name ?? id);
  const parts = contactParts.call(this, solved);
  // The shared solve a pose at a time, with a turn of the event loop every SWEEP_SLICE_MS: progress goes out, the reply
  // timer can hand the call to a job, and slice_cancel is heard. Nothing has moved yet, so a cancel changes nothing.
  const steps = firstContactSteps(solved, poseOf, parts, {
    object: obj.id, dir: until.dir, against, nameOf: name,
    ...(typeof until.max === "number" ? { max: until.max } : {}),
    ...(typeof until.tolerance === "number" ? { toleranceMm: until.tolerance } : {}),
  });
  const signal = this.callContext.getStore()?.signal;
  const cancelled = (where: string) => refuse("cancelled", `model_place {until} was cancelled ${where}; nothing moved.`);
  let found: Exclude<ReturnType<typeof steps.next>["value"], number>;
  let last = Date.now();
  for (;;) {
    const step = steps.next();
    if (step.done) { found = step.value; break; }
    if (Date.now() - last > SWEEP_SLICE_MS) {
      this.noteStage(`until: ${step.value} poses tried`);
      await eventLoopTurn();
      last = Date.now();
      if (signal?.aborted) return cancelled(`after ${step.value} poses`);
    }
  }
  if ("reason" in found) return refuse("bad-placement", found.reason);
  const unit = found.kind === "hinge" ? "degrees" : "mm";
  const key = found.kind === "hinge" ? "angle" : "travel";
  const r6 = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
  const searched = { from: r6(found.searched.from), to: r6(found.searched.to), ...(found.searched.limit ? { limit: true } : {}) };
  const ignored = found.ignored.length ? { ignored: found.ignored.map((row) => ({ moving: row.moving, other: row.other, names: [name(row.moving), name(row.other)] })) } : {};
  if (!found.contact) {
    const stop = found.searched.limit ? ", where a joint limit stops it" : "";
    return refuse("no-contact", `Nothing is touched turning ${name(found.body)} from ${searched.from} to ${searched.to} ${unit}${stop}. Nothing moved.`, { searched, evaluations: found.evaluations, ...ignored });
  }
  const pair = found.pair!;
  const meshAnswer = found.mesh ?? { value: found.value, past: found.past!, clearanceMm: found.clearanceMm!, pair };
  // The answer to place: the shared solve's (the mesh pass, short of it by the chords on curved faces), or the kernel's.
  let placed = { value: found.value, assembly: found.assembly, angles: found.angles, past: found.past!, pair, clearanceMm: found.clearanceMm!, boundMm: found.boundMm ?? 0, check: "mesh" as "mesh" | "kernel" };
  // The kernel's word on the pair (section 6): at the mesh pass's answer, then backed off until it calls the pair clear
  // or a touch when it finds them crossing, within KERNEL_CALLS checks. Poses are put back after.
  let exact: Record<string, unknown> | undefined;
  if (until.exact !== false) {
    const a = this.find(pair.moving), b = this.find(pair.other);
    const saved = new Map(solved.members.flatMap((row) => { const one = this.find(row.object); return one ? [[one.id, { m: [...one.modelPose.m], t: [...one.modelPose.t] }] as const] : []; }));
    const turnedTo = (value: number) => (value === found.value ? { assembly: found.assembly, angles: found.angles } : trainTurn(solved, found.body, value - found.from));
    const measure = async (value: number): Promise<KernelVerdict | { reason: string }> => {
      const turned = turnedTo(value);
      if ("reason" in turned) return { reason: turned.reason };
      this.writeSolved(turned.assembly, "", false);
      const measured = a && b ? await this.commonVolume(a, b) : { reason: "Part gone." };
      if ("reason" in measured) return { reason: measured.reason };
      const volumeMm3 = Math.round(measured.volumeMm3 * 1000) / 1000;
      return { verdict: measured.volumeMm3 === 0 ? "clear" : exactVerdict(measured.volumeMm3, [measured.volumes[0], measured.volumes[1]]), volumeMm3 };
    };
    const started = Date.now();
    try {
      const kernel = await kernelContact(found, measure);
      if ("reason" in kernel) exact = { atContact: { measured: false, note: kernel.reason } };
      else {
        const past = await measure(meshAnswer.past);
        const backedOff = r6(kernel.backedOff);
        exact = {
          atContact: kernel.at,
          meshAnswer: kernel.meshAnswer,
          past: "reason" in past ? { measured: false, note: past.reason } : past,
          agrees: kernel.meshAnswer.verdict !== "crossing",
          // The kernel placed it when it moved the joint, or confirmed a pose the margin chose; on flat faces it agrees.
          placed: kernel.reached && (found.mesh || kernel.meshAnswer.verdict === "crossing") ? "kernel" : "mesh",
          backedOff: { [unit]: backedOff, travelMm: Math.round(kernel.backedOffMm * 1e4) / 1e4 + 0 },
          kernelCalls: kernel.calls + 1,
          budget: KERNEL_CALLS,
          kernelMs: Date.now() - started,
        };
        if (exact.placed === "kernel" && kernel.value !== found.value) {
          const turned = turnedTo(kernel.value);
          if (!("reason" in turned)) {
            const gap = pairClearance(turned.assembly, poseOf, parts, pair.moving, pair.other);
            placed = { value: kernel.value, assembly: turned.assembly, angles: turned.angles, past: kernel.crossingAt ?? meshAnswer.past, pair, clearanceMm: "reason" in gap ? 0 : gap.mm, boundMm: "reason" in gap ? 0 : gap.boundMm ?? 0, check: "kernel" };
          }
        } else if (exact.placed === "kernel") placed = { ...placed, check: "kernel" };
      }
    } finally {
      for (const [id, pose] of saved) { const one = this.find(id); if (one) one.modelPose = pose as typeof one.modelPose; }
    }
  }
  if (signal?.aborted) return cancelled("after the kernel's check");
  this.remember("Pose");
  this.assemblies = assemblies.map((row) => (row.id === base.id ? placed.assembly : row));
  const moved = this.writeSolved(placed.assembly, "", true);
  this.autosaveDirty = true;
  const mm5 = (value: number) => Math.round(value * 1e5) / 1e5 + 0;
  const clearance = mm5(placed.clearanceMm);
  const value = r6(placed.value);
  const bound = mm5(placed.boundMm);
  const meshPlaced = r6(meshAnswer.value);
  const shortOf = found.mesh ? r6(Math.abs(meshAnswer.value - found.value)) : 0;
  // What the mesh pass alone can say on curved faces: how the pose stands to the facets' own contact.
  const marginNote = placed.check === "kernel" ? ""
    : found.mesh ? ` Curved faces there are meshed to within ${bound} mm of the true faces, so it stopped ${shortOf} ${unit} short of the facets' contact (${meshPlaced}): the true parts cannot overlap, and stand at most ${mm5(clearance + bound)} mm apart.`
    : found.marginKept === false ? ` Curved faces there are meshed to within ${bound} mm of the true faces and the parts already stood that close where it started, so this is the facets' contact: the true parts may overlap by up to ${mm5(Math.max(0, bound - clearance))} mm.`
    : "";
  const verdictOf = (row: unknown) => row as { verdict?: string; volumeMm3?: number; note?: string };
  let exactNote: string;
  if (!exact) exactNote = " The kernel was not asked (exact: false).";
  else if (exact.agrees === undefined) exactNote = ` The kernel could not measure the pair: ${String(verdictOf(exact.atContact).note ?? "")}`;
  else {
    const atMesh = verdictOf(exact.meshAnswer), here = verdictOf(exact.atContact), cost = `${String(exact.kernelCalls)} kernel checks, ${(Number(exact.kernelMs) / 1000).toFixed(1)} s`;
    if (exact.placed === "mesh") exactNote = ` The kernel finds ${String(atMesh.volumeMm3)} mm³ shared at the facets' contact (${meshPlaced}) and found no pose it calls clear within ${KERNEL_CALLS} checks: the pose is the mesh pass's, where the kernel finds ${String(here.volumeMm3)} mm³ (${String(here.verdict)}). ${cost}.`;
    else if (exact.agrees === false) exactNote = ` At the facets' contact (${meshPlaced}) the kernel finds ${String(atMesh.volumeMm3)} mm³ shared (the facets lie inside the true round face), so the joint backed off ${r6(Math.abs(meshAnswer.value - placed.value))} ${unit} (at most ${String((exact.backedOff as { travelMm: number }).travelMm)} mm of travel) to where the kernel finds ${here.verdict === "clear" ? "no shared volume" : `${String(here.volumeMm3)} mm³, a touch`}. The pose is the kernel's, to ${found.toleranceMm} mm of travel; ${cost}.`;
    else if (found.mesh) exactNote = ` The kernel finds ${atMesh.verdict === "clear" ? "no shared volume" : `${String(atMesh.volumeMm3)} mm³, a touch,`} at the facets' contact, so the joint stands there rather than short of it. ${cost}.`;
    else if (verdictOf(exact.past).verdict === "clear") exactNote = " The kernel finds no shared volume at this pose, nor just past it: the facets meet a little before the true surfaces do, within the kernel's chord tolerance.";
    else exactNote = " The kernel finds no shared volume at this pose, and shared volume just past it.";
  }
  const rows = placed.angles.filter((row) => row.object !== found.body);
  const placedPair = placed.pair;
  return {
    ok: true,
    assembly: placed.assembly.name,
    object: obj.id,
    joint: found.body,
    [key]: value,
    contact: { moving: placedPair.moving, other: placedPair.other, names: [name(placedPair.moving), name(placedPair.other)], clearanceMm: clearance, boundMm: bound, toleranceMm: found.toleranceMm, past: r6(placed.past), check: placed.check },
    ...(placed.value !== meshAnswer.value ? { mesh: { [key]: meshPlaced, past: r6(meshAnswer.past), clearanceMm: mm5(meshAnswer.clearanceMm) } } : {}),
    searched,
    evaluations: found.evaluations,
    ...ignored,
    ...(rows.length ? { angles: rows } : {}),
    ...moved,
    ...(exact ? { exact } : {}),
    note: `${name(found.body)} turned to ${value} ${unit}, where ${name(placedPair.moving)} touches ${name(placedPair.other)} with ${clearance} mm left between the meshes (${placed.check === "kernel" ? "placed by the kernel" : `the mesh pass, to ${found.toleranceMm} mm`}).${marginNote}${exactNote} One Undo puts it back.`,
  };
}

/**
 * The mesh pass over `obj`'s assembly. `toleranceMm` is how deep two meshes may overlap and still touch: model_check
 * {interference} gives the kernel's chord; the joint sweep keeps CONTACT_MM, since the exact pass measures what it finds.
 */
function meshInterference(this: Session, obj: PlateObject, toleranceMm = CONTACT_MM): Record<string, unknown> {
  const assembly = assemblyOf(this.liveAssemblies(), obj.id);
  if (!assembly) return refuse("no-assembly", "This part is in no assembly. model_place {to} puts it in one.", undefined, NEXT.assembly);
  const members = assembly.members.flatMap((row) => {
    const part = this.find(row.object);
    if (!part) return [];
    const solid = !!part.solid && part.solid.positions.length >= 9;
    const positions = solid ? part.solid!.positions : part.source;
    return positions.length >= 9 ? [{ part, positions: positions instanceof Float32Array ? positions : new Float32Array(positions), pose: solid ? part.modelPose : thenPose(seatLift(part.seatMm), part.modelPose) }] : [];
  });
  const pairs: Record<string, unknown>[] = [];
  let clear = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i]!;
      const b = members[j]!;
      const result = interference(a, b, { toleranceMm });
      if (result.verdict === "clear") {
        clear += 1;
        continue;
      }
      pairs.push({
        a: a.part.id,
        b: b.part.id,
        names: [shownName(a.part.name), shownName(b.part.name)],
        verdict: result.verdict,
        ...(result.nested ? { nested: true } : {}),
        ...(result.at ? { atMm: result.at.map((v) => Math.round(v * 100) / 100) } : {}),
      });
    }
  }
  const crossing = pairs.filter((row) => row.verdict === "crossing" || row.nested).length;
  return {
    ok: true,
    assembly: assembly.name,
    pass: "mesh",
    toleranceMm,
    pairs,
    clearPairs: clear,
    note: crossing > 0
      ? `${crossing} pair${crossing === 1 ? "" : "s"} share volume by the mesh: the meshes overlap deeper than ${toleranceMm} mm. Nothing is blocked: a press fit is meant to cross.`
      : `No pair shares volume by the mesh. A touch is faces or edges resting on each other, or meshes that overlap no deeper than ${toleranceMm} mm.`,
  };
}

/** The tool shape of a boolean op, for a preview: it is drawn, never applied. */
async function ghostMesh(this: Session, obj: PlateObject, raw: unknown): Promise<Ghost | { reason: string }> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return { reason: tree.reason };
  if (!obj.solid) return { reason: "This solid could not be read." };
  const baked = this.bake(obj, raw);
  if ("reason" in baked) return { reason: baked.reason };
  if (baked.op.kind !== "boolean") return { reason: "A preview needs a boolean op." };
  const spec = baked.op as unknown as PrimitiveSpec;
  const mesh = toolMesh(spec);
  if (mesh.length < 9) return { reason: "That tool shape has no size." };
  return { mesh, touches: disjointBoolean(obj.solid.bounds, spec, baked.op.op) === null };
}

/**
 * `rays: [{point, direction} | {x, y}]` asks many rays of one solid in one call (in the audited sessions surface_at
 * was called 224 times, 194 of them right after another): `hits` has one row per ray, in order, each what a single
 * call answers without `ok` and `frame`; a ray that misses or is not a ray is {hit: false, reason}.
 */
function manyRays(solid: Parameters<typeof surfaceAtSolid>[0], input: Record<string, unknown>, frame: string): Record<string, unknown> | null {
  if (!Array.isArray(input.rays)) return null;
  if (input.point !== undefined || input.direction !== undefined || input.x !== undefined || input.y !== undefined) return refuse("conflicting-arguments", "surface_at takes rays, or one ray as point and direction or x and y, not both.");
  const hits = input.rays.map((ray) => {
    const { ok, ...rest } = surfaceAtSolid(solid, ray && typeof ray === "object" && !Array.isArray(ray) ? ray as Record<string, unknown> : {});
    return ok === false ? { hit: false, ...rest } : rest;
  });
  return { ok: true, frame, hits };
}

async function surfaceAt(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  // --- R-B. A mesh has no solid: the ray meets its triangles where the plate holds them.
  if (this.meshBlock(obj)) {
    const placed = this.placed(obj);
    const mesh = { positions: placed.positions, triangles: new Uint32Array(0), bounds: { min: [...placed.bounds.min], max: [...placed.bounds.max] } } as Parameters<typeof surfaceAtSolid>[0];
    const many = manyRays(mesh, input, "plate");
    if (many) return many;
    const hit = surfaceAtSolid(mesh, input);
    return hit.ok === false ? hit : { ...hit, frame: "plate" };
  }
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (!obj.solid) return refuse("solid-unreadable", "This solid could not be read.");
  // The ray and the hit in the frame ops are typed in, so a cut at the hit point lands on it.
  const view = typedView(obj.solid, typedPoseOf(obj));
  return manyRays(view, input, obj.frame ?? "model") ?? { ...surfaceAtSolid(view, input), frame: obj.frame ?? "model" };
}

/** Gear pairs that include `obj`, from each solid's own gear and its fused gear steps. The volume check is unchanged. */
function gearPairs(objects: readonly PlateObject[], objectId: string) {
  const gears = objects.flatMap((part) => (part.tree ? gearsInTree(part.tree, part.modelPose, part.id, shownName(part.name)) : []));
  return gearPairRows(gears, objectId);
}

async function modelCheck(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await modelCheckBody.call(this, obj, input);
  // A sweep answers about its hinge; the gear pairs ride only on the other checks' replies.
  if (reply.ok !== true || input.sweep !== undefined) return reply;
  const gears = gearPairs(this.objects, obj.id);
  return gears.length > 0 ? { ...reply, gears } : reply;
}

async function modelCheckBody(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (input.sweep !== undefined) {
    if (input.interference === true) return refuse("conflicting-arguments", "Sweep a joint or check interference, not both.");
    const spec = input.sweep as Record<string, unknown>;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return refuse("bad-argument", "sweep is {from, to, step}, angles in degrees.");
    return this.jointSweep(obj, spec);
  }
  if (input.interference === true) return this.interferenceCheck(obj, input.exact === true, input.crossingsOnly === true);
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (!obj.solid || obj.solid.positions.length < 9) return refuse("solid-unreadable", "This solid could not be read.");
  const printer = this.printer();
  const base = checkReply(obj.solid.positions, obj.orient, obj.scale, { name: printer.name, bedMm: [printer.bedX, printer.bedY, printer.bedZ], nozzleMm: this.library.nozzleMm, belt: printer.kind === "belt" ? printer.belt : null }, input, obj.solid.triangles);
  if (input.surfaces !== true || base.ok !== true) return base;
  // surfaces was asked: when it cannot be given, the reply says why instead of answering as a plain check.
  const notInspected = (why: string) => ({ ...base, surfaces: `Not inspected: ${why}` });
  if (!obj.tree) return notInspected("this part has no solid history, only a mesh, so there are no surfaces to read.");
  const raw = await this.treeCall({
    call: "surfaceInspect",
    key: obj.tree.key,
    node: obj.tree.current,
    chordMm: CHORD,
    curvature: false,
    isoparms: false,
  }, "check");
  const decoded = decodeSurfaceInspect(raw);
  if (typeof decoded === "string") return notInspected(`the modeler could not read this part's surfaces (${decoded}).`);
  const warnings = Array.isArray(base.warnings) ? [...(base.warnings as string[])] : [];
  if (decoded.continuity.gaps > 0) {
    warnings.push(`${decoded.continuity.gaps} shared edge${decoded.continuity.gaps === 1 ? "" : "s"} have a surface gap (max ${decoded.continuity.maxGapMm.toFixed(3)} mm).`);
  }
  const minWall = typeof input.minWallMm === "number" && input.minWallMm > 0 ? input.minWallMm : this.library.nozzleMm * 2;
  if (decoded.surfaceHealth.minRadiusMm !== undefined && decoded.surfaceHealth.minRadiusMm < minWall) {
    warnings.push(`Tightest surface bend radius is ${decoded.surfaceHealth.minRadiusMm.toFixed(2)} mm (face ${decoded.surfaceHealth.tightestFace ?? "?"}), tighter than ${minWall.toFixed(2)} mm: Shell or thick offsets may self-intersect.`);
  }
  return {
    ...base,
    continuity: listedContinuity(decoded.continuity),
    surfaceHealth: decoded.surfaceHealth,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** A probe, and what the edit would do to the solid when the modeler sent the result back. */
async function probeMeasured(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  this.lastPreview = null;
  const out = await this.probe(obj, input.op, input.node, true);
  if (out.ok !== true || !obj.solid) return out;
  const op = out.stored as ModelOp | undefined;
  const before = solidMetrics(obj.solid);
  const lastPreview = this.lastPreview;
  let after: SolidMetrics | null = null;
  if (op?.kind === "scale") {
    const f = op.factor;
    const box = obj.solid.bounds;
    after = { volumeMm3: before.volumeMm3 * f ** 3, bbox: { min: box.min.map((v) => v * f) as [number, number, number], max: box.max.map((v) => v * f) as [number, number, number] }, shellCount: before.shellCount };
  } else if (lastPreview) {
    after = solidMetrics(lastPreview);
  }
  if (input.node !== undefined && this.nodeOf(obj, input.node) !== obj.tree?.current) return out;
  // model_apply judges the built step with the step guard; the probe has the same result in hand, so it says the same.
  const guarded = op && lastPreview && op.kind !== "group" ? stepGuard(op, obj.solid, lastPreview, typedPoseOf(obj)) : null;
  if (guarded) return { ...out, ok: false, code: "step-guard", ...guarded };
  const measured = probeMetrics(before, after);
  return { ...out, ...(measured.warning ? { reason: `${String(out.reason)} ${measured.warning}`, warning: measured.warning } : {}), metrics: measured.metrics };
}

function model(this: Session, name: string, input: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
  if (name === "model_place" && Array.isArray(input.objects)) return this.modelPlaceMany(input);
  const requested = typeof input.object === "string" ? input.object : "";
  // --- Split to print (D12). An export target's piece is off the plate and still a part to model.
  const obj = this.find(requested !== "" ? requested : this.selected) ?? this.piecesOffPlate.find((row) => row.id === requested && this.exportCut(row) !== null) ?? null;
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  const tool = Object.hasOwn(MODEL_TOOLS, name) ? MODEL_TOOLS[name] : undefined;
  if (!tool) throw new ProtocolError(`There is no tool named ${name}.`);
  return tool(this, obj, input);
}

/** The most one section call may take, whatever the modeler's timeout: about 5 s a plane on a 680 mm imported part. */
const SECTION_BUDGET_MS = 30_000;

/**
 * How long one modeler call may run before the server kills the modeler, which closes every open tree. --- 3.1 F9.
 * It is longer than the engine's own 60 s limit on a new step, which stops a slow boolean or blend cleanly with a
 * refusal: at 30 s the server killed first, and a 3,000-face join came back as treeLost instead of a sentence.
 */
function modelTimeoutMs(this: Session): number {
  const raw = Number(process.env.LIME_MCP_MODEL_TIMEOUT_S);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : 90;
  return seconds * 1000;
}

/** The steps from the root to `node`, a group's counted one by one: what a goto there may replay. */
function stepsTo(this: Session, tree: ModelTree, node: number): number {
  return pathTo(tree, node).reduce((sum, id) => {
    const op = tree.nodes.get(id)?.op;
    return sum + (op ? 1 : 0) + (op?.kind === "group" ? op.steps.length : 0);
  }, 0);
}

/** A call that replays `steps` steps (a group's count as many): two seconds each, at least the one-call limit. */
function replayBudgetMs(this: Session, steps: number): number {
  return Math.max(this.modelTimeoutMs(), steps * 2000);
}

function runawayMessage(this: Session, kind: string, budgetMs: number): string {
  const seconds = Math.max(1, Math.round(budgetMs / 1000));
  if (kind === "preview") return `This mesh did not finish opening in ${seconds} s. Nothing changed.`;
  if (kind === "section") return `This section did not finish in ${seconds} s, so it was stopped. A plane cut is quick on a sound solid, so this one is likely damaged: model_check lists edges where pieces meet only along a line and walls too thin to print. Undo the step that made them.`;
  const name = kind === "fillet" || kind === "chamfer" ? kind : "edit";
  return `This ${name} did not finish in ${seconds} s. Nothing changed. Try a smaller size or fewer edges.`;
}

/** --- R-C. The sentence for a call whose kernel process ended under it. */
function crashMessage(this: Session, kind: string, why: string): string {
  if (kind === "preview") return `This mesh stopped the kernel while opening (${why}). Nothing changed.`;
  if (kind === "loft") return `The loft stopped the kernel (${why}). Nothing changed. Make it in shorter pieces: at most 4 sections each, each piece starting at the section the last one ended on.`;
  if (kind === "shell") return `The shell stopped the kernel (${why}). Nothing changed. To hollow a loft, cut an inner loft instead.`;
  const name = kind === "open" ? "history" : kind;
  return `This ${name} stopped the kernel (${why}). Nothing changed. Try a smaller size or fewer pieces.`;
}

/**
 * A native call on a worker. The timer runs on this thread, so a blocked call can be cut off.
 * `onRunaway` replaces the stuck worker; by default that is the modeler, which drops the open trees.
 */
async function withBudget<T>(this: Session, kind: string, work: () => T | Promise<T>, onRunaway: () => Promise<void> = () => this.loseTrees(), budgetMs?: number): Promise<T> {
  const budget = budgetMs ?? this.modelTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rss: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new ModelRunaway(this.runawayMessage(kind, budget))), budget);
      const cap = Number(process.env.LIME_MCP_MODEL_RSS_MB);
      if (Number.isFinite(cap) && cap > 0) {
        rss = setInterval(() => {
          if (process.memoryUsage().rss / (1024 * 1024) > cap) reject(new ModelRunaway(this.runawayMessage(kind, budget)));
        }, 1000);
      }
      Promise.resolve(work()).then(
        resolve,
        (err: unknown) => reject(err instanceof Error ? err : new ProtocolError("The modeler did not answer.")),
      );
    });
  } catch (err) {
    if (err instanceof ModelRunaway) {
      await onRunaway();
      throw err;
    }
    // --- R-C. The process under the call ended (a kernel crash, a stack overflow, its memory cap). It is a refusal,
    // as a runaway is: the open trees are dropped and built again on next use, and the step never happened.
    if (err instanceof EngineStopped) {
      await onRunaway();
      throw new ModelRunaway(this.crashMessage(kind, err.why), true);
    }
    throw new ProtocolError(err instanceof Error ? err.message : "The modeler did not answer.");
  } finally {
    if (timer) clearTimeout(timer);
    if (rss) clearInterval(rss);
  }
}

/** A timed-out mesh preview is replaced. The modeler and its open trees are left alone. */
async function resetPreview(this: Session): Promise<void> {
  try {
    await this.ask(this.engine.resetPreview?.());
  } catch {
    // The next preview starts a fresh worker either way.
  }
}

/** A timed-out modeler is replaced. Open trees are dropped; the last committed bytes stay. */
async function loseTrees(this: Session): Promise<void> {
  try {
    await this.ask(this.engine.resetModeler());
  } catch {
    // The next model call starts a fresh modeler either way.
  }
  // Each history stays; its tree is built again from the root and ops when it is next used. A piece's tree, which
  // starts from another tree's split, reopens from its plate bytes as before.
  for (const obj of [...this.objects, ...this.toolsOffPlate, ...this.piecesOffPlate]) {
    obj.probes = new Map();
    if (obj.tree && obj.tree.root.kind !== "piece") obj.treeStale = true;
    else {
      obj.tree = null;
      obj.solid = null;
    }
  }
}

function lostReply(this: Session, err: unknown): Record<string, unknown> | null {
  if (!(err instanceof ModelRunaway)) return null;
  return refuse("model-runaway", err.message, { treeLost: true, treeNote: `${err.crashed ? "The modeler stopped" : "The modeler did not answer, so it was restarted"}, which closed every open history in it. Nothing applied is lost: each history is built again from its first solid and its steps on its next use, which takes a while on a long one.` });
}

async function treeCall(this: Session, body: Record<string, unknown>, label = "edit", budgetMs?: number): Promise<Record<string, unknown>> {
  const op = body.op && typeof body.op === "object" ? body.op as { kind?: unknown } : null;
  const kind = typeof op?.kind === "string" ? op.kind : label;
  // A profiled recipe run asks the bridge for its own kernel timing (mesh-end.ts); any other call is sent as it was.
  const tap = this.kernelTap;
  const sent = tap ? JSON.stringify({ timing: true, ...body }) : JSON.stringify(body);
  const started = tap ? performance.now() : 0;
  const text = await this.withBudget(kind, () => this.engine.modelTree(sent), undefined, budgetMs);
  const waited = tap ? performance.now() - started : 0;
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProtocolError("The modeler returned a damaged reply.");
  }
  if (tap) noteTreeCall(tap, waited, reply);
  const error = typeof reply.error === "string" ? reply.error : "";
  if (error.includes("was not found") || error.includes("Could not load the Open CASCADE bridge")) {
    throw new ProtocolError(occtHint(error));
  }
  return reply;
}

/**
 * The plate's step's saved solid, for a whole tree to build from instead of replaying every step above it: only one in
 * the binary format, which is that step exactly. The engine refuses one that is not the step, and replays instead.
 */
function seedOf(this: Session, obj: PlateObject, tree: ModelTree): { node: NodeId; bytes: Uint8Array } | null {
  const node = obj.platedNode;
  if (!obj.brep || !isBrep(obj.brep) || node === null || node === 0 || !tree.nodes.has(node)) return null;
  return { node, bytes: obj.brep };
}

/** STEP bytes the bridge returns. A missing `bytesBase64` is a failed export. */
function stepBytes(this: Session, reply: Record<string, unknown>): Uint8Array | null {
  if (typeof reply.bytesBase64 !== "string" || reply.bytesBase64 === "") return null;
  const bytes = base64ToBytes(reply.bytesBase64);
  if (!bytes || bytes.byteLength === 0) return null;
  if (typeof reply.byteLength === "number" && reply.byteLength !== bytes.byteLength) return null;
  return bytes;
}

async function ensureTree(this: Session, obj: PlateObject, depth = 0): Promise<ModelTree> {
  if (obj.tree && obj.treeStale) {
    const rebuilt = await this.rebuildStale(obj, depth);
    if (rebuilt) return rebuilt;
    // A history that will not build again falls back to what it did before a restart kept histories: the plate's
    // STEP or mesh, opened as a new root.
    obj.tree = null;
    obj.solid = null;
    obj.treeStale = false;
    if (obj.bytes.byteLength === 0 && !obj.brep) throw new ProtocolError("The modeler was restarted and this solid's history did not build again. It was never committed, so nothing is left to open.");
  }
  if (obj.tree) return obj.tree;
  const key = `mcp-${obj.id}`;
  const source = obj.brep ?? obj.bytes;
  const bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  const root = { kind: "step" as const, name: obj.brep ? stepFileName(obj.fileName) : obj.fileName, bytes };
  const reply = await this.treeCall(openRequest(key, root, CHORD));
  const error = typeof reply.error === "string" ? reply.error : "";
  if (error) throw new ProtocolError(plainModelError(error));
  obj.tree = newTree(key, root, obj.name, null);
  obj.solid = solidView(reply);
  return obj.tree;
}

/**
 * A history the restarted modeler lost, built again at its current step: the tools its joins name first, then the
 * whole tree, with a budget for every step in it. Null when it does not build.
 */
async function rebuildStale(this: Session, obj: PlateObject, depth: number): Promise<ModelTree | null> {
  const tree = obj.tree;
  if (!tree || tree.root.kind === "piece" || depth > 8) return null;
  for (const node of tree.nodes.values()) {
    if (node.op?.kind !== "join") continue;
    const tool = this.byTreeKey(node.op.tool.key);
    if (tool && tool !== obj && tool.treeStale) {
      try {
        await this.ensureTree(tool, depth + 1);
      } catch {
        return null;
      }
    }
  }
  // --- A9. The same step count as an open: groups are one node but many kernel steps. ---
  const budget = Math.max(this.modelTimeoutMs(), modelSteps(tree) * 2000);
  let reply: Record<string, unknown>;
  try {
    reply = await this.treeCall(wholeTreeRequest(tree, tree.root, tree.current, obj.stepTolerance || CHORD, { seed: this.seedOf(obj, tree) }), "open", budget);
  } catch (err) {
    if (err instanceof ModelRunaway) return null;
    throw err;
  }
  if (typeof reply.error === "string" && reply.error) return null;
  obj.treeStale = false;
  const solid = solidView(reply);
  if (solid) obj.solid = solid;
  return tree;
}

/** `solid_new` says `kind` for a fastener. Stored JSON and a boolean say `partKind`, because `kind` is the op tag. */
function fastenerArgs(input: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | Refusal {
  if (input.primitive !== "part") return { ok: true, args: input };
  const named = input.kind;
  const stored = input.partKind;
  if (typeof named === "string" && typeof stored === "string" && named !== stored) return refuse("conflicting-arguments", "Give kind or partKind, not two different ones.");
  const next = { ...input };
  if (typeof named === "string" && stored === undefined) next.partKind = named;
  delete next.kind;
  return { ok: true, args: next };
}

/**
 * --- Organic surfaces S6. A part whose root is a surface: `solid_new {feature}` with a nurbsSurface or a sheet op, as
 * the app's NURBS tool makes one (src/app/model/create.ts createFeatureSolid: an `open` of a feature root). A model_apply
 * of either kind needs a part that is not a closed solid, and a sheet op on a solid keeps the solid's faces, so this is
 * the way to start from a surface. The feature is baked as model_apply bakes it, in the part's own frame.
 */
async function featureSolidNew(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (input.primitive !== undefined || input.gear !== undefined || input.coupon !== undefined || input.kind !== undefined) {
    return refuse("conflicting-arguments", "Give a feature or a primitive, gear, part or coupon, not both.");
  }
  const feature = input.feature as Record<string, unknown>;
  if (feature.kind !== "nurbsSurface" && feature.kind !== "sheet") {
    return refuse("bad-op", "solid_new's feature is a nurbsSurface or a sheet. Start other parts from a primitive.");
  }
  const problem = organicFirstProblem(feature, "feature") ?? validate(OP_SCHEMA, feature, "feature") ?? organicProblem(feature, "feature") ?? nurbsSurfaceProblem(feature, "feature");
  if (problem) return refuse("bad-op", problem);
  const ctx = { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "A part that starts from a surface has no faces to pick yet." }) }) as never, nodeOf: () => null, hasNode: () => false };
  const baked = bakeOp(feature, ctx);
  if ("reason" in baked) return refusePartReason(baked.reason, "bad-op");
  if (!isFeatureOp(baked.op)) return refuse("bad-op", "solid_new's feature is a nurbsSurface or a sheet.");
  this.seq += 1;
  const id = `obj_${this.seq}`;
  const key = `mcp-${id}`;
  const root = { kind: "feature" as const, op: baked.op };
  const reply = await this.treeCall(openRequest(key, root, CHORD));
  const error = typeof reply.error === "string" ? reply.error : "";
  if (error) return refuse("kernel-refused", plainModelError(error, "create"));
  const name = this.givenName(input.name) ?? featureObjectName(this.objects.map((row) => row.name), baked.op.kind);
  const obj: PlateObject = {
    id,
    name,
    fileName: `${baked.op.kind}.step`,
    bytes: new Uint8Array(),
    source: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    triangles: 1,
    orient: [...ID_MATRIX],
    scale: 1,
    centered: true,
    offset: { x: 0, y: 0, z: 0 },
    seatMm: 0,
    stepTolerance: STEP,
    modelPose: IDENTITY_POSE,
    workplane: GLOBAL_WORKPLANE,
    tree: newTree(key, root, name, null),
    solid: solidView(reply),
    probes: new Map(),
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    reinforcement: [],
    objectSettings: {},
    platedNode: null,
  };
  this.objects.push(obj);
  this.selected = obj.id;
  const open = Array.isArray(reply.nakedEdges) ? reply.nakedEdges.length : 0;
  return {
    ok: true,
    object: obj.id,
    fingerprint: obj.solid?.fingerprint ?? null,
    bounds: obj.solid?.bounds ?? null,
    frame: "part",
    root: baked.op.kind,
    ...(open > 0 ? { openEdges: open, note: "An open sheet: thicken it or sew it shut before it can be printed." } : {}),
  };
}

async function solidNew(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (input.feature !== undefined) return this.featureSolidNew(input);
  // A gear: the gear op's fields (guide {kind:"gear"}), its base on Z = 0, centred on its axis.
  const gear = input.gear && typeof input.gear === "object" ? (input.gear as Record<string, unknown>) : null;
  if (gear && input.primitive !== undefined) return refuse("bad-argument", "Give a primitive or a gear, not both.");
  const prepared = fastenerArgs(input);
  if (!prepared.ok) return prepared;
  const typed = gear ? primitiveFrom({ ...gear, primitive: "gear", origin: [0, 0, 0], turn: [0, 0, 0] }, "gear") : primitiveFrom(prepared.args);
  if ("reason" in typed) return refusePartReason(typed.reason, "bad-argument");
  const gearWhy = gear ? gearRefusal(gearOf(typed)!, typed.height) : null;
  if (gearWhy) return refuse("bad-argument", gearWhy);
  const kind = typed.primitive;
  const spec = rootSpec(typed);
  this.seq += 1;
  const id = `obj_${this.seq}`;
  const key = `mcp-${id}`;
  // A part's model_describe box is the mesh box. 0.01 mm keeps that box within 0.02 mm of the analytic solid.
  const chord = kind === "part" ? 0.01 : CHORD;
  const reply = await this.treeCall(newSolidRequest(key, typed, chord));
  const error = typeof reply.error === "string" ? reply.error : "";
  if (error) return refuse("kernel-refused", plainModelError(error, "create"));
  const obj: PlateObject = {
    id,
    name: this.givenName(input.name) ?? kind,
    fileName: `${kind}.step`,
    bytes: new Uint8Array(),
    source: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    triangles: 1,
    orient: [...ID_MATRIX],
    scale: 1,
    centered: true,
    offset: { x: 0, y: 0, z: 0 },
    seatMm: 0,
    stepTolerance: kind === "part" ? 0.01 : STEP,
    modelPose: IDENTITY_POSE,
    workplane: GLOBAL_WORKPLANE,
    tree: newTree(key, { kind: "primitive", solid: spec }, kind, null),
    solid: solidView(reply),
    probes: new Map(),
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    reinforcement: [],
    objectSettings: {},
    platedNode: null,
  };
  this.objects.push(obj);
  this.selected = obj.id;
  return { ok: true, object: obj.id, fingerprint: obj.solid?.fingerprint ?? null, bounds: obj.solid?.bounds ?? null, frame: "part" };
}

/** A mesh has no solid to edit. A STEP file and a new solid do. */
function meshBlock(this: Session, obj: PlateObject): string | null {
  if (obj.tree || obj.brep) return null;
  const name = obj.fileName.toLowerCase();
  if (name.endsWith(".step") || name.endsWith(".stp")) return null;
  return MESH_EDIT;
}

async function opened(this: Session, obj: PlateObject): Promise<ModelTree | { reason: string }> {
  const blocked = this.meshBlock(obj);
  if (blocked) return { reason: blocked };
  return this.ensureTree(obj);
}

async function describe(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  const solid = obj.solid;
  if (!solid) return refuse("solid-unreadable", "This solid could not be read.");
  const stale = this.staleTransitions(obj, tree);
  return describeReply(solid, input, obj.frame ?? "model", stale.length > 0 ? { notes: stale.map((row) => row.note), staleTransitions: stale.map(({ note: _note, ...row }) => row) } : {}, typedPoseOf(obj));
}

/**
 * --- Print transitions (plan section 3, decision 5). The steps on the shown branch made for another pose: their stored
 * build direction is more than 1° from the one this pose on the plate's printer gives. The solid keeps them as built.
 */
function staleTransitions(this: Session, obj: PlateObject, tree: ModelTree): { node: string; label: string; offDeg: number; note: string }[] {
  const printer = this.printer();
  const pose = { orient: obj.orient, belt: printer.kind === "belt" ? printer.belt : null };
  return pathTo(tree, tree.current).flatMap((id) => {
    const step = tree.nodes.get(id);
    if (step?.op?.kind !== "transition") return [];
    const off = transitionStaleBy(step.op, pose);
    if (off == null) return [];
    const label = step.name ?? step.label;
    const node = nodeHandle(id);
    const turn = pose.belt ? " On the belt, even a turn about the plate's Z changes the layers." : "";
    return [{ node, label, offDeg: Math.round(off * 10) / 10, note: `${node}, "${label}", was made for another pose: its build direction is ${formatMm(Math.round(off * 10) / 10)}° from this pose's on the ${printer.name}.${turn} The solid keeps it as built. To re-aim it, model_probe and model_edit its op with build:null at ${node}; to keep it, leave it.` }];
  });
}

async function facesFind(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (!obj.solid) return refuse("solid-unreadable", "This solid could not be read.");
  return facesReply(obj.solid, input, this.expandContext(obj), typedPoseOf(obj), obj.frame ?? "model");
}

/**
 * section (I5–I7, R-B): a flat face's outline inset by insetMm, or the part cut by planes, as loops in each plane's
 * frame with the extrude origin and turn that draw in it. A solid is read exactly from the kernel; a mesh is cut by its
 * triangles where the plate holds them.
 */
async function sectionTool(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const chordMm = typeof input.chordMm === "number" ? input.chordMm : 0.05;
  // --- saveAs: the answer goes to the workspace as recipe data (data {name}), and the reply only counts it, so a
  // mesh's measured sections never pass through the model. A recipe reads section's answer directly instead.
  const saveAs = typeof input.saveAs === "string" ? input.saveAs : undefined;
  if (saveAs !== undefined && this.recipeDepth > 0) return refuse("conflicting-arguments", "A recipe reads section's answer directly; saveAs is for a call from the chat.");
  const answer = (sections: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const points = sections.reduce((sum, section) => sum + pointsIn(section), 0);
    if (saveAs !== undefined) {
      const saved = writeRecipeData(saveAs, { object: obj.id, ...extra, sections });
      if ("reason" in saved) return refuse("bad-argument", saved.reason);
      const areas = sections.map((section) => section.areaMm2);
      return { ok: true, object: obj.id, ...extra, saved: saveAs, ...saved, sections: sections.length, points, ...(areas.length <= 50 ? { areasMm2: areas } : {}) };
    }
    if (points > MAX_SECTION_POINTS) return refuse("out-of-range", `This answer would hold ${points} points, over ${MAX_SECTION_POINTS}. Cut fewer planes, pass resample, or a larger chordMm, or pass saveAs to keep it as recipe data.`);
    return { ok: true, object: obj.id, ...extra, sections };
  };
  const cuts = input.face === undefined ? cutPlanes(input) : null;
  if (cuts && "reason" in cuts) return refuse("bad-argument", cuts.reason);
  if (input.face !== undefined && ["planes", "fan", "levels"].some((key) => input[key] !== undefined)) return refuse("conflicting-arguments", "Give a face or planes, not both.");
  if (this.meshBlock(obj)) {
    if (!cuts) return refuse("mesh-not-solid", "A mesh has no faces to outline. Cut it with planes, fan, or levels.");
    const positions = this.placed(obj).positions;
    const options = { ...(typeof input.resample === "number" ? { resample: input.resample } : {}), ...(typeof input.startAngleDeg === "number" ? { startAngleDeg: input.startAngleDeg } : {}) };
    return answer(cuts.map((cut) => meshSection(positions, cut, options)), { frame: "plate" });
  }
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (!obj.solid) return refuse("solid-unreadable", "This solid could not be read.");
  // A plane cut of a damaged solid has kept Open CASCADE busy for more than 25 minutes, inside a build that never
  // looks at the kernel's own 20 s deadline. Whatever the modeler's timeout, a section gets SECTION_BUDGET_MS.
  const budget = Math.min(this.modelTimeoutMs(), SECTION_BUDGET_MS);
  let cut: Awaited<ReturnType<typeof solidSections>>;
  try {
    cut = await solidSections(input, chordMm, cuts, typedPoseOf(obj), this.expandContext(obj), (request) => this.treeCall({ ...request, key: tree.key, node: tree.current }, "section", budget));
  } catch (err) {
    const lost = this.lostReply(err);
    if (lost) return lost;
    throw err;
  }
  if ("reason" in cut) return refuse("bad-argument", cut.reason);
  return answer(cut.sections, cut.extra);
}

/** --- API 1.2. What a recipe's pick reads: any part's faces, sections and sketches (the person named them), and recipe data. */
function pickReads(this: Session, ctx: CallMeta): PickReads {
  return {
    faces: async (id) => {
      const obj = this.find(id);
      if (!obj) return { reason: UNKNOWN_OBJECT };
      if (this.meshBlock(obj)) return { reason: "a mesh has no faces to pick." };
      const tree = await this.opened(obj);
      if ("reason" in tree) return tree;
      return obj.solid ?? { reason: "This solid could not be read." };
    },
    section: (id, args) => this.runCall("section", { ...args, object: id }, ctx, true),
    pose: (id) => {
      const obj = this.find(id);
      return obj ? typedPoseOf(obj) : IDENTITY_POSE;
    },
    sketch: (id, step) => {
      const obj = this.find(id);
      if (!obj?.tree) return { reason: `${id} is not a part with a history.` };
      return sketchOutline(obj.tree, step, typedPoseOf(obj));
    },
    data: async (name) => {
      const found = recipeDataFile(name);
      if (!found) return { reason: recipeDataMissing(name) };
      return found;
    },
  };
}

async function edgesFind(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (!obj.solid) return refuse("solid-unreadable", "This solid could not be read.");
  return edgesReply(obj.solid, input, (filter) => this.onFaceIndex(obj, filter), typedPoseOf(obj), obj.frame ?? "model");
}

/** An edge filter whose onFace is a face selector {normal, withinDeg, nearPoint}, with that face's index in its place. */
function onFaceIndexMethod(this: Session, obj: PlateObject, filter: Record<string, unknown>): Record<string, unknown> | string {
  return onFaceIndex(filter, this.bakeContext(obj));
}

/**
 * --- D24. A frame is typed and answered in model space, and kept in the part's own frame, as the app and the file keep
 * it, so it moves with the part when model_place moves the part.
 */
async function workplaneSet(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const source = input.source === "global" || input.source === "bed" || input.source === "face" ? input.source : "face";
  const origin = Array.isArray(input.origin) && input.origin.length >= 3 ? input.origin.slice(0, 3) as [number, number, number] : null;
  const turn = Array.isArray(input.turn) && input.turn.length >= 3 ? input.turn.slice(0, 3) as [number, number, number] : null;
  const answer = () => {
    const plane = this.typedPlane(obj);
    return { ok: true, source: plane.source, origin: plane.origin, turn: plane.turn };
  };
  const typed = this.pendingTexts[0] as { origin?: unknown; turn?: unknown } | undefined;
  this.pendingTexts = [];
  delete obj.workplaneTyped;
  if (origin && turn && origin.every((value) => typeof value === "number") && turn.every((value) => typeof value === "number")) {
    obj.workplane = workplaneOwn({ source, origin, turn }, typedPoseOf(obj));
    const text = { origin: typed?.origin, turn: typed?.turn };
    if (exprLeaves({ origin, turn }, text, this.followsParameters).length > 0) obj.workplaneTyped = { source, origin: [...origin], turn: [...turn], text };
    return answer();
  }
  if (source === "global") {
    obj.workplane = { ...GLOBAL_WORKPLANE };
    return answer();
  }
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (source === "bed") {
    // Under the middle of the part as it stands, W up in model space.
    const box = obj.solid ? (isIdentity(typedPoseOf(obj)) ? obj.solid.bounds : boundsOf(featureSolidInModel(obj.solid, typedPoseOf(obj)).positions)) : { min: [0, 0, 0], max: [0, 0, 0] };
    obj.workplane = workplaneOwn(workplaneOnBed(box), typedPoseOf(obj));
    return answer();
  }
  const faceIndex = Number(input.faceIndex);
  const face = obj.solid?.faces[faceIndex];
  if (!face) return refuse("face-not-found", "That face is not on this solid.", undefined, NEXT.faces);
  if (!face.normal || !obj.solid) return refuse("curved-face", CURVED_FACE);
  const plane = facePlane(obj.solid.positions, obj.solid.triangles, faceIndex, face.normal);
  if (!plane) return refuse("curved-face", CURVED_FACE);
  obj.workplane = workplaneOnFace(plane);
  return answer();
}

function printUp(this: Session, obj: PlateObject): Record<string, unknown> {
  if (isGlobalFrame(obj.workplane)) return refuse("bad-frame", "Pick a face before pointing it up.");
  this.remember("Point up");
  const frame = eulerOrient(obj.workplane.turn[0], obj.workplane.turn[1], obj.workplane.turn[2]);
  obj.orient = [frame[0], frame[3], frame[6], frame[1], frame[4], frame[7], frame[2], frame[5], frame[8]];
  this.relink();
  return { ok: true, reslice: true, label: "Point up" };
}

/** The methods this module adds to Session. */
export const modelMethods = {
  interferenceCheck,
  jointSweep,
  placeUntil,
  commonVolume,
  meshInterference,
  ghostMesh,
  surfaceAt,
  modelCheck,
  probeMeasured,
  model,
  modelTimeoutMs,
  stepsTo,
  replayBudgetMs,
  runawayMessage,
  crashMessage,
  withBudget,
  resetPreview,
  loseTrees,
  lostReply,
  treeCall,
  seedOf,
  stepBytes,
  ensureTree,
  rebuildStale,
  solidNew,
  featureSolidNew,
  meshBlock,
  opened,
  describe,
  staleTransitions,
  facesFind,
  sectionTool,
  pickReads,
  edgesFind,
  onFaceIndex: onFaceIndexMethod,
  workplaneSet,
  printUp,
};

export const modelHandlers: Record<string, ToolHandler> = {
  assembly_merge: (s, input) => s.assemblyMerge(input),
  solid_new: (s, input) => input.coupon !== undefined && input.feature === undefined ? s.fitCouponNew(input) : s.solidNew(input),
  model_build: (s, input) => s.build(input),
  model_params: (s, input) => input.rebuild === true ? s.paramsRebuild(input) : s.paramsTool(input),
  model_define: (s, input) => s.defineTool(input),
};
