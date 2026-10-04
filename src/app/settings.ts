import { fx } from "./fx";
import { state, session, type CardId, type SliceResponse } from "./state";
import { currentApiTarget, authHeaders, engineDownMessage } from "../ui/api-base";
import { layerWeight, resolved, type ResolvedCard } from "../strategy";
import { levelBarHtml, paintSettingMarks, syncEmptyState } from "../ui/shell";
import { pushToast } from "../ui/toasts";
import { markProjectDirty } from "../project-dirty";
import { sliceBusyStatus, staleSliceCopy, cacheStatus, coverageWarning, inAirWarning } from "../slice-action";
import { applySliceProgress, currentSliceProgress } from "../ui/slice-progress";
import { filamentCost, filamentGrams, groupFeatures } from "../estimate";
import { offBed } from "../mesh-place";
import { boundsSize, overlapPairs, placeObject, selectedObject } from "../plate";
import { type PresetSettings, DEFAULT_PRESET, presetKeys, readPresets, diffPreset } from "../presets";
import { loadProfile, type PrinterProfile, saveProfile } from "../profiles";
import { noteAdvance, noteGcode, noteNozzle } from "./machine-actions";
import { loadMachineLibrary } from "./machine-library";
import { machineSectionHtml } from "../ui/machine-library";
import { loadPrusaLink } from "./prusa-link";
import { prusaSummary, rememberPrusaForm } from "./prusa-actions";
import { prusaFieldsHtml } from "../ui/prusa-link";
import { canRedoEdit, canUndoEdit, noteEdit } from "./history";
import { loadProfileLibrary } from "./profile-library";
import { SETTING_KEYWORDS, settingMatches } from "../ui/settings-search";
import { displayId } from "../ui/settings-profiles";
import { overrideSectionHtml } from "../ui/overrides-panel";
import { IRONING_STORED_TOAST, ironingFlowPercent, readIroningFlowPercent, readIroningSpacing, readIroningSpeed } from "../ironing";
import { loadSettingsLevel } from "../ui/settings-panel";

export function apiBase() {
  return currentApiTarget().base;
}

export function apiToken() {
  return currentApiTarget().token;
}

export function card(): CardId {
  if (state.blendKind === "byLayer") return "layer";
  if (state.blendKind === "byRegion") return "region";
  if (state.blendKind === "weight") return "efficiency";
  return state.strategy === "toughness" ? "toughness" : "speed";
}

export function stale() {
  return !!state.result && state.slicedHash !== settingsHash();
}

/** Stale and waiting on the user. A quiet refresh hides the warning while it runs; export still waits for its reply. */
export function staleWarning() {
  return stale() && !fx.quietRefreshing();
}

export function settingsHash() {
  const shift = state.offset;
  const mesh = state.mesh ? `${state.mesh.name}:${state.mesh.bytes.byteLength}:${state.partScale}:${state.centered}:${shift.x.toFixed(3)},${shift.y.toFixed(3)},${shift.z.toFixed(3)}:${state.orient.join(",")}` : "";
  const { result: _r, slicedHash: _h, busy: _b, progress: _p, error: _e, notice: _n, engine: _g, hidden: _hid, layer: _l, rangeLow: _lo, viewMode: _v, query: _q, showTravel: _t, colorMode: _c, paBands: _pb, paGcode: _pg, pricePerKg: _price, move: _mv, stage: _st, playing: _play, sourcePos: _sp, placed: _pl, pareto: _pa, help: _hp, splitCustom: _sc, poseHud: _ph, offset: _off, bedOpacity: _bo, sectionOn: _so, sectionNormal: _sn, sectionOffset: _sf, sectionHud: _sh, selectedVolumeId: _sel, modifierTool: _mt, plate: _plate, profile: _profile, ironing: _ironing, ironingFlow: _ironingFlow, ironingSpeed: _ironingSpeed, ironingSpacing: _ironingSpacing, ...rest } = state;
  // Price and density only weigh the estimate, which the UI computes from the reply.
  // Ironing is stored only. It is not on the slice request, so it does not stale a result.
  const { filamentDensityGCm3: _density, filamentCostPerKg: _cost, ...profile } = state.profile;
  const hashed = { mesh, profile, rest };
  if (state.plate.objects.length > 1) {
    return JSON.stringify({
      ...hashed,
      plate: state.plate.objects.map((obj) => `${obj.id}:${obj.partScale}:${obj.offset.x.toFixed(3)},${obj.offset.y.toFixed(3)},${obj.offset.z.toFixed(3)}:${obj.orient.join(",")}:${obj.sourcePos.length}`).join("|"),
    });
  }
  return JSON.stringify(hashed);
}

export function blend() {
  if (state.blendKind === "single") return { mode: "single", strategy: state.strategy };
  if (state.blendKind === "weight") return { mode: "weight", toughness: state.toughness };
  if (state.blendKind === "byLayer") return { mode: "byLayer", bottomMm: state.bottomMm, transitionMm: state.transitionMm };
  return { mode: "byRegion", axis: state.axis, atMm: state.atMm };
}

export function currentWeight() {
  const layer = state.result?.layers[state.layer];
  if (state.blendKind === "single") return state.strategy === "toughness" ? 1 : 0;
  if (state.blendKind === "weight") return state.toughness;
  if (state.blendKind === "byLayer") return layerWeight(layer?.z ?? state.bottomMm, state.bottomMm, state.transitionMm);
  return 1;
}

export function renderChrome() {
  const mesh = state.mesh;
  const result = state.result;
  const find = document.querySelector<HTMLInputElement>("#find");
  const findFocused = find != null && document.activeElement === find;
  const selStart = find?.selectionStart ?? null;
  const selEnd = find?.selectionEnd ?? null;
  document.querySelector("#leftBody")!.innerHTML = `
    ${levelBarHtml()}
    ${profileHeaderHtml()}
    <div class="find-row">
      <input id="find" type="search" placeholder="Search settings" aria-label="Search settings" value="${escapeHtml(state.query)}" />
      <button class="btn history-btn" id="undoEdit" type="button" aria-label="Undo" ${canUndoEdit() ? "" : "disabled"}>Undo</button>
      <button class="btn history-btn" id="redoEdit" type="button" aria-label="Redo" ${canRedoEdit() ? "" : "disabled"}>Redo</button>
    </div>
    <h2>Mesh</h2>
    <div class="meta">${mesh ? `<b>${escapeHtml(mesh.name)}</b>` : "Nothing loaded"}</div>
    <div class="object-list" id="objectList">${objectList()}</div>
    ${group("Quality", `
      ${num("lh", "Layer height mm", state.layerHeight, 0.08, 0.4, 0.02, "simple")}
      ${check("adaptive", "Adaptive layers", state.adaptive, "advanced")}
      ${state.adaptive ? `${num("amin", "Min mm", state.adaptiveMin, 0.04, 0.28, 0.02, "advanced")}${num("amax", "Max mm", state.adaptiveMax, 0.08, 0.4, 0.02, "advanced")}` : ""}
      ${check("simplify", "Simplify outlines", state.simplify, "advanced")}
      ${state.simplify ? `${num("simperr", "Outline tolerance mm, 0 = auto", state.simplifyError, 0, 0.2, 0.005, "expert")}<div class="meta">Every triangle is cut. Each layer's outline then drops vertices closer than this to the line through their neighbors. Auto is a sixteenth of the nozzle, 0.025 mm for 0.4 mm, so a gap the nozzle can print never closes.</div>` : ""}
    `)}
    ${group("Strength", `
      ${check("vwidth", "Variable walls", state.variableWidth, "simple")}
      ${check("travelopt", "Travel and seam", state.travelOpt, "advanced")}
      ${select("seam", "Seam position", state.seam, [["blend", "Blend (strategy)"], ["nearest", "Nearest"], ["aligned", "Aligned"], ["rear", "Rear"]], "advanced")}
      ${check("ironing", "Ironing", state.ironing, "advanced")}
      ${state.ironing ? `${num("ironflow", "Ironing flow %", ironingFlowPercent(state.ironingFlow), 1, 100, 1, "advanced")}${num("ironspeed", "Ironing speed mm/s", state.ironingSpeed, 1, 200, 1, "advanced")}${num("ironspace", "Ironing spacing mm", state.ironingSpacing, 0.05, 1, 0.01, "advanced")}<div class="meta">Stored only. Top skins are not ironed until the slicer reads this. Defaults are 10% flow, 20 mm/s, and 0.1 mm spacing.</div>` : ""}
      ${select("scarf", "Scarf seam", state.scarfSeam, [["blend", "Blend default"], ["off", "Off"], ["outer", "Outer walls"], ["all", "Outer and inner"]], "advanced")}
      ${state.scarfSeam === "off" ? "" : `${num("scarflen", "Scarf length mm", state.scarfLength, 1, 30, 1, "expert")}${num("scarfsteps", "Scarf steps", state.scarfSteps, 2, 32, 1, "expert")}`}
    `)}
    ${group("Speed", `
      ${check("feeds", "Per-feature speeds", state.featureSpeeds, "simple")}
      ${check("arcs", "Arc fit (G2/G3)", state.arcFit, "advanced")}
      ${check("combine", "Combine sparse infill", state.infillCombine, "advanced")}
      ${check("combing", "Hole-aware combing", state.combing, "advanced")}
      ${check("overhang", "Overhang and bridges", state.overhangControl, "simple")}
      ${num("pa", "Pressure advance", state.pressureAdvance, 0, 0.2, 0.005, "expert")}
      ${num("la", "Linear advance K", state.linearAdvance, 0, 2, 0.01, "expert")}
      ${select("gyroid3d", "3D gyroid", state.gyroid3d, [["blend", "Blend default"], ["off", "2D sine"], ["on", "Force 3D"]], "expert")}
      ${select("zhop", "Z-hop", state.zHop, [["blend", "Blend default"], ["off", "Off"], ["smart", "Smart"], ["always", "Always"]], "advanced")}
      ${state.zHop === "off" ? "" : `${num("zhopht", "Hop height mm", state.zHopHeight, 0.1, 2, 0.1, "expert")}${num("zhopmin", "Hop above travel mm", state.zHopMinTravel, 0.5, 20, 0.5, "expert")}`}
    `)}
    ${group("Support", `
      ${check("supports", "Smart supports", state.supports, "simple")}
      ${state.supports ? `${select("sstyle", "Style", state.supportStyle, [["grid", "Sparse grid"], ["tree", "Organic tree"]], "advanced")}
        ${num("sangle", "Overhang angle °", state.supportAngle, 20, 70, 5, "advanced")}
        ${state.supportStyle === "tree" ? `${num("bangle", "Branch angle °", state.branchAngle, 15, 60, 5, "expert")}
        ${num("tipd", "Tip diameter mm", state.tipDiameter, 0.4, 2, 0.1, "expert")}
        ${num("trunkd", "Trunk diameter mm", state.trunkDiameter, 1.5, 12, 0.2, "expert")}` : ""}
        ${num("shmult", "Shaft height ×", state.supportHeightMult, 1, 4, 1, "advanced")}` : ""}
    `)}
    ${group("Overrides", overrideSectionHtml(state.overrides, state.selectedVolumeId, state.modifierTool))}
    ${group("Other", `
      <h2>Printer</h2>
      ${profileFields()}
      <h2>Presets</h2>
      ${presetHtml()}
      ${group("PA calibration", `
        ${select("pafw", "Firmware", state.paFirmware, [["klipper", "Klipper"], ["marlin", "Marlin"]], "expert")}
        ${num("pastart", "K start", state.paStart, 0, 1, 0.005, "expert")}
        ${num("paend", "K end", state.paEnd, 0, 1, 0.005, "expert")}
        ${num("pastep", "K step", state.paStep, 0.001, 0.2, 0.005, "expert")}
        <button class="btn" id="pacal" type="button">Generate PA test</button>
        ${state.paBands.length ? `<div class="meta">${state.paBands.map((b) => `band ${b.index}: K ${b.k.toFixed(4)} · Z ${b.z0.toFixed(2)}–${b.z1.toFixed(2)}`).join("<br>")}</div>
          ${num("pachosen", "Chosen K", state.paFirmware === "marlin" ? state.linearAdvance : state.pressureAdvance, 0, 2, 0.005)}
          <button class="btn" id="paapply" type="button">Save K to profile</button>
          <button class="btn" id="paexport" type="button">Export PA G-code</button>` : ""}
      `, "expert")}
      <label class="check setting" data-level="advanced" data-label="auto-slice under 50k triangles"><input id="autoslice" type="checkbox" ${state.autoSlice ? "checked" : ""}/> Auto-slice under 50k triangles</label>
      <div class="meta">${triangleMeta(result)}</div>
      ${stageHtml(result)}
    `)}
  `;
  restoreFindCaret(findFocused, selStart, selEnd);
  applyFilter();
  syncFindStuck();

  const live = resolved(currentWeight(), state.layerHeight);
  document.querySelector("#right")!.innerHTML = `
    <h2>Strategy blend</h2>
    <div class="cards">
      ${cardBtn("speed", "Speed", "2 walls · lightning · fast feeds")}
      ${cardBtn("efficiency", "Efficiency", "Mid weight · lines then grid")}
      ${cardBtn("toughness", "Toughness", "5 walls · 48% 3D gyroid · scarf")}
      ${cardBtn("layer", "By layer", "Toughness at the bed, then speed")}
      ${cardBtn("region", "By region", "Low side toughness, high side speed")}
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
  fx.paintSliceButton(sliceBtn);
  fx.paintForceButton(document.querySelector<HTMLButtonElement>("#force")!);
  sliceBtn.disabled = state.busy || !state.mesh;
  (document.querySelector("#cancel") as HTMLButtonElement).disabled = !state.busy;
  (document.querySelector("#export") as HTMLButtonElement).disabled = !result || isStale || state.busy;
  document.querySelector("#timing")!.textContent = timingText();
  const warn = staleWarning();
  document.querySelector("#stage")!.classList.toggle("stale", warn);
  paintBanner(warn);
  fx.paintLegend();
  fx.paintSlider();
  fx.paintSpark();
  fx.paintPlayback();
  fx.paintGcode();
  paintStatus(warn);
  paintSettingMarks(currentPreset());
  syncEmptyState(!!state.mesh);
  session.supportUi?.refresh();
}

function timingText() {
  const result = state.result;
  if (state.busy) return busyText();
  if (!result) return "No slice yet";
  const seconds = result.estimate?.seconds ?? 0;
  return `${seconds / 60 < 1 ? `${seconds.toFixed(0)} s` : `${(seconds / 60).toFixed(1)} min`} · ${shownGrams(result).toFixed(2)} g`;
}

/** The slice's filament in grams at the profile's density. */
export function shownGrams(result: SliceResponse) {
  return filamentGrams(result.estimate?.filamentMm ?? 0, state.profile);
}

/** Show grams and cost at the profile's density and price, without asking the engine. */
function paintEstimate() {
  const est = document.querySelector("#estimate");
  if (est) est.innerHTML = estimateHtml();
  const timing = document.querySelector("#timing");
  if (timing) timing.textContent = timingText();
}

export function markEngineDown(message: string) {
  session.engineChecked = true;
  state.engine = message;
  if (session.announcedDown !== message) {
    session.announcedDown = message;
    pushToast(message, "error", {
      label: "Retry",
      run: () => {
        session.announcedDown = "";
        void probe();
      },
    });
  }
  paintEngineLink();
}

export function markEngineUp() {
  session.engineChecked = true;
  state.engine = "";
  session.announcedDown = "";
  paintEngineLink();
}

export function paintEngineLink() {
  const el = document.querySelector<HTMLElement>("#engineLink");
  if (!el) return;
  if (fx.isTauri()) {
    el.hidden = true;
    return;
  }
  const base = apiBase();
  el.hidden = false;
  el.title = base;
  if (!session.engineChecked) {
    el.dataset.state = "pending";
    el.textContent = "Engine …";
    return;
  }
  if (state.engine.includes("refused the token")) {
    el.dataset.state = "down";
    el.textContent = "Engine unauthorized";
    return;
  }
  if (state.engine) {
    el.dataset.state = "down";
    el.textContent = "Engine unreachable";
    return;
  }
  el.dataset.state = "ok";
  el.textContent = "Engine connected";
}

export function paintStatus(isStale: boolean) {
  const mesh = state.mesh;
  const result = state.result;
  const status = document.querySelector("#status");
  if (!status) return;
  if (!mesh) status.textContent = "Load an STL, 3MF, or STEP file from Samples or Open mesh. Arrow keys move the layer.";
  else if (state.busy) status.textContent = session.liveProgress && session.busyPhase
    ? `${session.busyPhase}. ${sliceBusyStatus(mesh.name, session.busyRecompute)}`
    : sliceBusyStatus(mesh.name, session.busyRecompute);
  else if (isStale) status.textContent = staleSliceCopy(fx.currentSliceAction(false).state).status;
  else if (result?.fromCache) status.textContent = cacheStatus(result.blend, new Date(result.slicedAtMs ?? 0).toLocaleString());
  else if (result) status.textContent = result.blend;
  else status.textContent = `${mesh.name} loaded. Choose a strategy, then slice.`;
  paintEngineLink();
}

export function markBusy(recompute: boolean) {
  state.busy = true;
  state.progress = 0;
  session.busySince = performance.now();
  session.busyRecompute = recompute;
  session.busyPhase = recompute ? "" : "Loading…";
  session.jobStage = "";
  session.liveProgress = false;
  const mine = session.busySince;
  const tick = window.setInterval(() => {
    if (!state.busy || session.busySince !== mine) {
      window.clearInterval(tick);
      return;
    }
    document.querySelector("#timing")!.textContent = busyText();
    applySliceProgress(sliceSample(), session.liveProgress ? session.busyPhase : "");
    paintStatus(stale());
  }, 100);
}

function sliceSample() {
  return currentSliceProgress(state.progress, Math.max(0, performance.now() - session.busySince), session.liveProgress);
}

export function busyText() {
  return `${session.busyPhase || "Slicing…"} ${((performance.now() - session.busySince) / 1000).toFixed(1)} s`;
}

export function bannerLine(text: string, cls = "", alert = false) {
  const kind = cls ? ` ${cls}` : "";
  const role = alert ? ` role="alert"` : "";
  const safe = escapeHtml(text);
  return `<div class="banner${kind}"${role} title="${safe}">${safe}</div>`;
}

export const TRANSIENT_ERRORS = new Set([
  "Load a mesh first.",
  "No G-code for this slice.",
  "Load a mesh before comparing blends.",
]);

export function toastTransient(message: string, tone: "warn" | "error") {
  const now = performance.now();
  if (message === session.lastToastText && now - session.lastToastAt < 500) return;
  session.lastToastText = message;
  session.lastToastAt = now;
  pushToast(message, tone);
}

/** Short-lived notices leave the banner. Blocking problems stay there. */
export function takeTransient() {
  if (state.notice === "Slice cancelled.") {
    toastTransient(state.notice, "warn");
    state.notice = "";
  }
  if (state.error && TRANSIENT_ERRORS.has(state.error)) {
    toastTransient(state.error, "error");
    state.error = "";
  }
}

export function paintBanner(isStale: boolean) {
  takeTransient();
  const rail = document.querySelector("#banner")!;
  const bits: string[] = [];
  if (state.engine) bits.push(bannerLine(state.engine));
  if (state.error) bits.push(bannerLine(state.error, "", true));
  if (state.notice) bits.push(bannerLine(state.notice, "warn"));
  if (isStale) bits.push(bannerLine(staleSliceCopy(fx.currentSliceAction(false).state).banner, "warn"));
  if (state.result && !state.result.sanity.ok) bits.push(bannerLine(state.result.sanity.notes.join(" ") || "G-code checks failed"));
  const objects = state.result?.objects;
  const unheld = coverageWarning(objects ? objects.flatMap((o) => o.coverage) : (state.result?.coverage ?? []));
  if (unheld) bits.push(bannerLine(unheld, "warn"));
  const air = objects?.map((o) => o.inAir).filter((a) => !!a);
  const floating = inAirWarning(
    air?.length ? { islands: air.reduce((n, a) => n + a!.islands, 0), overhangs: air.reduce((n, a) => n + a!.overhangs, 0) } : state.result?.inAir,
  );
  if (floating) bits.push(bannerLine(floating, "warn"));
  if (state.busy) {
    const sample = sliceSample();
    const indeterminate = !(sample.fraction > 0 && sample.fraction < 1);
    const pct = indeterminate ? 30 : Math.max(4, sample.fraction * 100);
    bits.push(`<div class="progress${indeterminate ? " indeterminate" : ""}" data-state="slicing" role="progressbar" aria-label="Slice progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(sample.fraction * 100)}"><span style="width:${pct}%"></span></div>`);
  }
  rail.innerHTML = bits.join("");
  const meter = document.querySelector<HTMLElement>("#sliceMeter");
  if (!state.busy) meter?.setAttribute("hidden", "");
  else applySliceProgress(sliceSample(), session.liveProgress ? session.busyPhase : "");
}

export const closedGroups = new Set<string>();

export function group(title: string, body: string, level?: "simple" | "advanced" | "expert") {
  const attr = level ? ` data-level="${level}"` : "";
  return `<details ${closedGroups.has(title) ? "" : "open"} class="group" data-group="${title}"${attr}><summary>${title}</summary><div class="stack">${body}</div></details>`;
}

export function num(id: string, label: string, value: number, min: number, max: number, step: number, level?: "simple" | "advanced" | "expert") {
  const attr = level ? ` data-level="${level}"` : "";
  return `<label class="field setting"${attr} data-label="${label.toLowerCase()}">${label}<input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
}

export function check(id: string, label: string, on: boolean, level?: "simple" | "advanced" | "expert") {
  const attr = level ? ` data-level="${level}"` : "";
  return `<label class="check setting"${attr} data-label="${label.toLowerCase()}"><input id="${id}" type="checkbox" ${on ? "checked" : ""}/> ${label}</label>`;
}

export function select(id: string, label: string, value: string, options: [string, string][], level?: "simple" | "advanced" | "expert") {
  const attr = level ? ` data-level="${level}"` : "";
  return `<label class="field setting"${attr} data-label="${label.toLowerCase()}">${label}<select id="${id}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
}

export function cardBtn(id: CardId, title: string, copy: string) {
  const cls = id === "toughness" || id === "layer" ? "tough" : id === "efficiency" ? "mid" : "speed";
  return `<button class="card ${cls}" type="button" data-card="${id}" aria-pressed="${card() === id}"><h3>${title}</h3><p>${copy}</p></button>`;
}

export function blendFields() {
  if (state.blendKind === "weight") {
    return `<label class="field" id="weightLabel">Toughness weight ${(state.toughness * 100).toFixed(0)}%<input id="weight" type="range" min="0" max="100" value="${Math.round(state.toughness * 100)}" /></label>`;
  }
  if (state.blendKind === "byLayer") {
    return `${num("bottom", "Toughness from the bed, mm", state.bottomMm, 0, 200, 0.2)}${num("trans", "Transition into speed, mm", state.transitionMm, 0, 200, 0.2)}`;
  }
  if (state.blendKind === "byRegion") {
    return `${select("axis", "Split axis", state.axis, [["x", "X"], ["y", "Y"]])}${num("at", "Split at mm", Number(state.atMm.toFixed(1)), -500, 500, 0.1)}<p class="deferred">Low side of the plane is toughness. High side is speed. Drag the cut in Prepare, Split, or 3D.</p>`;
  }
  return "";
}

export function paramLine(card: ResolvedCard) {
  const row = (name: string, feed: number, eff: number) => `${name} <b>${feed.toFixed(0)}</b> mm/s · effective <b>${eff.toFixed(0)}</b><br>`;
  const gyroid = card.pattern === "gyroid" && state.gyroid3d !== "off"
    ? row("3D gyroid", card.gyroidSpeed, card.effectiveGyroid)
    : "";
  return `${card.name} · ${card.walls} walls · ${card.pattern} · ${(card.density * 100).toFixed(0)}%<br>${row("outer", card.outer, card.effectiveOuter)}${row("inner", card.inner, card.effectiveInner)}${row("sparse", card.sparse, card.effectiveSparse)}${gyroid}${row("top", card.top, card.effectiveTop)}`;
}

export function paramTable(card: ResolvedCard) {
  if (state.blendKind === "byRegion") {
    return `Split ${state.axis.toUpperCase()} = ${state.atMm.toFixed(1)} mm · low toughness, high speed.<br>Low side ${paramLine(resolved(1, state.layerHeight))}<br>High side ${paramLine(resolved(0, state.layerHeight))}`;
  }
  return paramLine(card);
}

export function layerReadout() {
  const layer = state.result?.layers[state.layer];
  if (!layer) return "Slice to see this layer.";
  const below = (state.result?.layers ?? []).slice(0, state.layer).reduce((s, l) => s + (l.seconds ?? 0), 0);
  return `Layer <b>${layer.index + 1}</b> / ${state.result?.layers.length}<br>Z <b>${layer.z.toFixed(2)}</b> mm · h <b>${layer.height.toFixed(3)}</b><br>Layer time <b>${(layer.seconds ?? 0).toFixed(1)}</b> s · cumulative <b>${(below + (layer.seconds ?? 0)).toFixed(1)}</b> s<br>${escapeHtml(layer.note)}`;
}

export function triangleLine(src: number) {
  return `${src} triangles`;
}

export function triangleMeta(result: SliceResponse | null) {
  if (!result) return "Triangles <b>—</b>";
  const tol = result.mesh.outlineToleranceMm ?? 0;
  const outline = tol > 0 ? ` · outline ${tol.toFixed(3)} mm` : "";
  return `Triangles <b>${result.mesh.triangles}</b>${outline}`;
}

export function formatMs(ms: number) {
  if (!Number.isFinite(ms)) return "—";
  const n = Math.max(0, ms);
  const text = n >= 100 ? `${n.toFixed(0)} ms` : `${n.toFixed(1)} ms`;
  if (n >= 1000) return `${text} · ${(n / 1000).toFixed(n >= 10000 ? 1 : 2)} s`;
  return text;
}

export function stageHtml(result: SliceResponse | null) {
  const stages = result?.stages;
  if (!result || !stages) return "";
  const named = stages.contourMs + stages.supportMs + stages.toolpathMs + stages.orderMs + stages.combMs + stages.emitMs + (stages.roofMs ?? 0) + (stages.indexMs ?? 0);
  const other = Math.max(0, result.coreMs - named);
  const rows: [string, string, boolean][] = [
    ["index", formatMs(stages.indexMs ?? 0), false],
    ["contours", formatMs(stages.contourMs), false],
    ["roofs", formatMs(stages.roofMs ?? 0), false],
    ["supports", formatMs(stages.supportMs), false],
    ["toolpaths", formatMs(stages.toolpathMs), false],
    ["order", formatMs(stages.orderMs), false],
    ["combing", formatMs(stages.combMs), false],
    ["emit", formatMs(stages.emitMs), false],
  ];
  if ((stages.cutCpuMs ?? 0) + (stages.simplifyCpuMs ?? 0) >= 1) {
    rows.splice(2, 0, ["cut cpu", formatMs(stages.cutCpuMs ?? 0), false], ["simplify cpu", formatMs(stages.simplifyCpuMs ?? 0), false]);
  }
  if ((stages.wallCpuMs ?? 0) + (stages.infillCpuMs ?? 0) >= 1) {
    const at = rows.findIndex((row) => row[0] === "order");
    rows.splice(at, 0, ["walls cpu", formatMs(stages.wallCpuMs ?? 0), false], ["infill cpu", formatMs(stages.infillCpuMs ?? 0), false]);
  }
  if (other >= 1) rows.push(["other", formatMs(other), false]);
  rows.push(["core", formatMs(result.coreMs), true]);
  const title: Record<string, string> = {
    contours: "Cut every layer and simplify its outline",
    order: "Serial travel order: island tour, seams, and scarf",
    combing: "Travel routing inside each island and z-hop, in parallel",
    other: "Untimed remainder of core: layer bands and roofs",
    core: "Plan and G-code emit"
  };
  const body = rows
    .map(([name, value, total]) => {
      const tip = title[name] ? ` title="${title[name]}"` : "";
      const cls = [total ? "total" : "", name === "travel" ? "sub" : ""].filter(Boolean).join(" ");
      return `<tr${cls ? ` class="${cls}"` : ""}><td${tip}>${name}</td><td>${value}</td></tr>`;
    })
    .join("");
  return `<div class="stages"><div class="meta">Slice stages</div><table class="stages">${body}</table></div>`;
}

export function estimateHtml() {
  const est = state.result?.estimate;
  if (!est) return `<div class="meta">Slice to compare minutes and grams.</div>`;
  const groups = groupFeatures(est.byFeature ?? [], state.profile);
  const total = Math.max(0.001, est.seconds);
  const rows = groups.map((row) => `<tr><td>${row.label}</td><td>${row.seconds.toFixed(0)} s</td><td>${row.grams.toFixed(2)} g</td><td><div class="bar"><span style="width:${Math.min(100, (row.seconds / total) * 100)}%"></span></div></td></tr>`).join("");
  const meters = (est.filamentMm / 1000).toFixed(2);
  const grams = filamentGrams(est.filamentMm, state.profile);
  const cost = filamentCost(grams, state.profile).toFixed(2);
  return `
    <div class="meta"><b>${formatTime(est.seconds)}</b> · <b id="estGrams">${grams.toFixed(2)} g</b> · ${meters} m · €<span id="estCost">${cost}</span></div>
    <div class="meta">Filament €${state.profile.filamentCostPerKg.toFixed(2)} / kg from the printer profile.</div>
    <table class="est">${rows}</table>
    <div class="chips">${chips()}</div>
    <div class="meta">${est.arcMoves} arcs · ${est.retracts ?? 0} retracts · ${(est.travelMm ?? 0).toFixed(0)} mm travel · ${est.scarfedLoops ?? 0} scarfed loops</div>
  `;
}

export function isStepName(name: string) {
  return /\.(step|stp)$/i.test(name);
}

export function needsEngine(name: string) {
  return /\.(3mf|step|stp)$/i.test(name);
}

export function objectList() {
  if (!state.placed) return `<div class="meta">Drop an STL, 3MF, or STEP file, or open a sample.</div>`;
  const bedX = state.profile.bedX;
  const bedY = state.profile.bedY;
  const bedZ = state.profile.bedZ;
  const rows = state.plate.objects.length > 0
    ? state.plate.objects.map((obj) => ({ obj, part: placeObject(obj, bedX, bedY) }))
    : [];
  const pairs = overlapPairs(rows.map(({ obj, part }) => ({ id: obj.id, name: obj.name, bounds: part.bounds })));
  const many = rows.length > 1;
  const list = rows.map(({ obj, part }) => {
    const notes = offBed(part.bounds, bedX, bedY, bedZ);
    const selected = obj.id === state.plate.selectedId;
    return `
      <div class="obj obj-row" role="listitem" data-plate-id="${escapeHtml(obj.id)}" data-selected="${selected ? "true" : "false"}">
        <button class="obj-select" type="button" data-plate-select="${escapeHtml(obj.id)}" aria-pressed="${selected ? "true" : "false"}">
          <b>${escapeHtml(obj.name)}</b>
          <span>${triangleLine(part.positions.length / 9)} · ${boundsSize(part.bounds)} mm${notes.length ? ` · ${escapeHtml(notes.join("; "))}` : ""}</span>
        </button>
        ${many ? `<button class="btn" type="button" data-plate-remove="${escapeHtml(obj.id)}" aria-label="Remove ${escapeHtml(obj.name)}">Remove</button>` : ""}
      </div>`;
  }).join("");
  const selected = selectedObject(state.plate);
  const selectedPart = selected ? placeObject(selected, bedX, bedY) : state.placed;
  const b = selectedPart.bounds;
  const cx = ((b.min[0] + b.max[0]) / 2).toFixed(1);
  const cy = ((b.min[1] + b.max[1]) / 2).toFixed(1);
  const z0 = b.min[2].toFixed(1);
  const selectedNotes = offBed(b, bedX, bedY, bedZ);
  const overlap = pairs.map((pair) => pair.line).join("; ");
  return `
    <div role="list">${list || `<div class="obj" role="listitem"><b>${escapeHtml(state.mesh?.name ?? "part")}</b><span>${triangleLine(state.placed.positions.length / 9)} · ${boundsSize(state.placed.bounds)} mm</span></div>`}</div>
    <div class="row">
      <button class="btn" id="plateAdd" type="button">Add object</button>
      <button class="btn" id="plateDuplicate" type="button">Duplicate</button>
      <button class="btn" id="plateArrange" type="button" ${many ? "" : "disabled"}>Arrange</button>
      <button class="btn" id="center" type="button">Center</button>
      <button class="btn" id="layflat" type="button">Lay flat</button>
      <button class="btn" id="rotX" type="button" aria-label="Rotate 90 degrees around X">Rot X</button>
      <button class="btn" id="rotY" type="button" aria-label="Rotate 90 degrees around Y">Rot Y</button>
      <button class="btn" id="rotZ" type="button" aria-label="Rotate 90 degrees around Z">Rot Z</button>
      <button class="btn" id="export3mf" type="button">Export 3MF</button>
    </div>
    <label class="field setting" data-label="scale %" data-keywords="placement size percent">Scale %<input id="partScale" type="number" min="10" max="400" step="5" value="${Math.round(state.partScale * 100)}" /></label>
    ${isStepName(state.mesh?.name ?? "") ? num("stepTol", "STEP chord mm", state.stepTolerance, 0.01, 2, 0.01) : ""}
    ${overlap ? `<div class="meta warn-text" id="plateOverlap">${escapeHtml(overlap)}</div>` : ""}
    ${selectedNotes.length ? `<div class="meta warn-text">${selectedNotes.join("; ")}</div>` : `<div class="meta">On the ${bedX}×${bedY}×${bedZ} mm bed.</div>`}
    <div class="place-xy">
      <label class="field setting" data-label="position x" data-keywords="placement move bed offset">X mm<input id="placeX" type="number" step="1" value="${cx}" aria-label="Position X" /></label>
      <label class="field setting" data-label="position y" data-keywords="placement move bed offset">Y mm<input id="placeY" type="number" step="1" value="${cy}" aria-label="Position Y" /></label>
    </div>
    <div class="meta" id="placeReadout">X ${cx} · Y ${cy} · bed Z ${z0} mm</div>
    <div class="meta">Gizmo sits at the left and edits the selected object. Drag a ring to rotate. Drag the part or an arrow to move. Shift snaps 15° or 1 mm.</div>
  `;
}

export function profileFields() {
  const p = state.profile;
  return `
    ${machineSectionHtml(loadMachineLibrary(), { pressureAdvance: state.pressureAdvance, nozzleTemp: p.nozzleTemp, bedTemp: p.bedTemp })}
    ${num("nozzle", "Nozzle mm", p.nozzleDiameter, 0.15, 1.2, 0.05, "simple")}
    ${num("bedx", "Bed X mm", p.bedX, 50, 1000, 1, "simple")}
    ${num("bedy", "Bed Y mm", p.bedY, 50, 1000, 1, "simple")}
    ${num("bedz", "Bed Z mm", p.bedZ, 20, 1000, 1, "simple")}
    ${num("vol", "Max flow mm³/s", p.maxVolumetricMm3S, 1, 60, 0.5, "advanced")}
    ${num("accel", "Max accel mm/s²", p.maxAccel, 100, 20000, 100, "advanced")}
    ${num("density", "Density g/cm³", p.filamentDensityGCm3, 0.8, 2.5, 0.01, "advanced")}
    ${num("cost", "Filament €/kg", p.filamentCostPerKg, 0, 200, 1, "advanced")}
    <div class="row">
      <button class="btn" id="profileExport" type="button">Export JSON</button>
      <label class="btn file">Import JSON<input id="profileImport" type="file" accept="application/json,.json" /></label>
    </div>
    ${prusaFieldsHtml(loadPrusaLink(), prusaSummary())}
  `;
}

export function paretoHtml() {
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

export function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

export function chips() {
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

export function pct(value: number, base: number) {
  if (base <= 1e-6) return 0;
  return ((value - base) / base) * 100;
}

export function signed(n: number) {
  const v = n.toFixed(0);
  return n > 0 ? `+${v}%` : `${v}%`;
}

function profileHeaderHtml() {
  const library = loadProfileLibrary();
  const selected = displayId(library, currentPreset(), loadSettingsLevel());
  const options = library.profiles
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === selected ? " selected" : ""}>${escapeHtml(profile.name)}</option>`)
    .join("");
  return `
    <div class="profile-row">
      <select id="profilePick" aria-label="Settings profile">
        <option value="">Current</option>
        ${options}
      </select>
      <button class="btn history-btn" id="profileSave" type="button">Save</button>
      <details class="profile-more">
        <summary class="btn history-btn" aria-label="Profile actions">More</summary>
        <div class="profile-actions">
          <input id="profileName" type="text" aria-label="Profile name" placeholder="Profile name" />
          <button class="btn history-btn" id="profileRename" type="button">Rename</button>
          <button class="btn history-btn" id="profileDuplicate" type="button">Duplicate</button>
          <button class="btn history-btn" id="profileDelete" type="button">Delete</button>
          <button class="btn history-btn" id="settingsProfileExport" type="button">Export</button>
          <label class="btn history-btn file">Import<input id="profileFile" type="file" accept=".limeprofile.json,application/json" /></label>
        </div>
      </details>
    </div>`;
}

export function currentPreset(): PresetSettings {
  const out = { ...DEFAULT_PRESET };
  for (const key of presetKeys()) {
    (out as unknown as Record<string, unknown>)[key] = (state as unknown as Record<string, unknown>)[key];
  }
  return out;
}

export function presetHtml() {
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

export function applyPreset(next: PresetSettings) {
  noteEdit();
  for (const key of presetKeys()) {
    (state as unknown as Record<string, unknown>)[key] = next[key];
  }
  state.splitCustom = true;
  if (state.blendKind === "byRegion") fx.realignSplit("open");
  touch();
}

export function paintPresetDiff() {
  const node = document.querySelector("#presetDiff");
  if (!node) return;
  const diff = diffPreset(currentPreset());
  node.innerHTML = `<b>Vs default</b><br>${diff.length ? diff.map((line) => escapeHtml(line)).join("<br>") : "Matches the default preset."}`;
}

function restoreFindCaret(focused: boolean, selStart: number | null, selEnd: number | null) {
  if (!focused) return;
  const next = document.querySelector<HTMLInputElement>("#find");
  if (!next) return;
  next.focus({ preventScroll: true });
  const max = next.value.length;
  const start = Math.min(selStart ?? max, max);
  const end = Math.min(selEnd ?? max, max);
  next.setSelectionRange(start, end);
}

/** The panel that actually scrolls: `#left` on the desktop, the phone sheet body in compact. */
export function settingsScroller(): HTMLElement | null {
  const row = document.querySelector(".find-row");
  let node = row?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return node;
    node = node.parentElement;
  }
  return document.querySelector("#left");
}

export function syncFindStuck() {
  const row = document.querySelector(".find-row");
  const scroller = settingsScroller();
  if (!row || !scroller) return;
  const style = getComputedStyle(scroller);
  const fromTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const stickyLine = (parseFloat(style.paddingTop) || 0) + 2;
  const stuck = scroller.scrollTop > 2 && fromTop <= stickyLine;
  row.classList.toggle("is-stuck", stuck);
}

export function scrollSettingsToQuery() {
  const scroller = settingsScroller();
  if (!scroller) return;
  const q = state.query.trim();
  const match = q ? document.querySelector<HTMLElement>("#left .setting:not(.hidden)") : null;
  if (!match) {
    scroller.scrollTop = 0;
  } else {
    const row = document.querySelector(".find-row");
    const gap = (row?.getBoundingClientRect().height ?? 0) + 4;
    const delta = match.getBoundingClientRect().top - scroller.getBoundingClientRect().top - gap;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }
  syncFindStuck();
}

export function focusSettingsSearch() {
  const find = document.querySelector<HTMLInputElement>("#find");
  if (!find) return;
  find.focus({ preventScroll: true });
  find.select();
}

export function clearSettingsSearch() {
  const find = document.querySelector<HTMLInputElement>("#find");
  state.query = "";
  if (find) find.value = "";
  applyFilter();
  scrollSettingsToQuery();
}

export function applyFilter() {
  const q = state.query.trim();
  document.querySelector("#left")?.classList.toggle("is-searching", !!q);
  document.querySelectorAll<HTMLElement>("#left .setting").forEach((el) => {
    const control = el.querySelector("input, select, textarea");
    const id = control instanceof HTMLElement ? control.id : "";
    const keywords = `${el.dataset.keywords ?? ""} ${SETTING_KEYWORDS[id] ?? ""}`;
    el.classList.toggle("hidden", !settingMatches(q, el.dataset.label ?? "", keywords));
  });
  document.querySelectorAll<HTMLDetailsElement>("#left .group").forEach((group) => {
    const settings = [...group.querySelectorAll<HTMLElement>(".setting")];
    const any = settings.some((el) => !el.classList.contains("hidden"));
    group.classList.toggle("hidden", !!q && settings.length > 0 && !any);
    if (q && any) group.open = true;
  });
}

export function onBlend(ev: Event) {
  noteEdit();
  markProjectDirty();
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
  if (t.id === "axis") {
    state.axis = t.value as "x" | "y";
    state.splitCustom = false;
    fx.realignSplit("axis");
    fx.syncSplitField(true);
  }
  if (t.id === "at") {
    const next = Number(t.value);
    state.atMm = Number.isFinite(next) ? next : 0;
    state.splitCustom = true;
    fx.refreshSplitNotice();
  }
  if (t.id === "price") {
    state.pricePerKg = Number(t.value) || 0;
    const est = document.querySelector("#estimate");
    if (est) est.innerHTML = estimateHtml();
    return;
  }
  markStale();
  if (t.id === "bottom" || t.id === "trans" || t.id === "at" || t.id === "axis") {
    fx.paintSlider();
    fx.draw();
    const node = document.querySelector("#resolved");
    if (node) node.innerHTML = paramTable(resolved(currentWeight(), state.layerHeight));
  }
}

export function onSettings(ev: Event) {
  const t = ev.target as HTMLInputElement;
  if (t.id === "placeX" || t.id === "placeY") return;
  if (t.id === "find") {
    state.query = t.value;
    applyFilter();
    scrollSettingsToQuery();
    return;
  }
  if (t.id === "profileName" || t.id === "profilePick" || t.id === "machineName") return;
  if (t.id === "machineStart" || t.id === "machineEnd") {
    const start = document.querySelector<HTMLTextAreaElement>("#machineStart")?.value ?? "";
    const end = document.querySelector<HTMLTextAreaElement>("#machineEnd")?.value ?? "";
    noteGcode(start, end);
    return;
  }
  if (t.id === "machinePa") {
    noteAdvance(Number(t.value) || 0, state.linearAdvance);
    markProjectDirty();
    markStale();
    return;
  }
  if (t.id === "prusaUrl" || t.id === "prusaKey" || t.id === "prusaStart") {
    rememberPrusaForm();
    return;
  }
  if (t.closest("[data-override-card]")) return;
  noteEdit();
  markProjectDirty();
  const numIds = ["lh", "amin", "amax", "pa", "la", "zhopht", "zhopmin", "scarflen", "scarfsteps", "sangle", "bangle", "tipd", "trunkd", "shmult", "pastart", "paend", "pastep", "nozzle", "bedx", "bedy", "bedz", "vol", "accel", "density", "cost", "partScale", "simperr"] as const;
  const map: Record<string, (v: number) => void> = {
    lh: (v) => { state.layerHeight = v || 0.2; },
    amin: (v) => { state.adaptiveMin = v || 0.08; },
    amax: (v) => { state.adaptiveMax = v || 0.2; },
    pa: (v) => { noteAdvance(v || 0, state.linearAdvance); },
    la: (v) => { noteAdvance(state.pressureAdvance, v || 0); },
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
    nozzle: (v) => { state.profile.nozzleDiameter = v || 0.4; noteNozzle(state.profile.nozzleDiameter); },
    bedx: (v) => { state.profile.bedX = v || 220; },
    bedy: (v) => { state.profile.bedY = v || 220; },
    bedz: (v) => { state.profile.bedZ = v || 250; },
    vol: (v) => { state.profile.maxVolumetricMm3S = v || 12; },
    accel: (v) => { state.profile.maxAccel = v || 10000; },
    density: (v) => { state.profile.filamentDensityGCm3 = v || 1.24; },
    cost: (v) => { state.profile.filamentCostPerKg = v || 0; },
    partScale: (v) => { state.partScale = (v || 100) / 100; },
    simperr: (v) => { state.simplifyError = Math.max(0, v || 0); },
  };
  if (numIds.includes(t.id as typeof numIds[number])) map[t.id](Number(t.value));
  if (t.id === "adaptive") state.adaptive = t.checked;
  if (t.id === "feeds") state.featureSpeeds = t.checked;
  if (t.id === "arcs") state.arcFit = t.checked;
  if (t.id === "combine") state.infillCombine = t.checked;
  if (t.id === "combing") state.combing = t.checked;
  if (t.id === "overhang") state.overhangControl = t.checked;
  if (t.id === "vwidth") state.variableWidth = t.checked;
  if (t.id === "simplify") state.simplify = t.checked;
  if (t.id === "travelopt") state.travelOpt = t.checked;
  if (t.id === "supports") state.supports = t.checked;
  if (t.id === "autoslice") {
    state.autoSlice = t.checked;
    paintSettingMarks(currentPreset());
    return;
  }
  if (t.id === "gyroid3d") state.gyroid3d = t.value as typeof state.gyroid3d;
  if (t.id === "zhop") state.zHop = t.value as typeof state.zHop;
  if (t.id === "seam") state.seam = t.value as typeof state.seam;
  const ironingTurnedOn = t.id === "ironing" && t.checked && !state.ironing;
  const ironingTuned = t.id === "ironflow" || t.id === "ironspeed" || t.id === "ironspace";
  if (t.id === "ironing") state.ironing = t.checked;
  if (t.id === "ironflow") state.ironingFlow = readIroningFlowPercent(t.value);
  if (t.id === "ironspeed") state.ironingSpeed = readIroningSpeed(t.value);
  if (t.id === "ironspace") state.ironingSpacing = readIroningSpacing(t.value);
  if (ironingTurnedOn || (ironingTuned && ev.type === "change" && state.ironing)) pushToast(IRONING_STORED_TOAST, "info");
  if (t.id === "scarf") state.scarfSeam = t.value as typeof state.scarfSeam;
  if (t.id === "sstyle") state.supportStyle = t.value as typeof state.supportStyle;
  if (t.id === "pafw") state.paFirmware = t.value as typeof state.paFirmware;
  if (t.id === "profileImport") {
    const file = t.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      noteEdit();
      state.profile = { ...loadProfile(), ...JSON.parse(text) } as PrinterProfile;
      state.pressureAdvance = state.profile.pressureAdvance;
      state.linearAdvance = state.profile.linearAdvance;
      saveProfile(state.profile);
      fx.prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
      touch();
    }).catch(fx.fail);
    return;
  }
  const profileIds = ["nozzle", "bedx", "bedy", "bedz", "vol", "accel", "density", "cost"];
  if (profileIds.includes(t.id)) {
    state.profile.pressureAdvance = state.pressureAdvance;
    state.profile.linearAdvance = state.linearAdvance;
    saveProfile(state.profile);
    if (t.id === "density" || t.id === "cost") {
      paintEstimate();
      return;
    }
    if (!["bedx", "bedy", "bedz"].includes(t.id)) {
      markStale();
      return;
    }
    fx.prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
    fx.view3d.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
    fx.applyPlace(false);
    return;
  }
  if (t.id === "partScale") {
    fx.applyPlace(false);
    return;
  }
  if (t.id === "stepTol") {
    const value = Number(t.value);
    state.stepTolerance = Number.isFinite(value) ? value : 0.1;
    window.clearTimeout(session.stepTimer);
    session.stepTimer = window.setTimeout(() => { void fx.refreshStepPreview(); }, 250);
    return;
  }
  const structural = ["adaptive", "supports", "zhop", "scarf", "gyroid3d", "ironing"].includes(t.id);
  if (structural) renderChrome();
  markStale();
}

export function touch() {
  markProjectDirty();
  state.notice = "";
  renderChrome();
  fx.draw();
  fx.scheduleAuto();
}

export function markStale() {
  const sliceBtn = document.querySelector<HTMLButtonElement>("#slice");
  const forceBtn = document.querySelector<HTMLButtonElement>("#force");
  const exp = document.querySelector<HTMLButtonElement>("#export");
  const isStale = stale();
  if (sliceBtn) fx.paintSliceButton(sliceBtn);
  if (forceBtn) fx.paintForceButton(forceBtn);
  if (exp) exp.disabled = !state.result || isStale || state.busy;
  const warn = staleWarning();
  document.querySelector("#stage")?.classList.toggle("stale", warn);
  paintBanner(warn);
  paintPresetDiff();
  paintSettingMarks(currentPreset());
  paintStatus(warn);
  fx.scheduleAuto();
  fx.draw();
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

export async function probe() {
  if (fx.isTauri()) {
    paintEngineLink();
    return;
  }
  const base = apiBase();
  try {
    const res = await fetch(`${base}/api/health`, { headers: authHeaders(apiToken()) });
    if (res.status === 401) markEngineDown(`Slicer engine at ${base} refused the token.`);
    else if (!res.ok) markEngineDown(engineDownMessage(base));
    else markEngineUp();
  } catch {
    markEngineDown(engineDownMessage(base));
  }
  paintBanner(staleWarning());
}
Object.assign(fx, { apiBase, apiToken, card, stale, settingsHash, blend, currentWeight, renderChrome, markEngineDown, markEngineUp, paintEngineLink, paintStatus, markBusy, busyText, bannerLine, toastTransient, takeTransient, paintBanner, group, num, check, select, cardBtn, blendFields, paramLine, paramTable, layerReadout, triangleLine, triangleMeta, formatMs, stageHtml, estimateHtml, isStepName, needsEngine, objectList, profileFields, paretoHtml, formatTime, chips, pct, signed, currentPreset, presetHtml, applyPreset, paintPresetDiff, applyFilter, onBlend, onSettings, touch, markStale, staleWarning, escapeHtml, probe });
