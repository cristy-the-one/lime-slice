import { fx } from "./fx";
import { state, session, worker, cachedRecipes, type ParetoPoint, type SliceResponse } from "./state";
import { meshKeyHex, partFrameKey, quietRefresh, recipeKey, type SliceAction, sliceAction, sliceBusyLabel, storesReply, FORCE_LABEL } from "../slice-action";
import { currentPlacement, livePlate, meshBase64, meshBytes, fail, isTauri, objectBase64, objectFingerprint, objectPlacement, withMeshData } from "./files";
import { MeshRefs, sendWithMeshes, unknownMeshRef, type MeshFields, type SentMesh } from "../mesh-refs";
import { adoptPatch, previewBase } from "./viewer";
import { blend, renderChrome, settingsHash, markBusy, paintBanner, busyText, markEngineDown, apiBase, stale, apiToken, touch } from "./settings";
import { editRequestFields } from "../support-edit-list";
import { replyOffset, type SlicedBed } from "../bed-offset";
import { sliceOverrideFields } from "../overrides";
import { sliceFuzzyFields } from "../fuzzy-skin";
import { ironingSpacingMax, sliceIroningFields } from "../ironing";
import { seamSliceField } from "../seam";
import { plateListed, slicePlateFields, sourceFrame, type PlateObject, type PlateRequestObject } from "../plate";
import { seamRequestFields } from "../seam-paint";
import { paintRequestFields } from "../support-paint";
import { noteTally } from "./paint-actions";
import { loadMachineLibrary } from "./machine-library";
import { beltStamp } from "../ui/machine-library";
import { beltSliceField } from "../belt";
import { flowSliceField } from "../flow";
import { engineDownMessage, authHeaders } from "../ui/api-base";
import { topLayerIndex } from "../ui/preview-ux";
import { pushToast } from "../ui/toasts";
import {
  beginSliceJob,
  browserJobEvents,
  cancelJob,
  errorText,
  followJobProgress,
  formatStageLine,
  getText,
  jobEventsUrl,
  parseJobSnapshot,
  postJson,
  type JobSnapshot,
  type JobStatus,
} from "../ui/slice-job";

/** The desktop shell's `slice-progress` event. `message` is `stageLabel(stage)`. */
type DesktopProgress = { progress: number; message: string; stage: string; done: number; total: number; status: JobStatus };

export function meshFingerprint(): string {
  if (plateListed(state.plate)) return livePlate().map(objectFingerprint).join(",");
  const source = state.sourcePos ?? state.mesh?.bytes ?? null;
  if (source && source === session.fingerSource && state.partScale === session.fingerScale) return session.finger;
  session.fingerSource = source;
  session.fingerScale = state.partScale;
  session.finger = source ? meshKeyHex(new Uint8Array(meshBytes())) : "";
  return session.finger;
}

export function currentRecipeKey(): string | null {
  if (!state.mesh) return null;
  return recipeKey(payload(), meshFingerprint());
}

export function currentSliceAction(force = false): SliceAction {
  const recipe = currentRecipeKey();
  return sliceAction({
    cached: recipe !== null && cachedRecipes.has(recipe),
    settingsChanged: session.shownRecipe !== null && recipe !== session.shownRecipe,
    force,
  });
}

export function setButtonLabel(button: HTMLButtonElement, label: string) {
  let slot = button.querySelector<HTMLElement>(".btn-label");
  if (!slot) {
    slot = document.createElement("span");
    slot.className = "btn-label";
    button.replaceChildren(slot);
  }
  slot.textContent = label;
}

export function paintSliceButton(button: HTMLButtonElement) {
  const action = currentSliceAction(false);
  const label = state.busy ? sliceBusyLabel(session.busyRecompute) : action.label;
  setButtonLabel(button, label);
  button.dataset.tip = state.busy ? "" : action.detail;
  button.removeAttribute("title");
  button.setAttribute("aria-label", label);
  button.dataset.sliceAction = state.busy ? "busy" : action.state;
  const showSaved = !state.busy && action.state === "cached";
  button.classList.toggle("show-result", showSaved);
  button.classList.toggle("primary", !showSaved);
  button.classList.toggle("reslice", !state.busy && action.state === "changed");
}

export function paintForceButton(button: HTMLButtonElement) {
  const action = currentSliceAction(true);
  const ready = !state.busy && !!state.mesh && action.state === "force";
  setButtonLabel(button, FORCE_LABEL);
  button.hidden = !ready;
  button.dataset.tip = action.detail;
  button.removeAttribute("title");
  button.setAttribute("aria-label", FORCE_LABEL);
}

function quietEligible(): boolean {
  if (!state.mesh) return false;
  const request = payload();
  const fingerprint = meshFingerprint();
  return quietRefresh({
    stale: stale(),
    cached: cachedRecipes.has(recipeKey(request, fingerprint)),
    sameFrame: session.slicedFrame === partFrameKey(request, fingerprint),
  });
}

/** The stale result is refreshing by itself: waiting out the pause, or its request is in flight. */
export function quietRefreshing(): boolean {
  return quietEligible() && (state.busy || session.quietTried !== settingsHash());
}

function runQuiet() {
  if (state.busy || !quietEligible()) return;
  session.quietTried = settingsHash();
  void runSlice();
}

export function scheduleAuto() {
  window.clearTimeout(session.autoTimer);
  if (!state.mesh || state.busy) return;
  if (quietEligible() && session.quietTried !== settingsHash()) {
    // A gizmo drag refreshes once, at drag end.
    if (!state.poseHud) session.autoTimer = window.setTimeout(runQuiet, 200);
    return;
  }
  if (!state.autoSlice) return;
  const tris = state.result?.mesh.sourceTriangles ?? state.result?.mesh.triangles ?? Math.max(0, (state.mesh.bytes.byteLength - 84) / 50);
  if (tris >= 50000) return;
  session.autoTimer = window.setTimeout(() => void runSlice(), 300);
}

export function payload() {
  // One object with no settings of its own sends today's body; any other plate sends `objects`.
  const listed = plateListed(state.plate);
  const objects = listed ? livePlate() : [];
  const one = listed
    ? {}
    : {
        filename: state.sourcePos ? (state.mesh!.name || "part").replace(/\.(3mf|step|stp)$/i, ".stl") : (state.mesh!.name || "part"),
        pose: currentPlacement()?.pose,
        ...editRequestFields(state.supportEdits, treeSupports()),
        ...(state.sourcePos ? paintRequestFields(state.supportPaint, sourceFrame(state.sourcePos, state.partScale)) : {}),
        ...(state.sourcePos ? seamRequestFields(state.seamPaint, sourceFrame(state.sourcePos, state.partScale)) : {}),
      };
  const plate = listed
    ? {
        ...slicePlateFields(objects, (obj) => objectPlacement(obj).pose, { supports: state.supports, supportStyle: state.supportStyle }),
        ...(objects.some((obj) => objectTree(obj)) ? { includeSkeleton: true } : {}),
      }
    : {};
  return {
    ...one,
    stepToleranceMm: state.stepTolerance,
    layerHeight: state.layerHeight,
    lineWidth: lineWidth(),
    blend: blend(),
    adaptive: state.adaptive,
    adaptiveMin: state.adaptiveMin,
    adaptiveMax: state.adaptiveMax,
    supports: state.supports,
    supportAngle: state.supportAngle,
    supportStyle: state.supportStyle,
    branchAngle: state.branchAngle,
    tipDiameter: state.tipDiameter,
    trunkDiameter: state.trunkDiameter,
    supportHeightMult: state.supportHeightMult,
    infillCombine: state.infillCombine,
    combing: state.combing,
    featureSpeeds: state.featureSpeeds,
    printer: printer(),
    // Omitted at 1, so a filament that does not scale extrusion keeps its recipe key.
    ...flowSliceField(state.flow),
    ...retractSliceFields(),
    // Beside `printer`, and omitted for a cartesian machine, so that recipe stays the same bytes.
    ...beltSliceField(beltStamp(loadMachineLibrary()), state.supports),
    variableWidth: state.variableWidth,
    arcFit: state.arcFit,
    travelOpt: state.travelOpt,
    overhangControl: state.overhangControl,
    // Blend is left out, so a default slice keeps its bytes and its recipe key.
    ...seamSliceField(state.seam),
    // Off is left out, so a slice that does not iron keeps its bytes and its recipe key.
    ...sliceIroningFields({ on: state.ironing, flow: state.ironingFlow, speed: state.ironingSpeed, spacing: Math.min(state.ironingSpacing, ironingSpacingMax(lineWidth())) }),
    // Off is left out, so a slice that does not ask for fuzzy skin keeps its bytes and its recipe key.
    ...sliceFuzzyFields({ on: state.fuzzySkin, thickness: state.fuzzyThickness, pointDistance: state.fuzzyPointDistance }),
    scarfSeam: state.scarfSeam,
    scarfLength: state.scarfLength,
    scarfSteps: state.scarfSteps,
    scarfStartHeight: 0.15,
    scarfStartFlow: 0.55,
    gyroid3d: state.gyroid3d,
    zHop: state.zHop,
    zHopHeight: state.zHopHeight,
    zHopMinTravel: state.zHopMinTravel,
    baseline: false,
    compare: false,
    includeGcode: false,
    includePreview: true,
    simplify: state.simplify,
    simplifyErrorMm: state.simplifyError,
    ...sliceOverrideFields(state.overrides),
    ...plate,
    ...orderSliceFields(),
  };
}

/**
 * All-at-once is omitted. Clearance and gantry height are omitted at 0, which
 * means the engine's 35 mm toolhead and 20 mm gantry.
 */
function orderSliceFields(): { printOrder?: "sequential"; sequentialClearanceMm?: number; sequentialGantryMm?: number } {
  if (state.plate.objects.length < 2 || state.printOrder !== "sequential") return {};
  const out: { printOrder: "sequential"; sequentialClearanceMm?: number; sequentialGantryMm?: number } = { printOrder: "sequential" };
  const gap = state.sequentialClearance;
  if (Number.isFinite(gap) && gap > 0) out.sequentialClearanceMm = Math.min(100, Math.round(gap * 1000) / 1000);
  const gantry = state.sequentialGantry;
  if (Number.isFinite(gantry) && gantry > 0) out.sequentialGantryMm = Math.min(500, Math.round(gantry * 1000) / 1000);
  return out;
}

/** The selected object prints tree supports, so its support edits travel with the slice. */
export function lineWidth() {
  return Math.min(1.2, Math.max(0.2, state.profile.nozzleDiameter * 1.125));
}

export function treeSupports() {
  const obj = plateListed(state.plate) ? state.plate.objects.find((o) => o.id === state.plate.selectedId) : undefined;
  return obj ? objectTree(obj) : state.supports && state.supportStyle === "tree";
}

function objectTree(obj: PlateObject): boolean {
  return (obj.settings.supports ?? state.supports) && (obj.settings.supportStyle ?? state.supportStyle) === "tree";
}

/**
 * The printer as a slice request sends it. Filament density and price are left
 * out: they change no toolpath, and the UI turns the reply's filament length
 * into grams and cost itself, so editing them never makes a slice stale.
 */
function retractSliceFields(): { retractLength?: number; retractSpeed?: number } {
  if (!state.retractOn) return {};
  const length = Math.min(5, Math.max(0, Math.round(state.retractLength * 1000) / 1000));
  const out: { retractLength: number; retractSpeed?: number } = { retractLength: length };
  if (Number.isFinite(state.retractSpeed) && Math.abs(state.retractSpeed - 30) > 1e-6) {
    out.retractSpeed = Math.min(80, Math.max(5, Math.round(state.retractSpeed)));
  }
  return out;
}

export function printer() {
  const { filamentDensityGCm3: _density, filamentCostPerKg: _cost, ...profile } = state.profile;
  return {
    ...profile,
    pressureAdvance: state.pressureAdvance,
    linearAdvance: state.linearAdvance,
  };
}

/** The meshes this engine session holds, so a slice names them instead of sending them. */
const meshRefs = new MeshRefs();

/** `req` with its meshes on: named by `meshRef` where `named` holds them, else sent as `dataB64`. */
function attachMeshes(req: Record<string, unknown>, named: MeshRefs | null): { body: Record<string, unknown>; sent: SentMesh[] } {
  const fields = (fingerprint: string, base64: () => string): MeshFields => (named ? named.fields(fingerprint, base64) : { dataB64: base64() });
  const objects = req.objects as { id: string }[] | undefined;
  if (!objects) {
    const fingerprint = meshFingerprint();
    return { body: { ...req, ...fields(fingerprint, meshBase64) }, sent: [{ fingerprint }] };
  }
  const live = new Map(livePlate().map((obj) => [obj.id, obj]));
  const sent: SentMesh[] = [];
  const listed = objects.map((o) => {
    const obj = live.get(o.id)!;
    const fingerprint = objectFingerprint(obj);
    sent.push({ object: o.id, fingerprint });
    return { ...o, ...fields(fingerprint, () => objectBase64(obj)) };
  });
  return { body: { ...req, objects: listed }, sent };
}

/** `force` plans again even when this recipe is already cached. */
export async function runSlice(force = false) {
  if (!state.mesh) {
    state.error = "Load a mesh first.";
    renderChrome();
    return;
  }
  const id = ++session.job;
  const hash = settingsHash();
  const sentPose = currentPlacement()?.pose;
  const slicedBed: SlicedBed = {
    translation: [sentPose?.translation[0] ?? 0, sentPose?.translation[1] ?? 0],
    offset: [0, 0],
    orientKey: state.orient.join(","),
    scale: state.partScale,
    meshEpoch: session.meshEpoch,
  };
  const recipe = currentRecipeKey();
  const action = sliceAction({
    cached: recipe !== null && cachedRecipes.has(recipe),
    settingsChanged: session.shownRecipe !== null && recipe !== session.shownRecipe,
    force,
  });
  const frame = `${session.meshEpoch}:${state.partScale}`;
  const request: Record<string, unknown> = { ...payload(), reslice: action.reslice };
  const partFrame = partFrameKey(request, meshFingerprint());
  const base = previewBase();
  if (base) request.previewBase = base.token;
  const listed = request.objects as PlateRequestObject[] | undefined;
  const selected = listed?.find((o) => o.id === state.plate.selectedId);
  const edits = (listed ? selected?.supportEdits : request.supportEdits) ? state.supportEdits : [];
  const paint = state.supportPaint;
  const paintedIndex = listed ? Math.max(0, listed.findIndex((o) => o.id === state.plate.selectedId)) : 0;
  const slicedObjects = listed?.map((o) => {
    const obj = livePlate().find((p) => p.id === o.id)!;
    return {
      id: o.id,
      bed: {
        translation: [o.pose.translation[0], o.pose.translation[1]] as [number, number],
        offset: [0, 0] as [number, number],
        orientKey: obj.orient.join(","),
        scale: obj.partScale,
        meshEpoch: session.meshEpoch,
      },
    };
  });
  const bytes = meshBytes();
  markBusy(action.recompute);
  state.error = "";
  state.notice = "";
  renderChrome();
  let unlisten: (() => void) | undefined;
  let landed = false;
  try {
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    let send: (req: Record<string, unknown>) => Promise<SliceResponse>;
    session.liveProgress = true;
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<DesktopProgress>("slice-progress", ({ payload: p }) => {
        noteJob(id, { id: "", stage: p.stage, done: p.done, total: p.total, fraction: p.progress, status: p.status });
      });
      const invokeSlice = async (body: Record<string, unknown>) => {
        let text: string;
        try {
          text = await invoke<string>("slice_model", { payload: JSON.stringify(body) });
        } catch (err) {
          throw (typeof err === "string" && unknownMeshRef(err)) || err;
        }
        return parseInWorker(id, text);
      };
      send = (req) => sendWithMeshes(meshRefs, (named) => attachMeshes(req, named), invokeSlice);
    } else {
      send = (req) => sendWithMeshes(meshRefs, (named) => attachMeshes(req, named), (body) => runHttpSlice(id, bytes, req, body, meshFingerprint()));
    }
    if (id !== session.job) return;
    let body = await send(request);
    if (id !== session.job) return;
    if (body.error) throw new Error(body.error);
    if (body.previewPatch && !adoptPatch(id, body, base)) {
      // The engine patched a preview this view no longer holds: ask for the whole one.
      delete request.previewBase;
      body = await send(request);
      if (id !== session.job) return;
      if (body.error) throw new Error(body.error);
    }
    if (id !== session.job) return;
    if (body.error) throw new Error(body.error);
    state.result = body;
    session.resultJob = id;
    session.resultFrame = frame;
    slicedBed.offset = replyOffset(body.offset);
    session.slicedBed = slicedBed;
    session.slicedObjects =
      slicedObjects?.map((o) => ({ ...o, bed: { ...o.bed, offset: replyOffset(body.objects?.find((v) => v.id === o.id)?.offset) } })) ?? null;
    const prev = session.slicedFrame !== null && session.shownRecipe !== null ? { frame: session.slicedFrame, recipe: session.shownRecipe } : null;
    session.slicedFrame = partFrame;
    state.slicedHash = hash;
    session.slicedEdits = edits;
    const paintBefore = session.slicedPaint;
    session.slicedPaint = paint;
    noteTally(body, paintedIndex, paint, paintBefore);
    if (recipe) {
      if (storesReply(prev, { frame: partFrame, recipe })) cachedRecipes.add(recipe);
      session.shownRecipe = recipe;
    }
    state.layer = layerNear(body, session.chosenZ?.high, topLayerIndex(body.layers.length));
    state.rangeLow = layerNear(body, session.chosenZ?.low, state.rangeLow);
    fx.clampPlane();
    landed = true;
  } catch (err) {
    if (id !== session.job) return;
    const message = err instanceof Error ? err.message : String(err);
    if (message === "cancelled") return;
    if (message === "Failed to fetch") markEngineDown(engineDownMessage(apiBase()));
    else {
      state.error = message;
      pushToast(message, "error", { label: "Retry", run: () => { void runSlice(false); } });
    }
  } finally {
    unlisten?.();
    if (id === session.job) {
      state.busy = false;
      state.progress = 0;
      renderChrome();
      fx.draw();
      session.supportUi?.landed(landed);
      if (landed && stale()) scheduleAuto();
    }
  }
}

/**
 * The layer of `result` nearest `z`, so the sliders cut where the user left them
 * whatever layer height comes back. Without a height, `index` is only clamped.
 */
export function layerNear(result: SliceResponse, z: number | undefined, index: number) {
  if (z == null) return Math.min(index, Math.max(0, result.layers.length - 1));
  let best = 0;
  result.layers.forEach((layer, i) => {
    if (Math.abs(layer.z - z) < Math.abs(result.layers[best].z - z)) best = i;
  });
  return best;
}

/** Mesh the slice worker holds in Base64, so it is sent and encoded once per mesh. */
let workerMesh = "";

let activeHttp: { uiId: number; jobId: string; stop: () => void } | null = null;

function noteJob(uiId: number, snap: JobSnapshot) {
  if (uiId !== session.job) return;
  state.progress = snap.fraction;
  session.busyPhase = formatStageLine(snap);
  paintBanner();
  const timing = document.querySelector("#timing");
  if (timing) timing.textContent = busyText();
}

/**
 * Jobs when `POST /api/jobs` exists, sending `body`, which is `req` with its meshes on.
 * A 404 or a dead connection posts `req` to `POST /api/slice` with every mesh's bytes.
 */
async function runHttpSlice(uiId: number, bytes: ArrayBuffer, req: Record<string, unknown>, body: Record<string, unknown>, meshKey: string): Promise<SliceResponse> {
  const base = apiBase();
  const token = apiToken();
  const started = await beginSliceJob((text) => postJson(base, token, "/api/jobs", text), body);
  if ("unsupported" in started) return req.objects ? postSlice(uiId, new ArrayBuffer(0), withMeshData(req), "") : postSlice(uiId, bytes, req, meshKey);
  let stopped = false;
  activeHttp = { uiId, jobId: started.id, stop: () => { stopped = true; } };
  try {
    const terminal = await followJobProgress({
      eventsUrl: jobEventsUrl(base, started.id, token),
      openEvents: typeof EventSource === "undefined" ? null : browserJobEvents,
      poll: async () => {
        const res = await getText(base, token, `/api/jobs/${encodeURIComponent(started.id)}`);
        const snap = parseJobSnapshot(res.text);
        if (!snap) throw new Error(errorText(res.text, res.status));
        return snap;
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      shouldStop: () => stopped || uiId !== session.job,
      onUpdate: (snap) => noteJob(uiId, snap),
    });
    if (stopped || uiId !== session.job || terminal.status === "cancelled") throw new Error("cancelled");
    const result = await getText(base, token, `/api/jobs/${encodeURIComponent(started.id)}/result`);
    if (result.status !== 200) throw unknownMeshRef(result.text) ?? new Error(errorText(result.text, result.status));
    return parseInWorker(uiId, result.text);
  } finally {
    if (activeHttp?.jobId === started.id) activeHttp = null;
  }
}

export function postSlice(id: number, bytes: ArrayBuffer, body: unknown, meshKey: string) {
  return new Promise<SliceResponse>((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMsg);
      if (ev.data.cancelled) reject(new Error("cancelled"));
      else if (!ev.data.ok) reject(new Error(ev.data.error || "slice failed"));
      else resolve(ev.data.body as SliceResponse);
    };
    worker.addEventListener("message", onMsg);
    const send = meshKey !== workerMesh;
    workerMesh = meshKey;
    worker.postMessage({ id, bytes: send ? bytes : undefined, meshKey, payload: body, api: apiBase(), token: apiToken() });
  });
}

export function parseInWorker(id: number, text: string) {
  return new Promise<SliceResponse>((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMsg);
      if (!ev.data.ok) reject(new Error(ev.data.error));
      else resolve(ev.data.body as SliceResponse);
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage({ id, parseOnly: text });
  });
}

export function cancelSlice() {
  const http = activeHttp && activeHttp.uiId === session.job ? activeHttp : null;
  http?.stop();
  worker.postMessage({ id: session.job, cancel: true });
  session.job += 1;
  state.busy = false;
  state.progress = 0;
  session.liveProgress = false;
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (http) void cancelJob(apiBase(), apiToken(), http.jobId).catch(() => undefined);
  else if (tauri) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("cancel_slice"));
  else void fetch(`${apiBase()}/api/cancel`, { method: "POST", headers: authHeaders(apiToken()) }).catch(() => undefined);
  renderChrome();
  session.supportUi?.landed(false);
}

export async function runPaCal() {
  markBusy(true);
  state.error = "";
  renderChrome();
  try {
    const body = {
      firmware: state.paFirmware,
      start: state.paStart,
      end: state.paEnd,
      step: state.paStep,
      layerHeight: state.layerHeight,
      bandHeight: 2,
      slowMmS: 40,
      fastMmS: 200,
      accel: 3000,
      printer: printer(),
    };
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    let result: { gcode: string; bands: typeof state.paBands; error?: string };
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      result = JSON.parse(await invoke<string>("calibrate_pa", { payload: JSON.stringify(body) }));
    } else {
      const res = await fetch(`${apiBase()}/api/calibrate/pa`, { method: "POST", headers: authHeaders(apiToken(), { "Content-Type": "application/json" }), body: JSON.stringify(body) });
      result = await res.json();
      if (!res.ok) throw new Error(result.error || `calibration failed (${res.status})`);
    }
    state.paBands = result.bands;
    state.paGcode = result.gcode;
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    renderChrome();
  }
}

export async function runFlowCal() {
  markBusy(true);
  state.error = "";
  renderChrome();
  try {
    const body = {
      start: state.flowStart,
      end: state.flowEnd,
      step: state.flowStep,
      layerHeight: state.layerHeight,
      bandHeight: 5,
      speedMmS: 40,
      printer: printer(),
    };
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    let result: { gcode: string; bands: typeof state.flowBands; error?: string };
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      result = JSON.parse(await invoke<string>("calibrate_flow", { payload: JSON.stringify(body) }));
    } else {
      const res = await fetch(`${apiBase()}/api/calibrate/flow`, { method: "POST", headers: authHeaders(apiToken(), { "Content-Type": "application/json" }), body: JSON.stringify(body) });
      result = await res.json();
      if (!res.ok) throw new Error(result.error || `calibration failed (${res.status})`);
    }
    state.flowBands = result.bands;
    state.flowGcode = result.gcode;
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    renderChrome();
  }
}

export function applyPareto(index: number) {
  const point = state.pareto[index];
  if (!point) return;
  if (point.toughness <= 0.001) {
    state.blendKind = "single";
    state.strategy = "speed";
  } else if (point.toughness >= 0.999) {
    state.blendKind = "single";
    state.strategy = "toughness";
  } else {
    state.blendKind = "weight";
    state.toughness = point.toughness;
  }
  touch();
}

export async function runPareto() {
  if (!state.mesh) {
    state.error = "Load a mesh before comparing blends.";
    renderChrome();
    return;
  }
  if (plateListed(state.plate)) {
    state.error = "Compare blends works on a plate of one object. Remove the other objects first.";
    renderChrome();
    return;
  }
  markBusy(true);
  renderChrome();
  try {
    const body = { ...payload(), printer: { ...printer(), filamentDensityGCm3: state.profile.filamentDensityGCm3 }, dataB64: meshBase64() };
    let points: ParetoPoint[];
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      points = JSON.parse(await invoke<string>("pareto_model", { payload: JSON.stringify(body) }));
    } else {
      const res = await fetch(`${apiBase()}/api/pareto`, { method: "POST", headers: authHeaders(apiToken(), { "Content-Type": "application/json" }), body: JSON.stringify(body) });
      points = await res.json();
      if (!res.ok) throw new Error((points as { error?: string }).error || "compare failed");
    }
    state.pareto = points;
    state.notice = "";
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    renderChrome();
  }
}
export async function runTempCal() {
  markBusy(true);
  state.error = "";
  renderChrome();
  try {
    const body = {
      start: state.tempStart,
      end: state.tempEnd,
      step: state.tempStep,
      layerHeight: state.layerHeight,
      bandHeight: 5,
      speedMmS: 40,
      printer: printer(),
    };
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    let result: { gcode: string; bands: typeof state.tempBands; error?: string };
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      result = JSON.parse(await invoke<string>("calibrate_temp", { payload: JSON.stringify(body) }));
    } else {
      const res = await fetch(`${apiBase()}/api/calibrate/temp`, { method: "POST", headers: authHeaders(apiToken(), { "Content-Type": "application/json" }), body: JSON.stringify(body) });
      result = await res.json();
      if (!res.ok) throw new Error(result.error || `calibration failed (${res.status})`);
    }
    state.tempBands = result.bands;
    state.tempGcode = result.gcode;
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    renderChrome();
  }
}

export async function runRetractCal() {
  markBusy(true);
  state.error = "";
  renderChrome();
  try {
    const body = {
      start: state.retractStart,
      end: state.retractEnd,
      step: state.retractStep,
      layerHeight: state.layerHeight,
      bandHeight: 5,
      speedMmS: state.retractOn ? state.retractSpeed : 30,
      printer: printer(),
    };
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    let result: { gcode: string; bands: typeof state.retractBands; error?: string };
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      result = JSON.parse(await invoke<string>("calibrate_retract", { payload: JSON.stringify(body) }));
    } else {
      const res = await fetch(`${apiBase()}/api/calibrate/retract`, { method: "POST", headers: authHeaders(apiToken(), { "Content-Type": "application/json" }), body: JSON.stringify(body) });
      result = await res.json();
      if (!res.ok) throw new Error(result.error || `calibration failed (${res.status})`);
    }
    state.retractBands = result.bands;
    state.retractGcode = result.gcode;
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    renderChrome();
  }
}

Object.assign(fx, { lineWidth, meshFingerprint, currentRecipeKey, currentSliceAction, setButtonLabel, paintSliceButton, paintForceButton, quietRefreshing, scheduleAuto, payload, printer, runSlice, layerNear, postSlice, parseInWorker, cancelSlice, runPaCal, runFlowCal, runTempCal, runRetractCal, applyPareto, runPareto });
