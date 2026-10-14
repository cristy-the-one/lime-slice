import { bytesToBase64 } from "../base64";
import { encodeStl, settle } from "../mesh-place";
import type { ModelPick, ModelSolid } from "../model-view";
import { holeAxis, lastFace, outwardFromMesh, selectedEdges } from "../model-blend";
import { nextModelPicks, selectionCountLabel } from "../model-select";
import { contextParts } from "../model-context";
import { PROBE_WAIT_MS, isProbed, probeFromBody, probeKey, type ProbeView } from "../model-feasibility";
import { formatMm, splitPlaneInside, splitPlaneRange, zExtent } from "../model-plane";
import { closeModelTool, mountModelChrome, openModelTool, refreshModelGhost, setModelProbe, syncModelChrome, syncModelSolid } from "../ui/model-chrome";
import { addedSplit, meshTokenOf, shareMeshToken, withBrepFor, withoutObject } from "../plate";
import { base64ToBytes } from "../project";
import { authHeaders } from "../ui/api-base";
import { livePlate, place } from "./files";
import {
  beginModelVisit,
  cancelEdit,
  editUndoCount,
  endModelVisit,
  flushEdit,
  markModelEdit,
  noteEdit,
  patchEditBrep,
  redoUserEdit,
  undoUserEdit,
} from "./history";
import { fx } from "./fx";
import { modelerFailure, plainModelError } from "./model-error";
import { applySelectedToState, syncPlateFromState } from "./plate-sync";
import { apiBase, apiToken, isStepName } from "./settings";
import { state } from "./state";

let ticket = 0;
let picks: ModelPick[] = [];
let busy = false;
let probeSerial = 0;
let probeTimer = 0;
let pendingProbe: (() => void) | null = null;
/** The solid in the view. */
let open: Opened | null = null;
/** Every solid the engine session holds, by plate object: the opened file's object and each piece a split added. */
const opened = new Map<string, Opened>();
/** Mesh tokens whose plate objects already carry that solid's STEP, so nothing has to be written for them. */
const stepKnown = new Set<string>();
/** Kernel answers by `probeKey`. */
const answers = new Map<string, ProbeView>();
/** Engine calls that read or replace a held shape run one at a time, so an answer or a STEP always names the shape it came from. */
let engineQueue: Promise<unknown> = Promise.resolve();

interface ParsedSolid extends ModelSolid {
  faces: { id: number; areaMm2: number; normal?: [number, number, number] }[];
}

/** One solid the engine session holds for a plate object, and its Model undo history. */
interface Opened {
  objectId: string;
  solid: ParsedSolid;
  /** `meshTokenOf` the plate mesh that is this solid's current shape. */
  mesh: string;
  undos: ModelUndo[];
  redos: ModelUndo[];
  /** The pre-edit snap that redo pushes back onto `undos`. */
  redoBefore: ModelUndo[];
  /** True when that undo also stepped the Prepare history. */
  redoBacked: boolean[];
  /** Prepare undo-stack length after each solid edit, so undo can tell if that step is still on top. */
  modelMarks: number[];
}

type SupportEdits = typeof state.supportEdits;
type SupportPaint = typeof state.supportPaint;
type SeamPaint = typeof state.seamPaint;
type Reinforcement = typeof state.reinforcement;

interface ModelUndo {
  meshName: string;
  bytes: ArrayBuffer;
  sourcePos: Float32Array;
  supportEdits: SupportEdits;
  supportPaint: SupportPaint;
  seamPaint: SeamPaint;
  reinforcement: Reinforcement;
  partScale: number;
  brep: ArrayBuffer | null;
  addedId: string | null;
}

export function bindModelView() {
  fx.model?.onPick((pick: ModelPick | null, shift: boolean) => void onPick(pick, shift));
  document.querySelector("#modelPickFace")?.addEventListener("click", () => setMode("face"));
  document.querySelector("#modelPickEdge")?.addEventListener("click", () => setMode("edge"));
  document.querySelector("#modelApply")?.addEventListener("click", () => void applyTool());
  document.querySelector("#modelStep")?.addEventListener("click", () => void runExport());
  document.querySelector("#modelUndo")?.addEventListener("click", () => void runUndo());
  document.querySelector("#modelRedo")?.addEventListener("click", () => void runRedo());
  mountModelChrome({
    clearSelection() {
      picks = [];
      fx.model?.highlight([]);
      syncModelChrome([]);
      if (open) readout(`Volume ${mm(open.solid.volumeMm3)} mm³. Pick a face or an edge.`);
    },
    solidZ() {
      return zExtent(open?.solid.positions ?? null);
    },
    paramsChanged(typed) {
      scheduleProbe(typed ? PROBE_WAIT_MS : 0);
    },
    probeNow() {
      if (!pendingProbe) return;
      window.clearTimeout(probeTimer);
      sendPending();
    },
    solidBox() {
      return open ? boxOf(open.solid.positions) : null;
    },
    edgePoints(edge) {
      return open?.solid.edges.find((item) => item.id === edge)?.points ?? null;
    },
    holeAxis() {
      return drillAxis();
    },
  });
}

function inOrder<T>(call: () => Promise<T>): Promise<T> {
  const run = engineQueue.then(call, call);
  engineQueue = run.catch(() => undefined);
  return run;
}

/**
 * Fillet, chamfer, hole, and boolean ask the kernel whether the edit works before Apply.
 * A number still being typed waits `wait` ms; a newer edit discards the older answer.
 * An answer already known for this solid, shape, and numbers is used without asking.
 */
function scheduleProbe(wait: number) {
  window.clearTimeout(probeTimer);
  pendingProbe = null;
  probeSerial += 1;
  const serial = probeSerial;
  const at = open;
  const payload = at ? probePayload(at.solid.id) : null;
  if (!at || !payload) {
    setModelProbe(null);
    return;
  }
  const key = probeKey(at.solid.id, at.mesh, payload);
  const known = answers.get(key);
  if (known) {
    setModelProbe(known);
    return;
  }
  setModelProbe({ phase: "checking" });
  pendingProbe = () => void sendProbe(serial, key, payload);
  if (wait > 0) probeTimer = window.setTimeout(sendPending, wait);
  else sendPending();
}

function sendPending() {
  const send = pendingProbe;
  pendingProbe = null;
  send?.();
}

function probePayload(id: number): Record<string, unknown> | null {
  const current = openModelTool();
  if (!isProbed(current)) return null;
  if (current === "fillet" || current === "chamfer") {
    const edges = selectedEdges(picks);
    if (edges.length === 0) return null;
    const size = num("#modelBlend");
    return { id, kind: current, edge: edges[edges.length - 1], edges, radius: size, distance: size };
  }
  const origin = { x: num("#modelX"), y: num("#modelY"), z: num("#modelZ") };
  if (current === "hole") {
    const [dx, dy, dz] = drillAxis();
    return { id, kind: "hole", ...origin, dx, dy, dz, radius: num("#modelHoleR"), depth: num("#modelHoleD") };
  }
  return {
    id,
    kind: "boolean",
    op: boolOp(),
    primitive: prim(),
    ...origin,
    dx: num("#modelDx"),
    dy: num("#modelDy"),
    dz: num("#modelDz"),
    radius: num("#modelRadius"),
    height: num("#modelHeight"),
    ...turn(),
  };
}

async function sendProbe(serial: number, key: string, payload: Record<string, unknown>) {
  const body = await inOrder(() => post("/api/model/probe", payload));
  const view = probeFromBody(body);
  if (typeof body.ok === "boolean") remember(key, view);
  if (serial !== probeSerial || state.stage !== "model") return;
  setModelProbe(view);
}

function remember(key: string, view: ProbeView) {
  if (answers.size >= 256) answers.clear();
  answers.set(key, view);
}

function boolOp(): "fuse" | "cut" | "common" {
  if (document.querySelector("#modelCut")?.getAttribute("aria-pressed") === "true") return "cut";
  if (document.querySelector("#modelCommon")?.getAttribute("aria-pressed") === "true") return "common";
  return "fuse";
}

/**
 * Before a project save: every held solid's STEP onto its plate objects. A solid the engine can no
 * longer write loses its STEP rather than keep one from an older shape.
 */
export async function captureOpenSolid() {
  const problem = await inOrder(() => writeHeldSteps([...opened.values()]));
  if (!problem) return;
  for (const entry of opened.values()) {
    if (!stepKnown.has(entry.mesh)) putStep(entry.mesh, undefined);
  }
}

/** Leaving Model: fold the visit into one Prepare step and write the STEP of each edited solid, off the UI's path. */
export function leaveModel() {
  endModelVisit();
  for (const entry of opened.values()) entry.modelMarks.length = 0;
  void inOrder(() => writeHeldSteps([...opened.values()]));
}

export function showModel() {
  const mine = ++ticket;
  picks = [];
  flushEdit();
  noteEdit();
  const mesh = state.mesh;
  const objectId = state.plate.selectedId;
  const token = mesh ? meshTokenOf(mesh.bytes) : null;
  const known = objectId ? opened.get(objectId) : undefined;
  if (known && known.mesh === token) {
    open = known;
    fx.model?.setSolid(known.solid);
    refreshModelContext();
    fx.model?.highlight([]);
    syncModelChrome([]);
    showEdits(true);
    syncModelSolid();
    refreshModelGhost();
    syncUndo();
    readout(`Volume ${mm(known.solid.volumeMm3)} mm³. Pick a face or an edge.`);
    return;
  }
  open = null;
  fx.model?.setSolid(null);
  refreshModelContext();
  fx.model?.highlight([]);
  syncModelChrome([]);
  showEdits(false);
  syncUndo();
  if (!mesh || !objectId || !token) {
    readout("Open a STEP file to measure a solid.");
    return;
  }
  const brep = selectedBrep();
  if (!brep && !isStepName(mesh.name)) {
    readout("Model measure reads a STEP solid. This file is a mesh.");
    return;
  }
  readout("Reading the solid…");
  if (opened.size > 0) {
    // The session is about to hold another file. Its solids' in-between shapes go with it.
    endModelVisit();
    beginModelVisit();
  }
  if (brep) {
    void load(mine, objectId, token, stepFileName(mesh.name), brep, state.stepTolerance);
    return;
  }
  void load(mine, objectId, token, mesh.name, mesh.bytes, state.stepTolerance);
}

function setMode(mode: "face" | "edge") {
  fx.model?.setPickMode(mode);
  picks = [];
  fx.model?.highlight([]);
  syncModelChrome([]);
  document.querySelector("#modelPickFace")?.setAttribute("aria-pressed", mode === "face" ? "true" : "false");
  document.querySelector("#modelPickFace")?.classList.toggle("on", mode === "face");
  document.querySelector("#modelPickEdge")?.setAttribute("aria-pressed", mode === "edge" ? "true" : "false");
  document.querySelector("#modelPickEdge")?.classList.toggle("on", mode === "edge");
  if (open) readout(`Volume ${mm(open.solid.volumeMm3)} mm³. Pick ${mode === "face" ? "a face" : "an edge"}.`);
}

async function applyTool() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (!button || button.disabled) return;
  const current = document.querySelector<HTMLElement>("#modelBar")?.dataset.tool;
  const applied = open ? probePayload(open.solid.id) : null;
  if (current === "boolean") {
    await runBoolean(boolOp(), applied);
    return;
  }
  if (current === "split") await runSplit();
  else if (current === "fillet") await runBlend("fillet", applied);
  else if (current === "chamfer") await runBlend("chamfer", applied);
  else if (current === "hole") await runHole(applied);
  else if (current === "scale") await runScale();
}

/** Open the file in a new engine session. The solids of the last one are written first, since the session lets them go. */
async function load(mine: number, objectId: string, mesh: string, name: string, bytes: ArrayBuffer, chord: number) {
  const body = await inOrder(async () => {
    await writeHeldSteps([...opened.values()]);
    return post("/api/model", {
      filename: name,
      dataB64: bytesToBase64(new Uint8Array(bytes)),
      stepToleranceMm: chord,
    });
  });
  if (mine !== ticket || state.stage !== "model") return;
  const parsed = asSolid(body);
  if (!parsed) {
    readout(text(body.error) || "Could not read this STEP solid.");
    return;
  }
  opened.clear();
  stepKnown.clear();
  answers.clear();
  stepKnown.add(mesh);
  open = openedFor(objectId, parsed, mesh);
  syncUndo();
  present(parsed, `Volume ${mm(parsed.volumeMm3)} mm³. Pick a face or an edge.`);
}

function openedFor(objectId: string, solid: ParsedSolid, mesh: string): Opened {
  const entry: Opened = { objectId, solid, mesh, undos: [], redos: [], redoBefore: [], redoBacked: [], modelMarks: [] };
  opened.set(objectId, entry);
  return entry;
}

async function runBoolean(op: "fuse" | "cut" | "common", applied: Record<string, unknown> | null) {
  if (!open || busy || !state.mesh) return;
  const at = open;
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout("Editing the solid…");
  const body = await inOrder(() => post("/api/model/boolean", {
    id: at.solid.id,
    op,
    primitive: prim(),
    x: num("#modelX"),
    y: num("#modelY"),
    z: num("#modelZ"),
    dx: num("#modelDx"),
    dy: num("#modelDy"),
    dz: num("#modelDz"),
    radius: num("#modelRadius"),
    height: num("#modelHeight"),
    ...turn(),
    chordMm: state.stepTolerance,
  }));
  busy = false;
  if (mine !== ticket || state.stage !== "model") return;
  if (text(body.error)) {
    readout(text(body.error));
    return;
  }
  const parsed = asSolid(body);
  if (!parsed) {
    readout("The boolean returned nothing.");
    return;
  }
  const note = land(at, snap, parsed, null, false);
  if (note === null) return;
  present(parsed, `Volume ${mm(parsed.volumeMm3)} mm³.${note}`, applied);
}

async function runSplit() {
  if (!open || busy || !state.mesh) return;
  const at = open;
  const range = splitPlaneRange(zExtent(at.solid.positions));
  const z = num("#modelPlaneZ");
  if (!range) {
    readout("This solid is too thin to split.");
    return;
  }
  if (!splitPlaneInside(z, range)) {
    readout(`Move the plane into the part, between ${formatMm(range.min)} and ${formatMm(range.max)} mm.`);
    return;
  }
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout("Splitting the solid…");
  const body = await inOrder(() => post("/api/model/split", {
    id: at.solid.id,
    x: 0,
    y: 0,
    z,
    nx: 0,
    ny: 0,
    nz: 1,
    chordMm: state.stepTolerance,
  }));
  busy = false;
  if (mine !== ticket || state.stage !== "model") return;
  if (text(body.error)) {
    readout(text(body.error));
    return;
  }
  const parsed = asSolid(body);
  const other = body.other && typeof body.other === "object" ? asSolid(body.other as Record<string, unknown>) : null;
  if (!parsed || !other) {
    readout("The plane did not split this solid.");
    return;
  }
  const note = land(at, snap, parsed, other, false);
  if (note === null) {
    await rollback(at, snap);
    return;
  }
  present(parsed, `Split. Volume ${mm(parsed.volumeMm3)} mm³. The other piece sits in the same spot. Use Arrange to lay them side by side.${note}`);
}

async function runBlend(kind: "fillet" | "chamfer", applied: Record<string, unknown> | null) {
  if (!open || busy || !state.mesh) return;
  const at = open;
  const edges = selectedEdges(picks);
  if (edges.length === 0) {
    readout(kind === "fillet" ? "Pick an edge to fillet." : "Pick an edge to chamfer.");
    return;
  }
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  const count = edges.length === 1 ? "the edge" : `${edges.length} edges`;
  readout(kind === "fillet" ? `Filleting ${count}…` : `Chamfering ${count}…`);
  const body = await inOrder(() => post(kind === "fillet" ? "/api/model/fillet" : "/api/model/chamfer", {
    id: at.solid.id,
    edge: edges[edges.length - 1],
    edges,
    radius: num("#modelBlend"),
    distance: num("#modelBlend"),
    chordMm: state.stepTolerance,
  }));
  busy = false;
  if (mine !== ticket || state.stage !== "model") return;
  if (text(body.error)) {
    readout(text(body.error));
    return;
  }
  const parsed = asSolid(body);
  if (!parsed) {
    readout(kind === "fillet" ? "The fillet returned nothing." : "The chamfer returned nothing.");
    return;
  }
  const note = land(at, snap, parsed, null, false);
  if (note === null) return;
  const label = kind === "fillet" ? "Fillet" : "Chamfer";
  present(parsed, `${label}. Volume ${mm(parsed.volumeMm3)} mm³.${note}`, applied);
}

async function runHole(applied: Record<string, unknown> | null) {
  if (!open || busy || !state.mesh) return;
  const at = open;
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout("Cutting the hole…");
  const [dx, dy, dz] = drillAxis();
  const body = await inOrder(() => post("/api/model/hole", {
    id: at.solid.id,
    x: num("#modelX"),
    y: num("#modelY"),
    z: num("#modelZ"),
    dx,
    dy,
    dz,
    radius: num("#modelHoleR"),
    depth: num("#modelHoleD"),
    chordMm: state.stepTolerance,
  }));
  busy = false;
  if (mine !== ticket || state.stage !== "model") return;
  if (text(body.error)) {
    readout(text(body.error));
    return;
  }
  const parsed = asSolid(body);
  if (!parsed) {
    readout("The hole returned nothing.");
    return;
  }
  const note = land(at, snap, parsed, null, false);
  if (note === null) return;
  present(parsed, `Hole. Volume ${mm(parsed.volumeMm3)} mm³.${note}`, applied);
}

async function runScale() {
  if (!open || busy || !state.mesh) return;
  const at = open;
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout("Scaling the solid…");
  const body = await inOrder(() => post("/api/model/scale", {
    id: at.solid.id,
    factor: num("#modelFactor"),
    chordMm: state.stepTolerance,
  }));
  busy = false;
  if (mine !== ticket || state.stage !== "model") return;
  if (text(body.error)) {
    readout(text(body.error));
    return;
  }
  const parsed = asSolid(body);
  if (!parsed) {
    readout("The scale returned nothing.");
    return;
  }
  const note = land(at, snap, parsed, null, true);
  if (note === null) return;
  present(parsed, `Volume ${mm(parsed.volumeMm3)} mm³.${note}`);
}

async function runExport() {
  if (!open || busy || !state.mesh) return;
  const at = open;
  busy = true;
  readout("Writing STEP…");
  const mine = ticket;
  const problem = await inOrder(() => writeHeldSteps([at], true));
  busy = false;
  if (mine !== ticket || state.stage !== "model" || !open) return;
  if (problem) {
    readout(problem);
    return;
  }
  const brep = selectedBrep();
  if (!brep || !state.mesh) return;
  await saveStepFile(brep, stepFileName(state.mesh.name));
  readout(`Saved STEP. Volume ${mm(open.solid.volumeMm3)} mm³.`);
}

async function runUndo() {
  const at = open;
  const snap = at?.undos.pop();
  if (!at || !snap || busy) {
    if (snap) at?.undos.push(snap);
    syncUndo();
    return;
  }
  busy = true;
  const mine = ticket;
  const body = await inOrder(() => post("/api/model/undo", { id: at.solid.id, chordMm: state.stepTolerance }));
  busy = false;
  if (mine !== ticket || state.stage !== "model") {
    at.undos.push(snap);
    return;
  }
  const parsed = asSolid(body);
  if (text(body.error) || !parsed) {
    at.undos.push(snap);
    syncUndo();
    readout(text(body.error) || "Could not undo that edit.");
    return;
  }
  flushEdit();
  const forward = snapshot();
  const backed = at.modelMarks.at(-1) === editUndoCount();
  let took = false;
  if (backed) {
    took = undoUserEdit();
    if (took) at.modelMarks.pop();
  }
  if (!took) {
    restore(snap);
    if (snap.addedId && state.plate.objects.length > 1) {
      syncPlateFromState();
      state.plate = withoutObject(state.plate, snap.addedId);
      applySelectedToState(state.plate);
    }
    place();
  }
  at.redos.push(forward);
  at.redoBefore.push(snap);
  at.redoBacked.push(took);
  syncUndo();
  present(parsed, `Volume ${mm(parsed.volumeMm3)} mm³. Edit undone.`);
}

async function runRedo() {
  const at = open;
  const forward = at?.redos.pop();
  const before = at?.redoBefore.pop();
  const backed = at?.redoBacked.pop();
  if (!at || !forward || !before || backed == null || busy) {
    if (forward) at?.redos.push(forward);
    if (before) at?.redoBefore.push(before);
    if (backed != null) at?.redoBacked.push(backed);
    syncUndo();
    return;
  }
  busy = true;
  const mine = ticket;
  const body = await inOrder(() => post("/api/model/redo", { id: at.solid.id, chordMm: state.stepTolerance }));
  busy = false;
  if (mine !== ticket || state.stage !== "model") {
    at.redos.push(forward);
    at.redoBefore.push(before);
    at.redoBacked.push(backed);
    return;
  }
  const parsed = asSolid(body);
  if (text(body.error) || !parsed) {
    at.redos.push(forward);
    at.redoBefore.push(before);
    at.redoBacked.push(backed);
    syncUndo();
    readout(text(body.error) || "Could not redo that edit.");
    return;
  }
  flushEdit();
  let took = false;
  if (backed) {
    took = redoUserEdit();
    if (took) at.modelMarks.push(editUndoCount());
  }
  if (!took) {
    restore(forward);
    place();
  }
  at.undos.push(before);
  syncUndo();
  present(parsed, `Volume ${mm(parsed.volumeMm3)} mm³. Edit redone.`);
}

function land(at: Opened, snap: ModelUndo, parsed: ParsedSolid, other: ParsedSolid | null, resetScale: boolean): string | null {
  if (!state.mesh || !state.sourcePos) {
    readout("Open a solid before editing it.");
    return null;
  }
  noteEdit();
  const paint = state.supportPaint.length + state.seamPaint.length + state.reinforcement.length + state.supportEdits.length > 0;
  const scaled = resetScale && state.partScale !== 1;
  if (resetScale) state.partScale = 1;
  const positions = settle(new Float32Array(parsed.positions));
  const name = stlName(state.mesh.name);
  state.mesh = { name, bytes: encodeStl(positions, name) };
  state.sourcePos = positions;
  state.supportEdits = [];
  state.supportPaint = [];
  state.seamPaint = [];
  state.reinforcement = [];
  if (other) {
    syncPlateFromState();
    const selected = state.plate.selectedId;
    const prev = new Set(state.plate.objects.map((obj) => obj.id));
    const otherPos = settle(new Float32Array(other.positions));
    const otherName = name.replace(/\.stl$/i, "") + " split.stl";
    const next = selected
      ? addedSplit(state.plate, {
          name: otherName.replace(/\.stl$/i, ""),
          fileName: otherName,
          bytes: encodeStl(otherPos, otherName),
          sourcePos: otherPos,
          stepTolerance: state.stepTolerance,
        })
      : null;
    const piece = next?.objects.find((obj) => !prev.has(obj.id));
    if (!next || !selected || !piece) {
      cancelEdit();
      return null;
    }
    state.plate = { ...next, selectedId: selected };
    applySelectedToState(state.plate);
    snap.addedId = piece.id;
    // The piece is a held solid of its own: selecting it opens it from the session, with no STEP read.
    openedFor(piece.id, other, meshTokenOf(piece.bytes));
  }
  place();
  at.undos.push(snap);
  clearModelFuture(at);
  flushEdit();
  markModelEdit();
  at.modelMarks.push(editUndoCount());
  syncUndo();
  return `${paint ? " Support paint was cleared." : ""}${scaled ? " Placement scale is 100%." : ""}`;
}

async function rollback(at: Opened, snap: ModelUndo) {
  await inOrder(() => post("/api/model/undo", { id: at.solid.id, chordMm: state.stepTolerance }));
  restore(snap);
  place();
  if (state.mesh) at.mesh = meshTokenOf(state.mesh.bytes);
  readout("The other piece could not be added. The solid is unchanged.");
}

function restore(snap: ModelUndo) {
  state.mesh = { name: snap.meshName, bytes: snap.bytes };
  state.sourcePos = new Float32Array(snap.sourcePos);
  state.supportEdits = snap.supportEdits;
  state.supportPaint = snap.supportPaint;
  state.seamPaint = snap.seamPaint;
  state.reinforcement = snap.reinforcement;
  state.partScale = snap.partScale;
  setBrep(snap.brep);
}

function snapshot(): ModelUndo {
  const live = state.mesh?.bytes;
  const bytes = live?.slice(0) ?? new ArrayBuffer(0);
  if (live) shareMeshToken(live, bytes);
  return {
    meshName: state.mesh?.name ?? "solid.stl",
    bytes,
    sourcePos: new Float32Array(state.sourcePos ?? []),
    supportEdits: structuredClone(state.supportEdits) as SupportEdits,
    supportPaint: structuredClone(state.supportPaint) as unknown as SupportPaint,
    seamPaint: structuredClone(state.seamPaint) as unknown as SeamPaint,
    reinforcement: structuredClone(state.reinforcement) as unknown as Reinforcement,
    partScale: state.partScale,
    // A STEP buffer is never written in place, so the snap shares it.
    brep: selectedBrep(),
    addedId: null,
  };
}

/**
 * Write the STEP of each solid in `entries` whose plate objects do not carry it yet (`force`: even if
 * they do), and give it to every plate object, Prepare step, and Model snap with that mesh.
 * Run inside `inOrder`, so the shape written is the one `entry.mesh` names.
 */
async function writeHeldSteps(entries: Opened[], force = false): Promise<string | null> {
  let problem: string | null = null;
  for (const entry of entries) {
    const mesh = entry.mesh;
    if (!force && stepKnown.has(mesh)) continue;
    const step = await exportStep(entry.solid.id);
    if (typeof step === "string") problem = step;
    else putStep(mesh, step);
  }
  return problem;
}

async function exportStep(id: number): Promise<ArrayBuffer | string> {
  const body = await post("/api/model/export", { id });
  const problem = text(body.error);
  if (problem) return problem;
  if (typeof body.bytesBase64 !== "string") return "Open CASCADE did not write this solid.";
  const bytes = base64ToBytes(body.bytesBase64);
  if (!bytes || (typeof body.byteLength === "number" && bytes.byteLength !== body.byteLength)) {
    return "Open CASCADE did not write this solid.";
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** `step` is the solid whose plate mesh is `mesh`: it goes wherever that mesh is. Undefined removes it. */
function putStep(mesh: string, step: ArrayBuffer | undefined) {
  state.plate = withBrepFor(state.plate, mesh, step);
  patchEditBrep(mesh, step);
  for (const entry of opened.values()) {
    for (const snap of [...entry.undos, ...entry.redos, ...entry.redoBefore]) {
      if (meshTokenOf(snap.bytes) === mesh) snap.brep = step ?? null;
    }
  }
  if (step) stepKnown.add(mesh);
  else stepKnown.delete(mesh);
}

function setBrep(bytes: ArrayBuffer | null) {
  const id = state.plate.selectedId;
  if (!id) return;
  state.plate = {
    ...state.plate,
    objects: state.plate.objects.map((obj) => {
      if (obj.id !== id) return obj;
      const next = { ...obj };
      if (bytes && bytes.byteLength > 0) next.brep = bytes;
      else delete next.brep;
      return next;
    }),
  };
}

function selectedBrep() {
  const id = state.plate.selectedId;
  return state.plate.objects.find((obj) => obj.id === id)?.brep ?? null;
}

function stepFileName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.step`;
}

async function saveStepFile(bytes: ArrayBuffer, name: string) {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (tauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_text_file", { text: "", defaultName: name, extension: "step", bytesB64: bytesToBase64(new Uint8Array(bytes)) });
    return;
  }
  const blob = new Blob([bytes], { type: "application/step" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Show `parsed` as the open solid's shape, which is now the plate mesh. `applied` are the numbers the
 * edit used: applying them again to this shape would change nothing, so Apply stays off for them.
 */
function present(parsed: ParsedSolid, message: string, applied: Record<string, unknown> | null = null) {
  const at = open;
  if (!at) return;
  at.solid = parsed;
  if (state.mesh) at.mesh = meshTokenOf(state.mesh.bytes);
  if (applied) remember(probeKey(parsed.id, at.mesh, applied), { phase: "applied" });
  picks = [];
  fx.model?.setSolid(parsed);
  refreshModelContext();
  fx.model?.highlight([]);
  syncModelSolid();
  syncModelChrome([]);
  fx.model?.resize();
  showEdits(true);
  refreshModelGhost();
  readout(message);
}

/** The other plate objects, grey, in the open solid's frame. Nothing is drawn without an open solid. */
export function refreshModelContext() {
  const box = open ? boxOf(open.solid.positions) : null;
  fx.model?.setContext(box && open ? contextParts(livePlate(), open.objectId, box, state.profile.bedX, state.profile.bedY) : []);
}

function showEdits(on: boolean) {
  document.querySelector("#modelEdit")?.toggleAttribute("hidden", !on);
  if (!on) closeModelTool();
}

function clearModelFuture(at: Opened) {
  at.redos.length = 0;
  at.redoBefore.length = 0;
  at.redoBacked.length = 0;
}

function syncUndo() {
  const undo = document.querySelector<HTMLButtonElement>("#modelUndo");
  const redo = document.querySelector<HTMLButtonElement>("#modelRedo");
  if (undo) undo.disabled = (open?.undos.length ?? 0) === 0;
  if (redo) redo.disabled = (open?.redos.length ?? 0) === 0;
}

/** Turn degrees for a box or cylinder. A sphere does not turn. */
function turn() {
  if (prim() === "sphere") return { rx: 0, ry: 0, rz: 0 };
  return { rx: num("#modelRx"), ry: num("#modelRy"), rz: num("#modelRz") };
}

function boxOf(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } | null {
  if (positions.length < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

function prim() {
  return document.querySelector<HTMLSelectElement>("#modelPrim")?.value ?? "box";
}

/** Into the last picked face, or straight down when no face is picked. */
function drillAxis(): [number, number, number] {
  const face = lastFace(picks);
  if (!open || face == null) return [0, 0, -1];
  const stored = open.solid.faces.find((item) => item.id === face)?.normal;
  return holeAxis(stored ?? outwardFromMesh(open.solid.positions, open.solid.triangles, face));
}

function num(id: string) {
  const value = Number(document.querySelector<HTMLInputElement>(id)?.value);
  return Number.isFinite(value) ? value : 0;
}

function stlName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.stl`;
}

let measureSeq = 0;

async function onPick(pick: ModelPick | null, shift: boolean) {
  const solid = open?.solid;
  if (!solid) return;
  picks = nextModelPicks(picks, pick, shift);
  fx.model?.highlight(picks);
  syncModelChrome(picks);
  const seq = ++measureSeq;
  if (picks.length === 0) {
    readout(`Volume ${mm(solid.volumeMm3)} mm³. Pick a face or an edge.`);
    return;
  }
  if (picks.length === 1) {
    readout(`${describe(solid, picks[0]!)} Volume ${mm(solid.volumeMm3)} mm³.`);
    return;
  }
  if (picks.length !== 2) {
    readout(`${selectionCountLabel(picks)}. Volume ${mm(solid.volumeMm3)} mm³.`);
    return;
  }
  readout("Measuring distance…");
  const generation = ticket;
  const body = await post("/api/model/distance", {
    id: solid.id,
    aKind: picks[0]!.kind,
    aIndex: picks[0]!.index,
    bKind: picks[1]!.kind,
    bIndex: picks[1]!.index,
  });
  if (seq !== measureSeq || generation !== ticket || state.stage !== "model") return;
  const distance = typeof body.distanceMm === "number" ? body.distanceMm : null;
  if (distance == null) {
    readout(text(body.error) || "Could not measure that distance.");
    return;
  }
  readout(`${describe(solid, picks[0]!)} ${describe(solid, picks[1]!)} Distance ${mm(distance)} mm.`);
}

function describe(current: ParsedSolid, pick: ModelPick) {
  if (pick.kind === "face") {
    const area = current.faces.find((face) => face.id === pick.index)?.areaMm2;
    return `Face ${pick.index + 1} · ${mm(area ?? Number.NaN)} mm².`;
  }
  const length = current.edges.find((edge) => edge.id === pick.index)?.lengthMm;
  return `Edge ${pick.index + 1} · ${mm(length ?? Number.NaN)} mm.`;
}

function modelTool(): string | undefined {
  return document.querySelector<HTMLElement>("#modelBar")?.dataset.tool;
}

function readout(message: string) {
  const node = document.querySelector("#modelReadout");
  if (node) node.textContent = plainModelError(message, modelTool());
}

function mm(value: number) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readNormal(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const normal = value.slice(0, 3).map((item) => (typeof item === "number" ? item : Number.NaN));
  if (normal.some((item) => !Number.isFinite(item))) return null;
  return [normal[0]!, normal[1]!, normal[2]!];
}

function asSolid(body: Record<string, unknown>): ParsedSolid | null {
  if (typeof body.volumeMm3 !== "number" || !Array.isArray(body.positions) || !Array.isArray(body.triangles)) return null;
  const faces = Array.isArray(body.faces) ? body.faces.flatMap((face) => {
    if (!face || typeof face !== "object") return [];
    const row = face as { id?: unknown; areaMm2?: unknown; normal?: unknown };
    if (typeof row.id !== "number" || typeof row.areaMm2 !== "number") return [];
    const normal = readNormal(row.normal);
    return [{ id: row.id, areaMm2: row.areaMm2, ...(normal ? { normal } : {}) }];
  }) : [];
  const edges = Array.isArray(body.edges) ? body.edges.flatMap((edge) => {
    if (!edge || typeof edge !== "object") return [];
    const row = edge as { id?: unknown; lengthMm?: unknown; points?: unknown };
    if (typeof row.id !== "number" || typeof row.lengthMm !== "number" || !Array.isArray(row.points)) return [];
    return [{ id: row.id, lengthMm: row.lengthMm, points: Float32Array.from(row.points.filter((item) => typeof item === "number")) }];
  }) : [];
  return {
    id: typeof body.id === "number" ? body.id : 1,
    volumeMm3: body.volumeMm3,
    positions: Float32Array.from(body.positions.filter((item) => typeof item === "number")),
    triangles: body.triangles.filter((item) => typeof item === "number"),
    faces,
    edges,
  };
}

function commandFor(path: string) {
  if (path.endsWith("/distance")) return "model_distance";
  if (path.endsWith("/boolean")) return "model_boolean";
  if (path.endsWith("/split")) return "model_split";
  if (path.endsWith("/probe")) return "model_probe";
  if (path.endsWith("/fillet")) return "model_fillet";
  if (path.endsWith("/chamfer")) return "model_chamfer";
  if (path.endsWith("/hole")) return "model_hole";
  if (path.endsWith("/scale")) return "model_scale";
  if (path.endsWith("/export")) return "model_export";
  if (path.endsWith("/undo")) return "model_undo";
  if (path.endsWith("/redo")) return "model_redo";
  return "model_solid";
}

async function post(path: string, payload: unknown): Promise<Record<string, unknown>> {
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  try {
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      return JSON.parse(await invoke<string>(commandFor(path), { payload: JSON.stringify(payload) })) as Record<string, unknown>;
    }
    const res = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: authHeaders(apiToken(), { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok && typeof body.error !== "string") {
      return { error: modelerFailure(body.error ?? body.message, modelTool()) };
    }
    return body;
  } catch (err) {
    const message = modelerFailure(err, modelTool());
    if (message === "Failed to fetch") {
      return { error: `Model measure needs the slicer engine at ${apiBase()}. Start it with cargo run -p lime-slice --release -- serve.` };
    }
    return { error: message };
  }
}

Object.assign(fx, { refreshModelContext });
