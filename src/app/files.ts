import { fx } from "./fx";
import { state, session, STEP_TOLERANCE_DEFAULT } from "./state";
import { centeringShift, eulerOrient, formatDeg, ID_MATRIX, orientEuler, parseStl, placeMesh, encodeStl, scaledCanonical, encode3mf, type PlacedPart, type Placement } from "../mesh-place";
import { meshKeyHex } from "../slice-action";
import { bytesToBase64 } from "../base64";
import { needsEngine, apiBase, apiToken, markEngineDown, isStepName, renderChrome, markStale, stale, card, shownGrams } from "./settings";
import { withFooterGrams } from "../estimate";
import { legacyStockEnd, legacyStockStart, spliceText, withMachineGcode } from "../machine-gcode";
import { withPrintMeta } from "../print-meta";
import { activeHeat, loadMachineLibrary } from "./machine-library";
import { heatNotes, selection } from "../ui/machine-library";
import type { SliceResponse } from "./state";
import { authHeaders, engineDownMessage } from "../ui/api-base";
import { type SplitSync } from "../split-at";
import { confirmDiscard, markProjectDirty } from "../project-dirty";
import { pushToast } from "../ui/toasts";
import { clearEdits } from "../support-edit-list";
import { clearEditHistory, flushEdit, noteEdit } from "./history";
import { extractForeign3mfRecipe, foreign3mfMessage, foreignRecipeOffer, foreignSlicer3mf, type ForeignRecipe } from "../foreign-3mf";
import { assemblyNotice, shellCount } from "../mesh-shells";
import { emptyOverrides } from "../overrides";
import { isLimeProject } from "../file-drop";
import { addedMesh, boundEntries, emptyPlate, oneObjectPlate, placeObject, plateObjectPositions, resetHeldGeometry, setSelectedOverride, withLivePose, type PlateObject } from "../plate";
import { supportModeState } from "../support-source";
import { applySelectedToState, syncPlateFromState } from "./plate-sync";

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
  state.stepTolerance = STEP_TOLERANCE_DEFAULT;
  state.centered = true;
  state.offset = { x: 0, y: 0, z: 0 };
  state.supportEdits = clearEdits();
  state.supportPaint = [];
  state.seamPaint = [];
  state.reinforcement = [];
  state.overrides = emptyOverrides();
  state.selectedVolumeId = null;
  state.layerActions = [];
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
    reinforcement: state.reinforcement,
  });
  offerAssemblySplit(name, state.sourcePos, state.plate.selectedId);
  place("load");
  await offerForeignRecipe(name, bytes);
  fx.setStage("prepare");
  // An Add that started during this read was aimed at the plate it replaced.
  session.meshEpoch += 1;
}

export async function previewRemote(name: string, bytes: ArrayBuffer, stepToleranceMm = state.stepTolerance): Promise<Float32Array | null> {
  const payload = { filename: name, dataB64: bytesToBase64(new Uint8Array(bytes)), stepToleranceMm };
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
  const name = state.mesh.name;
  const bytes = state.mesh.bytes;
  const epoch = session.meshEpoch;
  const positions = await previewRemote(name, bytes);
  if (!positions) {
    renderChrome();
    return;
  }
  // Open, or Add selecting another file, moved on while this preview was in flight.
  if (session.meshEpoch !== epoch || state.mesh?.name !== name || state.mesh.bytes !== bytes) return;
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

/** Replace one Euler angle and rebuild the pose the rotate rings compose. */
export function setOrientAngle(axis: "x" | "y" | "z", deg: number) {
  if (!state.sourcePos || !Number.isFinite(deg)) return;
  const euler = orientEuler(state.orient);
  if (axis === "x") euler.rx = deg;
  else if (axis === "y") euler.ry = deg;
  else euler.rz = deg;
  state.orient = eulerOrient(euler.rx, euler.ry, euler.rz);
  applyPlace(false);
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
  const euler = orientEuler(state.orient);
  for (const [id, value] of [["placeRx", euler.rx], ["placeRy", euler.ry], ["placeRz", euler.rz]] as const) {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    if (input && document.activeElement !== input) input.value = formatDeg(value);
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
    reinforcement: state.reinforcement,
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

const APP_VERSION: string = __APP_VERSION__;

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

/** The G-code to print: the engine's, with the footer's grams at the profile's density, then progress and estimates, then the printer's start and end text. */
export async function printableGcode(result: SliceResponse) {
  const text = await fx.loadGcode(result);
  if (!text) return text;
  const seconds = result.layers.map((layer) => layer.seconds);
  const known = seconds.length > 0 && seconds.every((s): s is number => s !== undefined);
  return withPrinterGcode(withFooterGrams(text, shownGrams(result)), { layerSeconds: known ? seconds : [], layerHeight: state.layerHeight });
}

/** What a slice knows that a calibration file does not: its layer times and height. */
interface RunMeta {
  layerSeconds: readonly number[];
  layerHeight: number;
}

/** `gcode` with the print metadata printers read and the selected printer's start and end text, as Export and Send write it. */
export function withPrinterGcode(gcode: string, run?: RunMeta) {
  const library = loadMachineLibrary();
  const picked = selection(library);
  const stamped = withPrintMeta(gcode, {
    now: new Date(),
    version: APP_VERSION,
    layerSeconds: run?.layerSeconds ?? [],
    layerHeight: run?.layerHeight,
    nozzleDiameter: picked ? library.nozzleMm : undefined,
    filamentType: picked && picked.filament.material !== "Saved" ? picked.filament.material : undefined,
  });
  if (!picked) return stamped;
  // The engine was sent the capped temperatures, so the file already carries them.
  const heat = activeHeat(library);
  return withMachineGcode(
    stamped,
    spliceText(picked.printer.startGcode, legacyStockStart(picked.printer.name)),
    spliceText(picked.printer.endGcode, legacyStockEnd(picked.printer.name)),
    { startOwnsHoming: picked.printer.startOwnsHoming, heat, notes: heatNotes(heat) },
  );
}

/** Save the G-code. A missing or stale slice is made first, so Export needs only a mesh. */
export async function exportGcode() {
  if (!state.mesh || state.busy) return;
  if (!state.result || stale()) await fx.runSlice(false);
  const result = state.result;
  // The slice failed or the settings moved while it ran: the user sees why and presses Export again.
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
  syncPlateFromState();
  const objects = livePlate();
  const positions = objects.length > 1
    ? plateObjectPositions(objects, state.profile.bedX, state.profile.bedY)
    : state.placed.positions;
  const bytes = encode3mf(positions);
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

/** The Add object picker. Cancel leaves the plate alone: the change handler returns when no file was chosen. */
export function pickAddedMesh() {
  const input = document.querySelector<HTMLInputElement>("#plateAddFile");
  if (!input || !state.mesh || state.plate.objects.length === 0) return;
  input.value = "";
  input.click();
}

let meshAdds: Promise<void> = Promise.resolve();

/** True when Add can park another part: a mesh is already on the plate. */
export function plateHasMesh(): boolean {
  return state.mesh != null && state.sourcePos != null && state.plate.objects.length > 0;
}

/** Read `bytes` the way Open does, then add that part. One undo step once the mesh is in hand. */
export function addMeshBytes(name: string, bytes: ArrayBuffer): Promise<void> {
  const run = meshAdds.then(() => addMeshNow(name, bytes));
  meshAdds = run.then(() => undefined, () => undefined);
  return run;
}

/** Shift+drop. Each file goes through Add, in drop order. One undo step per mesh that lands. */
export async function addDroppedFiles(files: readonly File[]): Promise<void> {
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    await addMeshBytes(file.name, bytes);
  }
}

async function meshPositions(name: string, bytes: ArrayBuffer, stepTolerance: number): Promise<Float32Array | null> {
  if (!needsEngine(name)) return parseStl(bytes);
  return previewRemote(name, bytes, stepTolerance);
}

async function addMeshNow(name: string, bytes: ArrayBuffer) {
  if (!plateHasMesh()) return;
  if (isLimeProject(name)) {
    pushToast("Open a project from the File menu.", "info");
    return;
  }
  const stepTolerance = state.stepTolerance;
  const epoch = session.meshEpoch;
  const sourcePos = await meshPositions(name, bytes, stepTolerance);
  if (session.meshEpoch !== epoch || !state.mesh || state.plate.objects.length === 0) return;
  if (!sourcePos || sourcePos.length < 9) {
    if (!needsEngine(name) || !state.error) state.error = `Could not read ${name}.`;
    pushToast(state.error, "error", { label: "Retry", run: pickAddedMesh });
    renderChrome();
    return;
  }
  // Close anything still open so this add is its own undo step.
  flushEdit();
  noteEdit();
  syncPlateFromState();
  const next = addedMesh(state.plate, { name, fileName: name, bytes, sourcePos, stepTolerance }, state.profile.bedX, state.profile.bedY);
  if (!next) {
    flushEdit();
    return;
  }
  state.error = "";
  state.plate = next;
  applySelectedToState(state.plate);
  offerAssemblySplit(name, sourcePos, state.plate.selectedId);
  place();
  flushEdit();
  await offerForeignRecipe(name, bytes);
}

async function offerForeignRecipe(name: string, bytes: ArrayBuffer) {
  if (!/\.3mf$/i.test(name)) return;
  const raw = new Uint8Array(bytes);
  const vendor = foreignSlicer3mf(raw);
  if (!vendor) return;
  const epoch = session.meshEpoch;
  const recipe = session.projectRestoring ? null : await extractForeign3mfRecipe(raw).catch(() => null);
  if (session.meshEpoch !== epoch) return;
  const offer = recipe ? foreignRecipeOffer(recipe) : null;
  if (!offer || !recipe) {
    pushToast(foreign3mfMessage(vendor), "info");
    return;
  }
  pushToast(offer, "info", [
    { label: "Apply to Recipe", run: () => applyForeignRecipe(recipe) },
    { label: "Keep Current", run: () => {} },
  ]);
}

function applyForeignRecipe(recipe: ForeignRecipe) {
  noteEdit();
  if (recipe.layerHeightMm !== undefined) state.layerHeight = recipe.layerHeightMm;
  if (recipe.supports !== undefined) Object.assign(state, supportModeState(recipe.supports ? "auto" : "off"));
  if (recipe.walls !== undefined) state.plate = setSelectedOverride(state.plate, "walls", recipe.walls);
  if (recipe.infill !== undefined) state.plate = setSelectedOverride(state.plate, "infill", recipe.infill);
  markProjectDirty();
  renderChrome();
  markStale();
  flushEdit();
}

function offerAssemblySplit(name: string, positions: Float32Array | null, id: string | null) {
  if (session.projectRestoring || !positions || !id) return;
  const notice = assemblyNotice(name, shellCount(positions));
  if (!notice) return;
  pushToast(notice.message, "info", { label: notice.label, run: () => { fx.separateShells?.(id); } });
}

export function fail(err: unknown) {
  state.error = err instanceof Error ? err.message : String(err);
  state.busy = false;
  renderChrome();
}
Object.assign(fx, { printableGcode, loadNamed, adoptBytes, previewRemote, refreshStepPreview, place, applyPlace, nudgePlacement, setPlaceCenter, setOrientAngle, meshBytes, isTauri, saveText, fetchStoredGcode, exportGcode, export3mf, download, fail });
