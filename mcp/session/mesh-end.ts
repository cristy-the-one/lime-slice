/**
 * recipe_run's kernel timing (`profile: true`) and meshing once at the end (`meshAtEnd: true`, or `s.mesh_at_end()`).
 *
 * The timing: each tree call of a profiled run puts `timing` first in its body, and the bridge answers with `kernelUs`,
 * the microseconds it spent in booleans, volume integration, meshing, reading the mesh out and measuring faces, taken
 * from the kernel's own counters (`crates/lime-model-occt/src/lib.rs`). `treeCall` hands each answer to the run's
 * `KernelTap`, which keeps it per recipe call and in total. A bridge that does not know `timing` simply leaves it out,
 * and the profile then says only how long the engine took.
 *
 * The mesh: a plain model_apply (a boolean with a primitive, or an extrude with its own plane) of such a run asks the
 * engine for no mesh, and the part keeps a solid with its volume, fingerprint and box and no faces (`lightSolid`). Any
 * other call of the run, and the end of the run, first asks for the mesh of every part still without one
 * (`ensureMeshes`: a `goto` of its step, which meshes the solid the step already holds). The final solid and mesh are
 * the ones a run with the mesh on every step ends with; the checks that read a step's mesh (two pieces meeting only
 * along an edge) are not made on a step that skipped it.
 *
 * These are plain functions of the session, not methods, so the recipe path touches them in few places.
 */
import { gotoRequest } from "../../src/model-request.ts";
import { opBox, unionBox } from "../../src/modeling/anchors.ts";
import { solidView, type SolidView } from "../../src/modeling/model-calls.ts";
import type { ModelOp } from "../../src/model-tree.ts";
import { CHORD } from "./shared.ts";
import type { Session } from "../session.ts";

/** What one tree call spent in the bridge, in microseconds, as `kernelUs` reports it. */
export interface KernelUs {
  us: number;
  booleanUs: number;
  volumeUs: number;
  meshUs: number;
  readoutUs: number;
  describeUs: number;
  builds: number;
  meshes: number;
}

/** The engine time of some tree calls: the wall time around each, and the bridge's own part when it reported it. */
export interface KernelSink {
  /** Tree calls made. */
  requests: number;
  /** How many of them came back with `kernelUs`. */
  timed: number;
  /** Milliseconds from asking the engine to having its answer, the worker's hop included. */
  engineMs: number;
  /** The bridge's own counters, summed. */
  kernel: KernelUs;
}

export interface KernelTap {
  /** The recipe call being served, if any: the tree calls it makes add here as well as to `all`. */
  current: KernelSink | null;
  all: KernelSink;
}

export function newKernelUs(): KernelUs {
  return { us: 0, booleanUs: 0, volumeUs: 0, meshUs: 0, readoutUs: 0, describeUs: 0, builds: 0, meshes: 0 };
}

export function newSink(): KernelSink {
  return { requests: 0, timed: 0, engineMs: 0, kernel: newKernelUs() };
}

export function newTap(): KernelTap {
  return { current: null, all: newSink() };
}

/** `into` plus `more`. */
export function addSink(into: KernelSink, more: KernelSink): void {
  into.requests += more.requests;
  into.timed += more.timed;
  into.engineMs += more.engineMs;
  for (const key of Object.keys(into.kernel) as (keyof KernelUs)[]) into.kernel[key] += more.kernel[key];
}

/** Notes one tree call: its wall time, and the bridge's `kernelUs` when the reply carried it (which is then removed from the reply). */
export function noteTreeCall(tap: KernelTap, ms: number, reply: Record<string, unknown>): void {
  const sinks = tap.current ? [tap.all, tap.current] : [tap.all];
  const raw = reply.kernelUs;
  delete reply.kernelUs;
  const kernel = raw && typeof raw === "object" ? raw as Partial<Record<keyof KernelUs, unknown>> : null;
  for (const sink of sinks) {
    sink.requests += 1;
    sink.engineMs += ms;
    if (!kernel || typeof kernel.us !== "number") continue;
    sink.timed += 1;
    for (const key of Object.keys(sink.kernel) as (keyof KernelUs)[]) {
      const value = kernel[key];
      if (typeof value === "number" && Number.isFinite(value)) sink.kernel[key] += value;
    }
  }
}

const ms = (value: number) => Math.round(value * 10) / 10;
const fromUs = (value: number) => ms(value / 1000);

/** A sink's kernel part as the profile shows it, in milliseconds. Absent when no tree call came back with timing. */
export function kernelRow(sink: KernelSink): Record<string, number> | undefined {
  if (sink.requests === 0) return undefined;
  const k = sink.kernel;
  const row: Record<string, number> = { engineMs: ms(sink.engineMs), requests: sink.requests };
  if (sink.timed === 0) return row;
  const counted = k.booleanUs + k.volumeUs + k.meshUs + k.readoutUs + k.describeUs;
  return {
    ...row,
    kernelMs: fromUs(k.us),
    booleanMs: fromUs(k.booleanUs),
    volumeMs: fromUs(k.volumeUs),
    meshMs: fromUs(k.meshUs),
    readoutMs: fromUs(k.readoutUs),
    describeMs: fromUs(k.describeUs),
    otherMs: fromUs(Math.max(0, k.us - counted)),
    booleans: k.builds,
    meshes: k.meshes,
  };
}

/**
 * Where the run's time went, in milliseconds, in parts that add up to `runMs` (to a tenth of a millisecond each):
 * the recipe's own code and its start (`recipeMs`: the run less its calls), the host's work in the calls (`hostMs`:
 * the session's checks, baking and reading of replies, and the pipe to the recipe), the hop to the engine and back
 * (`engineHopMs`), and in the kernel the booleans, the meshing (building the mesh and reading it out), and the rest
 * (`kernelOtherMs`: volume integration, measuring faces and edges, building the tools and the history store). Without
 * the kernel's timing the kernel parts are left out and the engine's whole time is `engineMs`.
 */
export function splitOf(runMs: number, callsMs: number, all: KernelSink): Record<string, number> {
  const recipeMs = Math.max(0, runMs - callsMs);
  if (all.timed === 0) {
    const engine = Math.min(all.engineMs, callsMs);
    return { recipeMs: ms(recipeMs), hostMs: ms(callsMs - engine), engineMs: ms(engine) };
  }
  const k = all.kernel;
  const engineMs = Math.min(all.engineMs, callsMs);
  // The bridge's clock and ours are two clocks: should its time come out over the engine's, the kernel's parts shrink
  // alike, so the parts still add up.
  const fit = k.us / 1000 > engineMs && k.us > 0 ? engineMs / (k.us / 1000) : 1;
  const kernelMs = (k.us / 1000) * fit;
  const boolean = (k.booleanUs / 1000) * fit;
  const mesh = ((k.meshUs + k.readoutUs) / 1000) * fit;
  return {
    recipeMs: ms(recipeMs),
    hostMs: ms(callsMs - engineMs),
    engineHopMs: ms(engineMs - kernelMs),
    kernelBooleanMs: ms(boolean),
    kernelMeshMs: ms(mesh),
    kernelOtherMs: ms(Math.max(0, kernelMs - boolean - mesh)),
  };
}

// --- Mesh at the end -------------------------------------------------------------------------------------------------

/** The fields a deferred step's op may carry: a primitive's sizes and place, or an extrude's profile and its plane. Any other field may read a face. */
const PLAIN_FIELDS = new Set([
  "kind", "op", "primitive", "origin", "centre", "turn", "radius", "innerRadius", "topRadius", "height", "dx", "dy", "dz",
  "sides", "across", "flats", "profile", "loops", "depth", "symmetric", "label", "smooth", "corners",
]);

/** Whether a recipe's call is a plain model_apply that reads no face of the part, so the part may go on without a mesh. */
export function skipsMesh(tool: string, args: Record<string, unknown>): boolean {
  if (tool !== "model_apply") return false;
  const op = args.op;
  if (!op || typeof op !== "object" || Array.isArray(op)) return false;
  for (const key of Object.keys(args)) if (key !== "object" && key !== "op" && key !== "probe") return false;
  const fields = op as Record<string, unknown>;
  if (fields.kind !== "boolean" && fields.kind !== "extrude") return false;
  if (fields.kind === "boolean" && typeof fields.primitive !== "string") return false;
  if (fields.op !== "fuse" && fields.op !== "cut" && fields.op !== "common") return false;
  return Object.keys(fields).every((key) => PLAIN_FIELDS.has(key));
}

/**
 * A solid with its volume, fingerprint and box, from an apply that asked for no mesh. Measuring the box from the geometry
 * costs about what the mesh saves, so it is the box the part had, grown by a fuse's tool (`opBox`): never smaller than the
 * part, and the part's own while only cuts follow. It stands in for the mesh's box in the check that a tool misses the part
 * (a miss that would be refused only by a box that a cut has since shrunk is not refused, and the kernel builds it).
 * Null when there is no box to grow, or the reply is not the light one: the caller meshes.
 */
export function lightSolid(reply: Record<string, unknown>, prior: SolidView | null, op: ModelOp): SolidView | null {
  const fingerprint = reply.fingerprint as SolidView["fingerprint"];
  if (reply.format !== "lime-solid-lite" || !fingerprint || !prior) return null;
  const tool = op.kind === "boolean" || op.kind === "extrude" ? (op.op === "fuse" ? opBox(op) : prior.bounds) : null;
  const grown = tool ? unionBox(prior.bounds, tool) : null;
  if (!grown) return null;
  return {
    id: typeof reply.id === "number" ? reply.id : 0,
    volumeMm3: fingerprint.volumeMm3,
    editable: prior.editable,
    fingerprint,
    positions: new Float32Array(0),
    triangles: new Uint32Array(0),
    faces: [],
    edges: [],
    lines: [],
    bounds: { min: [...grown.min] as [number, number, number], max: [...grown.max] as [number, number, number] },
  };
}

/** The mesh of every part whose newest step has none yet: a `goto` of that step. A sentence when the engine would not. */
export async function ensureMeshes(session: Session): Promise<string | null> {
  for (const [id, node] of [...session.meshPending]) {
    session.meshPending.delete(id);
    const obj = session.find(id);
    const tree = obj?.tree;
    if (!obj || !tree || obj.treeStale || tree.current !== node) continue;
    let reply: Record<string, unknown>;
    try {
      reply = await session.treeCall(gotoRequest(tree.key, node, CHORD), "edit");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (typeof reply.error === "string" && reply.error) return reply.error;
    const solid = solidView(reply);
    if (!solid) return "The part's mesh could not be read.";
    obj.solid = solid;
  }
  return null;
}
