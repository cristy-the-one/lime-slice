import { colorForPath, FEATURE_COLOR, FEATURE_LABEL, type ColorMode } from "./colors";
import { layFlatMatrix, matMul, rotX, rotY, rotZ, centeringShift, boundsOf, placementPose } from "./mesh-place";
import { clampSplit, nextSplitAt, roundSplit, splitOutside, type AxisBounds, type SplitSync } from "./split-at";
import { indexLayerGcode, layerClass, layerMoves, matchGcodeLine, type LayerGcode, type PlayPoint } from "./playback";
import { createPrepareView } from "./prepare-view";
import { decodePaths, type PreviewPath } from "./preview-wire";
import { DEFAULT_PRESET, readPresets, writePresets } from "./presets";
import { profileJson } from "./profiles";
import { resolved } from "./strategy";
import { applyTheme, loadTheme, onSchemeChange, themeColors, type ThemeChoice } from "./theme";
import { mountChrome } from "./ui/chrome";
import { legendMarkup, mountLegend } from "./ui/legend";
import { mountLayerTip, syncLayerTip } from "./ui/layer-tip";
import { fillHelpShortcuts, mountPalette, mountStageTabs } from "./ui/palette";
import { applyStoredLevel, mountShell, syncEmptyState, syncSliceDock } from "./ui/shell";
import { authHeaders, engineDownMessage } from "./ui/api-base";
import { mountCompact } from "./ui/compact/mount";
import { mountConnection } from "./ui/connection";
import { mountPlatform } from "./platform";
import { mountToasts } from "./ui/toasts";
import { clampOffset, clipPolyline, flipSection, keepsPoint, layerCut, sectionReach, type SectionSpec, type Vec3 } from "./section-plane";
import { fnv1aHex, FORCE_LABEL, recipeKey, sliceAction, sliceBusyLabel, type SliceAction } from "./slice-action";
import { createSliceView, type SliceView3d } from "./view3d";
import { cachedRecipes, geomWorker, session, state, worker, type CardId, type ParetoPoint, type PreviewLayer, type SliceResponse } from "./app/state";
import { adoptBytes, applyPlace, export3mf, exportGcode, fail, fetchStoredGcode, isTauri, loadNamed, meshBytes, place, saveText, toBase64 } from "./app/files";
import { fx } from "./app/fx";
import { apiBase, apiToken, applyPreset, blend, busyText, closedGroups, currentPreset, currentWeight, escapeHtml, layerReadout, markBusy, markEngineDown, markStale, onBlend, onSettings, paintBanner, paramTable, probe, renderChrome, settingsHash, stale, touch } from "./app/settings";



import { mountMarkup } from "./app/markup";


Object.assign(fx, {
  paintLegend,
  paintSlider,
  loadGcode,
  layerGcode,
  pathsOf,
  movesNow,
  paintPlayback,
  paintGcode,
  syncGcodeHighlight,
  paintSpark,
  stopPlay,
  togglePlay,
  scrub,
  meshFingerprint,
  currentRecipeKey,
  currentSliceAction,
  setButtonLabel,
  paintSliceButton,
  paintForceButton,
  scheduleAuto,
  setView,
  setStage,
  setHelp,
  payload,
  printer,
  runSlice,
  layerNear,
  postSlice,
  parseInWorker,
  cancelSlice,
  placedAxisBounds,
  realignSplit,
  noticeBounds,
  refreshSplitNotice,
  commitSplit,
  syncSplitField,
  paintGizmoReadout,
  syncPlanes,
  clampPlane,
  paintRegionOverlay,
  previewMap,
  canvasPx,
  runPaCal,
  applyPareto,
  runPareto,
  resize,
  previewCenter,
  sectionLimit,
  activeSection,
  sectionKeeps,
  paintSectionChrome,
  draw,
  segmentStart,
  applyGeom,
  sync3d,
  fitNarrow,
});

mountMarkup(document.querySelector("#app")!);

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const ctx = canvas.getContext("2d")!;
const view3d: SliceView3d = createSliceView(document.querySelector<HTMLCanvasElement>("#view3d")!);
const prepare = createPrepareView(document.querySelector<HTMLCanvasElement>("#prepare")!);
prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
view3d.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
prepare.setBedOpacity(state.bedOpacity);
view3d.setBedOpacity(state.bedOpacity);
fx.prepare = prepare;
fx.view3d = view3d;
fx.canvas = canvas;
fx.ctx = ctx;
view3d.onSection((spec, hud) => {
  state.sectionNormal = spec.normal;
  state.sectionOffset = spec.offset;
  state.sectionHud = hud;
  paintSectionChrome();
  draw();
});

function paintLegend() {
  const kinds = new Set<string>();
  for (const layer of state.result?.layers ?? []) for (const kind of layer.paths.kinds) kinds.add(kind);
  const legend = document.querySelector("#legend")!;
  const est = state.result?.estimate;
  const total = Math.max(0.001, est?.seconds ?? 1);
  const by = new Map((est?.byFeature ?? []).map((row) => [row.kind, row.seconds]));
  const rows = [...kinds].sort().map((kind) => {
    const seconds = by.has(kind) ? by.get(kind)! : null;
    return {
      kind,
      label: FEATURE_LABEL[kind] ?? kind,
      color: FEATURE_COLOR[kind] ?? "#ccc",
      seconds,
      sharePct: seconds == null ? null : (seconds / total) * 100,
      shown: kind === "travel" ? state.showTravel : !state.hidden.has(kind),
    };
  });
  legend.innerHTML = legendMarkup(rows, (est?.scarfedLoops ?? 0) > 0);
}

function paintSlider() {
  const n = state.result?.layers.length ?? 0;
  const max = Math.max(0, n - 1);
  const hi = document.querySelector<HTMLInputElement>("#rangeHigh")!;
  const lo = document.querySelector<HTMLInputElement>("#rangeLow")!;
  hi.max = lo.max = String(max);
  state.layer = Math.min(state.layer, max);
  state.rangeLow = Math.min(state.rangeLow, state.layer);
  hi.value = String(state.layer);
  lo.value = String(state.rangeLow);
  const layer = state.result?.layers[state.layer];
  document.querySelector("#readHigh")!.textContent = layer ? `Z ${layer.z.toFixed(2)}` : "—";
  document.querySelector("#readLow")!.textContent = layer ? `${(layer.seconds ?? 0).toFixed(1)} s` : "Z —";
  const band = document.querySelector<HTMLElement>("#layerBand")!;
  const show = state.blendKind === "byLayer";
  band.hidden = !show;
  if (show && state.result && n > 1) {
    const z0 = state.result.layers[0].z;
    const z1 = state.result.layers[n - 1].z;
    const span = Math.max(0.2, z1 - z0);
    const top = 1 - Math.min(1, (state.bottomMm + state.transitionMm - z0) / span);
    const bot = 1 - Math.min(1, (state.bottomMm - z0) / span);
    band.style.top = `${top * 100}%`;
    band.style.height = `${Math.max(4, (bot - top) * 100)}%`;
  } else if (show) {
    band.style.top = "35%";
    band.style.height = "25%";
  }
  syncLayerTip();
}

const gcodeLoads = new WeakMap<SliceResponse, Promise<string>>();
const gcodeIndex = new WeakMap<SliceResponse, LayerGcode>();

/** The engine parks the G-code body; fetch it on first use, once per result. */
function loadGcode(result: SliceResponse): Promise<string> {
  let load = gcodeLoads.get(result);
  if (!load) {
    load = result.gcode || !result.gcodeToken ? Promise.resolve(result.gcode ?? "") : fetchStoredGcode(result.gcodeToken);
    gcodeLoads.set(result, load);
    load.then((text) => {
      gcodeIndex.set(result, indexLayerGcode(text));
      if (state.result !== result) return;
      paintPlayback();
      paintGcode();
    }, (err) => {
      if (state.result !== result) return;
      state.error = err instanceof Error ? err.message : String(err);
      renderChrome();
    });
  }
  return load;
}

/** Per-layer G-code once loaded. With load, starts fetching it if needed. */
function layerGcode(load = false): LayerGcode | null {
  const result = state.result;
  if (!result) return null;
  if (load) void loadGcode(result);
  return gcodeIndex.get(result) ?? null;
}

const decoded = new WeakMap<PreviewLayer, PreviewPath[]>();

/** One layer's paths as objects. Decoded on first use, only for layers that are drawn. */
function pathsOf(layer: PreviewLayer): PreviewPath[] {
  let paths = decoded.get(layer);
  if (!paths) {
    paths = decodePaths(layer.paths, layer.z);
    decoded.set(layer, paths);
  }
  return paths;
}

function movesNow(): PlayPoint[] {
  const layer = state.result?.layers[state.layer];
  if (!layer) return [];
  return layerMoves(pathsOf(layer), layer.z, layer.height);
}

function paintPlayback() {
  const moves = movesNow();
  const max = Math.max(0, moves.length - 1);
  state.move = Math.max(0, Math.min(max, state.move));
  const slider = document.querySelector<HTMLInputElement>("#move");
  const readout = document.querySelector("#playReadout");
  const play = document.querySelector<HTMLButtonElement>("#play");
  if (slider) {
    const maxStr = String(max);
    const valueStr = String(moves.length ? state.move : 0);
    if (slider.max !== maxStr) slider.max = maxStr;
    if (slider.value !== valueStr) slider.value = valueStr;
    slider.disabled = moves.length === 0;
  }
  if (play) {
    play.textContent = state.playing ? "Playing…" : "Play";
    play.disabled = state.playing || moves.length === 0;
  }
  const stop = document.querySelector<HTMLButtonElement>("#stop");
  if (stop) stop.disabled = !state.playing;
  const point = moves[state.move];
  if (!readout) return;
  if (!point) {
    readout.textContent = "Feature — · feed — · E —";
    return;
  }
  const gcode = layerGcode()?.layer(state.result?.layers[state.layer]?.index ?? state.layer) ?? [];
  const hit = matchGcodeLine(gcode, point);
  const line = hit >= 0 ? gcode[hit] : undefined;
  const feed = line?.feed ?? point.feed;
  const e = line?.e ?? point.e;
  const label = FEATURE_LABEL[point.kind] ?? point.kind;
  readout.textContent = `${label} · ${feed.toFixed(0)} mm/s · E ${e.toFixed(3)}`;
}

function paintGcode() {
  const pane = document.querySelector("#gcodePane");
  const stage = document.querySelector("#stage");
  if (!pane || !stage) return;
  const on = state.stage === "gcode";
  pane.toggleAttribute("hidden", !on);
  stage.classList.toggle("tab-gcode", on);
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((el) => {
    const pressed = el.dataset.tab === state.stage;
    el.setAttribute("aria-pressed", pressed ? "true" : "false");
    el.setAttribute("aria-selected", pressed ? "true" : "false");
    el.classList.toggle("on", pressed);
  });
  if (!on) return;
  const layer = state.result?.layers[state.layer];
  const doc = layerGcode(true);
  const lines = layer ? doc?.layer(layer.index) ?? [] : [];
  if (!state.result) {
    pane.innerHTML = `<div class="meta">Slice to read G-code for this layer.</div>`;
    return;
  }
  if (!doc) {
    pane.innerHTML = `<div class="meta">Loading G-code…</div>`;
    return;
  }
  if (lines.length === 0) {
    pane.innerHTML = `<div class="meta">No ;LAYER block in this G-code. Playback still follows the preview.</div>`;
    return;
  }
  const point = movesNow()[state.move];
  const active = matchGcodeLine(lines, point);
  pane.innerHTML = lines.map((line, i) => `<div class="line${i === active ? " on" : ""}" data-gline="${i}">${escapeHtml(line.text)}</div>`).join("");
  pane.querySelector(".line.on")?.scrollIntoView({ block: "center" });
}

function syncGcodeHighlight() {
  const pane = document.querySelector("#gcodePane");
  if (!pane || state.stage !== "gcode") return;
  const lines = [...pane.querySelectorAll<HTMLElement>(".line")];
  if (lines.length === 0) return;
  const layer = state.result?.layers[state.layer];
  const parsed = layer ? layerGcode()?.layer(layer.index) ?? [] : [];
  const active = matchGcodeLine(parsed, movesNow()[state.move]);
  lines.forEach((el, i) => el.classList.toggle("on", i === active));
  pane.querySelector(".line.on")?.scrollIntoView({ block: "nearest" });
}

function paintSpark() {
  const canvasEl = document.querySelector<HTMLCanvasElement>("#spark");
  const label = document.querySelector("#sparkLabel");
  if (!canvasEl) return;
  const layers = state.result?.layers ?? [];
  const seconds = layers.map((layer) => layer.seconds ?? 0);
  const here = layers[state.layer];
  const klass = here ? layerClass(seconds, state.layer) : "ok";
  if (label) {
    const tag = klass === "slow" ? "slow" : klass === "fast" ? "too fast" : "typical";
    label.innerHTML = here
      ? `<i style="background:var(--slow)"></i>slow<br><i style="background:var(--fast)"></i>too fast<br>${(here.seconds ?? 0).toFixed(1)} s · ${tag}`
      : "Layer time";
  }
  const rect = canvasEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvasEl.width = Math.max(1, Math.floor(rect.width * dpr));
  canvasEl.height = Math.max(1, Math.floor(rect.height * dpr));
  const g = canvasEl.getContext("2d");
  if (!g) return;
  const colors = themeColors();
  g.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (seconds.length === 0) return;
  const max = Math.max(...seconds, 0.001);
  const gap = seconds.length > 80 ? 0 : 1 * dpr;
  const barW = canvasEl.width / seconds.length;
  seconds.forEach((value, i) => {
    const kind = layerClass(seconds, i);
    g.fillStyle = kind === "slow" ? colors.slow : kind === "fast" ? colors.fast : colors.spark;
    const h = Math.max(dpr, (value / max) * (canvasEl.height - 3 * dpr));
    g.fillRect(i * barW, canvasEl.height - h, Math.max(dpr, barW - gap), h);
    if (i === state.layer) {
      g.strokeStyle = colors.teal;
      g.lineWidth = Math.max(1, dpr);
      g.strokeRect(i * barW + 0.5, canvasEl.height - h, Math.max(dpr, barW - gap) - 1, h - 1);
    }
  });
}

function stopPlay() {
  state.playing = false;
  window.clearInterval(session.playTimer);
  const play = document.querySelector<HTMLButtonElement>("#play");
  const stop = document.querySelector<HTMLButtonElement>("#stop");
  if (play) {
    play.textContent = "Play";
    play.disabled = movesNow().length === 0;
  }
  if (stop) stop.disabled = true;
}
function togglePlay() {
  if (state.playing) return;
  const moves = movesNow();
  if (moves.length === 0) return;
  layerGcode(true);
  if (state.move >= moves.length - 1) state.move = 0;
  state.playing = true;
  paintPlayback();
  session.playTimer = window.setInterval(() => {
    const n = movesNow().length;
    if (state.move >= n - 1) {
      stopPlay();
      paintPlayback();
      return;
    }
    state.move += 1;
    paintPlayback();
    syncGcodeHighlight();
    draw();
  }, 40);
}

function scrub(next: number) {
  const max = Math.max(0, (state.result?.layers.length ?? 1) - 1);
  const prev = state.layer;
  state.layer = Math.max(state.rangeLow, Math.min(max, next));
  const layers = state.result?.layers;
  if (layers?.length) session.chosenZ = { high: layers[state.layer].z, low: layers[state.rangeLow].z };
  if (state.layer !== prev) {
    state.move = 0;
    stopPlay();
  }
  const readout = document.querySelector("#layerReadout");
  if (readout) readout.innerHTML = layerReadout();
  const resolvedNode = document.querySelector("#resolved");
  if (resolvedNode && state.blendKind === "byLayer") resolvedNode.innerHTML = paramTable(resolved(currentWeight(), state.layerHeight));
  paintSlider();
  paintSpark();
  paintPlayback();
  paintGcode();
  draw();
}

document.querySelector("#left")!.addEventListener("input", onSettings);
document.querySelector("#left")!.addEventListener("toggle", (ev) => {
  const details = ev.target as HTMLDetailsElement;
  const title = details.dataset.group;
  if (!title) return;
  if (details.open) closedGroups.delete(title);
  else closedGroups.add(title);
}, true);
document.querySelector("#left")!.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === "pacal") void runPaCal();
  if (t.id === "paapply") {
    const chosen = Number((document.querySelector("#pachosen") as HTMLInputElement).value);
    if (state.paFirmware === "marlin") state.linearAdvance = chosen;
    else state.pressureAdvance = chosen;
    touch();
  }
  if (t.id === "paexport" && state.paGcode) void saveText(state.paGcode, "pa-calibration.gcode", "gcode");
  if (t.id === "presetSave") {
    const name = (document.querySelector("#presetName") as HTMLInputElement).value.trim();
    if (!name) return;
    const all = readPresets();
    all[name] = currentPreset();
    writePresets(all);
    renderChrome();
  }
  if (t.id === "presetLoad") {
    const name = (document.querySelector("#presetPick") as HTMLSelectElement).value;
    const preset = readPresets()[name];
    if (preset) applyPreset({ ...DEFAULT_PRESET, ...preset });
  }
  if (t.id === "presetDelete") {
    const name = (document.querySelector("#presetPick") as HTMLSelectElement).value;
    if (!name) return;
    const all = readPresets();
    delete all[name];
    writePresets(all);
    renderChrome();
  }
  if (t.id === "center") { state.centered = true; state.offset = { x: 0, y: 0, z: 0 }; place(); }
  if (t.id === "layflat" && state.sourcePos) { state.orient = layFlatMatrix(state.sourcePos); place(); }
  if (t.id === "rotX") { state.orient = matMul(rotX(90), state.orient); place(); }
  if (t.id === "rotY") { state.orient = matMul(rotY(90), state.orient); place(); }
  if (t.id === "rotZ") { state.orient = matMul(rotZ(90), state.orient); place(); }
  if (t.id === "profileExport") void saveText(profileJson(state.profile), `${state.profile.name.replace(/\s+/g, "_")}.json`, "json");
  if (t.id === "export3mf") void export3mf();
});
document.querySelector("#right")!.addEventListener("click", (ev) => {
  const dot = (ev.target as HTMLElement).closest<SVGElement>("[data-pareto]");
  if (dot) {
    applyPareto(Number(dot.dataset.pareto));
    return;
  }
  if ((ev.target as HTMLElement).id === "paretoBtn") {
    void runPareto();
    return;
  }
  const cardEl = (ev.target as HTMLElement).closest<HTMLElement>("[data-card]");
  if (!cardEl) return;
  const id = cardEl.dataset.card as CardId;
  if (id === "speed") { state.blendKind = "single"; state.strategy = "speed"; }
  else if (id === "toughness") { state.blendKind = "single"; state.strategy = "toughness"; }
  else if (id === "efficiency") { state.blendKind = "weight"; state.toughness = 0.5; }
  else if (id === "layer") state.blendKind = "byLayer";
  else {
    state.blendKind = "byRegion";
    realignSplit("open");
  }
  touch();
});
document.querySelector("#right")!.addEventListener("input", onBlend);
function meshFingerprint(): string {
  const source = state.sourcePos ?? state.mesh?.bytes ?? null;
  if (source && source === session.fingerSource && state.partScale === session.fingerScale) return session.finger;
  session.fingerSource = source;
  session.fingerScale = state.partScale;
  session.finger = source ? fnv1aHex(new Uint8Array(meshBytes())) : "";
  return session.finger;
}
function currentRecipeKey(): string | null {
  if (!state.mesh) return null;
  return recipeKey(payload(), meshFingerprint());
}
function currentSliceAction(force = false): SliceAction {
  const recipe = currentRecipeKey();
  return sliceAction({
    cached: recipe !== null && cachedRecipes.has(recipe),
    settingsChanged: session.shownRecipe !== null && recipe !== session.shownRecipe,
    force,
  });
}
function setButtonLabel(button: HTMLButtonElement, label: string) {
  let slot = button.querySelector<HTMLElement>(".btn-label");
  if (!slot) {
    slot = document.createElement("span");
    slot.className = "btn-label";
    button.replaceChildren(slot);
  }
  slot.textContent = label;
}
function paintSliceButton(button: HTMLButtonElement) {
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
function paintForceButton(button: HTMLButtonElement) {
  const action = currentSliceAction(true);
  const ready = !state.busy && !!state.mesh && action.state === "force";
  setButtonLabel(button, FORCE_LABEL);
  button.disabled = !ready;
  button.dataset.tip = ready ? action.detail : "Plan this recipe again. Available when a saved slice would be shown.";
  button.removeAttribute("title");
  button.setAttribute("aria-label", FORCE_LABEL);
}
function scheduleAuto() {
  window.clearTimeout(session.autoTimer);
  if (!state.autoSlice || !state.mesh || state.busy) return;
  const tris = state.result?.mesh.sourceTriangles ?? state.result?.mesh.triangles ?? Math.max(0, (state.mesh.bytes.byteLength - 84) / 50);
  if (tris >= 50000) return;
  session.autoTimer = window.setTimeout(() => void runSlice(), 300);
}

document.querySelector("#samples")!.addEventListener("click", (ev) => {
  const button = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-sample]");
  if (!button) return;
  void loadNamed(button.dataset.sample!).catch(fail);
  (document.querySelector("#samples") as HTMLDetailsElement).open = false;
});
document.querySelector("#file")!.addEventListener("change", (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  file.arrayBuffer().then((bytes) => adoptBytes(file.name, bytes)).catch(fail);
});
document.querySelectorAll<HTMLButtonElement>(".mode:not(.tab)").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.mode as typeof state.viewMode));
});
document.querySelector("#theme")!.addEventListener("change", (ev) => {
  applyTheme((ev.target as HTMLSelectElement).value as ThemeChoice);
  view3d.setTheme();
  prepare.setTheme();
  draw();
});
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    setStage(tab === "prepare" || tab === "gcode" ? tab : "preview");
  });
});
document.querySelector("#play")!.addEventListener("click", () => togglePlay());
document.querySelector("#stop")!.addEventListener("click", () => stopPlay());
document.querySelector("#move")!.addEventListener("input", (ev) => {
  const next = Number((ev.target as HTMLInputElement).value);
  if (next === state.move) return;
  stopPlay();
  layerGcode(true);
  state.move = next;
  paintPlayback();
  syncGcodeHighlight();
  draw();
});
document.querySelector("#spark")!.addEventListener("click", (ev) => {
  const layers = state.result?.layers.length ?? 0;
  if (layers === 0) return;
  const rect = (ev.currentTarget as HTMLCanvasElement).getBoundingClientRect();
  const t = ((ev as MouseEvent).clientX - rect.left) / Math.max(1, rect.width);
  const index = Math.max(0, Math.min(layers - 1, Math.floor(t * layers)));
  if (index < state.rangeLow) state.rangeLow = index;
  scrub(index);
});
document.querySelector("#colorBy")!.addEventListener("change", (ev) => {
  state.colorMode = (ev.target as HTMLSelectElement).value as ColorMode;
  draw();
});
document.querySelector("#bedOpacity")!.addEventListener("input", (ev) => {
  state.bedOpacity = Math.min(1, Math.max(0, Number((ev.target as HTMLInputElement).value) / 100));
  prepare.setBedOpacity(state.bedOpacity);
  view3d.setBedOpacity(state.bedOpacity);
});
document.querySelector("#sectionOn")!.addEventListener("change", (ev) => {
  state.sectionOn = (ev.target as HTMLInputElement).checked;
  state.sectionHud = "";
  paintSectionChrome();
  draw();
});
document.querySelector("#sectionOffset")!.addEventListener("input", (ev) => {
  state.sectionOffset = clampOffset(Number((ev.target as HTMLInputElement).value), sectionLimit());
  state.sectionHud = "";
  paintSectionChrome();
  draw();
});
document.querySelector("#sectionFlip")!.addEventListener("click", () => {
  const next = flipSection({ normal: state.sectionNormal, offset: state.sectionOffset });
  state.sectionNormal = next.normal;
  state.sectionOffset = next.offset;
  state.sectionHud = "";
  paintSectionChrome();
  draw();
});
document.querySelector("#legend")!.addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const kind = input.dataset.kind;
  if (!kind) return;
  if (input.checked) state.hidden.delete(kind);
  else state.hidden.add(kind);
  if (kind === "travel") state.showTravel = input.checked;
  view3d.setShowTravel(state.showTravel && !state.hidden.has("travel"));
  draw();
});
document.querySelector("#rangeHigh")!.addEventListener("input", (ev) => {
  const value = Number((ev.target as HTMLInputElement).value);
  if (value < state.rangeLow) state.rangeLow = value;
  scrub(value);
});
document.querySelector("#rangeLow")!.addEventListener("input", (ev) => {
  state.rangeLow = Math.min(state.layer, Number((ev.target as HTMLInputElement).value));
  scrub(state.layer);
});
document.querySelector("#toggleLeft")!.addEventListener("click", () => {
  document.querySelector(".workspace")!.classList.toggle("show-left");
});
document.querySelector("#toggleRight")!.addEventListener("click", () => {
  document.querySelector(".workspace")!.classList.toggle("show-right");
});
document.querySelector("#slice")!.addEventListener("click", () => void runSlice(false));
document.querySelector("#force")!.addEventListener("click", () => void runSlice(true));
document.querySelector("#cancel")!.addEventListener("click", () => cancelSlice());
document.querySelector("#export")!.addEventListener("click", () => void exportGcode());
document.querySelector("#helpClose")!.addEventListener("click", () => setHelp(false));

function setView(mode: typeof state.viewMode) {
  state.viewMode = mode;
  const stage = document.querySelector("#stage")!;
  stage.classList.remove("mode-flat", "mode-split", "mode-solid");
  stage.classList.add(`mode-${mode}`);
  document.querySelectorAll<HTMLButtonElement>(".mode:not(.tab)").forEach((el) => {
    const on = el.dataset.mode === mode;
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  });
  resize();
}

window.addEventListener("keydown", (ev) => {
  if (document.documentElement.dataset.overlay) return;
  const target = ev.target as HTMLElement | null;
  const tag = target?.tagName;
  const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || !!target?.isContentEditable;
  if (ev.key === "?" && !typing) {
    setHelp(!state.help);
    ev.preventDefault();
    return;
  }
  if (ev.key === "Escape" && state.help) {
    setHelp(false);
    return;
  }
  if (typing) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "o") {
    ev.preventDefault();
    document.querySelector<HTMLInputElement>("#file")?.click();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
    ev.preventDefault();
    void runSlice(false);
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "e") {
    ev.preventDefault();
    void exportGcode();
    return;
  }
  if (ev.key === "1") setView("flat");
  if (ev.key === "2") setView("split");
  if (ev.key === "3") setView("solid");
  if (!state.result || state.stage !== "preview") return;
  const n = state.result.layers.length;
  if (ev.key === "ArrowUp" || ev.key === "]") scrub(state.layer + 1);
  if (ev.key === "ArrowDown" || ev.key === "[") scrub(state.layer - 1);
  if (ev.key === "PageUp") scrub(state.layer + 10);
  if (ev.key === "PageDown") scrub(state.layer - 10);
  if (ev.key === "Home") scrub(0);
  if (ev.key === "End") scrub(n - 1);
});

document.querySelector(".app")!.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  document.querySelector(".app")!.classList.add("dropping");
});
document.querySelector(".app")!.addEventListener("dragleave", () => {
  document.querySelector(".app")!.classList.remove("dropping");
});
document.querySelector(".app")!.addEventListener("drop", (ev) => {
  const drop = ev as DragEvent;
  drop.preventDefault();
  document.querySelector(".app")!.classList.remove("dropping");
  const file = drop.dataTransfer?.files?.[0];
  if (!file) return;
  void file.arrayBuffer().then((bytes: ArrayBuffer) => adoptBytes(file.name, bytes)).catch(fail);
});

function setStage(stage: "prepare" | "preview" | "gcode") {
  state.stage = stage;
  document.querySelector<HTMLElement>("#prepareBody")!.hidden = stage !== "prepare";
  document.querySelector<HTMLElement>("#previewBody")!.hidden = stage !== "preview";
  document.querySelector("#legend")?.toggleAttribute("hidden", stage !== "preview");
  document.querySelector("#viewModes")?.toggleAttribute("hidden", stage !== "preview");
  document.querySelector(".stage-tools")?.toggleAttribute("hidden", stage === "prepare");
  document.querySelector<HTMLElement>("#viewPresets")?.toggleAttribute("hidden", stage !== "prepare");
  syncEmptyState(!!state.mesh);
  paintSectionChrome();
  paintGcode();
  resize();
}

function setHelp(open: boolean) {
  state.help = open;
  const sheet = document.querySelector<HTMLElement>("#help")!;
  sheet.hidden = !open;
  if (open) document.querySelector<HTMLButtonElement>("#helpClose")?.focus();
}

function payload() {
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
  };
}
function printer() {
  return {
    ...state.profile,
    pressureAdvance: state.pressureAdvance,
    linearAdvance: state.linearAdvance,
  };
}

/** `force` plans again even when this recipe is already cached. */
async function runSlice(force = false) {
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
    if (recipe) {
      cachedRecipes.add(recipe);
      session.shownRecipe = recipe;
    }
    state.layer = layerNear(body, session.chosenZ?.high, state.layer);
    state.rangeLow = layerNear(body, session.chosenZ?.low, state.rangeLow);
    clampPlane();
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
      draw();
      if (landed && stale()) scheduleAuto();
    }
  }
}

/**
 * The layer of `result` nearest `z`, so the sliders cut where the user left them
 * whatever layer height comes back. Without a height, `index` is only clamped.
 */
function layerNear(result: SliceResponse, z: number | undefined, index: number) {
  if (z == null) return Math.min(index, Math.max(0, result.layers.length - 1));
  let best = 0;
  result.layers.forEach((layer, i) => {
    if (Math.abs(layer.z - z) < Math.abs(result.layers[best].z - z)) best = i;
  });
  return best;
}

function postSlice(id: number, bytes: ArrayBuffer, body: unknown) {
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
function parseInWorker(id: number, text: string) {
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
function cancelSlice() {
  worker.postMessage({ id: session.job, cancel: true });
  session.job += 1;
  state.busy = false;
  state.notice = "Slice cancelled.";
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (tauri) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("cancel_slice"));
  else void fetch(`${apiBase()}/api/cancel`, { method: "POST", headers: authHeaders(apiToken()) }).catch(() => undefined);
  renderChrome();
}

function placedAxisBounds(): AxisBounds | null {
  if (!state.placed) return null;
  return boundsOf(state.placed);
}

function realignSplit(reason: SplitSync) {
  const bounds = placedAxisBounds();
  const before = state.atMm;
  const outside = !!bounds && splitOutside(before, bounds, state.axis);
  state.atMm = nextSplitAt(reason, before, bounds, state.axis, state.splitCustom);
  if (reason === "load" || reason === "axis" || outside) state.splitCustom = false;
  refreshSplitNotice();
}

function noticeBounds(): AxisBounds | null {
  if (state.result && !stale()) {
    const mesh = state.result.mesh;
    return {
      min: [mesh.min[0], mesh.min[1], mesh.min[2]],
      max: [mesh.max[0], mesh.max[1], mesh.max[2]],
    };
  }
  return placedAxisBounds();
}

function refreshSplitNotice() {
  const splitNote = state.notice.startsWith("Split at ");
  if (state.blendKind !== "byRegion") {
    if (splitNote) state.notice = "";
    return;
  }
  const bounds = noticeBounds();
  if (!bounds || !splitOutside(state.atMm, bounds, state.axis)) {
    if (splitNote) state.notice = "";
    return;
  }
  const i = state.axis === "x" ? 0 : 1;
  state.notice = `Split at ${state.atMm.toFixed(1)} mm is outside the mesh (${bounds.min[i].toFixed(1)}–${bounds.max[i].toFixed(1)}).`;
}

function commitSplit(at: number) {
  const bounds = placedAxisBounds();
  state.atMm = bounds ? roundSplit(clampSplit(at, bounds, state.axis)) : roundSplit(at);
  state.splitCustom = true;
  refreshSplitNotice();
  syncSplitField(true);
  const node = document.querySelector("#resolved");
  if (node && state.blendKind === "byRegion") node.innerHTML = paramTable(resolved(currentWeight(), state.layerHeight));
  markStale();
}

function syncSplitField(force = false) {
  const input = document.querySelector<HTMLInputElement>("#at");
  if (!input) return;
  if (!force && document.activeElement === input) return;
  if (Math.abs(Number(input.value) - state.atMm) < 0.049) return;
  input.value = state.atMm.toFixed(1);
}

function paintGizmoReadout() {
  const el = document.querySelector<HTMLElement>("#gizmoReadout");
  if (!el) return;
  if (state.stage !== "prepare" || !state.placed) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (state.poseHud) {
    el.textContent = state.poseHud;
    return;
  }
  if (state.blendKind === "byRegion") {
    el.textContent = `Split ${state.axis.toUpperCase()} ${state.atMm.toFixed(1)} mm · low toughness · high speed`;
    return;
  }
  const tool = document.querySelector<HTMLElement>("#toolRail")?.dataset.tool;
  if (tool === "move") {
    el.textContent = "Move · drag an arrow · Shift snaps 1 mm";
    return;
  }
  if (tool === "rotate") {
    el.textContent = "Rotate · drag a ring · Shift snaps 15°";
    return;
  }
  el.textContent = "Parked left · drag a ring to rotate · an arrow to move · Shift snaps";
}

function syncPlanes() {
  const show = state.blendKind === "byRegion";
  const placed = placedAxisBounds();
  prepare.setSplit(show && placed ? { axis: state.axis, at: state.atMm } : null);
  const model = state.result
    ? { min: state.result.mesh.min, max: state.result.mesh.max }
    : placed
      ? { min: [...placed.min], max: [...placed.max] }
      : null;
  if (model) view3d.setModel(model.min, model.max);
  view3d.setGhost(state.result ? null : state.placed);
  view3d.setPlane(show && model ? { axis: state.axis, at: state.atMm } : null);
  syncSplitField();
  paintGizmoReadout();
}

function clampPlane() {
  refreshSplitNotice();
}

function paintRegionOverlay(
  mesh: { min: number[]; max: number[] },
  map: (x: number, y: number) => [number, number],
  dpr: number,
) {
  const colors = themeColors();
  const at = state.atMm;
  const x0 = mesh.min[0];
  const x1 = mesh.max[0];
  const y0 = mesh.min[1];
  const y1 = mesh.max[1];
  const fill = (xa: number, ya: number, xb: number, yb: number, color: string) => {
    const [px, py] = map(xa, ya);
    const [qx, qy] = map(xb, yb);
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = color;
    ctx.fillRect(Math.min(px, qx), Math.min(py, qy), Math.abs(qx - px), Math.abs(qy - py));
    ctx.restore();
  };
  const text = (x: number, y: number, label: string, color: string) => {
    const [px, py] = map(x, y);
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.round(12 * dpr)}px IBM Plex Sans, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, px, py);
  };
  ctx.lineWidth = Math.max(2, 2 * dpr);
  ctx.strokeStyle = colors.text;
  ctx.beginPath();
  if (state.axis === "x") {
    if (at > x0 + 0.4) fill(x0, y0, Math.min(at, x1), y1, colors.amber);
    if (at < x1 - 0.4) fill(Math.max(at, x0), y0, x1, y1, colors.teal);
    const [lx, ly1] = map(at, y0);
    const [, ly2] = map(at, y1);
    ctx.moveTo(lx, ly1);
    ctx.lineTo(lx, ly2);
    ctx.stroke();
    if (at > x0 + 1) text((x0 + Math.min(at, x1)) / 2, (y0 + y1) / 2, "toughness", colors.amber);
    if (at < x1 - 1) text((Math.max(at, x0) + x1) / 2, (y0 + y1) / 2, "speed", colors.teal);
    return;
  }
  if (at > y0 + 0.4) fill(x0, y0, x1, Math.min(at, y1), colors.amber);
  if (at < y1 - 0.4) fill(x0, Math.max(at, y0), x1, y1, colors.teal);
  const [lx, ly] = map(x0, at);
  const [lx2] = map(x1, at);
  ctx.moveTo(lx, ly);
  ctx.lineTo(lx2, ly);
  ctx.stroke();
  if (at > y0 + 1) text((x0 + x1) / 2, (y0 + Math.min(at, y1)) / 2, "toughness", colors.amber);
  if (at < y1 - 1) text((x0 + x1) / 2, (Math.max(at, y0) + y1) / 2, "speed", colors.teal);
}

function previewMap(mesh: { min: number[]; max: number[] }) {
  const w = canvas.width;
  const h = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const pad = 28 * dpr;
  const spanX = Math.max(1e-6, mesh.max[0] - mesh.min[0]);
  const spanY = Math.max(1e-6, mesh.max[1] - mesh.min[1]);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * scale) / 2;
  const oy = (h - spanY * scale) / 2;
  const map = (x: number, y: number): [number, number] => [ox + (x - mesh.min[0]) * scale, h - (oy + (y - mesh.min[1]) * scale)];
  const unmap = (px: number, py: number): [number, number] => [
    mesh.min[0] + (px - ox) / scale,
    mesh.min[1] + (h - py - oy) / scale,
  ];
  return { map, unmap, dpr };
}

function canvasPx(ev: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
    y: (ev.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
  };
}

canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || state.blendKind !== "byRegion" || !state.result) return;
  const mesh = state.result.mesh;
  const { map, dpr } = previewMap(mesh);
  const px = canvasPx(ev);
  const line = state.axis === "x" ? map(state.atMm, mesh.min[1])[0] : map(mesh.min[0], state.atMm)[1];
  const dist = state.axis === "x" ? Math.abs(px.x - line) : Math.abs(px.y - line);
  if (dist > 16 * dpr) return;
  session.drag2d = true;
  canvas.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});
canvas.addEventListener("pointermove", (ev) => {
  if (!session.drag2d || !state.result) return;
  const { unmap } = previewMap(state.result.mesh);
  const px = canvasPx(ev);
  const [x, y] = unmap(px.x, px.y);
  commitSplit(state.axis === "x" ? x : y);
});
const endRegionDrag = () => { session.drag2d = false; };
canvas.addEventListener("pointerup", endRegionDrag);
canvas.addEventListener("pointercancel", endRegionDrag);

async function runPaCal() {
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

function applyPareto(index: number) {
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

async function runPareto() {
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

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (rect.width >= 1 && rect.height >= 1) {
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }
  view3d.resize();
  prepare.resize();
  if (window.innerWidth < 1200 && state.viewMode === "split") setView("solid");
  draw();
}

function previewCenter(): Vec3 | null {
  const mesh = state.result?.mesh;
  if (mesh) {
    return [
      (mesh.min[0] + mesh.max[0]) / 2,
      (mesh.min[1] + mesh.max[1]) / 2,
      (mesh.min[2] + mesh.max[2]) / 2,
    ];
  }
  if (!state.placed) return null;
  const bounds = boundsOf(state.placed);
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

function sectionLimit() {
  const mesh = state.result?.mesh;
  if (mesh) return sectionReach(mesh.min, mesh.max);
  if (state.placed) {
    const bounds = boundsOf(state.placed);
    return sectionReach(bounds.min, bounds.max);
  }
  return 100;
}

function activeSection(): SectionSpec | null {
  if (!state.sectionOn) return null;
  return { normal: state.sectionNormal, offset: state.sectionOffset };
}

function sectionKeeps(x: number, y: number, z: number) {
  const spec = activeSection();
  const center = previewCenter();
  if (!spec || !center) return true;
  return keepsPoint([x, y, z], center, spec);
}

function paintSectionChrome() {
  const preview = state.stage === "preview";
  const on = state.sectionOn;
  document.querySelector<HTMLElement>("#sectionField")!.hidden = !preview;
  document.querySelector<HTMLElement>("#sectionOffsetField")!.hidden = !(preview && on);
  document.querySelector<HTMLElement>("#sectionFlip")!.hidden = !(preview && on);
  document.querySelector<HTMLInputElement>("#sectionOn")!.checked = on;
  const slider = document.querySelector<HTMLInputElement>("#sectionOffset")!;
  const reach = sectionLimit();
  slider.min = (-reach).toFixed(2);
  slider.max = reach.toFixed(2);
  if (document.activeElement !== slider) slider.value = String(state.sectionOffset);
  const readout = document.querySelector<HTMLElement>("#sectionReadout")!;
  readout.hidden = !(preview && on);
  if (preview && on) {
    if (state.sectionHud) readout.textContent = state.sectionHud;
    else {
      const n = state.sectionNormal.map((v) => v.toFixed(2)).join(" ");
      readout.textContent = `Section ${n} · ${state.sectionOffset.toFixed(1)} mm · hides arrow side · layers still apply`;
    }
  }
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const colors = themeColors();
  ctx.fillStyle = colors.stage;
  ctx.fillRect(0, 0, w, h);
  const layer = state.result?.layers[state.layer];
  const mesh = state.result?.mesh;
  if (!layer || !mesh) {
    ctx.fillStyle = colors.muted;
    ctx.font = `${14 * (window.devicePixelRatio || 1)}px IBM Plex Sans, sans-serif`;
    ctx.fillText(state.mesh ? state.mesh.name : "Toolpath preview", 24, 36);
    ctx.fillText(state.mesh ? "Slice to preview the toolpath." : "Open a mesh, then slice.", 24, 60);
    sync3d();
    return;
  }
  const pad = 28 * (window.devicePixelRatio || 1);
  const spanX = Math.max(1e-6, mesh.max[0] - mesh.min[0]);
  const spanY = Math.max(1e-6, mesh.max[1] - mesh.min[1]);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * scale) / 2;
  const oy = (h - spanY * scale) / 2;
  const map = (x: number, y: number): [number, number] => [ox + (x - mesh.min[0]) * scale, h - (oy + (y - mesh.min[1]) * scale)];
  const played = movesNow()[state.move];
  const section = activeSection();
  const center = previewCenter();
  const layerZ = layer.z;
  pathsOf(layer).forEach((path, pathIndex) => {
    if (state.hidden.has(path.kind)) return;
    if (path.kind === "travel" && !state.showTravel) return;
    const cut = !played ? path.pts.length : pathIndex < played.path ? path.pts.length : pathIndex > played.path ? 1 : played.seg + 1;
    strokePts(path, 0, cut, 1);
    if (cut < path.pts.length) strokePts(path, Math.max(0, cut - 1), path.pts.length, 0.22);
  });
  ctx.setLineDash([]);
  function strokePts(path: PreviewPath, from: number, to: number, alpha: number) {
    if (to - from < 1) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colorForPath(path.kind, state.colorMode, path.toughness ?? 0, path.effectiveSpeed ?? path.speed ?? 0);
    ctx.lineWidth = path.kind === "travel" ? 1 : Math.max(1.2, scale * 0.1);
    ctx.setLineDash(path.kind === "travel" ? [4, 4] : []);
    const runs = section && center
      ? clipPolyline(path.pts, path.zs, layerZ, from, to, center, section)
      : null;
    if (!runs) {
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const [x, y] = map(path.pts[i][0], path.pts[i][1]);
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      for (const run of runs) {
        ctx.beginPath();
        run.forEach(([x, y], i) => {
          const [px, py] = map(x, y);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  if (section && center) {
    const seam = layerCut(layer.z, {
      minX: mesh.min[0],
      minY: mesh.min[1],
      maxX: mesh.max[0],
      maxY: mesh.max[1],
    }, center, section);
    if (seam) {
      const [ax, ay] = map(seam[0][0], seam[0][1]);
      const [bx, by] = map(seam[1][0], seam[1][1]);
      ctx.setLineDash([6 * (window.devicePixelRatio || 1), 4 * (window.devicePixelRatio || 1)]);
      ctx.strokeStyle = colors.amber;
      ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  if (played && sectionKeeps(played.x, played.y, played.z)) {
    const [x, y] = map(played.x, played.y);
    ctx.fillStyle = colors.amber;
    ctx.beginPath();
    ctx.arc(x, y, 5 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.blendKind === "byRegion") paintRegionOverlay(mesh, map, window.devicePixelRatio || 1);
  sync3d();
}

function segmentStart(paths: PreviewPath[], point: PlayPoint): [number, number] {
  const prev = paths[point.path]?.pts[point.seg - 1];
  return prev ?? [point.x, point.y];
}


geomWorker.onmessage = (ev) => {
  session.geomReady = { id: ev.data.id, data: ev.data };
  if (session.shown === state.result) applyGeom();
};

/** Shows the worker's buffers once they and the result they belong to have both arrived. */
function applyGeom() {
  const result = state.result;
  if (!result) {
    view3d.setBuffers(null);
    return;
  }
  if (session.geomReady?.id !== session.resultJob) return;
  const mesh = result.mesh;
  view3d.setBuffers({
    ...session.geomReady.data,
    span: Math.max(mesh.max[0] - mesh.min[0], mesh.max[1] - mesh.min[1], mesh.max[2] - mesh.min[2], 1),
    midZ: (mesh.min[2] + mesh.max[2]) / 2,
    centerX: (mesh.min[0] + mesh.max[0]) / 2,
    centerY: (mesh.min[1] + mesh.max[1]) / 2,
    frame: session.resultFrame,
  });
  session.geomReady = null;
  view3d.setRange(state.rangeLow, state.layer);
}

function sync3d() {
  if (state.result !== session.shown) {
    session.shown = state.result;
    applyGeom();
  }
  view3d.setHidden(state.hidden);
  view3d.setColorMode(state.colorMode);
  view3d.setShowTravel(state.showTravel && !state.hidden.has("travel"));
  view3d.setRange(state.rangeLow, state.layer);
  view3d.setSection(state.sectionOn ? { normal: state.sectionNormal, offset: state.sectionOffset } : null);
  const moves = movesNow();
  const point = moves[state.move];
  const shownLayer = state.result?.layers[state.layer];
  const prev = point && shownLayer ? segmentStart(pathsOf(shownLayer), point) : null;
  const headOn = point && prev && sectionKeeps(point.x, point.y, point.z);
  view3d.setPlayhead(headOn ? { x0: prev[0], y0: prev[1], z0: point.z, x1: point.x, y1: point.y, z1: point.z } : null);
  syncPlanes();
  paintSectionChrome();
  view3d.resize();
}

prepare.onSplit((at) => commitSplit(at));
prepare.onRotate((axis, deltaDeg, totalDeg) => {
  const spin = axis === "x" ? rotX : axis === "y" ? rotY : rotZ;
  state.orient = matMul(spin(deltaDeg), state.orient);
  state.poseHud = `${axis.toUpperCase()} ${totalDeg >= 0 ? "+" : ""}${totalDeg.toFixed(0)}°`;
  applyPlace(false);
});
prepare.onRotateEnd(() => {
  state.poseHud = "";
  paintGizmoReadout();
  renderChrome();
});
prepare.onMove((axis, deltaMm, totalMm) => {
  if (!state.sourcePos) return;
  if (state.centered) {
    state.offset = centeringShift(state.sourcePos, state.orient, state.partScale, state.profile.bedX, state.profile.bedY);
    state.centered = false;
  }
  state.offset = {
    x: state.offset.x + (axis === "x" ? deltaMm : 0),
    y: state.offset.y + (axis === "y" ? deltaMm : 0),
    z: state.offset.z + (axis === "z" ? deltaMm : 0),
  };
  state.poseHud = `${axis.toUpperCase()} ${totalMm >= 0 ? "+" : ""}${totalMm.toFixed(1)} mm`;
  applyPlace(false);
});
prepare.onMoveEnd(() => {
  state.poseHud = "";
  paintGizmoReadout();
  renderChrome();
});
view3d.onPlane((at) => commitSplit(at));

function fitNarrow() {
  if (window.innerWidth <= 1200) setView("solid");
}

new ResizeObserver(() => resize()).observe(document.querySelector("#stage")!);
applyStoredLevel();
applyTheme(loadTheme());
(document.querySelector("#theme") as HTMLSelectElement).value = loadTheme();
onSchemeChange(() => {
  view3d.setTheme();
  prepare.setTheme();
  draw();
});
renderChrome();
fitNarrow();
resize();
view3d.setTheme();
prepare.setTheme();
mountChrome({
  setGizmoTool: (tool) => prepare.setGizmoTool(tool),
  onToolReadout: () => paintGizmoReadout(),
});
mountShell({ setViewPreset: (preset) => prepare.setViewPreset(preset) });
mountConnection(() => {
  void probe();
});
mountPlatform();
mountCompact();
mountToasts();
mountPalette();
mountStageTabs();
fillHelpShortcuts(document.querySelector("#helpShortcuts")!);
mountLegend();
mountLayerTip();
document.addEventListener("lime-open-help", () => setHelp(true));
syncEmptyState(!!state.mesh);
resize();
void probe();
