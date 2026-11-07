/**
 * The Model dispatch: tool table by object, the modeler's budget and trees, solid_new, and the reads on a solid.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { base64ToBytes } from "../../src/base64.ts";
import { plainModelError } from "../../src/app/model-error.ts";
import { ID_MATRIX } from "../../src/mesh-place.ts";
import { disjointBoolean } from "../../src/model-feasibility.ts";
import { facePlane, formatMm } from "../../src/model-plane.ts";
import { rootSpec, type PrimitiveSpec } from "../../src/model-primitive.ts";
import { isBrep, newSolidRequest, openRequest, wholeTreeRequest } from "../../src/model-request.ts";
import { boundsOf, solidSections, describeReply, edgesReply, facesReply, nodeHandle, solidView } from "../../src/modeling/model-calls.ts";
import { onFaceIndex } from "../../src/modeling/bake.ts";
import { checkReply } from "../../src/modeling/part-reads.ts";
import { exprLeaves } from "../../src/modeling/links.ts";
import { IDENTITY_POSE, isIdentity, posedBounds, seatLift, thenPose, typedPoseOf } from "../../src/model-space.ts";
import { newTree, pathTo, type ModelOp, type ModelTree, type NodeId } from "../../src/model-tree.ts";
import { sketchOutline, type PickReads } from "../../src/recipe/picks.ts";
import { transitionStaleBy } from "../../src/model-transition.ts";
import { CURVED_FACE, GLOBAL_WORKPLANE, workplaneOwn, isGlobalFrame, workplaneOnBed, workplaneOnFace } from "../../src/workplane.ts";
import { cutPlanes, MAX_SECTION_POINTS, meshSection, pointsIn } from "../sections.ts";
import { eulerOrient } from "../../src/mesh-place.ts";
import { EngineStopped, occtHint, ProtocolError } from "../engine.ts";
import { recipeDataFile, recipeDataMissing, writeRecipeData } from "../recipe.ts";
import { probeMetrics, solidMetrics, surfaceAt as surfaceAtSolid, toolMesh, type SolidMetrics } from "../inspect.ts";
import { primitiveFrom } from "../../src/modeling/compose.ts";
import { typedView } from "../../src/modeling/typed-view.ts";
import { exactVerdict, interference, SLIVER_MM3 } from "../../src/interference.ts";
import { assemblyOf } from "../../src/assembly.ts";
import { featureSolidInModel } from "../../src/model-features.ts";
import { CHORD, type CallMeta, type Ghost, MESH_EDIT, ModelRunaway, type ObjectToolHandler, type PlateObject, STEP, type ToolHandler, UNKNOWN_OBJECT, modelSteps, shownName, stepFileName } from "./shared.ts";
import type { Session } from "../session.ts";
import { NEXT, refuse } from "../refusals.ts";

const MODEL_TOOLS: Record<string, ObjectToolHandler> = {
  model_describe: (s, obj, input) => s.describe(obj, input),
  faces_find: (s, obj, input) => s.facesFind(obj, input),
  edges_find: (s, obj, input) => s.edgesFind(obj, input),
  workplane_set: (s, obj, input) => s.workplaneSet(obj, input),
  workplane_print_up: (s, obj) => s.printUp(obj),
  model_place: (s, obj, input) => s.modelPlace(obj, input),
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
  model_edit: (s, obj, input) => s.edit(obj, s.nodeOf(obj, input.node), input.op),
  model_drop: (s, obj, input) => s.drop(obj, s.nodeOf(obj, input.node)),
  model_rename: (s, obj, input) => s.rename(obj, s.nodeOf(obj, input.node), String(input.label ?? "")),
  model_commit: (s, obj) => s.commit(obj),
  model_export_step: (s, obj, input) => {
    if (input.pieces === true && input.assembly === true) return refuse("conflicting-arguments", "Export the pieces or the assembly, not both.");
    if (input.assembly === true) return s.exportAssemblyStep(obj, String(input.name));
    return input.pieces === true ? s.exportPieceStep(obj, String(input.name)) : s.exportStep(obj, String(input.name));
  },
  measure: (s, obj, input) => s.measure(obj, input),
};

/**
 * --- Assemblies M6. Every pair of parts in `obj`'s assembly, at their assembled poses: the mesh pass's answer, clear,
 * touch or crossing, and nested for a part wholly inside another. Pairs that are clear are counted, not listed.
 */
async function interferenceCheck(this: Session, obj: PlateObject, exact: boolean, crossingsOnly = false): Promise<Record<string, unknown>> {
  const cheap = this.meshInterference(obj);
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

function meshInterference(this: Session, obj: PlateObject): Record<string, unknown> {
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
      const result = interference(a, b);
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
    pairs,
    clearPairs: clear,
    note: crossing > 0
      ? `${crossing} pair${crossing === 1 ? "" : "s"} share volume by the mesh. Nothing is blocked: a press fit is meant to cross.`
      : "No pair shares volume by the mesh. A touch is faces or edges resting on each other.",
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

async function surfaceAt(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  // --- R-B. A mesh has no solid: the ray meets its triangles where the plate holds them.
  if (this.meshBlock(obj)) {
    const placed = this.placed(obj);
    const hit = surfaceAtSolid({ positions: placed.positions, triangles: new Uint32Array(0), bounds: { min: [...placed.bounds.min], max: [...placed.bounds.max] } }, input);
    return hit.ok === false ? hit : { ...hit, frame: "plate" };
  }
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (!obj.solid) return refuse("solid-unreadable", "This solid could not be read.");
  // The ray and the hit in the frame ops are typed in, so a cut at the hit point lands on it.
  return { ...surfaceAtSolid(typedView(obj.solid, typedPoseOf(obj)), input), frame: obj.frame ?? "model" };
}

async function modelCheck(this: Session, obj: PlateObject, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (input.interference === true) return this.interferenceCheck(obj, input.exact === true, input.crossingsOnly === true);
  const tree = await this.opened(obj);
  if ("reason" in tree) return refuse("model-unavailable", tree.reason);
  if (!obj.solid || obj.solid.positions.length < 9) return refuse("solid-unreadable", "This solid could not be read.");
  const printer = this.printer();
  return checkReply(obj.solid.positions, obj.orient, obj.scale, { name: printer.name, bedMm: [printer.bedX, printer.bedY, printer.bedZ], nozzleMm: this.library.nozzleMm }, input);
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
  const measured = probeMetrics(before, after);
  return { ...out, ...(measured.warning ? { reason: `${String(out.reason)} ${measured.warning}`, warning: measured.warning } : {}), metrics: measured.metrics };
}

function model(this: Session, name: string, input: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
  const requested = typeof input.object === "string" ? input.object : "";
  // --- Split to print (D12). An export target's piece is off the plate and still a part to model.
  const obj = this.find(requested !== "" ? requested : this.selected) ?? this.piecesOffPlate.find((row) => row.id === requested && this.exportCut(row) !== null) ?? null;
  if (!obj) return refuse("no-object", UNKNOWN_OBJECT, undefined, NEXT.plate);
  const tool = Object.hasOwn(MODEL_TOOLS, name) ? MODEL_TOOLS[name] : undefined;
  if (!tool) throw new ProtocolError(`There is no tool named ${name}.`);
  return tool(this, obj, input);
}

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
  const text = await this.withBudget(kind, () => this.engine.modelTree(JSON.stringify(body)), undefined, budgetMs);
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProtocolError("The modeler returned a damaged reply.");
  }
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

async function solidNew(this: Session, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const typed = primitiveFrom(input);
  if ("reason" in typed) return refuse("bad-argument", typed.reason);
  const kind = typed.primitive;
  const spec = rootSpec(typed);
  this.seq += 1;
  const id = `obj_${this.seq}`;
  const key = `mcp-${id}`;
  const reply = await this.treeCall(newSolidRequest(key, typed, CHORD));
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
    stepTolerance: STEP,
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
  const cut = await solidSections(input, chordMm, cuts, typedPoseOf(obj), this.expandContext(obj), (request) => this.treeCall({ ...request, key: tree.key, node: tree.current }, "section"));
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
  return { ok: true, reslice: true, label: "Point up" };
}

/** The methods this module adds to Session. */
export const modelMethods = {
  interferenceCheck,
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
  solid_new: (s, input) => input.coupon !== undefined ? s.fitCouponNew(input) : s.solidNew(input),
  model_build: (s, input) => s.build(input),
  model_params: (s, input) => input.rebuild === true ? s.paramsRebuild(input) : s.paramsTool(input),
  model_define: (s, input) => s.defineTool(input),
};
