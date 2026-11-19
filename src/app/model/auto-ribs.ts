/**
 * --- Auto ribs: the card's side in the app (src/ui/auto-ribs-card.ts). The solid as the view draws it, the wall read
 * and the print check in a worker (src/auto-ribs-worker.ts), the plan source (./auto-ribs-source.ts), and Apply: the
 * plan's `ribNet` expanded as composite-apply's runCombined expands it, built as one group (one History row, undone as
 * one), and the outside checked by rays after; a network that changed the outside is taken back with Undo.
 */
import { applyPose, inversePose, toSolidOp, turnDir, type Affine } from "../../model-space";
import { buildDirection } from "../../belt";
import { posedContext } from "../../model-features";
import { printFrame } from "../../model-check";
import { ribNetPlan, ribNetVerify } from "../../modeling/rib-net.ts";
import { meshToModel } from "../../plate";
import { AUTO_RIBS_LABEL, cardFromRibNet, ribNetSource, type CheckNumbers } from "../../auto-ribs.ts";
import type { AutoRibsJob, AutoRibsJobBody, AutoRibsReply } from "../../auto-ribs-worker.ts";
import type { GroupOp, ModelOp } from "../../model-tree";
import type { NotOnWall, RibWall, RibWallOptions } from "../../modeling/rib-wall.ts";
import type { V3 } from "../../auto-ribs-plan.ts";
import { mountAutoRibsCard, openAutoRibsEdit } from "../../ui/auto-ribs-card.ts";

import { fx } from "../fx";
import { livePlate } from "../files";
import { loadMachineLibrary } from "../machine-library.ts";
import { state } from "../state";
import { S } from "./shared";
import { applyOp } from "./apply";
import { cancelEdit } from "./edit";
import { readout } from "./pick";
import { runEdit } from "./run-edit";
import { setMode, step } from "./tree";
import { inView, openPose, posePoints, viewed } from "./view";
import { openObject } from "./workplane";
import { planSource } from "./auto-ribs-source";
import { remapFaces, ribCardFor } from "../../modeling/auto-ribs.ts";
import { beltStamp, cardsOf, selection } from "../../ui/machine-library.ts";
import { buildStudyBody, faceTriangles, surfaceResult } from "../../sim/bridge-body.ts";
import { solveStudy } from "../../sim/desktop-solve.ts";
import { beltLayerNormal, type ObjectStudy, type StudyHold, type StudyLoad } from "../../sim/study.ts";
import type { MaterialCard } from "../../sim/cards.ts";
import { isTauri } from "../../platform.ts";
import { stressSliceRequest } from "../stress-slice.ts";
import { stressMesh } from "./view";

/** The pressure the check puts on the wall when no load is given, MPa, and its cell: as ribs_apply's verify. */
const CHECK_PRESSURE = 0.01;
const CHECK_CELL_MM = 2;

/** The card the shell model uses for the selected filament (shared with ribs_plan), as the panel needs it. */
function materialCard(): { card: MaterialCard; note: string } | null {
  const library = loadMachineLibrary();
  const cards = cardsOf(library);
  const fallback = cards.find((card) => card.id === "inhouse-petg") ?? cards[0];
  if (!fallback) return null;
  const filament = selection(library)?.filament;
  const chosen = ribCardFor(cards, { name: filament?.name ?? "this filament", material: filament?.material ?? "" }, fallback);
  return { card: chosen.card, note: chosen.row.note };
}

/** The part as it was before the last Apply, for the Stress check: its study mesh and its faces. */
let beforeApply: { mesh: ReturnType<typeof stressMesh>; positions: ArrayLike<number>; faceOf: ArrayLike<number> } | null = null;

/**
 * Check with Stress: the sliced study of the whole part before and after the ribs, as ribs_apply's verify runs it,
 * through the desktop's existing `sim_study` (the Stress panel's solve). Holds are the user's, else the faces the wall
 * joins; loads the user's, else an even pressure on the wall. Faces are found again on the ribbed part by where they lay.
 */
type StressNumbers = { maxDisplacementMm: number; minSafetyFactor: number | null };

async function stressCheck(setup: { holds: StudyHold[]; loads: StudyLoad[]; wallFaces: number[]; joinedFaces: number[]; cases?: { name: string; loads: StudyLoad[] }[] }, progress: (text: string) => void): Promise<{ before: StressNumbers; after: StressNumbers } | { cases: { name: string; before: StressNumbers; after: StressNumbers }[] } | { reason: string }> {
  const after = viewed();
  if (!beforeApply || !after) return { reason: "Apply the ribs first: the check compares the part before and after." };
  const material = materialCard();
  if (!material) return { reason: "No material card is in the library." };
  const holds: StudyHold[] = setup.holds.length ? setup.holds : setup.joinedFaces.length ? [{ kind: "faces", faces: setup.joinedFaces }] : [];
  if (holds.length === 0) return { reason: "The check needs a hold: the wall is joined to nothing. Give one under Hold and load." };
  const belt = beltStamp(loadMachineLibrary());
  const again = (faces: number[]) => (faces.length ? remapFaces({ positions: beforeApply!.positions, faceOf: beforeApply!.faceOf }, faces, { positions: after.positions, faceOf: after.triangles }) : faces);
  const solve = async (mesh: ReturnType<typeof stressMesh>, which: ObjectStudy) => {
    if (mesh && "reason" in mesh) return { reason: mesh.reason };
    const request = stressSliceRequest(undefined, mesh ?? undefined);
    if (!request) return { reason: "Load a mesh first." };
    const body = buildStudyBody({ request, study: which, card: material.card, triangles: (faces) => (mesh?.triangles ? faceTriangles(mesh.positions, mesh.triangles, faces) : []), checkResolution: false });
    if (typeof body !== "string") return body;
    const parsed = surfaceResult(await solveStudy(body), "displacement");
    if ("error" in parsed) return { reason: parsed.error };
    return { maxDisplacementMm: parsed.maxDisplacementMm ?? 0, minSafetyFactor: parsed.minSafetyFactor ?? null };
  };
  const pair = async (loads: StudyLoad[], beforeText: string, afterText: string) => {
    const study: ObjectStudy = { holds, loads, cardId: material.card.id, printer: true, buildAxis: belt ? beltLayerNormal(belt.angleDeg) : [0, 0, 1], gravity: false, edgeMm: CHECK_CELL_MM };
    const ribbed: ObjectStudy = { ...study, holds: study.holds.map((hold) => ({ ...hold, faces: again(hold.faces) })), loads: study.loads.map((load) => ({ ...load, faces: again(load.faces) })) };
    progress(beforeText);
    const one = await solve(beforeApply!.mesh, study);
    if ("reason" in one) return one;
    progress(afterText);
    const two = await solve(stressMesh(), ribbed);
    if ("reason" in two) return two;
    return { before: one, after: two };
  };
  if (setup.cases && setup.cases.length >= 2) {
    const reported: { name: string; before: StressNumbers; after: StressNumbers }[] = [];
    const total = setup.cases.length * 2;
    for (const [i, row] of setup.cases.entries()) {
      const loads = row.loads.length ? row.loads : [{ kind: "pressure" as const, faces: setup.wallFaces, magnitude: CHECK_PRESSURE, direction: [0, 0, -1] as [number, number, number] }];
      const done = await pair(loads, `Slicing and solving ${row.name}, the part as it was… (${i * 2 + 1} of ${total})`, `Slicing and solving ${row.name}, the ribbed part… (${i * 2 + 2} of ${total})`);
      if ("reason" in done) return done;
      reported.push({ name: row.name, before: done.before, after: done.after });
    }
    return { cases: reported };
  }
  const loads: StudyLoad[] = setup.loads.length ? setup.loads : [{ kind: "pressure", faces: setup.wallFaces, magnitude: CHECK_PRESSURE, direction: [0, 0, -1] }];
  return pair(loads, "Slicing and solving the part as it was… (1 of 2)", "Slicing and solving the ribbed part… (2 of 2)");
}

let worker: Worker | null = null;
let serial = 0;
const waiting = new Map<number, (reply: AutoRibsReply) => void>();

function ribsWorker(): Worker {
  if (worker) return worker;
  const made = new Worker(new URL("../../auto-ribs-worker.ts", import.meta.url), { type: "module" });
  made.onmessage = (ev: MessageEvent<AutoRibsReply>) => {
    const done = waiting.get(ev.data.id);
    waiting.delete(ev.data.id);
    done?.(ev.data);
  };
  made.onerror = (ev) => {
    ev.preventDefault();
    if (worker === made) worker = null;
    made.terminate();
    const reason = ev.message || "the worker failed";
    for (const [id, done] of waiting) done(id % 2 === 0 ? { id, kind: "wall", wall: { reason: `The wall could not be read: ${reason}.` } } : { id, kind: "check", check: { overhangMm2: 0, overhang: [], thinMm2: 0, thin: [] } });
    waiting.clear();
  };
  worker = made;
  return made;
}

function ask(job: AutoRibsJobBody, transfer: Transferable[]): Promise<AutoRibsReply> {
  const id = ++serial;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    ribsWorker().postMessage({ ...job, id } as AutoRibsJob, transfer);
  });
}

/** The solid on screen in the panel's frame (as the view draws it), memoised per solid and pose. */
let posed: { solid: object; pose: string; positions: Float32Array; faceOf: Uint32Array } | null = null;

function panelSolid() {
  const solid = viewed();
  if (!solid || !S.open || solid.positions.length < 9) return null;
  const pose = openPose();
  const key = JSON.stringify(pose);
  if (posed?.solid !== solid || posed.pose !== key) posed = { solid, pose: key, positions: Float32Array.from(posePoints(solid.positions, pose)), faceOf: Uint32Array.from(solid.triangles) };
  return { positions: posed.positions, faceOf: posed.faceOf, volumeMm3: solid.volumeMm3, key: `${S.open.key}:${solid.id}:${key}` };
}

function posedArray(positions: ArrayLike<number>, pose: Affine): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) out.set(applyPose(pose, [positions[i]!, positions[i + 1]!, positions[i + 2]!]), i);
  return out;
}

function printer() {
  return selection(loadMachineLibrary())?.printer ?? null;
}

/** The print check of the solid on screen, its regions in the panel's frame. */
async function checkNow(): Promise<CheckNumbers | null> {
  const solid = viewed();
  const obj = openObject();
  if (!solid || solid.positions.length < 9) return null;
  const orient = obj?.orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const print = printFrame(solid.positions instanceof Float32Array ? solid.positions : Float32Array.from(solid.positions), orient, 1);
  const p = printer();
  const belt = p?.kind === "belt" ? { angleDeg: p.belt.angleDeg, widthMm: p.belt.widthMm, maxLengthMm: p.belt.maxLengthMm } : null;
  const reply = await ask({ kind: "check", positions: print.positions, minWallMm: Math.max(0.1, 2 * (state.profile.nozzleDiameter || 0.4)), buildMm: [state.profile.bedX, state.profile.bedY, state.profile.bedZ], belt }, [print.positions.buffer]);
  if (reply.kind !== "check") return null;
  const back = (box: { min: V3; max: V3 }): { min: V3; max: V3 } => {
    const corners: V3[] = [];
    for (let k = 0; k < 8; k += 1) {
      const p0: V3 = [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]];
      corners.push(applyPose(openPose(), applyPose(print.toSource, p0)));
    }
    const min = [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i]!))) as V3;
    const max = [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i]!))) as V3;
    return { min, max };
  };
  const c = reply.check;
  return { overhangMm2: c.overhangMm2, overhang: c.overhang.map((row) => ({ ...back(row), areaMm2: row.areaMm2 })), thinMm2: c.thinMm2, thin: c.thin.map((row) => ({ ...back(row), areaMm2: row.areaMm2 })) };
}

/** The group the card's Apply builds, while an edit replays it. */
let pending: GroupOp | null = null;

export function autoRibsPendingOp(): ModelOp | null {
  return pending;
}

async function applyNet(raw: Record<string, unknown>): Promise<{ ok: true; beforeMm3: number; afterMm3: number } | { ok: false; reason: string }> {
  const at = S.open;
  const solid = viewed();
  if (!at || !solid) return { ok: false, reason: "No solid is open." };
  const pose = openPose();
  const surface = posedContext(solid, pose).surface?.() ?? null;
  const net = ribNetPlan(raw, surface);
  if ("reason" in net) return { ok: false, reason: net.reason };
  const steps = net.steps.map((one) => toSolid(one as unknown as ModelOp, pose));
  const group: GroupOp = { kind: "group", label: AUTO_RIBS_LABEL, source: JSON.parse(JSON.stringify(raw)) as unknown, steps, combine: "fuse" };
  const before = solid;
  const beforeMm3 = solid.volumeMm3;
  beforeApply = { mesh: stressMesh(), positions: solid.positions, faceOf: solid.triangles };
  pending = group;
  try {
    if (S.editing) await runEdit(S.editing);
    else await applyOp(group, `Adding ${Array.isArray(raw.paths) ? raw.paths.length : 0} rib runs as one step…`);
  } finally {
    pending = null;
  }
  const after = viewed();
  if (!after || after === before || S.editing) return { ok: false, reason: S.readoutText || "The ribs did not build." };
  const broke = ribNetVerify(net, posedArray(after.positions, openPose()));
  if (broke) {
    await step("undo");
    return { ok: false, reason: broke };
  }
  return { ok: true, beforeMm3, afterMm3: after.volumeMm3 };
}

/** A model-space step into the solid's frame, as runCombined stores a ribNet's steps. */
const toSolid = (op: ModelOp, pose: Affine): ModelOp => toSolidOp(op, pose);

export function bindAutoRibs() {
  mountAutoRibsCard({
    state() {
      const solid = viewed();
      if (!S.open || !solid || S.lens && !S.editing) return "none";
      return solid.editable ? "ok" : "surfaces";
    },
    solid: panelSolid,
    toSolid(positions) {
      const back = inversePose(openPose());
      return posedArray(positions, back);
    },
    ray(x, y) {
      const ray = fx.model?.pointerRay(x, y);
      return ray ? { origin: ray.origin as V3, direction: ray.direction as V3 } : null;
    },
    faceAt: (x, y) => fx.model?.pickSolid(x, y)?.face ?? null,
    densityGCm3: () => state.profile.filamentDensityGCm3 || 1.24,
    nozzleMm: () => state.profile.nozzleDiameter || 0.4,
    printerName: () => printer()?.name ?? "this printer",
    build() {
      const p = printer();
      const obj = openObject();
      const own = buildDirection(obj?.orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], p?.kind === "belt" ? p.belt : null);
      return turnDir(openPose(), own);
    },
    stress() {
      const sim = openObject()?.sim;
      return sim ? { holds: sim.holds, loads: sim.loads } : null;
    },
    others() {
      const own = S.open?.objectId;
      return livePlate().filter((obj) => obj.id !== own).map((obj) => ({ id: obj.id, name: obj.name }));
    },
    obstacle(id) {
      const obj = livePlate().find((row) => row.id === id && row.id !== S.open?.objectId);
      return obj ? posedArray(obj.sourcePos, inView(meshToModel(obj))) : null;
    },
    async readWall(options: RibWallOptions): Promise<RibWall | { reason: string; missed?: NotOnWall[] }> {
      const solid = panelSolid();
      if (!solid) return { reason: "No solid is open." };
      const positions = new Float32Array(solid.positions);
      const faceOf = new Uint32Array(solid.faceOf);
      const reply = await ask({ kind: "wall", positions, faceOf, options }, [positions.buffer, faceOf.buffer]);
      return reply.kind === "wall" ? reply.wall : { reason: "The wall could not be read." };
    },
    check: checkNow,
    apply: applyNet,
    material() {
      const chosen = materialCard();
      return chosen ? { e: chosen.card.EInPlaneMPa, nu: chosen.card.nu, note: chosen.note } : null;
    },
    // The desktop's sim_study runs the check; a page under test may answer it (`__limeSimStudy`). A browser has neither.
    stressAvailable: () => isTauri() || typeof (globalThis as { __limeSimStudy?: unknown }).__limeSimStudy === "function",
    stressCheck,
    source: planSource,
    readout,
    // The edit closed without Apply: the view goes back to the step shown before it, as other cards' edits do.
    cancelled: cancelEdit,
    pickFaces() {
      setMode("face");
    },
  });
}

/** The pencil on a rib network row: the card opens with the step's own request, or empty for a typed network. */
export function startAutoRibsEdit(op: ModelOp, head: string): boolean {
  const source = ribNetSource(op);
  if (!source) return false;
  openAutoRibsEdit(cardFromRibNet(source), head);
  return true;
}
