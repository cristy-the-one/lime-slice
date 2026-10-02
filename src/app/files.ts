import { fx } from "./fx";
import { state, session } from "./state";
import { ID_MATRIX, parseStl, transformPositions, encodeStl, scaledCanonical, encode3mf } from "../mesh-place";
import { needsEngine, apiBase, apiToken, markEngineDown, isStepName, renderChrome, markStale, stale, card } from "./settings";
import { authHeaders, engineDownMessage } from "../ui/api-base";
import { type SplitSync } from "../split-at";

export async function loadNamed(name: string) {
  state.error = "";
  const res = await fetch(`/samples/${name}`);
  if (!res.ok) throw new Error(`could not load ${name}`);
  await adoptBytes(name, await res.arrayBuffer());
}

export async function adoptBytes(name: string, bytes: ArrayBuffer) {
  session.meshEpoch += 1;
  session.chosenZ = null;
  state.mesh = { name, bytes };
  state.error = "";
  state.orient = ID_MATRIX;
  state.partScale = 1;
  state.stepTolerance = 0.1;
  state.centered = true;
  state.offset = { x: 0, y: 0, z: 0 };
  const parsed = needsEngine(name) ? null : parseStl(bytes);
  state.sourcePos = parsed ?? (await previewRemote(name, bytes));
  place("load");
  fx.setStage("prepare");
}

export async function previewRemote(name: string, bytes: ArrayBuffer): Promise<Float32Array | null> {
  const payload = { filename: name, dataB64: toBase64(new Uint8Array(bytes)), stepToleranceMm: state.stepTolerance };
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
  if (!state.sourcePos) {
    state.placed = null;
    fx.prepare.setMesh(null);
    if (rerender) renderChrome();
    return;
  }
  state.placed = transformPositions(state.sourcePos, state.orient, state.partScale, state.profile.bedX, state.profile.bedY, state.centered, state.offset);
  fx.realignSplit(sync);
  fx.prepare.setMesh(state.placed, sync === "load");
  fx.prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
  markStale();
  if (rerender) renderChrome();
}

export function meshBytes() {
  if (!state.sourcePos) return state.mesh?.bytes ?? new ArrayBuffer(0);
  return encodeStl(scaledCanonical(state.sourcePos, state.partScale), state.mesh?.name ?? "part");
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
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

export async function exportGcode() {
  const result = state.result;
  if (!result || stale()) return;
  let text: string;
  try {
    text = await fx.loadGcode(result);
  } catch {
    return;
  }
  if (!text) {
    state.error = "No G-code for this slice.";
    renderChrome();
    return;
  }
  const minutes = Math.max(1, Math.round((result.estimate?.seconds ?? 0) / 60));
  const grams = (result.estimate?.filamentG ?? 0).toFixed(0);
  const base = (state.mesh?.name ?? "part").replace(/\.(stl|3mf|step|stp)$/i, "");
  const blend = card();
  await saveText(text, `${base}_${blend}_${minutes}m_${grams}g.gcode`, "gcode");
}

export async function export3mf() {
  if (!state.placed) return;
  const bytes = encode3mf(state.placed);
  const name = `${(state.mesh?.name ?? "part").replace(/\.(stl|3mf|step|stp)$/i, "")}.3mf`;
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_text_file", { text: "", defaultName: name, extension: "3mf", bytesB64: toBase64(bytes) });
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

export function fail(err: unknown) {
  state.error = err instanceof Error ? err.message : String(err);
  state.busy = false;
  renderChrome();
}
Object.assign(fx, { loadNamed, adoptBytes, previewRemote, refreshStepPreview, place, applyPlace, meshBytes, toBase64, isTauri, saveText, fetchStoredGcode, exportGcode, export3mf, download, fail });
