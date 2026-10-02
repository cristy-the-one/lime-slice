import { fx } from "./fx";
import { state, session, worker, cachedRecipes, type ParetoPoint, type SliceResponse } from "./state";
import { fnv1aHex, recipeKey, type SliceAction, sliceAction, sliceBusyLabel, FORCE_LABEL } from "../slice-action";
import { meshBytes, toBase64, fail, isTauri } from "./files";
import { syncSliceDock } from "../ui/shell";
import { blend, renderChrome, settingsHash, markBusy, paintBanner, busyText, markEngineDown, apiBase, stale, apiToken, touch } from "./settings";
import { placementPose } from "../mesh-place";
import { editRequestFields } from "../support-edit-list";
import { engineDownMessage, authHeaders } from "../ui/api-base";

export function meshFingerprint(): string {
  const source = state.sourcePos ?? state.mesh?.bytes ?? null;
  if (source && source === session.fingerSource && state.partScale === session.fingerScale) return session.finger;
  session.fingerSource = source;
  session.fingerScale = state.partScale;
  session.finger = source ? fnv1aHex(new Uint8Array(meshBytes())) : "";
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
  syncSliceDock(button);
}

export function paintForceButton(button: HTMLButtonElement) {
  const action = currentSliceAction(true);
  const ready = !state.busy && !!state.mesh && action.state === "force";
  setButtonLabel(button, FORCE_LABEL);
  button.disabled = !ready;
  button.dataset.tip = ready ? action.detail : "Plan this recipe again. Available when a saved slice would be shown.";
  button.removeAttribute("title");
  button.setAttribute("aria-label", FORCE_LABEL);
}

export function scheduleAuto() {
  window.clearTimeout(session.autoTimer);
  if (!state.autoSlice || !state.mesh || state.busy) return;
  const tris = state.result?.mesh.sourceTriangles ?? state.result?.mesh.triangles ?? Math.max(0, (state.mesh.bytes.byteLength - 84) / 50);
  if (tris >= 50000) return;
  session.autoTimer = window.setTimeout(() => void runSlice(), 300);
}

export function payload() {
  return {
    filename: state.sourcePos
      ? (state.mesh!.name || "part").replace(/\.(3mf|step|stp)$/i, ".stl")
      : (state.mesh!.name || "part"),
    stepToleranceMm: state.stepTolerance,
    layerHeight: state.layerHeight,
    lineWidth: Math.min(1.2, Math.max(0.2, state.profile.nozzleDiameter * 1.125)),
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
    variableWidth: state.variableWidth,
    arcFit: state.arcFit,
    travelOpt: state.travelOpt,
    overhangControl: state.overhangControl,
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
    pose: state.sourcePos
      ? placementPose(state.sourcePos, state.orient, state.partScale, state.profile.bedX, state.profile.bedY, state.centered, state.offset)
      : undefined,
    ...editRequestFields(state.supportEdits, treeSupports()),
  };
}

// The engine holds up islands and unbridged overhangs even with Smart
// supports off, so the style alone decides whether trees can be edited.
export function treeSupports() {
  return state.supportStyle === "tree";
}

export function printer() {
  return {
    ...state.profile,
    pressureAdvance: state.pressureAdvance,
    linearAdvance: state.linearAdvance,
  };
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
  const recipe = currentRecipeKey();
  const action = sliceAction({
    cached: recipe !== null && cachedRecipes.has(recipe),
    settingsChanged: session.shownRecipe !== null && recipe !== session.shownRecipe,
    force,
  });
  const frame = `${session.meshEpoch}:${state.partScale}`;
  const request = { ...payload(), reslice: action.reslice };
  const edits = request.supportEdits ? state.supportEdits : [];
  const bytes = meshBytes();
  markBusy(action.recompute);
  state.error = "";
  state.notice = "";
  renderChrome();
  let unlisten: (() => void) | undefined;
  let landed = false;
  try {
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    let body: SliceResponse;
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ progress: number; message: string }>("slice-progress", (ev) => {
        if (id !== session.job) return;
        state.progress = ev.payload.progress;
        session.busyPhase = ev.payload.message;
        paintBanner(false);
        document.querySelector("#timing")!.textContent = busyText();
      });
      if (id !== session.job) return;
      const json = await invoke<string>("slice_model", { payload: JSON.stringify({ ...request, dataB64: toBase64(new Uint8Array(bytes)) }) });
      if (id !== session.job) return;
      body = await parseInWorker(id, json);
    } else {
      body = await postSlice(id, bytes, request);
    }
    if (id !== session.job) return;
    if (body.error) throw new Error(body.error);
    state.result = body;
    session.resultJob = id;
    session.resultFrame = frame;
    state.slicedHash = hash;
    session.slicedEdits = edits;
    if (recipe) {
      cachedRecipes.add(recipe);
      session.shownRecipe = recipe;
    }
    state.layer = layerNear(body, session.chosenZ?.high, state.layer);
    state.rangeLow = layerNear(body, session.chosenZ?.low, state.rangeLow);
    fx.clampPlane();
    landed = true;
  } catch (err) {
    if (id !== session.job) return;
    const message = err instanceof Error ? err.message : String(err);
    if (message === "cancelled") state.notice = "Slice cancelled.";
    else if (message === "Failed to fetch") markEngineDown(engineDownMessage(apiBase()));
    else state.error = message;
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

export function postSlice(id: number, bytes: ArrayBuffer, body: unknown) {
  return new Promise<SliceResponse>((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMsg);
      if (ev.data.cancelled) reject(new Error("cancelled"));
      else if (!ev.data.ok) reject(new Error(ev.data.error || "slice failed"));
      else resolve(ev.data.body as SliceResponse);
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage({ id, bytes, payload: body, api: apiBase(), token: apiToken() }, [bytes.slice(0)]);
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
  worker.postMessage({ id: session.job, cancel: true });
  session.job += 1;
  state.busy = false;
  state.notice = "Slice cancelled.";
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (tauri) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("cancel_slice"));
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
  markBusy(true);
  renderChrome();
  try {
    const body = { ...payload(), dataB64: toBase64(new Uint8Array(meshBytes())) };
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
Object.assign(fx, { meshFingerprint, currentRecipeKey, currentSliceAction, setButtonLabel, paintSliceButton, paintForceButton, scheduleAuto, payload, printer, runSlice, layerNear, postSlice, parseInWorker, cancelSlice, runPaCal, applyPareto, runPareto });
