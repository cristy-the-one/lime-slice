import { colorForPath, FEATURE_COLOR, FEATURE_LABEL, type ColorMode } from "./colors";
import { encode3mf, encodeStl, ID_MATRIX, layFlatMatrix, matMul, offBed, parseStl, rotX, rotY, rotZ, transformPositions, boundsOf, type Mat3 } from "./mesh-place";
import { layerClass, layerMoves, matchGcodeLine, parseLayerGcode, type PlayPoint } from "./playback";
import { createPrepareView } from "./prepare-view";
import { DEFAULT_PRESET, diffPreset, presetKeys, readPresets, writePresets, type PresetSettings } from "./presets";
import { loadProfile, profileJson, saveProfile, type PrinterProfile } from "./profiles";
import { layerWeight, resolved, type ResolvedCard } from "./strategy";
import { applyTheme, loadTheme, onSchemeChange, themeColors, type ThemeChoice } from "./theme";
import { createSliceView, type RibbonBuffers, type SliceView3d } from "./view3d";

const API = "http://127.0.0.1:43118";

type StrategyId = "speed" | "toughness";
type BlendMode = "single" | "weight" | "byLayer" | "byRegion";
type CardId = "speed" | "efficiency" | "toughness" | "layer" | "region";

interface PreviewPath {
  kind: string;
  strategy: string;
  pts: [number, number][];
  zs?: number[];
  width?: number;
  speed?: number;
  effectiveSpeed?: number;
  toughness?: number;
}
interface PreviewLayer {
  index: number;
  z: number;
  height: number;
  note: string;
  seconds?: number;
  speedWalls: number;
  toughnessWalls: number;
  supportPaths: number;
  paths: PreviewPath[];
}
interface FeatureRow {
  kind: string;
  seconds: number;
  filamentMm: number;
  filamentG: number;
}
interface SliceResponse {
  coreMs: number;
  baselineMs: number;
  blend: string;
  mesh: { triangles: number; min: number[]; max: number[] };
  sanity: { ok: boolean; notes: string[]; layers: number; finalE: number; extrusionLengthMm: number };
  estimate?: {
    seconds: number;
    filamentMm: number;
    filamentG: number;
    arcMoves: number;
    travelMm?: number;
    retracts?: number;
    scarfedLoops?: number;
    byFeature?: FeatureRow[];
  };
  compare?: { label: string; seconds: number; filamentG: number }[];
  gcode: string;
  gcodeToken?: string;
  layers: PreviewLayer[];
  score?: { toughness: number };
  error?: string;
}

interface ParetoPoint {
  label: string;
  toughness: number;
  seconds: number;
  filamentG: number;
  score: number;
}

const state = {
  mesh: null as { name: string; bytes: ArrayBuffer } | null,
  result: null as SliceResponse | null,
  slicedHash: "",
  layer: 0,
  rangeLow: 0,
  showTravel: false,
  hidden: new Set<string>(),
  colorMode: "feature" as ColorMode,
  busy: false,
  progress: 0,
  error: "",
  notice: "",
  engine: "",
  blendKind: "single" as BlendMode,
  strategy: "speed" as StrategyId,
  toughness: 0.5,
  bottomMm: 4,
  transitionMm: 6,
  axis: "x" as "x" | "y",
  atMm: 10,
  layerHeight: 0.2,
  adaptive: false,
  adaptiveMin: 0.08,
  adaptiveMax: 0.2,
  supports: false,
  supportAngle: 45,
  supportStyle: "grid" as "grid" | "tree",
  branchAngle: 40,
  tipDiameter: 0.8,
  trunkDiameter: 4.2,
  supportHeightMult: 1,
  infillCombine: true,
  combing: true,
  featureSpeeds: true,
  pressureAdvance: 0,
  linearAdvance: 0,
  variableWidth: true,
  arcFit: true,
  travelOpt: true,
  overhangControl: true,
  scarfSeam: "blend" as "blend" | "off" | "outer" | "all",
  scarfLength: 10,
  scarfSteps: 8,
  gyroid3d: "blend" as "blend" | "off" | "on",
  zHop: "blend" as "off" | "blend" | "always" | "smart",
  zHopHeight: 0.4,
  zHopMinTravel: 2,
  paFirmware: "klipper" as "klipper" | "marlin",
  paStart: 0,
  paEnd: 0.08,
  paStep: 0.005,
  paBands: [] as { index: number; k: number; z0: number; z1: number }[],
  paGcode: "",
  pricePerKg: 20,
  autoSlice: false,
  viewMode: "split" as "flat" | "split" | "solid",
  query: "",
  move: 0,
  stage: "preview" as "prepare" | "preview" | "gcode",
  playing: false,
  profile: loadProfile(),
  sourcePos: null as Float32Array | null,
  placed: null as Float32Array | null,
  orient: ID_MATRIX as Mat3,
  partScale: 1,
  centered: true,
  pareto: [] as ParetoPoint[],
  gcodeToken: "",
  help: false,
};

const worker = new Worker(new URL("./slice-worker.ts", import.meta.url), { type: "module" });
let job = 0;
let autoTimer = 0;

const app = document.querySelector("#app")!;
app.innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand">Lime <span>Slice</span></div>
      <button class="btn panel-toggle" id="toggleLeft" type="button">Settings</button>
      <button class="btn panel-toggle" id="toggleRight" type="button">Blend</button>
      <label class="btn file">Open mesh<input id="file" type="file" accept=".stl,.3mf,.STL,.3MF" /></label>
      <details class="menu" id="samples">
        <summary class="btn">Samples</summary>
        <nav>
          <button type="button" data-sample="calibration_cube_20mm.stl">20 mm cube</button>
          <button type="button" data-sample="lime_hull.stl">60 mm hull</button>
          <button type="button" data-sample="calibration_cube_20mm.3mf">Cube 3MF</button>
          <button type="button" data-sample="overhang_ledge.stl">Overhang</button>
          <button type="button" data-sample="slope_ramp.stl">Slope</button>
          <button type="button" data-sample="thin_fin.stl">Thin wall</button>
          <button type="button" data-sample="bridge_span.stl">Bridge</button>
          <button type="button" data-sample="arc_post.stl">Arc post</button>
        </nav>
      </details>
      <label class="theme-field">Theme
        <select id="theme" aria-label="Theme">
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <div class="spacer"></div>
      <div class="timing" id="timing">No slice yet</div>
      <button class="btn primary" id="slice" type="button">Slice</button>
      <button class="btn" id="cancel" type="button" hidden>Cancel</button>
      <button class="btn" id="export" type="button" disabled>Export G-code</button>
    </header>
    <div class="banner-rail" id="banner"></div>
    <div class="workspace">
      <aside class="panel" id="left"></aside>
      <section class="stage mode-split" id="stage">
        <div class="viewbar">
          <div class="modes" id="viewModes">
            <button class="btn mode" type="button" data-mode="flat" aria-pressed="false">2D</button>
            <button class="btn mode" type="button" data-mode="split" aria-pressed="true">Split</button>
            <button class="btn mode" type="button" data-mode="solid" aria-pressed="false">3D</button>
          </div>
          <div class="modes" role="tablist" aria-label="Workspace">
            <button class="btn mode tab" id="tabPrepare" type="button" data-tab="prepare" aria-pressed="false">Prepare</button>
            <button class="btn mode tab on" id="tabPreview" type="button" data-tab="preview" aria-pressed="true">Preview</button>
            <button class="btn mode tab" id="tabGcode" type="button" data-tab="gcode" aria-pressed="false">G-code</button>
          </div>
          <label class="field">Color
            <select id="colorBy">
              <option value="feature">Feature</option>
              <option value="weight">Blend weight</option>
              <option value="speed">Speed</option>
            </select>
          </label>
        </div>
        <div class="stage-body" id="prepareBody" hidden>
          <canvas id="prepare" aria-label="Model on the build plate"></canvas>
        </div>
        <div class="stage-body" id="previewBody">
          <div class="vslider" id="vslider">
            <div class="readout" id="readHigh">—</div>
            <div class="track">
              <div class="band" id="layerBand" hidden></div>
              <input id="rangeLow" type="range" min="0" max="0" value="0" aria-label="Lowest visible layer" />
              <input id="rangeHigh" type="range" min="0" max="0" value="0" aria-label="Current layer" />
            </div>
            <div class="readout" id="readLow">Z —</div>
          </div>
          <div class="previews">
            <div class="pane" id="pane2d"><canvas id="view" aria-label="2D toolpath"></canvas></div>
            <div class="pane" id="pane3d"><canvas id="view3d" aria-label="3D toolpath"></canvas></div>
          </div>
        </div>
        <div class="gcode-pane" id="gcodePane" hidden></div>
        <div class="stage-tools">
          <div class="spark-wrap">
            <div class="spark-label" id="sparkLabel">Layer time</div>
            <canvas id="spark" aria-label="Per-layer time"></canvas>
          </div>
          <div class="playback">
            <button class="btn" id="play" type="button" aria-label="Play toolpath">Play</button>
            <input id="move" type="range" min="0" max="0" value="0" aria-label="Toolpath playback" />
            <div class="play-readout" id="playReadout">Feature — · feed — · E —</div>
          </div>
        </div>
        <div class="legend" id="legend"></div>
      </section>
      <aside class="panel right" id="right"></aside>
    </div>
    <footer class="status" id="status">Load an STL or 3MF. Arrow keys move the layer. Press ? for shortcuts.</footer>
  </div>
  <div id="help" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="helpTitle">
    <div class="sheet-card">
      <h2 id="helpTitle">Shortcuts</h2>
      <ul>
        <li><kbd>Ctrl</kbd>+<kbd>O</kbd> Open mesh</li>
        <li><kbd>Ctrl</kbd>+<kbd>Enter</kbd> Slice</li>
        <li><kbd>Ctrl</kbd>+<kbd>E</kbd> Export G-code</li>
        <li><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> 2D, split, 3D</li>
        <li><kbd>↑</kbd> <kbd>↓</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd> Layer</li>
        <li><kbd>?</kbd> This sheet</li>
      </ul>
      <button class="btn" id="helpClose" type="button">Close</button>
    </div>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const ctx = canvas.getContext("2d")!;
const view3d: SliceView3d = createSliceView(document.querySelector<HTMLCanvasElement>("#view3d")!);
const prepare = createPrepareView(document.querySelector<HTMLCanvasElement>("#prepare")!);
prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
view3d.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
let shown: SliceResponse | null = null;

function card(): CardId {
  if (state.blendKind === "byLayer") return "layer";
  if (state.blendKind === "byRegion") return "region";
  if (state.blendKind === "weight") return "efficiency";
  return state.strategy === "toughness" ? "toughness" : "speed";
}

function stale() {
  return !!state.result && state.slicedHash !== settingsHash();
}

function settingsHash() {
  const mesh = state.mesh ? `${state.mesh.name}:${state.mesh.bytes.byteLength}:${state.partScale}:${state.centered}:${state.orient.join(",")}` : "";
  const { result: _r, slicedHash: _h, busy: _b, progress: _p, error: _e, notice: _n, engine: _g, hidden: _hid, layer: _l, rangeLow: _lo, viewMode: _v, query: _q, showTravel: _t, colorMode: _c, paBands: _pb, paGcode: _pg, pricePerKg: _price, move: _mv, stage: _st, playing: _play, sourcePos: _sp, placed: _pl, pareto: _pa, gcodeToken: _gt, help: _hp, ...rest } = state;
  return JSON.stringify({ mesh, profile: state.profile, rest });
}

function blend() {
  if (state.blendKind === "single") return { mode: "single", strategy: state.strategy };
  if (state.blendKind === "weight") return { mode: "weight", toughness: state.toughness };
  if (state.blendKind === "byLayer") return { mode: "byLayer", bottomMm: state.bottomMm, transitionMm: state.transitionMm };
  return { mode: "byRegion", axis: state.axis, atMm: state.atMm };
}

function currentWeight() {
  const layer = state.result?.layers[state.layer];
  if (state.blendKind === "single") return state.strategy === "toughness" ? 1 : 0;
  if (state.blendKind === "weight") return state.toughness;
  if (state.blendKind === "byLayer") return layerWeight(layer?.z ?? state.bottomMm, state.bottomMm, state.transitionMm);
  return 1;
}

function renderChrome() {
  const mesh = state.mesh;
  const result = state.result;
  document.querySelector("#left")!.innerHTML = `
    <input id="find" type="search" placeholder="Search settings" value="${escapeHtml(state.query)}" />
    <h2>Mesh</h2>
    <div class="meta">${mesh ? `<b>${escapeHtml(mesh.name)}</b>` : "Nothing loaded"}</div>
    <div class="object-list" id="objectList">${objectList()}</div>
    ${group("Printer and filament", profileFields())}
    ${group("Presets", presetHtml())}
    ${group("Quality", `
      ${num("lh", "Layer height mm", state.layerHeight, 0.08, 0.4, 0.02)}
      ${check("adaptive", "Adaptive layers", state.adaptive)}
      ${state.adaptive ? `${num("amin", "Min mm", state.adaptiveMin, 0.04, 0.28, 0.02)}${num("amax", "Max mm", state.adaptiveMax, 0.08, 0.4, 0.02)}` : ""}
    `)}
    ${group("Speed and motion", `
      ${check("feeds", "Per-feature speeds", state.featureSpeeds)}
      ${check("arcs", "Arc fit (G2/G3)", state.arcFit)}
      ${check("combine", "Combine sparse infill", state.infillCombine)}
      ${check("combing", "Hole-aware combing", state.combing)}
      ${check("overhang", "Overhang and bridges", state.overhangControl)}
      ${num("pa", "Pressure advance", state.pressureAdvance, 0, 0.2, 0.005)}
      ${num("la", "Linear advance K", state.linearAdvance, 0, 2, 0.01)}
      ${select("gyroid3d", "3D gyroid", state.gyroid3d, [["blend", "Blend default"], ["off", "2D sine"], ["on", "Force 3D"]])}
      ${select("zhop", "Z-hop", state.zHop, [["blend", "Blend default"], ["off", "Off"], ["smart", "Smart"], ["always", "Always"]])}
      ${state.zHop === "off" ? "" : `${num("zhopht", "Hop height mm", state.zHopHeight, 0.1, 2, 0.1)}${num("zhopmin", "Hop above travel mm", state.zHopMinTravel, 0.5, 20, 0.5)}`}
    `)}
    ${group("Walls and seams", `
      ${check("vwidth", "Variable walls", state.variableWidth)}
      ${check("travelopt", "Travel and seam", state.travelOpt)}
      ${select("scarf", "Scarf seam", state.scarfSeam, [["blend", "Blend default"], ["off", "Off"], ["outer", "Outer walls"], ["all", "Outer and inner"]])}
      ${state.scarfSeam === "off" ? "" : `${num("scarflen", "Scarf length mm", state.scarfLength, 1, 30, 1)}${num("scarfsteps", "Scarf steps", state.scarfSteps, 2, 32, 1)}`}
    `)}
    ${group("Supports", `
      ${check("supports", "Smart supports", state.supports)}
      ${state.supports ? `${select("sstyle", "Style", state.supportStyle, [["grid", "Sparse grid"], ["tree", "Organic tree"]])}
        ${num("sangle", "Overhang angle °", state.supportAngle, 20, 70, 5)}
        ${state.supportStyle === "tree" ? `${num("bangle", "Branch angle °", state.branchAngle, 15, 60, 5)}
        ${num("tipd", "Tip diameter mm", state.tipDiameter, 0.4, 2, 0.1)}
        ${num("trunkd", "Trunk diameter mm", state.trunkDiameter, 1.5, 12, 0.2)}` : ""}
        ${num("shmult", "Shaft height ×", state.supportHeightMult, 1, 4, 1)}` : ""}
    `)}
    ${group("PA calibration", `
      ${select("pafw", "Firmware", state.paFirmware, [["klipper", "Klipper"], ["marlin", "Marlin"]])}
      ${num("pastart", "K start", state.paStart, 0, 1, 0.005)}
      ${num("paend", "K end", state.paEnd, 0, 1, 0.005)}
      ${num("pastep", "K step", state.paStep, 0.001, 0.2, 0.005)}
      <button class="btn" id="pacal" type="button">Generate PA test</button>
      ${state.paBands.length ? `<div class="meta">${state.paBands.map((b) => `band ${b.index}: K ${b.k.toFixed(4)} · Z ${b.z0.toFixed(2)}–${b.z1.toFixed(2)}`).join("<br>")}</div>
        ${num("pachosen", "Chosen K", state.paFirmware === "marlin" ? state.linearAdvance : state.pressureAdvance, 0, 2, 0.005)}
        <button class="btn" id="paapply" type="button">Save K to profile</button>
        <button class="btn" id="paexport" type="button">Export PA G-code</button>` : ""}
    `)}
    <label class="check"><input id="autoslice" type="checkbox" ${state.autoSlice ? "checked" : ""}/> Auto-slice under 50k triangles</label>
    <div class="meta">Triangles <b>${result ? result.mesh.triangles : "—"}</b></div>
  `;
  applyFilter();

  const live = resolved(currentWeight(), state.layerHeight);
  document.querySelector("#right")!.innerHTML = `
    <h2>Strategy blend</h2>
    <div class="cards">
      ${cardBtn("speed", "Speed", "2 walls · lightning · fast feeds")}
      ${cardBtn("efficiency", "Efficiency", "Mid weight · lines then grid")}
      ${cardBtn("toughness", "Toughness", "5 walls · 48% 3D gyroid · scarf")}
      ${cardBtn("layer", "By layer", "Toughness at the bed, then speed")}
      ${cardBtn("region", "By region", "Split plane, low side toughness")}
    </div>
    <div class="stack" id="blendFields">${blendFields()}</div>
    <h2>Blend compare</h2>
    <div id="pareto">${paretoHtml()}</div>
    <h2>Resolved now</h2>
    <div class="meta" id="resolved">${paramTable(live)}</div>
    <h2>Estimate</h2>
    <div id="estimate">${estimateHtml()}</div>
    <h2>Active layer</h2>
    <div class="meta" id="layerReadout">${layerReadout()}</div>
  `;

  const isStale = stale();
  const sliceBtn = document.querySelector<HTMLButtonElement>("#slice")!;
  sliceBtn.textContent = isStale ? "Re-slice" : "Slice";
  sliceBtn.classList.toggle("reslice", isStale);
  sliceBtn.disabled = state.busy || !state.mesh;
  (document.querySelector("#cancel") as HTMLButtonElement).hidden = !state.busy;
  (document.querySelector("#export") as HTMLButtonElement).disabled = !result || isStale || state.busy;
  document.querySelector("#timing")!.textContent = state.busy
    ? `Slicing… ${Math.round(state.progress * 100)}%`
    : result
      ? `${(result.estimate?.seconds ?? 0) / 60 < 1 ? `${(result.estimate?.seconds ?? 0).toFixed(0)} s` : `${((result.estimate?.seconds ?? 0) / 60).toFixed(1)} min`} · ${(result.estimate?.filamentG ?? 0).toFixed(2)} g`
      : "No slice yet";
  document.querySelector("#stage")!.classList.toggle("stale", isStale);
  paintBanner(isStale);
  paintLegend();
  paintSlider();
  paintSpark();
  paintPlayback();
  paintGcode();
  const status = document.querySelector("#status")!;
  if (!mesh) status.textContent = "Load an STL or 3MF from Samples or Open mesh. Arrow keys move the layer.";
  else if (state.busy) status.textContent = `Slicing ${mesh.name}…`;
  else if (isStale) status.textContent = "This preview is stale. Re-slice before export.";
  else if (result) status.textContent = result.blend;
  else status.textContent = `${mesh.name} loaded. Choose a strategy, then slice.`;
}

function paintBanner(isStale: boolean) {
  const rail = document.querySelector("#banner")!;
  const bits: string[] = [];
  if (state.engine) bits.push(`<div class="banner">${escapeHtml(state.engine)}</div>`);
  if (state.error) bits.push(`<div class="banner" role="alert">${escapeHtml(state.error)}</div>`);
  if (state.notice) bits.push(`<div class="banner warn">${escapeHtml(state.notice)}</div>`);
  if (isStale) bits.push(`<div class="banner warn">Settings changed since this slice. Export stays off until you re-slice.</div>`);
  if (state.result && !state.result.sanity.ok) bits.push(`<div class="banner">${escapeHtml(state.result.sanity.notes.join(" ") || "G-code checks failed")}</div>`);
  if (state.busy) bits.push(`<div class="progress ${state.progress > 0 && state.progress < 1 ? "" : "indeterminate"}" data-state="slicing"><span style="width:${Math.max(8, state.progress * 100)}%"></span></div>`);
  rail.innerHTML = bits.join("");
}

const closedGroups = new Set<string>();
function group(title: string, body: string) {
  return `<details ${closedGroups.has(title) ? "" : "open"} class="group" data-group="${title}"><summary>${title}</summary><div class="stack">${body}</div></details>`;
}
function num(id: string, label: string, value: number, min: number, max: number, step: number) {
  return `<label class="field setting" data-label="${label.toLowerCase()}">${label}<input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
}
function check(id: string, label: string, on: boolean) {
  return `<label class="check setting" data-label="${label.toLowerCase()}"><input id="${id}" type="checkbox" ${on ? "checked" : ""}/> ${label}</label>`;
}
function select(id: string, label: string, value: string, options: [string, string][]) {
  return `<label class="field setting" data-label="${label.toLowerCase()}">${label}<select id="${id}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
}
function cardBtn(id: CardId, title: string, copy: string) {
  const cls = id === "toughness" || id === "layer" ? "tough" : id === "efficiency" ? "mid" : "speed";
  return `<button class="card ${cls}" type="button" data-card="${id}" aria-pressed="${card() === id}"><h3>${title}</h3><p>${copy}</p></button>`;
}
function blendFields() {
  if (state.blendKind === "weight") {
    return `<label class="field" id="weightLabel">Toughness weight ${(state.toughness * 100).toFixed(0)}%<input id="weight" type="range" min="0" max="100" value="${Math.round(state.toughness * 100)}" /></label>`;
  }
  if (state.blendKind === "byLayer") {
    return `${num("bottom", "Toughness from the bed, mm", state.bottomMm, 0, 200, 0.2)}${num("trans", "Transition into speed, mm", state.transitionMm, 0, 200, 0.2)}`;
  }
  if (state.blendKind === "byRegion") {
    return `${select("axis", "Split axis", state.axis, [["x", "X"], ["y", "Y"]])}${num("at", "Split at mm (low = toughness)", state.atMm, -500, 500, 0.5)}<p class="deferred">Half-space split only. Painted regions and modifier boxes stay deferred until the core has region masks.</p>`;
  }
  return "";
}
function paramLine(card: ResolvedCard) {
  const row = (name: string, feed: number, eff: number) => `${name} <b>${feed.toFixed(0)}</b> mm/s · effective <b>${eff.toFixed(0)}</b><br>`;
  const gyroid = card.pattern === "gyroid" && state.gyroid3d !== "off"
    ? row("3D gyroid", card.gyroidSpeed, card.effectiveGyroid)
    : "";
  return `${card.name} · ${card.walls} walls · ${card.pattern} · ${(card.density * 100).toFixed(0)}%<br>${row("outer", card.outer, card.effectiveOuter)}${row("inner", card.inner, card.effectiveInner)}${row("sparse", card.sparse, card.effectiveSparse)}${gyroid}${row("top", card.top, card.effectiveTop)}`;
}
function paramTable(card: ResolvedCard) {
  if (state.blendKind === "byRegion") {
    return `Split ${state.axis.toUpperCase()} = ${state.atMm.toFixed(2)} mm.<br>Low side ${paramLine(resolved(1, state.layerHeight))}<br>High side ${paramLine(resolved(0, state.layerHeight))}`;
  }
  return paramLine(card);
}
function layerReadout() {
  const layer = state.result?.layers[state.layer];
  if (!layer) return "Slice to see this layer.";
  const below = (state.result?.layers ?? []).slice(0, state.layer).reduce((s, l) => s + (l.seconds ?? 0), 0);
  return `Layer <b>${layer.index + 1}</b> / ${state.result?.layers.length}<br>Z <b>${layer.z.toFixed(2)}</b> mm · h <b>${layer.height.toFixed(3)}</b><br>Layer time <b>${(layer.seconds ?? 0).toFixed(1)}</b> s · cumulative <b>${(below + (layer.seconds ?? 0)).toFixed(1)}</b> s<br>${escapeHtml(layer.note)}`;
}

function estimateHtml() {
  const est = state.result?.estimate;
  if (!est) return `<div class="meta">Slice to compare minutes and grams.</div>`;
  const groups = groupFeatures(est.byFeature ?? []);
  const total = Math.max(0.001, est.seconds);
  const rows = groups.map((row) => `<tr><td>${row.label}</td><td>${row.seconds.toFixed(0)} s</td><td>${row.grams.toFixed(2)} g</td><td><div class="bar"><span style="width:${Math.min(100, (row.seconds / total) * 100)}%"></span></div></td></tr>`).join("");
  const meters = (est.filamentMm / 1000).toFixed(2);
  const cost = ((est.filamentG / 1000) * state.profile.filamentCostPerKg).toFixed(2);
  return `
    <div class="meta"><b>${formatTime(est.seconds)}</b> · <b>${est.filamentG.toFixed(2)} g</b> · ${meters} m · €${cost}</div>
    <div class="meta">Filament €${state.profile.filamentCostPerKg.toFixed(2)} / kg from the printer profile.</div>
    <table class="est">${rows}</table>
    <div class="chips">${chips()}</div>
    <div class="meta">${est.arcMoves} arcs · ${est.retracts ?? 0} retracts · ${(est.travelMm ?? 0).toFixed(0)} mm travel · ${est.scarfedLoops ?? 0} scarfed loops</div>
  `;
}
function objectList() {
  if (!state.placed) return `<div class="meta">Drop an STL or 3MF, or open a sample.</div>`;
  const b = boundsOf(state.placed);
  const size = b.max.map((v, i) => (v - b.min[i]).toFixed(1)).join(" × ");
  const notes = offBed(state.placed, state.profile.bedX, state.profile.bedY, state.profile.bedZ);
  return `
    <div class="obj" role="listitem">
      <b>${escapeHtml(state.mesh?.name ?? "part")}</b>
      <span>${state.placed.length / 9} triangles · ${size} mm</span>
    </div>
    <div class="row">
      <button class="btn" id="center" type="button">Center</button>
      <button class="btn" id="layflat" type="button">Lay flat</button>
      <button class="btn" id="rotX" type="button" aria-label="Rotate 90 degrees around X">Rot X</button>
      <button class="btn" id="rotY" type="button" aria-label="Rotate 90 degrees around Y">Rot Y</button>
      <button class="btn" id="rotZ" type="button" aria-label="Rotate 90 degrees around Z">Rot Z</button>
      <button class="btn" id="export3mf" type="button">Export 3MF</button>
    </div>
    <label class="field">Scale %<input id="partScale" type="number" min="10" max="400" step="5" value="${Math.round(state.partScale * 100)}" /></label>
    ${notes.length ? `<div class="meta warn-text">${notes.join("; ")}</div>` : `<div class="meta">On the ${state.profile.bedX}×${state.profile.bedY}×${state.profile.bedZ} mm bed.</div>`}
  `;
}

function profileFields() {
  const p = state.profile;
  return `
    ${num("nozzle", "Nozzle mm", p.nozzleDiameter, 0.15, 1.2, 0.05)}
    ${num("bedx", "Bed X mm", p.bedX, 50, 1000, 1)}
    ${num("bedy", "Bed Y mm", p.bedY, 50, 1000, 1)}
    ${num("bedz", "Bed Z mm", p.bedZ, 20, 1000, 1)}
    ${num("vol", "Max flow mm³/s", p.maxVolumetricMm3S, 1, 60, 0.5)}
    ${num("accel", "Max accel mm/s²", p.maxAccel, 100, 20000, 100)}
    ${num("density", "Density g/cm³", p.filamentDensityGCm3, 0.8, 2.5, 0.01)}
    ${num("cost", "Filament €/kg", p.filamentCostPerKg, 0, 200, 1)}
    <div class="row">
      <button class="btn" id="profileExport" type="button">Export JSON</button>
      <label class="btn file">Import JSON<input id="profileImport" type="file" accept="application/json,.json" /></label>
    </div>
  `;
}

function paretoHtml() {
  if (state.pareto.length === 0) {
    return `<button class="btn" id="paretoBtn" type="button">Compare speed, mixes, toughness</button><div class="meta">Plots print time against grams. Bubble size is the toughness score.</div>`;
  }
  const pts = state.pareto;
  const minT = Math.min(...pts.map((p) => p.seconds));
  const maxT = Math.max(...pts.map((p) => p.seconds));
  const minG = Math.min(...pts.map((p) => p.filamentG));
  const maxG = Math.max(...pts.map((p) => p.filamentG));
  const maxS = Math.max(...pts.map((p) => p.score), 0.01);
  const xOf = (s: number) => 28 + ((s - minT) / Math.max(1, maxT - minT)) * 200;
  const yOf = (g: number) => 150 - ((g - minG) / Math.max(0.01, maxG - minG)) * 120;
  const dots = pts.map((p, i) => {
    const r = 6 + (p.score / maxS) * 10;
    return `<circle class="pareto-dot" data-pareto="${i}" cx="${xOf(p.seconds).toFixed(1)}" cy="${yOf(p.filamentG).toFixed(1)}" r="${r.toFixed(1)}" tabindex="0" role="button" aria-label="${p.label}, ${formatTime(p.seconds)}, ${p.filamentG.toFixed(2)} grams"><title>${p.label}: ${formatTime(p.seconds)}, ${p.filamentG.toFixed(2)} g, toughness ${p.score.toFixed(2)}</title></circle>`;
  }).join("");
  const tough = pts[pts.length - 1];
  const speed = pts[0];
  const saveMin = (tough.seconds - speed.seconds) / 60;
  const saveG = tough.filamentG - speed.filamentG;
  return `
    <svg class="pareto" viewBox="0 0 250 180" role="img" aria-label="Time versus filament">
      <text x="28" y="14">grams</text>
      <text x="150" y="174">time</text>
      ${dots}
    </svg>
    <div class="meta">Speed saves <b>${saveMin.toFixed(1)} min</b> and <b>${saveG.toFixed(2)} g</b> versus toughness.</div>
    <button class="btn" id="paretoBtn" type="button">Recompare</button>
  `;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}
function groupFeatures(rows: FeatureRow[]) {
  const bucket = (label: string, kinds: string[]) => {
    const hit = rows.filter((row) => kinds.includes(row.kind));
    return { label, seconds: hit.reduce((s, r) => s + r.seconds, 0), grams: hit.reduce((s, r) => s + r.filamentG, 0) };
  };
  const used = new Set(["outer", "inner", "wall", "sparse", "infill", "solid", "gap-fill", "top", "support", "support-interface", "travel"]);
  const other = rows.filter((row) => !used.has(row.kind));
  return [
    bucket("Outer wall", ["outer"]),
    bucket("Inner wall", ["inner", "wall"]),
    bucket("Infill", ["sparse", "infill", "solid", "gap-fill"]),
    bucket("Top / bottom", ["top"]),
    bucket("Supports", ["support", "support-interface"]),
    bucket("Travel", ["travel"]),
    { label: "Other", seconds: other.reduce((s, r) => s + r.seconds, 0), grams: other.reduce((s, r) => s + r.filamentG, 0) },
  ].filter((row) => row.seconds > 0.05 || row.grams > 0.001);
}
function chips() {
  const est = state.result?.estimate;
  const compare = state.result?.compare ?? [];
  if (!est || compare.length === 0) return "";
  return compare.map((row) => {
    const dt = pct(est.seconds, row.seconds);
    const dg = pct(est.filamentG, row.filamentG);
    const bad = dt > 0 && dg > 0;
    return `<span class="chip ${bad ? "bad" : ""}">vs ${row.label} ${signed(dt)} time · ${signed(dg)} g</span>`;
  }).join("");
}
function pct(value: number, base: number) {
  if (base <= 1e-6) return 0;
  return ((value - base) / base) * 100;
}
function signed(n: number) {
  const v = n.toFixed(0);
  return n > 0 ? `+${v}%` : `${v}%`;
}

function paintLegend() {
  const kinds = new Set<string>();
  for (const layer of state.result?.layers ?? []) for (const path of layer.paths) kinds.add(path.kind);
  const legend = document.querySelector("#legend")!;
  if (kinds.size === 0) {
    legend.innerHTML = `<span>Legend fills in after a slice.</span>`;
    return;
  }
  const est = state.result?.estimate;
  const total = Math.max(0.001, est?.seconds ?? 1);
  const by = new Map((est?.byFeature ?? []).map((row) => [row.kind, row.seconds]));
  legend.innerHTML = [...kinds].sort().map((kind) => {
    const share = by.has(kind) ? ` · ${((by.get(kind)! / total) * 100).toFixed(0)}%` : "";
    const shown = kind === "travel" ? state.showTravel : !state.hidden.has(kind);
    return `<label><input type="checkbox" data-kind="${kind}" ${shown ? "checked" : ""}/><i class="swatch" style="background:${FEATURE_COLOR[kind] ?? "#ccc"}"></i>${FEATURE_LABEL[kind] ?? kind}${share}</label>`;
  }).join("") + ((est?.scarfedLoops ?? 0) > 0 ? `<span><i class="swatch" style="background:#fff"></i>Scarf ramp</span>` : "");
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
}

function currentPreset(): PresetSettings {
  const out = { ...DEFAULT_PRESET };
  for (const key of presetKeys()) {
    (out as unknown as Record<string, unknown>)[key] = (state as unknown as Record<string, unknown>)[key];
  }
  return out;
}
function presetHtml() {
  const saved = readPresets();
  const names = Object.keys(saved).sort();
  const options = names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  const diff = diffPreset(currentPreset());
  const body = diff.length ? diff.map((line) => escapeHtml(line)).join("<br>") : "Matches the default preset.";
  return `
    <label class="field">Saved<select id="presetPick"><option value="">Choose…</option>${options}</select></label>
    <div class="stack" style="flex-direction:row;flex-wrap:wrap">
      <button class="btn" id="presetLoad" type="button">Load</button>
      <button class="btn" id="presetDelete" type="button">Delete</button>
    </div>
    <label class="field">Name<input id="presetName" type="text" placeholder="bench speed" /></label>
    <button class="btn" id="presetSave" type="button">Save preset</button>
    <div class="meta diff" id="presetDiff"><b>Vs default</b><br>${body}</div>
  `;
}
function applyPreset(next: PresetSettings) {
  for (const key of presetKeys()) {
    (state as unknown as Record<string, unknown>)[key] = next[key];
  }
  touch();
}
function paintPresetDiff() {
  const node = document.querySelector("#presetDiff");
  if (!node) return;
  const diff = diffPreset(currentPreset());
  node.innerHTML = `<b>Vs default</b><br>${diff.length ? diff.map((line) => escapeHtml(line)).join("<br>") : "Matches the default preset."}`;
}

function movesNow(): PlayPoint[] {
  const layer = state.result?.layers[state.layer];
  if (!layer) return [];
  return layerMoves(layer.paths, layer.z, layer.height);
}

function paintPlayback() {
  const moves = movesNow();
  const max = Math.max(0, moves.length - 1);
  state.move = Math.max(0, Math.min(max, state.move));
  const slider = document.querySelector<HTMLInputElement>("#move");
  const readout = document.querySelector("#playReadout");
  const play = document.querySelector<HTMLButtonElement>("#play");
  if (slider) {
    slider.max = String(max);
    slider.value = String(moves.length ? state.move : 0);
    slider.disabled = moves.length === 0;
  }
  if (play) play.textContent = state.playing ? "Pause" : "Play";
  const point = moves[state.move];
  if (!readout) return;
  if (!point) {
    readout.textContent = "Feature — · feed — · E —";
    return;
  }
  const gcode = parseLayerGcode(state.result?.gcode ?? "", state.result?.layers[state.layer]?.index ?? state.layer);
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
  });
  if (!on) return;
  const layer = state.result?.layers[state.layer];
  const lines = layer ? parseLayerGcode(state.result?.gcode ?? "", layer.index) : [];
  if (!state.result) {
    pane.innerHTML = `<div class="meta">Slice to read G-code for this layer.</div>`;
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
  const parsed = layer ? parseLayerGcode(state.result?.gcode ?? "", layer.index) : [];
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

let playTimer = 0;
function stopPlay() {
  state.playing = false;
  window.clearInterval(playTimer);
  const play = document.querySelector<HTMLButtonElement>("#play");
  if (play) play.textContent = "Play";
}
function togglePlay() {
  if (state.playing) {
    stopPlay();
    return;
  }
  const moves = movesNow();
  if (moves.length === 0) return;
  if (state.move >= moves.length - 1) state.move = 0;
  state.playing = true;
  const play = document.querySelector<HTMLButtonElement>("#play");
  if (play) play.textContent = "Pause";
  playTimer = window.setInterval(() => {
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

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>("#left .setting").forEach((el) => {
    el.classList.toggle("hidden", !!q && !(el.dataset.label ?? "").includes(q));
  });
}

function scrub(next: number) {
  const max = Math.max(0, (state.result?.layers.length ?? 1) - 1);
  const prev = state.layer;
  state.layer = Math.max(state.rangeLow, Math.min(max, next));
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
  if (t.id === "center") { state.centered = true; place(); }
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
  else state.blendKind = "byRegion";
  touch();
});
document.querySelector("#right")!.addEventListener("input", onBlend);

function onBlend(ev: Event) {
  const t = ev.target as HTMLInputElement;
  if (t.id === "weight") {
    state.toughness = Number(t.value) / 100;
    const label = document.querySelector("#weightLabel");
    if (label?.firstChild) label.firstChild.textContent = `Toughness weight ${(state.toughness * 100).toFixed(0)}%`;
    const node = document.querySelector("#resolved");
    if (node) node.innerHTML = paramTable(resolved(state.toughness, state.layerHeight));
    markStale();
    return;
  }
  if (t.id === "bottom") state.bottomMm = Number(t.value) || 0;
  if (t.id === "trans") state.transitionMm = Number(t.value) || 0;
  if (t.id === "axis") state.axis = t.value as "x" | "y";
  if (t.id === "at") state.atMm = Number(t.value) || 0;
  if (t.id === "price") {
    state.pricePerKg = Number(t.value) || 0;
    const est = document.querySelector("#estimate");
    if (est) est.innerHTML = estimateHtml();
    return;
  }
  markStale();
  if (t.id === "bottom" || t.id === "trans" || t.id === "at" || t.id === "axis") {
    paintSlider();
    draw();
    const node = document.querySelector("#resolved");
    if (node) node.innerHTML = paramTable(resolved(currentWeight(), state.layerHeight));
  }
}

function onSettings(ev: Event) {
  const t = ev.target as HTMLInputElement;
  if (t.id === "find") {
    state.query = t.value;
    applyFilter();
    return;
  }
  const numIds = ["lh", "amin", "amax", "pa", "la", "zhopht", "zhopmin", "scarflen", "scarfsteps", "sangle", "bangle", "tipd", "trunkd", "shmult", "pastart", "paend", "pastep", "nozzle", "bedx", "bedy", "bedz", "vol", "accel", "density", "cost", "partScale"] as const;
  const map: Record<string, (v: number) => void> = {
    lh: (v) => { state.layerHeight = v || 0.2; },
    amin: (v) => { state.adaptiveMin = v || 0.08; },
    amax: (v) => { state.adaptiveMax = v || 0.2; },
    pa: (v) => { state.pressureAdvance = v || 0; },
    la: (v) => { state.linearAdvance = v || 0; },
    zhopht: (v) => { state.zHopHeight = v || 0.4; },
    zhopmin: (v) => { state.zHopMinTravel = v || 2; },
    scarflen: (v) => { state.scarfLength = v || 10; },
    scarfsteps: (v) => { state.scarfSteps = v || 8; },
    sangle: (v) => { state.supportAngle = v || 45; },
    bangle: (v) => { state.branchAngle = v || 40; },
    tipd: (v) => { state.tipDiameter = v || 0.8; },
    trunkd: (v) => { state.trunkDiameter = v || 4.2; },
    shmult: (v) => { state.supportHeightMult = v || 1; },
    pastart: (v) => { state.paStart = v || 0; },
    paend: (v) => { state.paEnd = v || 0; },
    pastep: (v) => { state.paStep = v || 0.005; },
    nozzle: (v) => { state.profile.nozzleDiameter = v || 0.4; },
    bedx: (v) => { state.profile.bedX = v || 220; },
    bedy: (v) => { state.profile.bedY = v || 220; },
    bedz: (v) => { state.profile.bedZ = v || 250; },
    vol: (v) => { state.profile.maxVolumetricMm3S = v || 12; },
    accel: (v) => { state.profile.maxAccel = v || 10000; },
    density: (v) => { state.profile.filamentDensityGCm3 = v || 1.24; },
    cost: (v) => { state.profile.filamentCostPerKg = v || 0; },
    partScale: (v) => { state.partScale = (v || 100) / 100; },
  };
  if (numIds.includes(t.id as typeof numIds[number])) map[t.id](Number(t.value));
  if (t.id === "adaptive") state.adaptive = t.checked;
  if (t.id === "feeds") state.featureSpeeds = t.checked;
  if (t.id === "arcs") state.arcFit = t.checked;
  if (t.id === "combine") state.infillCombine = t.checked;
  if (t.id === "combing") state.combing = t.checked;
  if (t.id === "overhang") state.overhangControl = t.checked;
  if (t.id === "vwidth") state.variableWidth = t.checked;
  if (t.id === "travelopt") state.travelOpt = t.checked;
  if (t.id === "supports") state.supports = t.checked;
  if (t.id === "autoslice") { state.autoSlice = t.checked; return; }
  if (t.id === "gyroid3d") state.gyroid3d = t.value as typeof state.gyroid3d;
  if (t.id === "zhop") state.zHop = t.value as typeof state.zHop;
  if (t.id === "scarf") state.scarfSeam = t.value as typeof state.scarfSeam;
  if (t.id === "sstyle") state.supportStyle = t.value as typeof state.supportStyle;
  if (t.id === "pafw") state.paFirmware = t.value as typeof state.paFirmware;
  if (t.id === "profileImport") {
    const file = t.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      state.profile = { ...loadProfile(), ...JSON.parse(text) } as PrinterProfile;
      state.pressureAdvance = state.profile.pressureAdvance;
      state.linearAdvance = state.profile.linearAdvance;
      saveProfile(state.profile);
      prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
      touch();
    }).catch(fail);
    return;
  }
  const profileIds = ["nozzle", "bedx", "bedy", "bedz", "vol", "accel", "density", "cost"];
  if (profileIds.includes(t.id)) {
    state.profile.pressureAdvance = state.pressureAdvance;
    state.profile.linearAdvance = state.linearAdvance;
    saveProfile(state.profile);
    prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
    view3d.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
    applyPlace(false);
    return;
  }
  if (t.id === "partScale") {
    applyPlace(false);
    return;
  }
  const structural = ["adaptive", "supports", "zhop", "scarf", "gyroid3d"].includes(t.id);
  if (structural) renderChrome();
  markStale();
}

function touch() {
  state.notice = "";
  renderChrome();
  draw();
  scheduleAuto();
}
function markStale() {
  const sliceBtn = document.querySelector<HTMLButtonElement>("#slice");
  const exp = document.querySelector<HTMLButtonElement>("#export");
  const isStale = stale();
  if (sliceBtn) {
    sliceBtn.textContent = isStale ? "Re-slice" : "Slice";
    sliceBtn.classList.toggle("reslice", isStale);
  }
  if (exp) exp.disabled = !state.result || isStale || state.busy;
  document.querySelector("#stage")?.classList.toggle("stale", isStale);
  paintBanner(isStale);
  paintPresetDiff();
  if (isStale) document.querySelector("#status")!.textContent = "This preview is stale. Re-slice before export.";
  scheduleAuto();
  draw();
}
function scheduleAuto() {
  window.clearTimeout(autoTimer);
  if (!state.autoSlice || !state.mesh || state.busy) return;
  const tris = state.result?.mesh.triangles ?? Math.max(0, (state.mesh.bytes.byteLength - 84) / 50);
  if (tris >= 50000) return;
  autoTimer = window.setTimeout(() => void runSlice(), 300);
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
  draw();
});
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    setStage(tab === "prepare" || tab === "gcode" ? tab : "preview");
  });
});
document.querySelector("#play")!.addEventListener("click", () => togglePlay());
document.querySelector("#move")!.addEventListener("input", (ev) => {
  stopPlay();
  state.move = Number((ev.target as HTMLInputElement).value);
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
document.querySelector("#slice")!.addEventListener("click", () => void runSlice());
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
    void runSlice();
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

async function loadNamed(name: string) {
  state.error = "";
  const res = await fetch(`/samples/${name}`);
  if (!res.ok) throw new Error(`could not load ${name}`);
  if (name.includes("hull")) state.atMm = 0;
  if (name.includes("cube")) state.atMm = 10;
  await adoptBytes(name, await res.arrayBuffer());
}

async function adoptBytes(name: string, bytes: ArrayBuffer) {
  state.mesh = { name, bytes };
  state.error = "";
  state.orient = ID_MATRIX;
  state.partScale = 1;
  state.centered = true;
  const parsed = name.toLowerCase().endsWith(".3mf") ? null : parseStl(bytes);
  state.sourcePos = parsed ?? (await previewRemote(name, bytes));
  place();
  setStage("prepare");
}

async function previewRemote(name: string, bytes: ArrayBuffer): Promise<Float32Array | null> {
  const payload = { filename: name, dataB64: toBase64(new Uint8Array(bytes)) };
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  try {
    let body: { positions: number[] };
    if (tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      body = JSON.parse(await invoke<string>("preview_mesh", { payload: JSON.stringify(payload) }));
    } else {
      const res = await fetch(`${API}/api/mesh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      body = await res.json();
      if (!res.ok) throw new Error("mesh preview failed");
    }
    return new Float32Array(body.positions);
  } catch {
    state.notice = "Could not preview this mesh. STL works offline; 3MF needs the slicer engine.";
    return null;
  }
}

function place() {
  applyPlace(true);
}

function applyPlace(rerender: boolean) {
  if (!state.sourcePos) {
    state.placed = null;
    prepare.setMesh(null);
    if (rerender) renderChrome();
    return;
  }
  state.placed = transformPositions(state.sourcePos, state.orient, state.partScale, state.profile.bedX, state.profile.bedY, state.centered);
  prepare.setMesh(state.placed);
  prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
  markStale();
  if (rerender) renderChrome();
}

function setStage(stage: "prepare" | "preview" | "gcode") {
  state.stage = stage;
  document.querySelector<HTMLElement>("#prepareBody")!.hidden = stage !== "prepare";
  document.querySelector<HTMLElement>("#previewBody")!.hidden = stage !== "preview";
  document.querySelector("#legend")?.toggleAttribute("hidden", stage !== "preview");
  document.querySelector("#viewModes")?.toggleAttribute("hidden", stage !== "preview");
  document.querySelector(".stage-tools")?.toggleAttribute("hidden", stage === "prepare");
  paintGcode();
  resize();
}

function setHelp(open: boolean) {
  state.help = open;
  const sheet = document.querySelector<HTMLElement>("#help")!;
  sheet.hidden = !open;
  if (open) document.querySelector<HTMLButtonElement>("#helpClose")?.focus();
}

function meshBytes() {
  if (state.placed) return encodeStl(state.placed, state.mesh?.name ?? "part");
  return state.mesh?.bytes ?? new ArrayBuffer(0);
}

function payload() {
  return {
    filename: (state.mesh!.name || "part").replace(/\.3mf$/i, ".stl"),
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
  };
}
function printer() {
  return {
    ...state.profile,
    pressureAdvance: state.pressureAdvance,
    linearAdvance: state.linearAdvance,
  };
}

async function runSlice() {
  if (!state.mesh) {
    state.error = "Load a mesh first.";
    renderChrome();
    return;
  }
  const id = ++job;
  const hash = settingsHash();
  const request = payload();
  const bytes = meshBytes();
  state.busy = true;
  state.progress = 0.08;
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
        if (id !== job) return;
        state.progress = ev.payload.progress;
        paintBanner(false);
        document.querySelector("#timing")!.textContent = ev.payload.message;
      });
      if (id !== job) return;
      const json = await invoke<string>("slice_model", { payload: JSON.stringify({ ...request, dataB64: toBase64(new Uint8Array(bytes)) }) });
      if (id !== job) return;
      body = await parseInWorker(id, json);
    } else {
      body = await postSlice(id, bytes, request);
    }
    if (id !== job) return;
    if (body.error) throw new Error(body.error);
    if (!body.gcode && body.gcodeToken) body.gcode = await fetchStoredGcode(body.gcodeToken);
    if (id !== job) return;
    state.result = body;
    state.gcodeToken = body.gcodeToken ?? "";
    state.slicedHash = hash;
    state.layer = Math.min(state.layer, Math.max(0, body.layers.length - 1));
    clampPlane();
    landed = true;
  } catch (err) {
    if (id !== job) return;
    const message = err instanceof Error ? err.message : String(err);
    if (message === "cancelled") state.notice = "Slice cancelled.";
    else state.error = message === "Failed to fetch" ? "Slicer engine not running. Start it with cargo run -p lime-slice --release -- serve" : message;
  } finally {
    unlisten?.();
    if (id === job) {
      state.busy = false;
      state.progress = 0;
      renderChrome();
      draw();
      if (landed && stale()) scheduleAuto();
    }
  }
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
    worker.postMessage({ id, bytes, payload: body, api: API }, [bytes.slice(0)]);
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
  worker.postMessage({ id: job, cancel: true });
  job += 1;
  state.busy = false;
  state.notice = "Slice cancelled.";
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (tauri) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("cancel_slice"));
  renderChrome();
}

function clampPlane() {
  const mesh = state.result?.mesh;
  if (!mesh || state.blendKind !== "byRegion") return;
  const i = state.axis === "x" ? 0 : 1;
  if (state.atMm < mesh.min[i] || state.atMm > mesh.max[i]) {
    state.notice = `Split at ${state.atMm.toFixed(1)} mm is outside the mesh (${mesh.min[i].toFixed(1)}–${mesh.max[i].toFixed(1)}).`;
  }
}

async function runPaCal() {
  state.busy = true;
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
      const res = await fetch(`${API}/api/calibrate/pa`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

function toBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function isTauri() {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function saveText(text: string, name: string, extension: string) {
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

async function fetchStoredGcode(token: string) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("gcode_text", { token });
  }
  const res = await fetch(`${API}/api/gcode/${token}`);
  if (!res.ok) throw new Error("G-code is no longer available. Slice again.");
  return res.text();
}

async function exportGcode() {
  if (!state.result || stale()) return;
  let text = state.result.gcode;
  if (!text && state.gcodeToken) text = await fetchStoredGcode(state.gcodeToken);
  if (!text) {
    state.error = "No G-code for this slice.";
    renderChrome();
    return;
  }
  const minutes = Math.max(1, Math.round((state.result.estimate?.seconds ?? 0) / 60));
  const grams = (state.result.estimate?.filamentG ?? 0).toFixed(0);
  const base = (state.mesh?.name ?? "part").replace(/\.(stl|3mf)$/i, "");
  const blend = card();
  await saveText(text, `${base}_${blend}_${minutes}m_${grams}g.gcode`, "gcode");
}

async function export3mf() {
  if (!state.placed) return;
  const bytes = encode3mf(state.placed);
  const name = `${(state.mesh?.name ?? "part").replace(/\.(stl|3mf)$/i, "")}.3mf`;
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
  state.busy = true;
  state.progress = 0.2;
  renderChrome();
  try {
    const body = { ...payload(), dataB64: toBase64(new Uint8Array(meshBytes())) };
    let points: ParetoPoint[];
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      points = JSON.parse(await invoke<string>("pareto_model", { payload: JSON.stringify(body) }));
    } else {
      const res = await fetch(`${API}/api/pareto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

function download(text: string, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
function fail(err: unknown) {
  state.error = err instanceof Error ? err.message : String(err);
  state.busy = false;
  renderChrome();
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
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
  layer.paths.forEach((path, pathIndex) => {
    if (state.hidden.has(path.kind)) return;
    if (path.kind === "travel" && !state.showTravel) return;
    const cut = !played ? path.pts.length : pathIndex < played.path ? path.pts.length : pathIndex > played.path ? 1 : played.seg + 1;
    strokePts(path, 0, cut, 1);
    if (cut < path.pts.length) strokePts(path, Math.max(0, cut - 1), path.pts.length, 0.22);
  });
  ctx.setLineDash([]);
  function strokePts(path: PreviewPath, from: number, to: number, alpha: number) {
    if (to - from < 1) return;
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const [x, y] = map(path.pts[i][0], path.pts[i][1]);
      if (i === from) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colorForPath(path.kind, state.colorMode, path.toughness ?? 0, path.effectiveSpeed ?? path.speed ?? 0);
    ctx.lineWidth = path.kind === "travel" ? 1 : Math.max(1.2, scale * 0.1);
    ctx.setLineDash(path.kind === "travel" ? [4, 4] : []);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (played) {
    const [x, y] = map(played.x, played.y);
    ctx.fillStyle = colors.amber;
    ctx.beginPath();
    ctx.arc(x, y, 5 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.blendKind === "byRegion") {
    ctx.strokeStyle = colors.teal;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (state.axis === "x") {
      const [x1, y1] = map(state.atMm, mesh.min[1]);
      const [, y2] = map(state.atMm, mesh.max[1]);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1, y2);
    } else {
      const [x1, y1] = map(mesh.min[0], state.atMm);
      const [x2] = map(mesh.max[0], state.atMm);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y1);
    }
    ctx.stroke();
  }
  sync3d();
}

function segmentStart(paths: PreviewPath[], point: PlayPoint): [number, number] {
  const prev = paths[point.path]?.pts[point.seg - 1];
  return prev ?? [point.x, point.y];
}

const geomWorker = new Worker(new URL("./geom-worker.ts", import.meta.url), { type: "module" });
let geomJob = 0;
let geomKey = "";

function rebuildGeom() {
  const result = state.result;
  if (!result) {
    view3d.setBuffers(null);
    return;
  }
  const id = ++geomJob;
  const onMsg = (ev: MessageEvent) => {
    if (ev.data.id !== id) return;
    geomWorker.removeEventListener("message", onMsg);
    const mesh = result.mesh;
    const buffers: RibbonBuffers = {
      ranges: ev.data.ranges,
      ribbonPos: ev.data.ribbonPos,
      ribbonCol: ev.data.ribbonCol,
      facePos: ev.data.facePos,
      faceCol: ev.data.faceCol,
      travelPos: ev.data.travelPos,
      travelCol: ev.data.travelCol,
      span: Math.max(mesh.max[0] - mesh.min[0], mesh.max[1] - mesh.min[1], mesh.max[2] - mesh.min[2], 1),
      midZ: (mesh.min[2] + mesh.max[2]) / 2,
      centerX: (mesh.min[0] + mesh.max[0]) / 2,
      centerY: (mesh.min[1] + mesh.max[1]) / 2,
    };
    view3d.setBuffers(buffers);
    view3d.setRange(state.rangeLow, state.layer);
  };
  geomWorker.addEventListener("message", onMsg);
  geomWorker.postMessage({
    id,
    layers: result.layers,
    min: result.mesh.min,
    max: result.mesh.max,
    hidden: [...state.hidden],
    showTravel: state.showTravel && !state.hidden.has("travel"),
    colorMode: state.colorMode,
  });
}

function sync3d() {
  const key = `${state.result?.coreMs ?? 0}:${state.colorMode}:${[...state.hidden].join()}:${state.showTravel}`;
  if (state.result !== shown || key !== geomKey) {
    shown = state.result;
    geomKey = key;
    if (state.result) view3d.setModel(state.result.mesh.min, state.result.mesh.max);
    rebuildGeom();
  }
  view3d.setShowTravel(state.showTravel && !state.hidden.has("travel"));
  view3d.setRange(state.rangeLow, state.layer);
  const moves = movesNow();
  const point = moves[state.move];
  const prev = point ? segmentStart(state.result?.layers[state.layer]?.paths ?? [], point) : null;
  view3d.setPlayhead(point && prev ? { x0: prev[0], y0: prev[1], z0: point.z, x1: point.x, y1: point.y, z1: point.z } : null);
  view3d.setPlane(state.blendKind === "byRegion" && state.result ? { axis: state.axis, at: state.atMm } : null);
  view3d.onPlane((at) => {
    state.atMm = Math.round(at * 10) / 10;
    const input = document.querySelector<HTMLInputElement>("#at");
    if (input) input.value = String(state.atMm);
    markStale();
    draw();
  });
  view3d.resize();
}

view3d.onPlane((at) => {
  state.atMm = Math.round(at * 10) / 10;
  markStale();
});

function fitNarrow() {
  if (window.innerWidth <= 1200) setView("solid");
}

async function probe() {
  if (isTauri()) return;
  try {
    const res = await fetch(`${API}/api/health`);
    if (!res.ok) throw new Error(String(res.status));
    state.engine = "";
  } catch {
    state.engine = "Slicer engine not running. Start it with cargo run -p lime-slice --release -- serve";
  }
  paintBanner(stale());
}

new ResizeObserver(() => resize()).observe(document.querySelector("#stage")!);
applyTheme(loadTheme());
(document.querySelector("#theme") as HTMLSelectElement).value = loadTheme();
onSchemeChange(() => {
  view3d.setTheme();
  draw();
});
renderChrome();
fitNarrow();
resize();
view3d.setTheme();
void probe();
