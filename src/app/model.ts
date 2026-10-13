import { bytesToBase64 } from "../base64";
import { encodeStl, settle } from "../mesh-place";
import type { ModelPick, ModelSolid } from "../model-view";
import { lastEdge, nextModelPicks, selectionCountLabel } from "../model-select";
import { closeModelTool, mountModelChrome, refreshModelGhost, syncModelChrome } from "../ui/model-chrome";
import { addedMesh, withoutObject } from "../plate";
import { markProjectDirty } from "../project-dirty";
import { base64ToBytes } from "../project";
import { authHeaders } from "../ui/api-base";
import { place } from "./files";
import { fx } from "./fx";
import { modelerFailure } from "./model-error";
import { applySelectedToState, syncPlateFromState } from "./plate-sync";
import { apiBase, apiToken, isStepName } from "./settings";
import { state } from "./state";

let ticket = 0;
let solid: ParsedSolid | null = null;
let picks: ModelPick[] = [];
let busy = false;
let keptToken = "";
let keptSolid: ParsedSolid | null = null;
const undos: ModelUndo[] = [];

interface ParsedSolid extends ModelSolid {
  faces: { id: number; areaMm2: number }[];
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
  mountModelChrome({
    clearSelection() {
      picks = [];
      fx.model?.highlight([]);
      syncModelChrome([]);
      if (solid) readout(`Volume ${mm(solid.volumeMm3)} mm³. Pick a face or an edge.`);
    },
  });
}

/** Write the open solid onto the selected object when that session is still current. */
export async function captureOpenSolid() {
  if (!solid || !state.mesh || meshToken() !== keptToken) return;
  await rememberBrep();
}

export function showModel() {
  const mine = ++ticket;
  picks = [];
  const mesh = state.mesh;
  if (keptSolid && mesh && meshToken() === keptToken) {
    solid = keptSolid;
    fx.model?.setSolid(solid);
    fx.model?.highlight([]);
    syncModelChrome([]);
    showEdits(true);
    refreshModelGhost();
    readout(`Volume ${mm(solid.volumeMm3)} mm³. Pick a face or an edge.`);
    return;
  }
  solid = null;
  fx.model?.setSolid(null);
  fx.model?.highlight([]);
  syncModelChrome([]);
  showEdits(false);
  if (!mesh) {
    readout("Open a STEP file to measure a solid.");
    return;
  }
  const brep = selectedBrep();
  if (!brep && !isStepName(mesh.name)) {
    readout("Model measure reads a STEP solid. This file is a mesh.");
    return;
  }
  keptSolid = null;
  keptToken = "";
  undos.length = 0;
  syncUndo();
  readout("Reading the solid…");
  if (brep) {
    void load(mine, stepFileName(mesh.name), brep, state.stepTolerance);
    return;
  }
  void load(mine, mesh.name, mesh.bytes, state.stepTolerance);
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
  if (solid) readout(`Volume ${mm(solid.volumeMm3)} mm³. Pick ${mode === "face" ? "a face" : "an edge"}.`);
}

async function applyTool() {
  const button = document.querySelector<HTMLButtonElement>("#modelApply");
  if (!button || button.disabled) return;
  const current = document.querySelector<HTMLElement>("#modelBar")?.dataset.tool;
  if (current === "boolean") {
    const op = document.querySelector("#modelCut")?.getAttribute("aria-pressed") === "true"
      ? "cut"
      : document.querySelector("#modelCommon")?.getAttribute("aria-pressed") === "true"
        ? "common"
        : "fuse";
    await runBoolean(op);
    return;
  }
  if (current === "split") await runSplit();
  else if (current === "fillet") await runBlend("fillet");
  else if (current === "chamfer") await runBlend("chamfer");
  else if (current === "hole") await runHole();
  else if (current === "scale") await runScale();
}

async function load(mine: number, name: string, bytes: ArrayBuffer, chord: number) {
  const body = await post("/api/model", {
    filename: name,
    dataB64: bytesToBase64(new Uint8Array(bytes)),
    stepToleranceMm: chord,
  });
  if (mine !== ticket || state.stage !== "model") return;
  const parsed = asSolid(body);
  if (!parsed) {
    readout(text(body.error) || "Could not read this STEP solid.");
    return;
  }
  present(parsed, `Volume ${mm(parsed.volumeMm3)} mm³. Pick a face or an edge.`);
}

async function runBoolean(op: "fuse" | "cut" | "common") {
  if (!solid || busy || !state.mesh) return;
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout("Editing the solid…");
  const body = await post("/api/model/boolean", {
    id: solid.id,
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
    chordMm: state.stepTolerance,
  });
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
  const note = land(snap, parsed, null, false);
  if (note === null) return;
  await commitView(parsed, `Volume ${mm(parsed.volumeMm3)} mm³.${note}`);
}

async function runSplit() {
  if (!solid || busy || !state.mesh) return;
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout("Splitting the solid…");
  const body = await post("/api/model/split", {
    id: solid.id,
    x: 0,
    y: 0,
    z: num("#modelPlaneZ"),
    nx: 0,
    ny: 0,
    nz: 1,
    chordMm: state.stepTolerance,
  });
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
  const note = land(snap, parsed, other, false);
  if (note === null) {
    await rollback(snap);
    return;
  }
  await commitView(parsed, `Split. Volume ${mm(parsed.volumeMm3)} mm³. The other solid is on the plate.${note}`);
}

async function runBlend(kind: "fillet" | "chamfer") {
  if (!solid || busy || !state.mesh) return;
  const edge = edgeIndex();
  if (edge == null) {
    readout(kind === "fillet" ? "Pick an edge to fillet." : "Pick an edge to chamfer.");
    return;
  }
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout(kind === "fillet" ? "Filleting the edge…" : "Chamfering the edge…");
  const body = await post(kind === "fillet" ? "/api/model/fillet" : "/api/model/chamfer", {
    id: solid.id,
    edge,
    radius: num("#modelBlend"),
    distance: num("#modelBlend"),
    chordMm: state.stepTolerance,
  });
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
  const note = land(snap, parsed, null, false);
  if (note === null) return;
  const label = kind === "fillet" ? "Fillet" : "Chamfer";
  await commitView(parsed, `${label}. Volume ${mm(parsed.volumeMm3)} mm³.${note}`);
}

async function runHole() {
  if (!solid || busy || !state.mesh) return;
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout("Cutting the hole…");
  const body = await post("/api/model/hole", {
    id: solid.id,
    x: num("#modelX"),
    y: num("#modelY"),
    z: num("#modelZ"),
    radius: num("#modelHoleR"),
    depth: num("#modelHoleD"),
    chordMm: state.stepTolerance,
  });
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
  const note = land(snap, parsed, null, false);
  if (note === null) return;
  await commitView(parsed, `Hole. Volume ${mm(parsed.volumeMm3)} mm³.${note}`);
}

async function runScale() {
  if (!solid || busy || !state.mesh) return;
  busy = true;
  const snap = snapshot();
  const mine = ticket;
  readout("Scaling the solid…");
  const body = await post("/api/model/scale", {
    id: solid.id,
    factor: num("#modelFactor"),
    chordMm: state.stepTolerance,
  });
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
  const note = land(snap, parsed, null, true);
  if (note === null) return;
  await commitView(parsed, `Volume ${mm(parsed.volumeMm3)} mm³.${note}`);
}

async function runExport() {
  if (!solid || busy || !state.mesh) return;
  busy = true;
  readout("Writing STEP…");
  const mine = ticket;
  const problem = await rememberBrep();
  busy = false;
  if (mine !== ticket || state.stage !== "model" || !solid) return;
  if (problem) {
    readout(problem);
    return;
  }
  const brep = selectedBrep();
  if (!brep || !state.mesh) return;
  await saveStepFile(brep, stepFileName(state.mesh.name));
  readout(`Saved STEP. Volume ${mm(solid.volumeMm3)} mm³.`);
}

async function runUndo() {
  const snap = undos.pop();
  if (!snap || !solid || busy) {
    if (snap) undos.push(snap);
    syncUndo();
    return;
  }
  busy = true;
  const mine = ticket;
  const body = await post("/api/model/undo", { id: solid.id, chordMm: state.stepTolerance });
  busy = false;
  if (mine !== ticket || state.stage !== "model") {
    undos.push(snap);
    return;
  }
  const parsed = asSolid(body);
  if (text(body.error) || !parsed) {
    undos.push(snap);
    syncUndo();
    readout(text(body.error) || "Could not undo that edit.");
    return;
  }
  restore(snap);
  if (snap.addedId && state.plate.objects.length > 1) {
    syncPlateFromState();
    state.plate = withoutObject(state.plate, snap.addedId);
    applySelectedToState(state.plate);
  }
  place();
  syncUndo();
  present(parsed, `Volume ${mm(parsed.volumeMm3)} mm³. Edit undone.`);
}

function land(snap: ModelUndo, parsed: ParsedSolid, other: ParsedSolid | null, resetScale: boolean): string | null {
  if (!state.mesh || !state.sourcePos) {
    readout("Open a solid before editing it.");
    return null;
  }
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
      ? addedMesh(
          state.plate,
          {
            name: otherName.replace(/\.stl$/i, ""),
            fileName: otherName,
            bytes: encodeStl(otherPos, otherName),
            sourcePos: otherPos,
            stepTolerance: state.stepTolerance,
          },
          state.profile.bedX,
          state.profile.bedY,
        )
      : null;
    const addedId = next?.objects.find((obj) => !prev.has(obj.id))?.id ?? null;
    if (!next || !selected || !addedId) return null;
    state.plate = { ...next, selectedId: selected };
    applySelectedToState(state.plate);
    snap.addedId = addedId;
  }
  place();
  undos.push(snap);
  syncUndo();
  return `${paint ? " Support paint was cleared." : ""}${scaled ? " Placement scale is 100%." : ""}`;
}

async function rollback(snap: ModelUndo) {
  if (solid) await post("/api/model/undo", { id: solid.id, chordMm: state.stepTolerance });
  restore(snap);
  place();
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
  return {
    meshName: state.mesh?.name ?? "solid.stl",
    bytes: state.mesh?.bytes.slice(0) ?? new ArrayBuffer(0),
    sourcePos: new Float32Array(state.sourcePos ?? []),
    supportEdits: structuredClone(state.supportEdits) as SupportEdits,
    supportPaint: structuredClone(state.supportPaint) as unknown as SupportPaint,
    seamPaint: structuredClone(state.seamPaint) as unknown as SeamPaint,
    reinforcement: structuredClone(state.reinforcement) as unknown as Reinforcement,
    partScale: state.partScale,
    brep: selectedBrep()?.slice(0) ?? null,
    addedId: null,
  };
}

async function commitView(parsed: ParsedSolid, message: string) {
  const problem = await rememberBrep();
  present(parsed, problem ? `${message} ${problem}` : message);
}

async function rememberBrep(): Promise<string | null> {
  if (!solid) return "Open a solid before saving it.";
  const body = await post("/api/model/export", { id: solid.id });
  const problem = text(body.error);
  if (problem) return problem;
  if (typeof body.bytesBase64 !== "string") return "Open CASCADE did not write this solid.";
  const bytes = base64ToBytes(body.bytesBase64);
  if (!bytes || (typeof body.byteLength === "number" && bytes.byteLength !== body.byteLength)) {
    return "Open CASCADE did not write this solid.";
  }
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  setBrep(copy);
  markProjectDirty();
  return null;
}

function setBrep(bytes: ArrayBuffer | null) {
  const id = state.plate.selectedId;
  if (!id) return;
  state.plate = {
    ...state.plate,
    objects: state.plate.objects.map((obj) => {
      if (obj.id !== id) return obj;
      const next = { ...obj };
      if (bytes && bytes.byteLength > 0) next.brep = bytes.slice(0);
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

function present(parsed: ParsedSolid, message: string) {
  solid = parsed;
  keptSolid = parsed;
  keptToken = meshToken();
  picks = [];
  fx.model?.setSolid(parsed);
  fx.model?.highlight([]);
  syncModelChrome([]);
  fx.model?.resize();
  showEdits(true);
  refreshModelGhost();
  readout(message);
}

function showEdits(on: boolean) {
  document.querySelector("#modelEdit")?.toggleAttribute("hidden", !on);
  if (!on) closeModelTool();
}

function syncUndo() {
  const button = document.querySelector<HTMLButtonElement>("#modelUndo");
  if (button) button.disabled = undos.length === 0;
}

function prim() {
  return document.querySelector<HTMLSelectElement>("#modelPrim")?.value ?? "box";
}

function edgeIndex() {
  return lastEdge(picks);
}

function num(id: string) {
  const value = Number(document.querySelector<HTMLInputElement>(id)?.value);
  return Number.isFinite(value) ? value : 0;
}

function meshToken() {
  return `${state.plate.selectedId ?? ""}:${state.mesh?.name ?? ""}:${state.mesh?.bytes.byteLength ?? 0}`;
}

function stlName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.stl`;
}

let measureSeq = 0;

async function onPick(pick: ModelPick | null, shift: boolean) {
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

function readout(message: string) {
  const node = document.querySelector("#modelReadout");
  if (node) node.textContent = message;
}

function mm(value: number) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asSolid(body: Record<string, unknown>): ParsedSolid | null {
  if (typeof body.volumeMm3 !== "number" || !Array.isArray(body.positions) || !Array.isArray(body.triangles)) return null;
  const faces = Array.isArray(body.faces) ? body.faces.flatMap((face) => {
    if (!face || typeof face !== "object") return [];
    const row = face as { id?: unknown; areaMm2?: unknown };
    if (typeof row.id !== "number" || typeof row.areaMm2 !== "number") return [];
    return [{ id: row.id, areaMm2: row.areaMm2 }];
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
  if (path.endsWith("/fillet")) return "model_fillet";
  if (path.endsWith("/chamfer")) return "model_chamfer";
  if (path.endsWith("/hole")) return "model_hole";
  if (path.endsWith("/scale")) return "model_scale";
  if (path.endsWith("/export")) return "model_export";
  if (path.endsWith("/undo")) return "model_undo";
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
      return { error: modelerFailure(body.error ?? body.message) };
    }
    return body;
  } catch (err) {
    const message = modelerFailure(err);
    if (message === "Failed to fetch") {
      return { error: `Model measure needs the slicer engine at ${apiBase()}. Start it with cargo run -p lime-slice --release -- serve.` };
    }
    return { error: message };
  }
}
