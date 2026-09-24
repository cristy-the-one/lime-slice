import { createSliceView, type SliceView3d } from "./view3d";

const API = "http://127.0.0.1:43118";

type StrategyId = "speed" | "toughness";
type Blend =
  | { mode: "single"; strategy: StrategyId }
  | { mode: "weight"; toughness: number }
  | { mode: "byLayer"; bottomMm: number; transitionMm: number }
  | { mode: "byRegion"; axis: "x" | "y"; atMm: number };

interface PreviewPath {
  kind: string;
  strategy: string;
  pts: [number, number][];
}
interface PreviewLayer {
  index: number;
  z: number;
  height: number;
  note: string;
  speedWalls: number;
  toughnessWalls: number;
  supportPaths: number;
  paths: PreviewPath[];
}
interface SliceResponse {
  coreMs: number;
  baselineMs: number;
  baselineLabel: string;
  blend: string;
  mesh: { triangles: number; min: number[]; max: number[] };
  sanity: {
    ok: boolean;
    layers: number;
    extrusionMoves: number;
    finalE: number;
    extrusionLengthMm: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    notes: string[];
  };
  estimate?: { seconds: number; filamentMm: number; filamentG: number; arcMoves: number };
  score?: { speed: number; efficiency: number; toughness: number };
  gcode: string;
  layers: PreviewLayer[];
  error?: string;
}

interface LoadedMesh {
  name: string;
  bytes: ArrayBuffer;
}

const state: {
  mesh: LoadedMesh | null;
  result: SliceResponse | null;
  layer: number;
  showTravel: boolean;
  busy: boolean;
  error: string;
  blendKind: Blend["mode"];
  strategy: StrategyId;
  toughness: number;
  bottomMm: number;
  transitionMm: number;
  axis: "x" | "y";
  atMm: number;
  layerHeight: number;
  adaptive: boolean;
  adaptiveMin: number;
  adaptiveMax: number;
  supports: boolean;
  supportAngle: number;
  supportStyle: "grid" | "tree";
  supportHeightMult: number;
  infillCombine: boolean;
  combing: boolean;
  featureSpeeds: boolean;
  pressureAdvance: number;
  linearAdvance: number;
  variableWidth: boolean;
  arcFit: boolean;
  travelOpt: boolean;
  overhangControl: boolean;
  viewMode: "flat" | "split" | "solid";
} = {
  mesh: null,
  result: null,
  layer: 0,
  showTravel: false,
  busy: false,
  error: "",
  blendKind: "byRegion",
  strategy: "speed",
  toughness: 0.55,
  bottomMm: 4,
  transitionMm: 6,
  axis: "x",
  atMm: 10,
  layerHeight: 0.2,
  adaptive: false,
  adaptiveMin: 0.08,
  adaptiveMax: 0.2,
  supports: false,
  supportAngle: 45,
  supportStyle: "grid",
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
  viewMode: "split",
};

const app = document.querySelector("#app")!;
app.innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand">Lime <span>Slice</span></div>
      <label class="btn file">Open mesh<input id="file" type="file" accept=".stl,.3mf,.STL,.3MF" /></label>
      <button class="btn" id="cube" type="button">20 mm cube</button>
      <button class="btn" id="hull" type="button">60 mm hull</button>
      <button class="btn" id="cube3mf" type="button">Cube 3MF</button>
      <button class="btn" id="ledge" type="button">Overhang</button>
      <button class="btn" id="ramp" type="button">Slope</button>
      <button class="btn" id="fin" type="button">Thin wall</button>
      <button class="btn" id="span" type="button">Bridge</button>
      <div class="spacer"></div>
      <div class="timing" id="timing">No slice yet</div>
      <button class="btn primary" id="slice" type="button">Slice</button>
      <button class="btn" id="export" type="button" disabled>Export G-code</button>
    </header>
    <div class="workspace">
      <aside class="panel" id="left"></aside>
      <section class="stage mode-split" id="stage">
        <div class="viewbar">
          <div class="modes">
            <button class="btn mode" type="button" data-mode="flat">2D</button>
            <button class="btn mode on" type="button" data-mode="split">Split</button>
            <button class="btn mode" type="button" data-mode="solid">3D</button>
          </div>
          <span class="viewhint">3D: drag orbit · right-drag pan · wheel zoom</span>
        </div>
        <div class="previews">
          <div class="pane" id="pane2d"><canvas id="view"></canvas></div>
          <div class="pane" id="pane3d"><canvas id="view3d"></canvas></div>
        </div>
        <div class="scrub">
          <input id="slider" type="range" min="0" max="0" value="0" />
          <div class="legend" id="legend"></div>
        </div>
      </section>
      <aside class="panel right" id="right"></aside>
    </div>
    <footer class="status" id="status">Load an STL or 3MF. Wheel or the slider changes layer.</footer>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const ctx = canvas.getContext("2d")!;
const view3d: SliceView3d = createSliceView(document.querySelector<HTMLCanvasElement>("#view3d")!);
let shownSlice: SliceResponse | null = null;

document.querySelectorAll<HTMLButtonElement>(".mode").forEach((button) => {
  button.addEventListener("click", () => {
    state.viewMode = button.dataset.mode as typeof state.viewMode;
    const stage = document.querySelector("#stage")!;
    stage.classList.remove("mode-flat", "mode-split", "mode-solid");
    stage.classList.add(`mode-${state.viewMode}`);
    document.querySelectorAll(".mode").forEach((el) => el.classList.toggle("on", el === button));
    resize();
  });
});

function blend(): Blend {
  if (state.blendKind === "single") return { mode: "single", strategy: state.strategy };
  if (state.blendKind === "weight") return { mode: "weight", toughness: state.toughness };
  if (state.blendKind === "byLayer") {
    return { mode: "byLayer", bottomMm: state.bottomMm, transitionMm: state.transitionMm };
  }
  return { mode: "byRegion", axis: state.axis, atMm: state.atMm };
}

function renderChrome() {
  const mesh = state.mesh;
  const meshLine = mesh
    ? `<b>${escapeHtml(mesh.name)}</b><br>${(mesh.bytes.byteLength / 1024).toFixed(1)} KB`
    : "Nothing loaded";
  const result = state.result;
  const bounds = result
    ? `${result.mesh.min.map((n) => n.toFixed(1)).join(", ")} → ${result.mesh.max.map((n) => n.toFixed(1)).join(", ")}`
    : "—";
  document.querySelector("#left")!.innerHTML = `
    <h2>Mesh</h2>
    <div class="meta">${meshLine}</div>
    <h2>Printer stub</h2>
    <div class="meta">Generic Marlin 0.4 mm PLA<br>Nozzle 200 °C · bed 60 °C<br>Filament 1.75 mm · bed 220 mm</div>
    <label class="field">Pressure advance<input id="pa" type="number" min="0" max="0.2" step="0.005" value="${state.pressureAdvance}" /></label>
    <label class="field">Linear advance K<input id="la" type="number" min="0" max="2" step="0.01" value="${state.linearAdvance}" /></label>
    <h2>Slice</h2>
    <label class="field">Layer height mm<input id="lh" type="number" min="0.08" max="0.4" step="0.02" value="${state.layerHeight}" /></label>
    <label class="check"><input id="adaptive" type="checkbox" ${state.adaptive ? "checked" : ""}/> Adaptive layers</label>
    ${state.adaptive ? `<label class="field">Min mm<input id="amin" type="number" min="0.04" max="0.28" step="0.02" value="${state.adaptiveMin}" /></label>
    <label class="field">Max mm<input id="amax" type="number" min="0.08" max="0.4" step="0.02" value="${state.adaptiveMax}" /></label>` : ""}
    <label class="check"><input id="supports" type="checkbox" ${state.supports ? "checked" : ""}/> Smart supports</label>
    ${state.supports ? `<label class="field">Style<select id="sstyle"><option value="grid" ${state.supportStyle === "grid" ? "selected" : ""}>Sparse grid</option><option value="tree" ${state.supportStyle === "tree" ? "selected" : ""}>Tree</option></select></label>
    <label class="field">Overhang angle °<input id="sangle" type="number" min="20" max="70" step="5" value="${state.supportAngle}" /></label>
    <label class="field">Shaft height ×<input id="shmult" type="number" min="1" max="4" step="1" value="${state.supportHeightMult}" /></label>` : ""}
    <label class="check"><input id="combine" type="checkbox" ${state.infillCombine ? "checked" : ""}/> Combine sparse infill</label>
    <label class="check"><input id="combing" type="checkbox" ${state.combing ? "checked" : ""}/> Hole-aware combing</label>
    <label class="check"><input id="feeds" type="checkbox" ${state.featureSpeeds ? "checked" : ""}/> Per-feature speeds</label>
    <label class="check"><input id="vwidth" type="checkbox" ${state.variableWidth ? "checked" : ""}/> Variable walls</label>
    <label class="check"><input id="arcs" type="checkbox" ${state.arcFit ? "checked" : ""}/> Arc fit (G2/G3)</label>
    <label class="check"><input id="travelopt" type="checkbox" ${state.travelOpt ? "checked" : ""}/> Travel and seam</label>
    <label class="check"><input id="overhang" type="checkbox" ${state.overhangControl ? "checked" : ""}/> Overhang and bridges</label>
    <div class="meta" style="margin-top:8px">Triangles <b>${result ? result.mesh.triangles : "—"}</b><br>Bounds <b>${bounds}</b></div>
    ${state.error ? `<div class="banner" style="margin-top:10px">${escapeHtml(state.error)}</div>` : ""}
    ${result ? `<div class="banner ${result.sanity.ok ? "ok" : ""}" style="margin-top:10px">${result.sanity.ok ? "G-code checks passed" : "G-code checks failed"}<br>${escapeHtml(result.sanity.notes.join(" ") || `${result.sanity.layers} layers · E ${result.sanity.finalE.toFixed(1)} mm · path ${result.sanity.extrusionLengthMm.toFixed(0)} mm`)}</div>` : ""}
  `;

  document.querySelector("#right")!.innerHTML = `
    <h2>Strategies</h2>
    <div class="stack">
      <div class="strategy speed"><h3>Speed</h3><p>2 walls · lightning infill · 140 mm/s · volumetric cap · nearest seam</p></div>
      <div class="strategy mid"><h3>Efficiency</h3><p>Weight mix · lines then grid · filament score from the estimator</p></div>
      <div class="strategy tough"><h3>Toughness</h3><p>5 walls · 48% gyroid · 45 mm/s · aligned seam · strength pattern</p></div>
    </div>
    <h2>Blend</h2>
    <div class="stack">
      <label class="field">How to mix
        <select id="blendKind">
          ${opt("single", "Single strategy", state.blendKind)}
          ${opt("weight", "Weight / efficiency", state.blendKind)}
          ${opt("byLayer", "By layer", state.blendKind)}
          ${opt("byRegion", "By region", state.blendKind)}
        </select>
      </label>
      ${blendFields()}
    </div>
    <h2>Active layer</h2>
    <div class="meta" id="layerReadout">${layerReadout()}</div>
  `;

  const timing = document.querySelector("#timing")!;
  const est = result?.estimate;
  const score = result?.score;
  timing.textContent = result
    ? `core ${result.coreMs.toFixed(1)} ms · ${est ? `${(est.seconds / 60).toFixed(1)} min · ${est.filamentG.toFixed(2)} g` : `E ${result.sanity.finalE.toFixed(0)} mm`}${score ? ` · speed ${score.speed.toFixed(0)} eff ${score.efficiency.toFixed(0)}` : ""}`
    : state.busy
      ? "Slicing…"
      : "No slice yet";
  (document.querySelector("#export") as HTMLButtonElement).disabled = !result;
  const slider = document.querySelector<HTMLInputElement>("#slider")!;
  const max = Math.max(0, (result?.layers.length ?? 1) - 1);
  slider.max = String(max);
  slider.value = String(Math.min(state.layer, max));
  document.querySelector("#legend")!.innerHTML = `
    <span><i class="swatch" style="background:#f0a202"></i>speed wall</span>
    <span><i class="swatch" style="background:#2ec4b6"></i>toughness wall</span>
    <span><i class="swatch" style="background:#f6d48a"></i>outer</span>
    <span><i class="swatch" style="background:#a56d12"></i>sparse infill</span>
    <span><i class="swatch" style="background:#1b7f76"></i>toughness infill</span>
    <span><i class="swatch" style="background:#d7d2c6"></i>skirt</span>
    <span><i class="swatch" style="background:#e85d4c"></i>thin / gap</span>
    <span><i class="swatch" style="background:#f2cc60"></i>bridge</span>
    <span><i class="swatch" style="background:#7aa2f7"></i>support</span>
    <span><i class="swatch" style="background:#c6a0f6"></i>interface</span>
    <label><input id="travel" type="checkbox" ${state.showTravel ? "checked" : ""}/> travel</label>
  `;
  const status = document.querySelector("#status")!;
  if (!mesh) status.textContent = "Load an STL or 3MF, or open a sample. Wheel or the slider changes layer.";
  else if (state.busy) status.textContent = `Slicing ${mesh.name}…`;
  else if (result) {
    const layer = result.layers[state.layer];
    status.textContent = layer
      ? `${result.blend} · layer ${layer.index} · Z ${layer.z.toFixed(2)} · ${layer.note}`
      : result.blend;
  }
  bindChrome();
}

function blendFields() {
  if (state.blendKind === "single") {
    return `<label class="field">Strategy<select id="strategy">${opt("speed", "Speed", state.strategy)}${opt("toughness", "Toughness", state.strategy)}</select></label>`;
  }
  if (state.blendKind === "weight") {
    return `<label class="field">Toughness weight ${(state.toughness * 100).toFixed(0)}%<input id="weight" type="range" min="0" max="100" value="${Math.round(state.toughness * 100)}" /></label>`;
  }
  if (state.blendKind === "byLayer") {
    return `<label class="field">Toughness from the bed, mm<input id="bottom" type="number" step="0.2" value="${state.bottomMm}" /></label>
      <label class="field">Transition into speed, mm<input id="trans" type="number" step="0.2" value="${state.transitionMm}" /></label>`;
  }
  return `<label class="field">Split axis<select id="axis">${opt("x", "X", state.axis)}${opt("y", "Y", state.axis)}</select></label>
    <label class="field">Split at mm (low = toughness)<input id="at" type="number" step="0.5" value="${state.atMm}" /></label>`;
}

function layerReadout() {
  const layer = state.result?.layers[state.layer];
  if (!layer) return "Slice to compare wall counts.";
  return `Z <b>${layer.z.toFixed(2)}</b> · h <b>${(layer.height ?? 0).toFixed(3)}</b><br>speed walls <b>${layer.speedWalls}</b><br>toughness walls <b>${layer.toughnessWalls}</b><br>support paths <b>${layer.supportPaths ?? 0}</b>`;
}

function opt(value: string, label: string, current: string) {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`;
}

function bindChrome() {
  document.querySelector("#lh")?.addEventListener("change", (ev) => {
    state.layerHeight = Number((ev.target as HTMLInputElement).value) || 0.2;
  });
  document.querySelector("#adaptive")?.addEventListener("change", (ev) => {
    state.adaptive = (ev.target as HTMLInputElement).checked;
    if (state.adaptive && state.adaptiveMax < state.layerHeight) state.adaptiveMax = state.layerHeight;
    renderChrome();
  });
  document.querySelector("#amin")?.addEventListener("change", (ev) => {
    state.adaptiveMin = Number((ev.target as HTMLInputElement).value) || 0.08;
  });
  document.querySelector("#amax")?.addEventListener("change", (ev) => {
    state.adaptiveMax = Number((ev.target as HTMLInputElement).value) || state.layerHeight;
  });
  document.querySelector("#supports")?.addEventListener("change", (ev) => {
    state.supports = (ev.target as HTMLInputElement).checked;
    renderChrome();
  });
  document.querySelector("#sangle")?.addEventListener("change", (ev) => {
    state.supportAngle = Number((ev.target as HTMLInputElement).value) || 45;
  });
  document.querySelector("#sstyle")?.addEventListener("change", (ev) => {
    state.supportStyle = (ev.target as HTMLSelectElement).value as "grid" | "tree";
  });
  document.querySelector("#shmult")?.addEventListener("change", (ev) => {
    state.supportHeightMult = Number((ev.target as HTMLInputElement).value) || 1;
  });
  document.querySelector("#combine")?.addEventListener("change", (ev) => {
    state.infillCombine = (ev.target as HTMLInputElement).checked;
  });
  document.querySelector("#combing")?.addEventListener("change", (ev) => {
    state.combing = (ev.target as HTMLInputElement).checked;
  });
  document.querySelector("#feeds")?.addEventListener("change", (ev) => {
    state.featureSpeeds = (ev.target as HTMLInputElement).checked;
  });
  document.querySelector("#pa")?.addEventListener("change", (ev) => {
    state.pressureAdvance = Number((ev.target as HTMLInputElement).value) || 0;
  });
  document.querySelector("#la")?.addEventListener("change", (ev) => {
    state.linearAdvance = Number((ev.target as HTMLInputElement).value) || 0;
  });
  document.querySelector("#vwidth")?.addEventListener("change", (ev) => {
    state.variableWidth = (ev.target as HTMLInputElement).checked;
  });
  document.querySelector("#arcs")?.addEventListener("change", (ev) => {
    state.arcFit = (ev.target as HTMLInputElement).checked;
  });
  document.querySelector("#travelopt")?.addEventListener("change", (ev) => {
    state.travelOpt = (ev.target as HTMLInputElement).checked;
  });
  document.querySelector("#overhang")?.addEventListener("change", (ev) => {
    state.overhangControl = (ev.target as HTMLInputElement).checked;
  });
  document.querySelector("#blendKind")?.addEventListener("change", (ev) => {
    state.blendKind = (ev.target as HTMLSelectElement).value as Blend["mode"];
    renderChrome();
    draw();
  });
  document.querySelector("#strategy")?.addEventListener("change", (ev) => {
    state.strategy = (ev.target as HTMLSelectElement).value as StrategyId;
  });
  document.querySelector("#weight")?.addEventListener("input", (ev) => {
    state.toughness = Number((ev.target as HTMLInputElement).value) / 100;
    const readout = document.querySelector("#right .field");
    if (readout) readout.firstChild!.textContent = `Toughness weight ${(state.toughness * 100).toFixed(0)}%`;
  });
  document.querySelector("#bottom")?.addEventListener("change", (ev) => {
    state.bottomMm = Number((ev.target as HTMLInputElement).value) || 0;
  });
  document.querySelector("#trans")?.addEventListener("change", (ev) => {
    state.transitionMm = Number((ev.target as HTMLInputElement).value) || 0;
  });
  document.querySelector("#axis")?.addEventListener("change", (ev) => {
    state.axis = (ev.target as HTMLSelectElement).value as "x" | "y";
  });
  document.querySelector("#at")?.addEventListener("change", (ev) => {
    state.atMm = Number((ev.target as HTMLInputElement).value) || 0;
  });
  document.querySelector("#travel")?.addEventListener("change", (ev) => {
    state.showTravel = (ev.target as HTMLInputElement).checked;
    draw();
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

async function loadNamed(name: string) {
  state.error = "";
  const res = await fetch(`/samples/${name}`);
  if (!res.ok) throw new Error(`could not load ${name}`);
  state.mesh = { name, bytes: await res.arrayBuffer() };
  state.result = null;
  if (name.includes("hull")) state.atMm = 0;
  if (name.includes("cube")) state.atMm = 10;
  renderChrome();
  draw();
}

document.querySelector("#cube")!.addEventListener("click", () => loadNamed("calibration_cube_20mm.stl").catch(fail));
document.querySelector("#hull")!.addEventListener("click", () => loadNamed("lime_hull.stl").catch(fail));
document.querySelector("#cube3mf")!.addEventListener("click", () => loadNamed("calibration_cube_20mm.3mf").catch(fail));
document.querySelector("#ledge")!.addEventListener("click", () => loadNamed("overhang_ledge.stl").catch(fail));
document.querySelector("#ramp")!.addEventListener("click", () => loadNamed("slope_ramp.stl").catch(fail));
document.querySelector("#fin")!.addEventListener("click", () => loadNamed("thin_fin.stl").catch(fail));
document.querySelector("#span")!.addEventListener("click", () => loadNamed("bridge_span.stl").catch(fail));
document.querySelector("#file")!.addEventListener("change", (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  file.arrayBuffer().then((bytes) => {
    state.mesh = { name: file.name, bytes };
    state.result = null;
    state.error = "";
    renderChrome();
    draw();
  }).catch(fail);
});

document.querySelector("#slice")!.addEventListener("click", () => void runSlice());
document.querySelector("#export")!.addEventListener("click", () => {
  if (!state.result) return;
  const blob = new Blob([state.result.gcode], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const base = (state.mesh?.name ?? "part").replace(/\.(stl|3mf)$/i, "");
  a.download = `${base}.gcode`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.querySelector("#slider")!.addEventListener("input", (ev) => {
  state.layer = Number((ev.target as HTMLInputElement).value);
  const readout = document.querySelector("#layerReadout");
  if (readout) readout.innerHTML = layerReadout();
  const layer = state.result?.layers[state.layer];
  if (layer && state.result) {
    document.querySelector("#status")!.textContent = `${state.result.blend} · layer ${layer.index} · Z ${layer.z.toFixed(2)} · ${layer.note}`;
  }
  draw();
});

canvas.addEventListener("wheel", (ev) => {
  if (!state.result) return;
  ev.preventDefault();
  const dir = ev.deltaY > 0 ? 1 : -1;
  state.layer = Math.max(0, Math.min(state.result.layers.length - 1, state.layer + dir));
  (document.querySelector("#slider") as HTMLInputElement).value = String(state.layer);
  renderChrome();
  draw();
}, { passive: false });

window.addEventListener("keydown", (ev) => {
  if (!state.result) return;
  if (ev.key === "[" || ev.key === "]") {
    state.layer = Math.max(0, Math.min(state.result.layers.length - 1, state.layer + (ev.key === "]" ? 1 : -1)));
    renderChrome();
    draw();
  }
});

async function runSlice() {
  if (!state.mesh) {
    state.error = "Load a mesh first.";
    renderChrome();
    return;
  }
  state.busy = true;
  state.error = "";
  renderChrome();
  try {
    const payload = {
      filename: state.mesh.name,
      dataB64: arrayBufferToBase64(state.mesh.bytes),
      layerHeight: state.layerHeight,
      lineWidth: 0.45,
      blend: blend(),
      adaptive: state.adaptive,
      adaptiveMin: state.adaptiveMin,
      adaptiveMax: state.adaptiveMax,
      supports: state.supports,
      supportAngle: state.supportAngle,
      supportStyle: state.supportStyle,
      supportHeightMult: state.supportHeightMult,
      infillCombine: state.infillCombine,
      combing: state.combing,
      featureSpeeds: state.featureSpeeds,
      printer: {
        name: "Generic Marlin 0.4 mm PLA",
        nozzleDiameter: 0.4,
        filamentDiameter: 1.75,
        nozzleTemp: 200,
        bedTemp: 60,
        bedX: 220,
        bedY: 220,
        maxVolumetricMm3S: 12,
        filamentDensityGCm3: 1.24,
        pressureAdvance: state.pressureAdvance,
        linearAdvance: state.linearAdvance,
      },
      variableWidth: state.variableWidth,
      arcFit: state.arcFit,
      travelOpt: state.travelOpt,
      overhangControl: state.overhangControl,
    };
    state.result = await slice(payload);
    if (state.result.error) throw new Error(state.result.error);
    state.layer = Math.min(state.layer, Math.max(0, state.result.layers.length - 1));
    const mid = state.result.mesh;
    if (state.blendKind === "byRegion" && state.atMm === 10 && state.mesh.name.includes("hull")) {
      state.atMm = (mid.min[0] + mid.max[0]) / 2;
    }
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    renderChrome();
    draw();
  }
}

async function slice(payload: unknown): Promise<SliceResponse> {
  const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (tauri.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    const json = await invoke<string>("slice_model", { payload: JSON.stringify(payload) });
    return JSON.parse(json) as SliceResponse;
  }
  const res = await fetch(`${API}/api/slice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as SliceResponse;
  if (!res.ok) throw new Error(body.error || `slice failed (${res.status})`);
  return body;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fail(err: unknown) {
  state.error = err instanceof Error ? err.message : String(err);
  state.busy = false;
  renderChrome();
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  view3d.resize();
  draw();
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0c0e12";
  ctx.fillRect(0, 0, w, h);
  const layer = state.result?.layers[state.layer];
  const mesh = state.result?.mesh;
  if (!layer || !mesh) {
    ctx.fillStyle = "#9a9386";
    ctx.font = `${14 * (window.devicePixelRatio || 1)}px IBM Plex Sans, sans-serif`;
    ctx.fillText("Toolpath preview", 24, 36);
    ctx.fillText("Open the cube or hull, then slice.", 24, 60);
    sync3d();
    return;
  }
  let minX = mesh.min[0];
  let maxX = mesh.max[0];
  let minY = mesh.min[1];
  let maxY = mesh.max[1];
  const pad = 28 * (window.devicePixelRatio || 1);
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * scale) / 2;
  const oy = (h - spanY * scale) / 2;
  const map = (x: number, y: number): [number, number] => [ox + (x - minX) * scale, h - (oy + (y - minY) * scale)];

  ctx.strokeStyle = "#222733";
  ctx.lineWidth = 1;
  ctx.strokeRect(map(minX, minY)[0], map(maxX, maxY)[1], spanX * scale, spanY * scale);

  const order = ["travel", "support", "support-interface", "infill", "sparse", "solid", "top", "gap-fill", "bridge", "thin-wall", "skirt", "inner", "outer", "wall"];
  const paths = [...layer.paths].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const path of paths) {
    if (path.kind === "travel" && !state.showTravel) continue;
    ctx.beginPath();
    path.pts.forEach((p, i) => {
      const [x, y] = map(p[0], p[1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colorFor(path);
    const support = path.kind === "support" || path.kind === "support-interface";
    const wall = path.kind === "wall" || path.kind === "outer" || path.kind === "inner";
    ctx.lineWidth = wall ? Math.max(1.4, scale * 0.12) : path.kind === "travel" ? 1 : support ? Math.max(1.2, scale * 0.1) : Math.max(1, scale * 0.08);
    ctx.setLineDash(path.kind === "travel" ? [4, 4] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  sync3d();
}

function sync3d() {
  if (state.result !== shownSlice) {
    shownSlice = state.result;
    view3d.setSlice(state.result);
  }
  view3d.setShowTravel(state.showTravel);
  view3d.setLayer(state.layer);
  view3d.resize();
}

function colorFor(path: PreviewPath) {
  if (path.kind === "travel") return "#4d5668";
  if (path.kind === "skirt") return "#d7d2c6";
  if (path.kind === "support") return "#7aa2f7";
  if (path.kind === "support-interface") return "#c6a0f6";
  if (path.kind === "thin-wall" || path.kind === "gap-fill") return "#e85d4c";
  if (path.kind === "bridge") return "#f2cc60";
  const tough = path.strategy === "toughness";
  if (path.kind === "outer") return tough ? "#7ee0d6" : "#f6d48a";
  if (path.kind === "inner" || path.kind === "wall") return tough ? "#2ec4b6" : "#f0a202";
  if (path.kind === "top") return tough ? "#8fd9c8" : "#e7b34a";
  if (path.kind === "solid") return tough ? "#1b7f76" : "#c9842a";
  return tough ? "#1b7f76" : "#a56d12";
}

new ResizeObserver(resize).observe(canvas);
renderChrome();
resize();
