import { fx } from "./fx";
import { geomWorker, state, session, type PreviewLayer, type SliceResponse } from "./state";
import { createPrepareView } from "../prepare-view";
import { createSliceView, type SliceView3d } from "../view3d";
import { FEATURE_LABEL, FEATURE_COLOR, colorForPath } from "../colors";
import { legendMarkup } from "../ui/legend";
import { syncLayerTip } from "../ui/layer-tip";
import { type LayerGcode, indexLayerGcode, type PlayPoint, layerMoves, matchGcodeLine, layerClasses } from "../playback";
import { applyPlace, fetchStoredGcode } from "./files";
import { renderChrome, escapeHtml, layerReadout, paramTable, currentWeight, stale, markStale } from "./settings";
import { type PreviewPath, decodePaths } from "../preview-wire";
import { patchGeometry, patchLayers, type PreviewPatch } from "../preview-patch";
import type { PreviewGeometry } from "../preview-geom";
import type { RibbonBuffers } from "../view3d";
import { themeColors } from "../theme";
import { resolved } from "../strategy";
import { syncEmptyState } from "../ui/shell";
import { type AxisBounds, type SplitSync, splitOutside, nextSplitAt, roundSplit, clampSplit } from "../split-at";
import { centeringShift, matMul, rotX, rotY, rotZ } from "../mesh-place";
import { type Vec3, sectionReach, type SectionSpec, keepsPoint, clipPolyline, layerCut } from "../section-plane";

export function paintLegend() {
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

export function paintSlider() {
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

export const gcodeLoads = new WeakMap<SliceResponse, Promise<string>>();

export const gcodeIndex = new WeakMap<SliceResponse, LayerGcode>();

/** The engine parks the G-code body; fetch it on first use, once per result. */
export function loadGcode(result: SliceResponse): Promise<string> {
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
export function layerGcode(load = false): LayerGcode | null {
  const result = state.result;
  if (!result) return null;
  if (load) void loadGcode(result);
  return gcodeIndex.get(result) ?? null;
}

export const decoded = new WeakMap<PreviewLayer, PreviewPath[]>();

/** One layer's paths as objects. Decoded on first use, only for layers that are drawn. */
export function pathsOf(layer: PreviewLayer): PreviewPath[] {
  let paths = decoded.get(layer);
  if (!paths) {
    paths = decodePaths(layer.paths, layer.z);
    decoded.set(layer, paths);
  }
  return paths;
}

export function movesNow(): PlayPoint[] {
  const layer = state.result?.layers[state.layer];
  if (!layer) return [];
  return layerMoves(pathsOf(layer), layer.z, layer.height);
}

export function paintPlayback() {
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

export function paintGcode() {
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

export function syncGcodeHighlight() {
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

/** The histogram bars for one result, size, and palette. A slider step only repaints the current-layer marker over them. */
let spark: ReturnType<typeof sparkBars> | null = null;

function sparkBars(layers: PreviewLayer[], width: number, height: number, dpr: number, colors: ReturnType<typeof themeColors>, palette: string) {
  const seconds = layers.map((layer) => layer.seconds ?? 0);
  const kinds = layerClasses(seconds);
  const bars = document.createElement("canvas");
  bars.width = width;
  bars.height = height;
  const g = bars.getContext("2d")!;
  const max = Math.max(...seconds, 0.001);
  const gap = seconds.length > 80 ? 0 : 1 * dpr;
  const barW = width / Math.max(1, seconds.length);
  const heights = seconds.map((value, i) => {
    const kind = kinds[i];
    g.fillStyle = kind === "slow" ? colors.slow : kind === "fast" ? colors.fast : colors.spark;
    const h = Math.max(dpr, (value / max) * (height - 3 * dpr));
    g.fillRect(i * barW, height - h, Math.max(dpr, barW - gap), h);
    return h;
  });
  return { layers, width, height, palette, kinds, bars, heights, barW, gap };
}

export function paintSpark() {
  const canvasEl = document.querySelector<HTMLCanvasElement>("#spark");
  const label = document.querySelector("#sparkLabel");
  if (!canvasEl) return;
  const layers = state.result?.layers ?? [];
  const rect = canvasEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvasEl.width !== width) canvasEl.width = width;
  if (canvasEl.height !== height) canvasEl.height = height;
  const colors = themeColors();
  const palette = `${colors.slow} ${colors.fast} ${colors.spark}`;
  if (spark?.layers !== layers || spark.width !== width || spark.height !== height || spark.palette !== palette) {
    spark = sparkBars(layers, width, height, dpr, colors, palette);
  }
  const here = layers[state.layer];
  const klass = here ? spark.kinds[state.layer] : "ok";
  if (label) {
    const tag = klass === "slow" ? "slow" : klass === "fast" ? "too fast" : "typical";
    label.innerHTML = here
      ? `<i style="background:var(--slow)"></i>slow<br><i style="background:var(--fast)"></i>too fast<br>${(here.seconds ?? 0).toFixed(1)} s · ${tag}`
      : "Layer time";
  }
  const g = canvasEl.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, width, height);
  if (layers.length === 0) return;
  g.drawImage(spark.bars, 0, 0);
  if (!here) return;
  const h = spark.heights[state.layer];
  g.strokeStyle = colors.teal;
  g.lineWidth = Math.max(1, dpr);
  g.strokeRect(state.layer * spark.barW + 0.5, height - h, Math.max(dpr, spark.barW - spark.gap) - 1, h - 1);
}

export function stopPlay() {
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

export function togglePlay() {
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

export function scrub(next: number) {
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

export function setView(mode: typeof state.viewMode) {
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

export function setStage(stage: "prepare" | "preview" | "gcode") {
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

export function setHelp(open: boolean) {
  state.help = open;
  const sheet = document.querySelector<HTMLElement>("#help")!;
  sheet.hidden = !open;
  if (open) document.querySelector<HTMLButtonElement>("#helpClose")?.focus();
}

export function placedAxisBounds(): AxisBounds | null {
  return state.placed?.bounds ?? null;
}

export function realignSplit(reason: SplitSync) {
  const bounds = placedAxisBounds();
  const before = state.atMm;
  const outside = !!bounds && splitOutside(before, bounds, state.axis);
  state.atMm = nextSplitAt(reason, before, bounds, state.axis, state.splitCustom);
  if (reason === "load" || reason === "axis" || outside) state.splitCustom = false;
  refreshSplitNotice();
}

export function noticeBounds(): AxisBounds | null {
  if (state.result && !stale()) {
    const mesh = state.result.mesh;
    return {
      min: [mesh.min[0], mesh.min[1], mesh.min[2]],
      max: [mesh.max[0], mesh.max[1], mesh.max[2]],
    };
  }
  return placedAxisBounds();
}

export function refreshSplitNotice() {
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

export function commitSplit(at: number) {
  const bounds = placedAxisBounds();
  state.atMm = bounds ? roundSplit(clampSplit(at, bounds, state.axis)) : roundSplit(at);
  state.splitCustom = true;
  refreshSplitNotice();
  syncSplitField(true);
  const node = document.querySelector("#resolved");
  if (node && state.blendKind === "byRegion") node.innerHTML = paramTable(resolved(currentWeight(), state.layerHeight));
  markStale();
}

export function syncSplitField(force = false) {
  const input = document.querySelector<HTMLInputElement>("#at");
  if (!input) return;
  if (!force && document.activeElement === input) return;
  if (Math.abs(Number(input.value) - state.atMm) < 0.049) return;
  input.value = state.atMm.toFixed(1);
}

export function paintGizmoReadout() {
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

export function syncPlanes() {
  const show = state.blendKind === "byRegion";
  const placed = placedAxisBounds();
  fx.prepare.setSplit(show && placed ? { axis: state.axis, at: state.atMm } : null);
  const model = state.result
    ? { min: state.result.mesh.min, max: state.result.mesh.max }
    : placed
      ? { min: [...placed.min], max: [...placed.max] }
      : null;
  if (model) fx.view3d.setModel(model.min, model.max);
  fx.view3d.setGhost(state.result ? null : state.placed);
  fx.view3d.setPlane(show && model ? { axis: state.axis, at: state.atMm } : null);
  syncSplitField();
  paintGizmoReadout();
}

export function clampPlane() {
  refreshSplitNotice();
}

export function paintRegionOverlay(
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
    fx.ctx.save();
    fx.ctx.globalAlpha = 0.18;
    fx.ctx.fillStyle = color;
    fx.ctx.fillRect(Math.min(px, qx), Math.min(py, qy), Math.abs(qx - px), Math.abs(qy - py));
    fx.ctx.restore();
  };
  const text = (x: number, y: number, label: string, color: string) => {
    const [px, py] = map(x, y);
    fx.ctx.fillStyle = color;
    fx.ctx.font = `600 ${Math.round(12 * dpr)}px IBM Plex Sans, sans-serif`;
    fx.ctx.textAlign = "center";
    fx.ctx.textBaseline = "middle";
    fx.ctx.fillText(label, px, py);
  };
  fx.ctx.lineWidth = Math.max(2, 2 * dpr);
  fx.ctx.strokeStyle = colors.text;
  fx.ctx.beginPath();
  if (state.axis === "x") {
    if (at > x0 + 0.4) fill(x0, y0, Math.min(at, x1), y1, colors.amber);
    if (at < x1 - 0.4) fill(Math.max(at, x0), y0, x1, y1, colors.teal);
    const [lx, ly1] = map(at, y0);
    const [, ly2] = map(at, y1);
    fx.ctx.moveTo(lx, ly1);
    fx.ctx.lineTo(lx, ly2);
    fx.ctx.stroke();
    if (at > x0 + 1) text((x0 + Math.min(at, x1)) / 2, (y0 + y1) / 2, "toughness", colors.amber);
    if (at < x1 - 1) text((Math.max(at, x0) + x1) / 2, (y0 + y1) / 2, "speed", colors.teal);
    return;
  }
  if (at > y0 + 0.4) fill(x0, y0, x1, Math.min(at, y1), colors.amber);
  if (at < y1 - 0.4) fill(x0, Math.max(at, y0), x1, y1, colors.teal);
  const [lx, ly] = map(x0, at);
  const [lx2] = map(x1, at);
  fx.ctx.moveTo(lx, ly);
  fx.ctx.lineTo(lx2, ly);
  fx.ctx.stroke();
  if (at > y0 + 1) text((x0 + x1) / 2, (y0 + Math.min(at, y1)) / 2, "toughness", colors.amber);
  if (at < y1 - 1) text((x0 + x1) / 2, (Math.max(at, y0) + y1) / 2, "speed", colors.teal);
}

export function previewMap(mesh: { min: number[]; max: number[] }) {
  const w = fx.canvas.width;
  const h = fx.canvas.height;
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

export function canvasPx(ev: PointerEvent) {
  const rect = fx.canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) * (fx.canvas.width / Math.max(1, rect.width)),
    y: (ev.clientY - rect.top) * (fx.canvas.height / Math.max(1, rect.height)),
  };
}

export const endRegionDrag = () => { session.drag2d = false; };

export function resize() {
  const rect = fx.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (rect.width >= 1 && rect.height >= 1) {
    fx.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    fx.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }
  fx.view3d.resize();
  fx.prepare.resize();
  if (window.innerWidth < 1200 && state.viewMode === "split") setView("solid");
  draw();
}

export function previewCenter(): Vec3 | null {
  const mesh = state.result?.mesh;
  if (mesh) {
    return [
      (mesh.min[0] + mesh.max[0]) / 2,
      (mesh.min[1] + mesh.max[1]) / 2,
      (mesh.min[2] + mesh.max[2]) / 2,
    ];
  }
  if (!state.placed) return null;
  const { bounds } = state.placed;
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

export function sectionLimit() {
  const mesh = state.result?.mesh;
  if (mesh) return sectionReach(mesh.min, mesh.max);
  if (state.placed) {
    const { bounds } = state.placed;
    return sectionReach(bounds.min, bounds.max);
  }
  return 100;
}

export function activeSection(): SectionSpec | null {
  if (!state.sectionOn) return null;
  return { normal: state.sectionNormal, offset: state.sectionOffset };
}

export function sectionKeeps(x: number, y: number, z: number) {
  const spec = activeSection();
  const center = previewCenter();
  if (!spec || !center) return true;
  return keepsPoint([x, y, z], center, spec);
}

export function paintSectionChrome() {
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

export function draw() {
  const w = fx.canvas.width;
  const h = fx.canvas.height;
  fx.ctx.setTransform(1, 0, 0, 1, 0, 0);
  const colors = themeColors();
  fx.ctx.fillStyle = colors.stage;
  fx.ctx.fillRect(0, 0, w, h);
  const layer = state.result?.layers[state.layer];
  const mesh = state.result?.mesh;
  if (!layer || !mesh) {
    fx.ctx.fillStyle = colors.muted;
    fx.ctx.font = `${14 * (window.devicePixelRatio || 1)}px IBM Plex Sans, sans-serif`;
    fx.ctx.fillText(state.mesh ? state.mesh.name : "Toolpath preview", 24, 36);
    fx.ctx.fillText(state.mesh ? "Slice to preview the toolpath." : "Open a mesh, then slice.", 24, 60);
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
  fx.ctx.setLineDash([]);
  function strokePts(path: PreviewPath, from: number, to: number, alpha: number) {
    if (to - from < 1) return;
    fx.ctx.globalAlpha = alpha;
    fx.ctx.strokeStyle = colorForPath(path.kind, state.colorMode, path.toughness ?? 0, path.effectiveSpeed ?? path.speed ?? 0);
    fx.ctx.lineWidth = path.kind === "travel" ? 1 : Math.max(1.2, scale * 0.1);
    fx.ctx.setLineDash(path.kind === "travel" ? [4, 4] : []);
    const runs = section && center
      ? clipPolyline(path.pts, path.zs, layerZ, from, to, center, section)
      : null;
    if (!runs) {
      fx.ctx.beginPath();
      for (let i = from; i < to; i++) {
        const [x, y] = map(path.pts[i][0], path.pts[i][1]);
        if (i === from) fx.ctx.moveTo(x, y);
        else fx.ctx.lineTo(x, y);
      }
      fx.ctx.stroke();
    } else {
      for (const run of runs) {
        fx.ctx.beginPath();
        run.forEach(([x, y], i) => {
          const [px, py] = map(x, y);
          if (i === 0) fx.ctx.moveTo(px, py);
          else fx.ctx.lineTo(px, py);
        });
        fx.ctx.stroke();
      }
    }
    fx.ctx.globalAlpha = 1;
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
      fx.ctx.setLineDash([6 * (window.devicePixelRatio || 1), 4 * (window.devicePixelRatio || 1)]);
      fx.ctx.strokeStyle = colors.amber;
      fx.ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
      fx.ctx.beginPath();
      fx.ctx.moveTo(ax, ay);
      fx.ctx.lineTo(bx, by);
      fx.ctx.stroke();
      fx.ctx.setLineDash([]);
    }
  }
  if (played && sectionKeeps(played.x, played.y, played.z)) {
    const [x, y] = map(played.x, played.y);
    fx.ctx.fillStyle = colors.amber;
    fx.ctx.beginPath();
    fx.ctx.arc(x, y, 5 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    fx.ctx.fill();
  }
  if (state.blendKind === "byRegion") paintRegionOverlay(mesh, map, window.devicePixelRatio || 1);
  sync3d();
}

export function segmentStart(paths: PreviewPath[], point: PlayPoint): [number, number] {
  const prev = paths[point.path]?.pts[point.seg - 1];
  return prev ?? [point.x, point.y];
}

type GeomData = Omit<RibbonBuffers, "span" | "midZ" | "centerX" | "centerY">;

/** The preview on screen: the reply's token, its layers, and the buffers drawn from them. */
interface ShownPreview {
  token: string;
  layers: PreviewLayer[];
  geom: GeomData;
}
let shownPreview: ShownPreview | null = null;
/** Partial replies waiting for the geometry worker to build their new paths. */
const patching = new Map<number, { patch: PreviewPatch; base: ShownPreview }>();

/** What the next request can name as `previewBase`: the preview on screen, if the shown result drew it. */
export function previewBase(): ShownPreview | null {
  return shownPreview && state.result?.previewToken === shownPreview.token && state.result.layers === shownPreview.layers ? shownPreview : null;
}

/**
 * Turn a partial reply into a whole one: its layers rebuilt from `base`, and
 * the new paths sent to the geometry worker, whose buffers `applyGeom` then
 * splices into the ones on screen. False when `base` is not what the patch
 * was made against, so the caller asks for the whole preview.
 */
export function adoptPatch(id: number, body: SliceResponse, base: ShownPreview | null): boolean {
  const patch = body.previewPatch;
  const layers = patch && base && patch.base === base.token ? patchLayers(base.layers, patch) : null;
  if (!patch || !base || !layers) return false;
  body.layers = layers;
  patching.set(id, { patch, base });
  geomWorker.postMessage({ id, layers: patch.changed, min: body.mesh.min, max: body.mesh.max, kinds: base.geom.kinds });
  return true;
}

const toGeometry = (d: GeomData): PreviewGeometry => ({ ranges: d.ranges, kinds: d.kinds, ribbon: d.ribbonPos, ribbonInfo: d.ribbonInfo, face: d.facePos, faceInfo: d.faceInfo, travel: d.travelPos, travelInfo: d.travelInfo });
const fromGeometry = (g: PreviewGeometry): GeomData => ({ ranges: g.ranges, kinds: g.kinds, ribbonPos: g.ribbon, ribbonInfo: g.ribbonInfo, facePos: g.face, faceInfo: g.faceInfo, travelPos: g.travel, travelInfo: g.travelInfo, frame: "" });

/** Shows the worker's buffers once they and the result they belong to have both arrived. */
export function applyGeom() {
  const result = state.result;
  if (!result) {
    fx.view3d.setBuffers(null);
    return;
  }
  if (session.geomReady?.id !== session.resultJob) return;
  const mesh = result.mesh;
  fx.view3d.setBuffers({
    ...session.geomReady.data,
    span: Math.max(mesh.max[0] - mesh.min[0], mesh.max[1] - mesh.min[1], mesh.max[2] - mesh.min[2], 1),
    midZ: (mesh.min[2] + mesh.max[2]) / 2,
    centerX: (mesh.min[0] + mesh.max[0]) / 2,
    centerY: (mesh.min[1] + mesh.max[1]) / 2,
    frame: session.resultFrame,
  });
  shownPreview = result.previewToken ? { token: result.previewToken, layers: result.layers, geom: session.geomReady.data } : null;
  session.geomReady = null;
  fx.view3d.setRange(state.rangeLow, state.layer);
}

export function sync3d() {
  if (state.result !== session.shown) {
    session.shown = state.result;
    applyGeom();
  }
  fx.view3d.setHidden(state.hidden);
  fx.view3d.setColorMode(state.colorMode);
  fx.view3d.setShowTravel(state.showTravel && !state.hidden.has("travel"));
  fx.view3d.setRange(state.rangeLow, state.layer);
  fx.view3d.setSection(state.sectionOn ? { normal: state.sectionNormal, offset: state.sectionOffset } : null);
  const moves = movesNow();
  const point = moves[state.move];
  const shownLayer = state.result?.layers[state.layer];
  const prev = point && shownLayer ? segmentStart(pathsOf(shownLayer), point) : null;
  const headOn = point && prev && sectionKeeps(point.x, point.y, point.z);
  fx.view3d.setPlayhead(headOn ? { x0: prev[0], y0: prev[1], z0: point.z, x1: point.x, y1: point.y, z1: point.z } : null);
  syncPlanes();
  paintSectionChrome();
  session.supportUi?.refresh();
  fx.view3d.resize();
}

export function fitNarrow() {
  if (window.innerWidth <= 1200) setView("solid");
}

export let view3d: SliceView3d;
export let prepare: ReturnType<typeof createPrepareView>;

export function mountViews() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
  const ctx = canvas.getContext("2d")!;
  view3d = createSliceView(document.querySelector<HTMLCanvasElement>("#view3d")!);
  prepare = createPrepareView(document.querySelector<HTMLCanvasElement>("#prepare")!);
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
  canvas.addEventListener("pointerup", endRegionDrag);
  canvas.addEventListener("pointercancel", endRegionDrag);
  geomWorker.onmessage = (ev) => {
    const pending = patching.get(ev.data.id);
    patching.delete(ev.data.id);
    const data: GeomData = pending
      ? fromGeometry(patchGeometry(toGeometry(pending.base.geom), pending.base.layers, pending.patch, toGeometry(ev.data)))
      : ev.data;
    session.geomReady = { id: ev.data.id, data };
    if (session.shown === state.result) applyGeom();
  };
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
}

Object.assign(fx, { paintLegend, paintSlider, loadGcode, layerGcode, pathsOf, movesNow, paintPlayback, paintGcode, syncGcodeHighlight, paintSpark, stopPlay, togglePlay, scrub, setView, setStage, setHelp, placedAxisBounds, realignSplit, noticeBounds, refreshSplitNotice, commitSplit, syncSplitField, paintGizmoReadout, syncPlanes, clampPlane, paintRegionOverlay, previewMap, canvasPx, resize, previewCenter, sectionLimit, activeSection, sectionKeeps, paintSectionChrome, draw, segmentStart, applyGeom, sync3d, fitNarrow });
