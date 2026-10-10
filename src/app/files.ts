import { fx } from "./fx";
import { state, session } from "./state";
import { centeringShift, ID_MATRIX, parseStl, placeMesh, encodeStl, scaledCanonical, encode3mf, type PlacedPart, type Placement } from "../mesh-place";
import { meshKeyHex } from "../slice-action";
import { bytesToBase64 } from "../base64";
import { needsEngine, apiBase, apiToken, markEngineDown, isStepName, renderChrome, markStale, stale, card, shownGrams } from "./settings";
import { withFooterGrams } from "../estimate";
import { legacyStockEnd, legacyStockStart, spliceText, withMachineGcode } from "../machine-gcode";
import { loadMachineLibrary } from "./machine-library";
import { selection } from "../ui/machine-library";
import type { SliceResponse } from "./state";
import { authHeaders, engineDownMessage } from "../ui/api-base";
import { type SplitSync } from "../split-at";
import { confirmDiscard, markProjectDirty } from "../project-dirty";
import { pushToast } from "../ui/toasts";
import { clearEdits } from "../support-edit-list";
import { clearEditHistory } from "./history";
import { foreign3mfMessage, foreignSlicer3mf } from "../foreign-3mf";
import { emptyOverrides } from "../overrides";
import { boundEntries, emptyPlate, oneObjectPlate, placeObject, resetHeldGeometry, withLivePose, type PlateObject } from "../plate";
import { syncPlateFromState } from "./plate-sync";

export async function loadNamed(name: string) {
  state.error = "";
  const res = await fetch(`/samples/${name}`);
  if (!res.ok) throw new Error(`could not load ${name}`);
  await adoptBytes(name, await res.arrayBuffer());
}

export async function adoptBytes(name: string, bytes: ArrayBuffer) {
  if (!session.projectRestoring && !confirmDiscard()) return;
  session.meshEpoch += 1;
  session.chosenZ = null;
  state.mesh = { name, bytes };
  state.error = "";
  state.orient = ID_MATRIX;
  state.partScale = 1;
  state.stepTolerance = 0.1;
  state.centered = true;
  state.offset = { x: 0, y: 0, z: 0 };
  state.supportEdits = clearEdits();
  state.supportPaint = [];
  state.seamPaint = [];
  state.overrides = emptyOverrides();
  state.selectedVolumeId = null;
  clearEditHistory();
  session.supportUi?.reset();
  const parsed = needsEngine(name) ? null : parseStl(bytes);
  if (!needsEngine(name) && !parsed) {
    state.mesh = null;
    state.sourcePos = null;
    state.plate = emptyPlate();
    resetHeldGeometry();
    state.error = `Could not read ${name}.`;
    pushToast(state.error, "error", { label: "Retry", run: openMeshPicker });
    renderChrome();
    return;
  }
  state.sourcePos = parsed ?? (await previewRemote(name, bytes));
  if (!state.sourcePos) {
    state.plate = emptyPlate();
    resetHeldGeometry();
    if (!state.engine) pushToast(state.error || `Could not read ${name}.`, "error", { label: "Retry", run: openMeshPicker });
    renderChrome();
    return;
  }
  state.plate = oneObjectPlate({
    name,
    fileName: name,
    bytes,
    sourcePos: state.sourcePos,
    orient: state.orient,
    partScale: state.partScale,
    centered: state.centered,
    offset: state.offset,
    stepTolerance: state.stepTolerance,
    supportEdits: state.supportEdits,
    supportPaint: state.supportPaint,
    seamPaint: state.seamPaint,
  });
  if (/\.3mf$/i.test(name)) {
    const vendor = foreignSlicer3mf(new Uint8Array(bytes));
    if (vendor) pushToast(foreign3mfMessage(vendor), "info");
  }
  place("load");
  fx.setStage("prepare");
}

export async function previewRemote(name: string, bytes: ArrayBuffer): Promise<Float32Array | null> {
  const payload = { filename: name, dataB64: bytesToBase64(new Uint8Array(bytes)), stepToleranceMm: state.stepTolerance };
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  try {
    let body: { positions?: number[]; error?: string };
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      body = JSON.parse(await invoke<string>("preview_mesh", { payload: JSON.stringify(payload) }));
    } else {
      const res = await fetch(`${apiBase()}/api/mesh`, { method: "POST", headers: authHeaders(apiToken(), { "Content-Type": "application/json" }), body: JSON.stringify(payload) });
      body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not preview this mesh.");
    }
    if (!body.positions) throw new Error(body.error || "Could not preview this mesh.");
    return new Float32Array(body.positions);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not preview this mesh.";
    state.error = message === "Failed to fetch"
      ? `STEP and 3MF need the slicer engine at ${apiBase()}. Start it with cargo run -p lime-slice --release -- serve.`
      : message;
    if (message === "Failed to fetch") markEngineDown(engineDownMessage(apiBase()));
    return null;
  }
}

export async function refreshStepPreview() {
  if (!state.mesh || !isStepName(state.mesh.name)) return;
  const positions = await previewRemote(state.mesh.name, state.mesh.bytes);
  if (!positions) {
    renderChrome();
    return;
  }
  state.error = "";
  state.sourcePos = positions;
  place("transform");
}

export function place(sync: SplitSync = "transform") {
  applyPlace(true, sync);
}

export function applyPlace(rerender: boolean, sync: SplitSync = "transform") {
  syncPlateFromState();
  state.placed = currentPlacement();
  if (!state.placed) {
    fx.prepare.setMesh(null);
    fx.prepare.setPlateBounds?.([]);
    if (rerender) renderChrome();
    return;
  }
  fx.realignSplit(sync);
  fx.prepare.setMesh(state.placed, sync === "load");
  fx.syncCut();
  fx.drawPaint?.();
  fx.prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
  fx.prepare.setPlateBounds(boundEntries(state.plate, state.profile.bedX, state.profile.bedY));
  paintPlaceFields();
  markProjectDirty();
  markStale();
  if (rerender) renderChrome();
}

/** Move the placed part on one axis. X/Y also slides the sliced preview. */
export function nudgePlacement(axis: "x" | "y" | "z", deltaMm: number) {
  if (!state.sourcePos || !Number.isFinite(deltaMm) || deltaMm === 0) return;
  if (state.centered) {
    state.offset = centeringShift(state.sourcePos, state.orient, state.partScale, state.profile.bedX, state.profile.bedY);
    state.centered = false;
  }
  state.offset = {
    x: state.offset.x + (axis === "x" ? deltaMm : 0),
    y: state.offset.y + (axis === "y" ? deltaMm : 0),
    z: state.offset.z + (axis === "z" ? deltaMm : 0),
  };
  applyPlace(false);
}

/** Put the part's bounds center on this bed X or Y. */
export function setPlaceCenter(axis: "x" | "y", mm: number) {
  const placed = state.placed;
  if (!placed || !Number.isFinite(mm)) return;
  const i = axis === "x" ? 0 : 1;
  const current = (placed.bounds.min[i] + placed.bounds.max[i]) / 2;
  nudgePlacement(axis, mm - current);
}

function paintPlaceFields() {
  const bounds = state.placed?.bounds;
  if (!bounds) return;
  const cx = ((bounds.min[0] + bounds.max[0]) / 2).toFixed(1);
  const cy = ((bounds.min[1] + bounds.max[1]) / 2).toFixed(1);
  const row = document.querySelector<HTMLElement>("#placeXY");
  if (row) row.dataset.bedZ = bounds.min[2].toFixed(1);
  for (const [id, value] of [["placeX", cx], ["placeY", cy]] as const) {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    if (input && document.activeElement !== input) input.value = value;
  }
}

let placing: { source: Float32Array; key: string; placement: PlacedPart } | null = null;

/** Placement of the current mesh and pose. The slice request and both views share one build per change. */
export function currentPlacement(): PlacedPart | null {
  const source = state.sourcePos;
  if (!source) return null;
  const key = JSON.stringify([state.orient, state.partScale, state.profile.bedX, state.profile.bedY, state.centered, state.offset]);
  if (placing?.source !== source || placing.key !== key) {
    const placement = placeMesh(source, state.orient, state.partScale, state.profile.bedX, state.profile.bedY, state.centered, state.offset);
    placing = { source, key, placement: Object.assign(placement, { canonical: canonicalMesh(source) }) };
  }
  return placing.placement;
}

let canonical: { source: Float32Array; scale: number; positions: Float32Array } | null = null;

/** The scaled, unposed vertices: what the engine is sent and what both views draw under the pose matrix. */
function canonicalMesh(source: Float32Array) {
  if (canonical?.source !== source || canonical.scale !== state.partScale) {
    canonical = { source, scale: state.partScale, positions: scaledCanonical(source, state.partScale) };
  }
  return canonical.positions;
}

/** The bytes `meshBytes` last built, and their Base64, for the mesh and scale they came from. */
let encoded: { source: ArrayBuffer | Float32Array | null; scale: number; name: string; bytes: ArrayBuffer; b64?: string } | null = null;

/** The mesh as the engine takes it. Encoded once per mesh and scale, not once per slice. */
export function meshBytes() {
  const source = state.sourcePos ?? state.mesh?.bytes ?? null;
  const name = state.mesh?.name ?? "part";
  if (encoded && encoded.source === source && encoded.scale === state.partScale && encoded.name === name) return encoded.bytes;
  const bytes = !state.sourcePos ? (state.mesh?.bytes ?? new ArrayBuffer(0)) : encodeStl(canonicalMesh(state.sourcePos), name);
  encoded = { source, scale: state.partScale, name, bytes };
  return bytes;
}

/** `meshBytes` in Base64, kept with them. */
export function meshBase64() {
  const bytes = meshBytes();
  encoded!.b64 ??= bytesToBase64(new Uint8Array(bytes));
  return encoded!.b64;
}

/** The plate's objects, the selected one as the pose tools hold it now. */
export function livePlate(): PlateObject[] {
  if (!state.sourcePos || !state.mesh) return state.plate.objects;
  return withLivePose(state.plate, {
    fileName: state.mesh.name,
    sourcePos: state.sourcePos,
    orient: state.orient,
    partScale: state.partScale,
    centered: state.centered,
    offset: state.offset,
    stepTolerance: state.stepTolerance,
    supportEdits: state.supportEdits,
    supportPaint: state.supportPaint,
    seamPaint: state.seamPaint,
  });
}

/** One object's placement on the bed, kept until its pose or mesh changes. */
const placed = new Map<string, { source: Float32Array; key: string; placement: Placement }>();
export function objectPlacement(obj: PlateObject): Placement {
  const key = JSON.stringify([obj.orient, obj.partScale, state.profile.bedX, state.profile.bedY, obj.centered, obj.offset]);
  const held = placed.get(obj.id);
  if (held?.source === obj.sourcePos && held.key === key) return held.placement;
  const placement = placeObject(obj, state.profile.bedX, state.profile.bedY);
  placed.set(obj.id, { source: obj.sourcePos, key, placement });
  return placement;
}

/** One object's scaled, unposed mesh as the engine is sent it, with its Base64 and fingerprint once asked. */
interface ObjectMesh {
  source: Float32Array;
  scale: number;
  bytes: ArrayBuffer;
  b64?: string;
  finger?: string;
}
const objectMeshes = new Map<string, ObjectMesh>();
function objectMesh(obj: PlateObject): ObjectMesh {
  const held = objectMeshes.get(obj.id);
  if (held?.source === obj.sourcePos && held.scale === obj.partScale) return held;
  const mesh = { source: obj.sourcePos, scale: obj.partScale, bytes: encodeStl(scaledCanonical(obj.sourcePos, obj.partScale), obj.fileName) };
  objectMeshes.set(obj.id, mesh);
  return mesh;
}

export function objectBase64(obj: PlateObject): string {
  const mesh = objectMesh(obj);
  return (mesh.b64 ??= bytesToBase64(new Uint8Array(mesh.bytes)));
}

export function objectFingerprint(obj: PlateObject): string {
  const mesh = objectMesh(obj);
  return (mesh.finger ??= meshKeyHex(new Uint8Array(mesh.bytes)));
}

/** A slice request with its mesh bytes on: each object's own for a plate, else the one mesh's. */
export function withMeshData(req: Record<string, unknown>): Record<string, unknown> {
  const objects = req.objects as { id: string }[] | undefined;
  if (!objects) return { ...req, dataB64: meshBase64() };
  const live = new Map(livePlate().map((obj) => [obj.id, obj]));
  return { ...req, objects: objects.map((o) => ({ ...o, dataB64: objectBase64(live.get(o.id)!) })) };
}

export function isTauri() {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

export async function saveText(text: string, name: string, extension: string) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_text_file", { text, defaultName: name, extension });
    return;
  }
  const picker = (window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description: extension, accept: { "application/octet-stream": [`.${extension}`] } }] });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  download(text, name);
}

export async function fetchStoredGcode(token: string) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("gcode_text", { token });
  }
  const res = await fetch(`${apiBase()}/api/gcode/${token}`, { headers: authHeaders(apiToken()) });
  if (!res.ok) throw new Error("G-code is no longer available. Slice again.");
  return res.text();
}

/** The G-code to print: the engine's, with the footer's grams at the profile's density, then the printer's start and end text. */
export async function printableGcode(result: SliceResponse) {
  const text = await fx.loadGcode(result);
  if (!text) return text;
  return withPrinterGcode(withFooterGrams(text, shownGrams(result)));
}

/** `gcode` with the selected printer's start and end text, as Export and Send write it. */
export function withPrinterGcode(gcode: string) {
  const picked = selection(loadMachineLibrary());
  if (!picked) return gcode;
  return withMachineGcode(
    gcode,
    spliceText(picked.printer.startGcode, legacyStockStart(picked.printer.name)),
    spliceText(picked.printer.endGcode, legacyStockEnd(picked.printer.name)),
  );
}

export async function exportGcode() {
  const result = state.result;
  if (!result || stale()) return;
  let text: string;
  try {
    text = await printableGcode(result);
  } catch {
    return;
  }
  if (!text) {
    state.error = "No G-code for this slice.";
    renderChrome();
    return;
  }
  const minutes = Math.max(1, Math.round((result.estimate?.seconds ?? 0) / 60));
  const grams = shownGrams(result).toFixed(0);
  const base = (state.mesh?.name ?? "part").replace(/\.(stl|3mf|step|stp)$/i, "");
  const blend = card();
  await saveText(text, `${base}_${blend}_${minutes}m_${grams}g.gcode`, "gcode");
}

export async function export3mf() {
  if (!state.placed) return;
  const bytes = encode3mf(state.placed.positions);
  const name = `${(state.mesh?.name ?? "part").replace(/\.(stl|3mf|step|stp)$/i, "")}.3mf`;
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_text_file", { text: "", defaultName: name, extension: "3mf", bytesB64: bytesToBase64(bytes) });
    return;
  }
  const blob = new Blob([bytes], { type: "model/3mf" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function download(text: string, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function openMeshPicker() {
  document.querySelector<HTMLInputElement>("#file")?.click();
}

export function fail(err: unknown) {
  state.error = err instanceof Error ? err.message : String(err);
  state.busy = false;
  renderChrome();
}
Object.assign(fx, { printableGcode, loadNamed, adoptBytes, previewRemote, refreshStepPreview, place, applyPlace, nudgePlacement, setPlaceCenter, meshBytes, isTauri, saveText, fetchStoredGcode, exportGcode, export3mf, download, fail });
