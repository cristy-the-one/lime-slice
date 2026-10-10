import { ArrowDownToLine, Copy, Crosshair, LayoutGrid, Plus, RotateCw, createElement, type IconNode } from "lucide";
import { fx } from "./fx";
import { state, session, type CardId, type SliceResponse } from "./state";
import { currentApiTarget, authHeaders, engineDownMessage } from "../ui/api-base";
import { layerWeight, resolved, type ResolvedCard } from "../strategy";
import { paintSettingMarks, syncEmptyState } from "../ui/shell";
import { pushToast } from "../ui/toasts";
import { markProjectDirty } from "../project-dirty";
import { coverageWarning, inAirWarning } from "../slice-action";
import { applySliceProgress, currentSliceProgress } from "../ui/slice-progress";
import { filamentCost, filamentGrams, groupFeatures } from "../estimate";
import { OTHER_COLOR, featureColor } from "../colors";
import { offBed } from "../mesh-place";
import { boundsSize, overlapPairs, placeObject, selectedObject, setSelectedOverride, settingsEmpty } from "../plate";
import { type PresetSettings, DEFAULT_PRESET, presetKeys } from "../presets";
import { saveProfile } from "../profiles";
import { noteAdvance, noteFirmware, noteFlow, noteGcode, noteRetract, setSmartSupports } from "./machine-actions";
import { currentRules } from "./rules";
import { ADVANCE, orderFields, type Rules } from "../settings-rules";
import { loadMachineLibrary } from "./machine-library";
import { beltStamp, machineChipLabel, machinePickHtml, machineSectionHtml } from "../ui/machine-library";
import { prusaSummary, rememberPrusaForm, syncSendButtons } from "./prusa-actions";
import { noteEdit } from "./history";
import { loadProfileLibrary } from "./profile-library";
import { settingMatches } from "../ui/settings-search";
import { displayId } from "../ui/settings-profiles";
import { OVERRIDES_TIP, overrideSectionHtml } from "../ui/overrides-panel";
import { fuzzyRequest } from "../fuzzy-skin";
import { ironingRequest, ironingSpacingMax } from "../ironing";
import { levelSelectHtml, loadClosedGroups, loadSettingsLevel, saveClosedGroups, setSettingsLevel } from "../ui/settings-panel";
import {
  GROUPS,
  STRATEGY_ROWS,
  controlById,
  controlsOf,
  isStructural,
  keywordsOf,
  resolveMax,
  resolveOptions,
  shownAtLevel,
  strategyCard,
  type ControlSpec,
  type GroupSpec,
  type SchemaContext,
  type Tier,
} from "../ui/settings-schema";
import { chordGlyphs, keyOf } from "../ui/commands";

export function apiBase() {
  return currentApiTarget().base;
}

export function apiToken() {
  return currentApiTarget().token;
}

export function card(): CardId {
  return strategyCard(state);
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
  const { result: _r, slicedHash: _h, busy: _b, progress: _p, error: _e, notice: _n, engine: _g, hidden: _hid, layer: _l, rangeLow: _lo, viewMode: _v, query: _q, showTravel: _t, colorMode: _c, paBands: _pb, paGcode: _pg, flowBands: _fb, flowGcode: _fg, tempBands: _tb, tempGcode: _tg, retractBands: _rb, retractGcode: _rg, retractStart: _rs, retractEnd: _re, retractStep: _rp, retractOn: _ron, retractLength: _rl, retractSpeed: _rsp, printOrder: _printOrder, sequentialClearance: _sequentialClearance, sequentialGantry: _sequentialGantry, pricePerKg: _price, move: _mv, stage: _st, playing: _play, sourcePos: _sp, placed: _pl, pareto: _pa, help: _hp, splitCustom: _sc, poseHud: _ph, offset: _off, bedOpacity: _bo, sectionOn: _so, sectionNormal: _sn, sectionOffset: _sf, sectionHud: _sh, selectedVolumeId: _sel, modifierTool: _mt, plate: _plate, profile: _profile, ironing: _ironing, ironingFlow: _ironingFlow, ironingSpeed: _ironingSpeed, ironingSpacing: _ironingSpacing, fuzzySkin: _fuzzy, fuzzyThickness: _fuzzyThickness, fuzzyPointDistance: _fuzzyDistance, ...rest } = state;
  // Price and density only weigh the estimate, which the UI computes from the reply.
  const { filamentDensityGCm3: _density, filamentCostPerKg: _cost, ...profile } = state.profile;
  // Ironing counts as it is sent, so a number changed while it is off stales nothing.
  const ironing = ironingRequest({ on: state.ironing, flow: state.ironingFlow, speed: state.ironingSpeed, spacing: state.ironingSpacing });
  // Fuzzy skin counts as it is sent, so a number changed while it is off stales nothing.
  const fuzzy = fuzzyRequest({ on: state.fuzzySkin, thickness: state.fuzzyThickness, pointDistance: state.fuzzyPointDistance });
  // A cartesian printer leaves this off, so its hash is the one it had before belt profiles.
  const library = loadMachineLibrary();
  const belt = beltStamp(library);
  // Hidden controls and the advance the firmware does not use are not part of the recipe.
  const rules = currentRules(library);
  const retract = state.retractOn ? { retractLength: state.retractLength, retractSpeed: state.retractSpeed } : {};
  const order = orderFieldsOf(rules);
  const objectSettings = state.plate.objects
    .filter((obj) => !settingsEmpty(obj.settings))
    .map((obj) => `${obj.id}:${JSON.stringify(obj.settings)}`)
    .join("|");
  const hashed = { mesh, profile: rules.coerce(profile), rest: rules.coerce(rest), ...ironing, ...fuzzy, ...retract, ...order, ...(belt ? { belt } : {}), ...(objectSettings ? { objectSettings } : {}) };
  if (state.plate.objects.length > 1) {
    return JSON.stringify({
      ...hashed,
      plate: state.plate.objects.map((obj) => `${obj.id}:${obj.partScale}:${obj.offset.x.toFixed(3)},${obj.offset.y.toFixed(3)},${obj.offset.z.toFixed(3)}:${obj.orient.join(",")}:${obj.sourcePos.length}`).join("|"),
    });
  }
  return JSON.stringify(hashed);
}


function orderFieldsOf(rules: Rules) {
  return orderFields(rules, { printOrder: state.printOrder, clearanceMm: state.sequentialClearance, gantryMm: state.sequentialGantry });
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

/** Stores the typed text of the focused field now, ahead of its `change`, which then finds the value stored and does nothing. True when it stored one. */
export function commitTypedFields(typing = typedField()): boolean {
  if (!typing || !commitTypedField(typing)) return false;
  markProjectDirty();
  return true;
}

function schemaContext(rules: Rules = currentRules()): SchemaContext {
  return { belt: rules.belt, lineWidth: fx.lineWidth?.() ?? state.profile.nozzleDiameter * 1.125 };
}

export function renderChrome() {
  const typing = typedField();
  // The change that would have queued the auto slice does nothing now, so it is queued here, as `touch` would.
  if (commitTypedFields(typing)) fx.scheduleAuto();
  const result = state.result;
  const rules = currentRules();
  const ctx = schemaContext(rules);
  const find = document.querySelector<HTMLInputElement>("#find");
  const findFocused = find != null && document.activeElement === find;
  const selStart = find?.selectionStart ?? null;
  const selEnd = find?.selectionEnd ?? null;
  document.querySelector("#leftBody")!.innerHTML = `
    <div class="panel-head">
      ${profileHeaderHtml()}
      <div class="find-row">
        <div class="find-box">
          <input id="find" type="search" placeholder="Search settings" aria-label="Search settings" value="${escapeHtml(state.query)}" />
          <kbd aria-hidden="true">/</kbd>
        </div>
        ${levelSelectHtml()}
      </div>
    </div>
    ${GROUPS.map((group) => groupCardHtml(group, rules, ctx)).join("")}
  `;
  restoreFindCaret(findFocused, selStart, selEnd);
  if (typing) document.querySelector<HTMLInputElement>(`#${typing.id}`)?.focus({ preventScroll: true });
  applyFilter();
  syncFindStuck();

  const live = resolved(currentWeight(), state.layerHeight);
  const section = (title: string, body: string, tier?: Tier) => `<section class="res"${tier ? ` data-level="${tier}"` : ""}><h4>${title}</h4>${body}</section>`;
  document.querySelector("#right")!.innerHTML = `
    ${result ? section("Estimate", `<div id="estimate">${estimateHtml()}</div>`) : ""}
    ${result ? section("Active layer", `<div class="meta" id="layerReadout">${layerReadout()}</div>`) : ""}
    ${rules.hidden.has("blendCompare") ? "" : section("Compare blends", `<div id="pareto"${state.mesh ? "" : ' class="is-off"'}>${paretoHtml()}</div>`)}
    ${section("Resolved parameters", `<div class="meta" id="resolved">${paramTable(live)}</div>`, "advanced")}
    ${result ? section("Diagnostics", `<div class="meta">${triangleMeta(result)}</div>${stageHtml(result)}`, "expert") : ""}
  `;

  paintPrinterChip();
  paintCalibrate();
  const auto = document.querySelector<HTMLInputElement>("#autoslice");
  if (auto) auto.checked = state.autoSlice;
  const isStale = stale();
  const sliceBtn = document.querySelector<HTMLButtonElement>("#slice")!;
  fx.paintSliceButton(sliceBtn);
  fx.paintForceButton(document.querySelector<HTMLButtonElement>("#force")!);
  sliceBtn.disabled = state.busy || !state.mesh;
  document.querySelector<HTMLButtonElement>("#cancel")!.hidden = !state.busy;
  paintExport(document.querySelector("#export"), isStale);
  syncSendButtons();
  document.querySelector("#timing")!.textContent = timingText();
  const warn = staleWarning();
  document.querySelector("#stage")!.classList.toggle("stale", warn);
  paintBanner();
  fx.paintLegend();
  fx.paintSlider();
  fx.paintSpark();
  fx.paintPlayback();
  fx.paintGcode();
  paintEngineLink();
  paintSettingMarks(currentPreset());
  syncEmptyState(!!state.mesh);
  session.supportUi?.refresh();
  fx.syncPreviewPending?.();
}

function timingText() {
  const result = state.result;
  if (state.busy) return busyText();
  if (!result) return "";
  const grams = shownGrams(result);
  return `${formatTime(result.estimate?.seconds ?? 0)} · ${grams.toFixed(2)} g · €${filamentCost(grams, state.profile).toFixed(2)}`;
}

type Band = { index: number; z0: number; z1: number };

function bandLines<T extends Band>(bands: T[], value: (band: T) => string): string {
  if (bands.length === 0) return "";
  return `<div class="meta">${bands.map((b) => `band ${b.index}: ${value(b)} · Z ${b.z0.toFixed(2)}–${b.z1.toFixed(2)}`).join("<br>")}</div>`;
}

function plainRow(id: string, label: string, value: number, min: number, max: number, step: number) {
  return `<label class="row"><span class="row-label">${label}</span><input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
}

function calSection(title: string, help: string, fields: string[], generate: { id: string; label: string }, result: string) {
  return `<section class="cal">
    <h3>${title}</h3>
    <p class="cal-help">${escapeHtml(help)}</p>
    ${fields.map(fieldRow).join("")}
    <div class="row-tools"><button class="btn" id="${generate.id}" type="button">${generate.label}</button></div>
    ${result}
  </section>`;
}

function calibrateHtml() {
  const rules = currentRules();
  const chosenK = state[ADVANCE[rules.firmware].key];
  return [
    calSection("Pressure advance", "Each band prints at one K. Pick the band whose corners are sharpest, then save that K to the filament.", ["pastart", "paend", "pastep"], { id: "pacal", label: "Generate PA test" },
      state.paBands.length ? `${bandLines(state.paBands, (b) => `K ${b.k.toFixed(4)}`)}${plainRow("pachosen", "Chosen K", chosenK, 0, 2, 0.005)}<div class="row-tools"><button class="btn" id="paapply" type="button">Save K to profile</button><button class="btn" id="paexport" type="button">Export PA G-code</button></div>` : ""),
    calSection("Flow", "Each band is one hollow wall at one multiplier. Measure the wall; the band that matches the line width is the flow. 1 leaves a slice unchanged.", ["flowstart", "flowend", "flowstep"], { id: "flowcal", label: "Generate flow test" },
      state.flowBands.length ? `${bandLines(state.flowBands, (b) => `flow ${b.flow.toFixed(3)}`)}${plainRow("flowchosen", "Chosen flow", state.flow, 0.5, 1.5, 0.01)}<div class="row-tools"><button class="btn" id="flowapply" type="button">Save flow to filament</button><button class="btn" id="flowexport" type="button">Export flow G-code</button></div>` : ""),
    calSection("Temperature", "Each band is one hollow wall; the nozzle waits at that band's temperature before it starts. Saving writes the chosen °C onto the filament.", ["tempstart", "tempend", "tempstep"], { id: "tempcal", label: "Generate temperature test" },
      state.tempBands.length ? `${bandLines(state.tempBands, (b) => `${b.temp.toFixed(0)} °C`)}${plainRow("tempchosen", "Chosen °C", state.profile.nozzleTemp, 150, 320, 1)}<div class="row-tools"><button class="btn" id="tempapply" type="button">Save temperature to filament</button><button class="btn" id="tempexport" type="button">Export temperature G-code</button></div>` : ""),
    calSection("Retraction", "Each band is two posts; the travel between them retracts by that band's length. Saving writes the length onto the filament, and the speed when it is not 30 mm/s.", ["retractstart", "retractend", "retractstep"], { id: "retractcal", label: "Generate retraction test" },
      state.retractBands.length ? `${bandLines(state.retractBands, (b) => `${b.length.toFixed(3)} mm`)}${plainRow("retractchosen", "Chosen length mm", state.retractLength, 0, 5, 0.05)}<div class="row-tools"><button class="btn" id="retractapply" type="button">Save retraction to filament</button><button class="btn" id="retractexport" type="button">Export retraction G-code</button></div>` : ""),
  ].join("");
}

function paintCalibrate() {
  const body = document.querySelector("#calibrateBody");
  if (!body) return;
  const typing = document.activeElement instanceof HTMLInputElement && body.contains(document.activeElement) ? document.activeElement.id : "";
  body.innerHTML = calibrateHtml();
  if (typing) document.querySelector<HTMLInputElement>(`#${typing}`)?.focus({ preventScroll: true });
}

export function setCalibrate(open: boolean) {
  const sheet = document.querySelector<HTMLElement>("#calibrate");
  if (!sheet) return;
  sheet.hidden = !open;
  if (open) {
    document.documentElement.dataset.overlay = "calibrate";
    sheet.querySelector<HTMLElement>("input, button")?.focus();
  } else if (document.documentElement.dataset.overlay === "calibrate") {
    delete document.documentElement.dataset.overlay;
  }
}

function paintPrinterChip() {
  const library = loadMachineLibrary();
  const label = document.querySelector("#printerChipLabel");
  if (label) label.textContent = machineChipLabel(library);
  const pick = document.querySelector("#printerPick");
  if (pick) pick.innerHTML = machinePickHtml(library);
}

/** Open the Printer details group and scroll to it. Simple has no such group, so it steps up to Advanced. */
export function revealPrinterDetails() {
  if (loadSettingsLevel() === "simple") {
    setSettingsLevel("advanced");
    applyFilter();
  }
  if (closedGroups.has("printer")) noteGroupToggle("printer", true);
  const group = document.querySelector<HTMLDetailsElement>('#left .group[data-group="printer"]');
  if (!group) return;
  group.open = true;
  if (window.innerWidth <= 960) document.querySelector(".workspace")?.classList.add("show-left");
  group.scrollIntoView({ block: "start", behavior: "smooth" });
}

/** Show the results panel where the layout hides it, and scroll it to the estimate. */
export function revealResults() {
  const workspace = document.querySelector(".workspace");
  if (workspace?.classList.contains("is-right-collapsed")) document.querySelector<HTMLButtonElement>(".panel-collapse-right")?.click();
  if (window.innerWidth <= 960) workspace?.classList.add("show-right");
  const right = document.querySelector<HTMLElement>("#right");
  if (right) right.scrollTop = 0;
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
  el.removeAttribute("data-tip");
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
  el.removeAttribute("title");
  el.dataset.tip = "Engine connected";
}

export function markBusy(recompute: boolean) {
  state.busy = true;
  state.progress = 0;
  session.busySince = performance.now();
  session.busyRecompute = recompute;
  session.busyPhase = recompute ? "" : "Loading…";
  session.liveProgress = false;
  const mine = session.busySince;
  const tick = window.setInterval(() => {
    if (!state.busy || session.busySince !== mine) {
      window.clearInterval(tick);
      return;
    }
    document.querySelector("#timing")!.textContent = busyText();
    applySliceProgress(sliceSample(), session.liveProgress ? session.busyPhase : "");
  }, 100);
}

function sliceSample() {
  return currentSliceProgress(state.progress, Math.max(0, performance.now() - session.busySince), session.liveProgress);
}

export function busyText() {
  return `${session.busyPhase || "Slicing…"} ${((performance.now() - session.busySince) / 1000).toFixed(1)} s`;
}

/** `action` adds a button to the line; the click is read from `data-banner-action`. */
export function bannerLine(text: string, cls = "", alert = false, action?: { id: string; label: string }) {
  const kind = `${cls ? ` ${cls}` : ""}${action ? " has-action" : ""}`;
  const role = alert ? ` role="alert"` : "";
  const safe = escapeHtml(text);
  const button = action ? `<button class="btn banner-action" type="button" data-banner-action="${action.id}">${escapeHtml(action.label)}</button>` : "";
  return `<div class="banner${kind}"${role} title="${safe}"><span class="banner-text">${safe}</span>${button}</div>`;
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
  if (state.error && TRANSIENT_ERRORS.has(state.error)) {
    toastTransient(state.error, "error");
    state.error = "";
  }
}

export function paintBanner() {
  takeTransient();
  const rail = document.querySelector("#banner")!;
  const bits: string[] = [];
  if (state.engine) bits.push(bannerLine(state.engine));
  if (state.error) bits.push(bannerLine(state.error, "", true));
  if (state.notice) bits.push(bannerLine(state.notice, "warn"));
  if (state.result && !state.result.sanity.ok) bits.push(bannerLine(state.result.sanity.notes.join(" ") || "G-code checks failed"));
  const objects = state.result?.objects;
  const unheld = coverageWarning(objects ? objects.flatMap((o) => o.coverage) : (state.result?.coverage ?? []));
  if (unheld) bits.push(bannerLine(unheld, "warn"));
  const air = objects?.map((o) => o.inAir).filter((a) => !!a);
  const floating = inAirWarning(
    air?.length ? { islands: air.reduce((n, a) => n + a!.islands, 0), overhangs: air.reduce((n, a) => n + a!.overhangs, 0) } : state.result?.inAir,
  );
  if (floating) bits.push(bannerLine(floating, "warn", false, { id: "supports", label: "Turn on supports" }));
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

// Group cards

/** Groups the user closed, kept across sessions. */
export const closedGroups = loadClosedGroups(GROUPS.filter((group) => group.closed).map((group) => group.id));

export function noteGroupToggle(id: string, open: boolean) {
  if (open) closedGroups.delete(id);
  else closedGroups.add(id);
  saveClosedGroups(closedGroups);
}

function groupCardHtml(group: GroupSpec, rules: Rules, ctx: SchemaContext): string {
  const body = controlsOf(group.id).map((spec) => controlHtml(spec, rules, ctx)).join("");
  const hidden = group.id === "objects" && !state.placed ? " hidden" : "";
  return `<details class="group" data-group="${group.id}" data-level="${group.tier}" style="--hue: var(${group.accent})"${closedGroups.has(group.id) ? "" : " open"}${hidden}>
    <summary class="group-head"><span class="group-tick" aria-hidden="true"></span><span class="group-title">${escapeHtml(group.title)}</span><span class="group-sum">${escapeHtml(group.summary(state, ctx))}</span><span class="group-chev" aria-hidden="true"></span></summary>
    <div class="group-body">${body}</div>
  </details>`;
}

const CUSTOM: Record<string, () => string> = {
  strategyRows: strategyRowsHtml,
  objectTools: objectToolsHtml,
  objectList: objectListHtml,
  objectPlace: objectPlaceHtml,
  objectOverrides: () => {
    const selected = selectedObject(state.plate);
    return selected ? objectOverrideFields(selected) : "";
  },
  printOrderFields: () => printOrderFields(currentRules()),
  modifiers: () => `<div class="subhead" data-tip="${escapeHtml(OVERRIDES_TIP)}">Modifiers</div>${overrideSectionHtml(state.overrides, state.selectedVolumeId, state.modifierTool)}`,
  seamTools: () => toolRow([{ id: "seamPaintBtn", tool: "seam", label: "Paint seam", command: "paint-seam" }]),
  supportTools: () => toolRow([
    { id: "paintSupportsBtn", tool: "paint", label: "Paint", command: "paint-supports" },
    { id: "editTreesBtn", tool: "supports", label: "Edit trees", command: "edit-supports" },
  ]),
  machine: machineHtml,
};

function controlHtml(spec: ControlSpec, rules: Rules, ctx: SchemaContext): string {
  if (spec.rule && rules.hidden.has(spec.rule)) return "";
  if (spec.when && !spec.when(state)) return "";
  if (spec.kind.type === "custom") {
    const body = CUSTOM[spec.id]?.() ?? "";
    return body ? `<div class="slot" data-slot="${spec.id}" data-level="${spec.tier}">${body}</div>` : "";
  }
  const value = spec.get!(state);
  const attrs = `data-level="${spec.tier}" data-label="${escapeHtml(spec.label.toLowerCase())}"${spec.keywords ? ` data-keywords="${escapeHtml(spec.keywords)}"` : ""}${tipAttr(spec.tip)}`;
  const cls = `row setting${spec.parent ? " sub" : ""}`;
  const label = `<span class="row-label">${escapeHtml(spec.label)}</span>`;
  if (spec.kind.type === "check") {
    return `<label class="${cls}" ${attrs}>${label}<input id="${spec.id}" type="checkbox" class="switch" role="switch" ${value ? "checked" : ""}/></label>`;
  }
  if (spec.kind.type === "select") {
    const options = resolveOptions(spec.kind, ctx).map(([v, l]) => `<option value="${v}" ${v === value ? "selected" : ""}>${l}</option>`).join("");
    return `<label class="${cls}" ${attrs}>${label}<select id="${spec.id}">${options}</select></label>`;
  }
  const max = resolveMax(spec.kind, ctx);
  if (spec.kind.type === "range") {
    return `<label class="${cls} range" ${attrs} id="${spec.id}Label">${label}<output class="row-out" for="${spec.id}">${value}%</output><input id="${spec.id}" type="range" min="${spec.kind.min}" max="${max}" step="${spec.kind.step}" value="${value}" /></label>`;
  }
  return `<label class="${cls}" ${attrs}>${label}<input id="${spec.id}" type="number" min="${spec.kind.min}" max="${max}" step="${spec.kind.step}" value="${value}" /></label>`;
}

function tipAttr(tip?: string) {
  return tip ? ` data-tip="${escapeHtml(tip)}"` : "";
}

/** A field row the calibration sheet and the gear panel render outside the group cards. */
export function fieldRow(id: string): string {
  const spec = controlById(id);
  if (!spec) return "";
  return controlHtml(spec, currentRules(), schemaContext());
}

function kbdHtml(command: string): string {
  const chord = keyOf(command);
  return chord ? `<kbd>${escapeHtml(chordGlyphs(chord))}</kbd>` : "";
}

function strategyRowsHtml(): string {
  const current = card();
  return `<div class="strat-list" role="group" aria-label="Strategy">${STRATEGY_ROWS.map((row) => `
    <button class="strat" type="button" data-card="${row.id}" aria-pressed="${current === row.id}" data-tip="${escapeHtml(row.copy)}">
      <i class="strat-swatch" data-swatch="${row.id}" aria-hidden="true"></i>
      <span class="strat-name">${row.name}</span>
      <small>${escapeHtml(row.copy)}</small>
      ${kbdHtml(row.command)}
    </button>`).join("")}</div>`;
}

function icon(node: IconNode): string {
  return createElement(node, { width: 15, height: 15, "aria-hidden": "true", class: "ico" }).outerHTML;
}

function toolRow(buttons: { id: string; tool: string; label: string; command: string }[]): string {
  return `<div class="row-tools">${buttons.map((b) => `<button class="btn" id="${b.id}" type="button" data-rail-tool="${b.tool}">${escapeHtml(b.label)} ${kbdHtml(b.command)}</button>`).join("")}</div>`;
}

function objectToolsHtml(): string {
  const many = state.plate.objects.length > 1;
  const tool = (id: string, node: IconNode, tip: string, extra = "", aria = tip) =>
    `<button class="tool-btn" id="${id}" type="button" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(aria)}"${extra}>${icon(node)}</button>`;
  const spin = (axis: "X" | "Y" | "Z") =>
    `<button class="tool-btn" id="rot${axis}" type="button" data-tip="Rotate 90° around ${axis}" aria-label="Rotate 90 degrees around ${axis}">${icon(RotateCw)}<sub>${axis.toLowerCase()}</sub></button>`;
  return `<div class="obj-tools" role="toolbar" aria-label="Object tools">
    ${tool("plateAdd", Plus, "Add object")}
    ${tool("plateDuplicate", Copy, "Duplicate")}
    ${tool("plateArrange", LayoutGrid, "Arrange", many ? "" : " disabled")}
    ${tool("center", Crosshair, "Center on bed")}
    ${tool("layflat", ArrowDownToLine, "Lay flat")}
    <span class="tool-sep" aria-hidden="true"></span>
    ${spin("X")}${spin("Y")}${spin("Z")}
  </div>`;
}

export function isStepName(name: string) {
  return /\.(step|stp)$/i.test(name);
}

export function needsEngine(name: string) {
  return /\.(3mf|step|stp)$/i.test(name);
}

function plateRows() {
  const bedX = state.profile.bedX;
  const bedY = state.profile.bedY;
  const bedZ = state.profile.bedZ;
  const library = loadMachineLibrary();
  const rules = currentRules(library);
  const beltWidth = beltStamp(library)?.widthMm ?? bedX;
  const limit = (bounds: Parameters<typeof offBed>[0]) => offBed(bounds, rules.belt ? beltWidth : bedX, bedY, bedZ, rules.belt);
  const rows = state.plate.objects.map((obj) => ({ obj, part: placeObject(obj, bedX, bedY) }));
  return { rows, limit };
}

function objectListHtml(): string {
  if (!state.placed) return "";
  const { rows, limit } = plateRows();
  const pairs = overlapPairs(rows.map(({ obj, part }) => ({ id: obj.id, name: obj.name, bounds: part.bounds })));
  const many = rows.length > 1;
  const list = rows.map(({ obj, part }) => {
    const notes = limit(part.bounds);
    const selected = obj.id === state.plate.selectedId;
    return `
      <div class="obj obj-row" role="listitem" data-plate-id="${escapeHtml(obj.id)}" data-selected="${selected ? "true" : "false"}">
        <button class="obj-select" type="button" data-plate-select="${escapeHtml(obj.id)}" aria-pressed="${selected ? "true" : "false"}" data-tip="${escapeHtml(obj.name)} · ${triangleLine(obj.sourcePos.length / 9)}">
          <b>${escapeHtml(obj.name)}</b>
          <span>${boundsSize(part.bounds)} mm</span>
          ${notes.length ? `<em class="obj-note">${escapeHtml(notes.join("; "))}</em>` : ""}
        </button>
        ${many ? `<button class="btn obj-remove" type="button" data-plate-remove="${escapeHtml(obj.id)}" aria-label="Remove ${escapeHtml(obj.name)}">Remove</button>` : ""}
      </div>`;
  }).join("");
  const overlap = pairs.map((pair) => pair.line).join("; ");
  return `
    <div class="object-list" id="objectList"><div role="list">${list || `<div class="obj" role="listitem"><b>${escapeHtml(state.mesh?.name ?? "part")}</b><span>${boundsSize(state.placed.bounds)} mm</span></div>`}</div></div>
    ${overlap ? `<div class="meta warn-text" id="plateOverlap">${escapeHtml(overlap)} <button class="btn" type="button" data-plate-arrange>Arrange</button></div>` : ""}`;
}

function objectPlaceHtml(): string {
  if (!state.placed) return "";
  const { limit } = plateRows();
  const selected = selectedObject(state.plate);
  const selectedPart = selected ? placeObject(selected, state.profile.bedX, state.profile.bedY) : state.placed;
  const b = selectedPart.bounds;
  const cx = ((b.min[0] + b.max[0]) / 2).toFixed(1);
  const cy = ((b.min[1] + b.max[1]) / 2).toFixed(1);
  const z0 = b.min[2].toFixed(1);
  const selectedNotes = limit(b);
  return `
    ${selectedNotes.length ? `<div class="meta warn-text">${selectedNotes.join("; ")}</div>` : ""}
    <div class="grid3" id="placeXY" data-bed-z="${z0}">
      <label class="setting" data-label="position x" data-keywords="placement move bed offset">X mm<input id="placeX" type="number" step="1" value="${cx}" aria-label="Position X" /></label>
      <label class="setting" data-label="position y" data-keywords="placement move bed offset">Y mm<input id="placeY" type="number" step="1" value="${cy}" aria-label="Position Y" /></label>
      <label class="setting" data-label="scale %" data-keywords="placement size percent">Scale %<input id="partScale" type="number" min="10" max="400" step="5" value="${Math.round(state.partScale * 100)}" /></label>
    </div>
    ${isStepName(state.mesh?.name ?? "") ? `<label class="row setting" data-label="step chord mm" data-keywords="tessellation tolerance"><span class="row-label">STEP chord mm</span><input id="stepTol" type="number" min="0.01" max="2" step="0.01" value="${state.stepTolerance}" /></label>` : ""}
  `;
}

const SEQUENTIAL = {
  seqclear: { key: "sequentialClearance", max: 100 },
  seqgantry: { key: "sequentialGantry", max: 500 },
} as const;
type SequentialId = keyof typeof SEQUENTIAL;

const TYPED_FIELDS = ["seqclear", "seqgantry", "placeX", "placeY", "objInfill", "objWalls", "objSpeed"];

/** These commit on `change`, so a re-render while one holds typed text must commit it first and give focus back. */
function typedField(): HTMLInputElement | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement) || !TYPED_FIELDS.includes(el.id)) return null;
  return el.value === el.defaultValue ? null : el;
}

/** Commits a typed field the way its change handler does. False when nothing was stored. */
function commitTypedField(el: HTMLInputElement): boolean {
  switch (el.id) {
    case "seqclear":
    case "seqgantry":
      return noteSequential(el.id, el.value);
    case "placeX":
    case "placeY": {
      const mm = Number(el.value);
      if (!Number.isFinite(mm)) return false;
      noteEdit();
      fx.setPlaceCenter(el.id === "placeX" ? "x" : "y", mm);
      return true;
    }
    case "objInfill":
    case "objWalls":
    case "objSpeed":
      return noteObjectOverride(el.id, el.value);
    default:
      return false;
  }
}

/** Empty is 0, the engine's default. A value outside `0..max` is ignored. */
function sequentialMm(raw: string, max: number): number | undefined {
  const text = raw.trim();
  if (text === "") return 0;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > max) return undefined;
  return Math.round(n * 1000) / 1000;
}

/** Stores a typed clearance or gantry height. False when it is unreadable or already stored. */
export function noteSequential(id: SequentialId, raw: string): boolean {
  const { key, max } = SEQUENTIAL[id];
  const value = sequentialMm(raw, max);
  if (value === undefined || value === state[key]) return false;
  noteEdit();
  state[key] = value;
  return true;
}

/** Stores an object's infill, walls or speed override. False when it is unreadable or already stored. */
export function noteObjectOverride(id: "objInfill" | "objWalls" | "objSpeed", raw: string): boolean {
  const text = raw.trim();
  let value: number | undefined;
  if (text !== "") {
    const n = Number(text);
    if (!Number.isFinite(n)) return false;
    if (id === "objInfill") {
      if (n < 0 || n > 100) return false;
      value = Math.round(n) / 100;
    } else if (id === "objWalls") {
      const walls = Math.round(n);
      if (walls < 1 || walls > 12) return false;
      value = walls;
    } else if (n <= 0 || n > 1000) {
      return false;
    } else {
      value = n;
    }
  }
  const key = id === "objInfill" ? "infill" : id === "objWalls" ? "walls" : "speed";
  if (!state.plate.selectedId || selectedObject(state.plate)?.settings[key] === value) return false;
  noteEdit();
  state.plate = setSelectedOverride(state.plate, key, value);
  return true;
}

function printOrderFields(rules: Rules): string {
  if (rules.hidden.has("printOrder")) return "";
  const clearance = state.sequentialClearance > 0 ? String(state.sequentialClearance) : "";
  const gantry = state.sequentialGantry > 0 ? String(state.sequentialGantry) : "";
  return `
    <label class="row setting" data-label="print order" data-keywords="sequential one at a time" data-tip="One at a time: one object finishes, including its supports, before the next starts, and the nozzle climbs above the printed ones before it moves on. Clearance is how far your toolhead reaches around the nozzle, 35 mm when empty. Gantry height is from the nozzle tip to the gantry, 20 mm when empty; only the last object may be taller. Too close or too tall is an error and no G-code."><span class="row-label">Print order</span><select id="printOrder"><option value="all-at-once"${state.printOrder === "all-at-once" ? " selected" : ""}>All at once</option><option value="sequential"${state.printOrder === "sequential" ? " selected" : ""}>One at a time</option></select></label>
    ${state.printOrder === "sequential" ? `<label class="row setting sub" data-label="sequential clearance" data-keywords="one at a time gap nozzle toolhead"><span class="row-label">Toolhead clearance mm</span><input id="seqclear" type="number" min="0" max="100" step="0.1" placeholder="35" value="${clearance}" aria-label="Sequential clearance" /></label><label class="row setting sub" data-label="sequential gantry height" data-keywords="one at a time gantry height"><span class="row-label">Gantry height mm</span><input id="seqgantry" type="number" min="0" max="500" step="0.1" placeholder="20" value="${gantry}" aria-label="Sequential gantry height" /></label>` : ""}`;
}

function objectOverrideFields(obj: NonNullable<ReturnType<typeof selectedObject>>): string {
  const infill = obj.settings.infill;
  const walls = obj.settings.walls;
  const speed = obj.settings.speed;
  const shown = (value: number | undefined) => (value === undefined ? "" : String(value));
  return `
    <div class="grid3" data-tip="Empty keeps the strategy. A height range or a modifier still wins on a field it sets.">
      <label class="setting" data-label="object infill" data-keywords="per object density percent">Infill %
        <input id="objInfill" type="number" min="0" max="100" step="5" placeholder="auto" value="${infill === undefined ? "" : String(Math.round(infill * 100))}" aria-label="Object infill percent" />
      </label>
      <label class="setting" data-label="object walls" data-keywords="per object perimeters">Walls
        <input id="objWalls" type="number" min="1" max="12" step="1" placeholder="auto" value="${shown(walls)}" aria-label="Object walls" />
      </label>
      <label class="setting" data-label="object speed" data-keywords="per object speed cap">Speed mm/s
        <input id="objSpeed" type="number" min="1" max="1000" step="5" placeholder="auto" value="${shown(speed)}" aria-label="Object speed cap" />
      </label>
    </div>`;
}

function machineHtml() {
  const p = state.profile;
  const library = loadMachineLibrary();
  const rules = currentRules(library);
  return machineSectionHtml(library, { advance: state[ADVANCE[rules.firmware].key], nozzleTemp: p.nozzleTemp, bedTemp: p.bedTemp, flow: state.flow }, rules, prusaSummary());
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
    return `Split ${state.axis.toUpperCase()} = ${state.atMm.toFixed(1)} mm<br>Low side ${paramLine(resolved(1, state.layerHeight))}<br>High side ${paramLine(resolved(0, state.layerHeight))}`;
  }
  return paramLine(card);
}

export function layerReadout() {
  const layer = state.result?.layers[state.layer];
  if (!layer) return "";
  const below = (state.result?.layers ?? []).slice(0, state.layer).reduce((s, l) => s + (l.seconds ?? 0), 0);
  return `Layer <b>${layer.index + 1}</b> / ${state.result?.layers.length}<br>Z <b>${layer.z.toFixed(2)}</b> mm · h <b>${layer.height.toFixed(3)}</b><br>Layer time <b>${(layer.seconds ?? 0).toFixed(1)}</b> s · cumulative <b>${(below + (layer.seconds ?? 0)).toFixed(1)}</b> s<br>${escapeHtml(layer.note)}`;
}

export function triangleLine(src: number) {
  return `${src} triangles`;
}

export function triangleMeta(result: SliceResponse | null) {
  if (!result) return "";
  const tol = result.mesh.outlineToleranceMm ?? 0;
  const outline = tol > 0 ? ` · outline ${tol.toFixed(3)} mm` : "";
  // An older reply has no counts, which is unknown, not zero.
  const count = (n: number | undefined) => (typeof n === "number" ? String(n) : "—");
  const repaired = count(result.mesh.repairedLayers);
  const dropped = count(result.mesh.droppedChains);
  return `Triangles <b>${result.mesh.triangles}</b>${outline}<br>Repaired layers ${repaired} · dropped chains ${dropped}`;
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

/** The feature each estimate row is colored as. */
const ROW_KIND: Record<string, string> = { "Outer wall": "outer", "Inner wall": "inner", Infill: "sparse", "Top / bottom": "top", Ironing: "ironing", Supports: "support", Travel: "travel" };

function clockTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const mm = String(h ? m : m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function estimateHtml() {
  const est = state.result?.estimate;
  if (!est) return "";
  const groups = groupFeatures(est.byFeature ?? [], state.profile);
  const longest = Math.max(0.001, ...groups.map((row) => row.seconds));
  const rows = groups.map((row) => {
    const kind = ROW_KIND[row.label];
    const color = kind ? featureColor(kind) : OTHER_COLOR;
    return `<tr><td>${row.label}</td><td><div class="bar"><span style="width:${Math.min(100, (row.seconds / longest) * 100)}%;background:${color}"></span></div></td><td>${row.seconds.toFixed(0)} s</td><td>${row.grams.toFixed(2)} g</td></tr>`;
  }).join("");
  const meters = (est.filamentMm / 1000).toFixed(2);
  const grams = filamentGrams(est.filamentMm, state.profile);
  const cost = filamentCost(grams, state.profile).toFixed(2);
  const hours = est.seconds >= 3600;
  return `
    <div class="big" data-tip="Filament €${state.profile.filamentCostPerKg.toFixed(2)} / kg from the filament.">
      <div><b>${clockTime(est.seconds)}</b><small>${hours ? "h:min:s" : "min:s"}</small></div>
      <div><b id="estGrams">${grams.toFixed(2)} g</b><small>€<span id="estCost">${cost}</span> · ${meters} m</small></div>
    </div>
    <h4 class="sub">Time by feature</h4>
    <table class="est">${rows}</table>
    <div class="chips">${chips()}</div>
    <div class="meta">${est.arcMoves} arcs · ${est.retracts ?? 0} retracts · ${(est.travelMm ?? 0).toFixed(0)} mm travel · ${est.scarfedLoops ?? 0} scarfed loops</div>
  `;
}

export function paretoHtml() {
  if (state.pareto.length === 0) {
    return `<button class="btn" id="paretoBtn" type="button" data-tip="Plots print time against grams. Bubble size is the toughness score.">Compare speed, mixes, toughness</button>`;
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
      <button class="btn" id="profileSave" type="button">Save</button>
      <details class="profile-more menu">
        <summary class="btn" aria-label="Profile actions" data-tip="Rename, duplicate, delete, export or import a profile">More</summary>
        <div class="profile-actions">
          <input id="profileName" type="text" aria-label="Profile name" placeholder="Profile name" />
          <button class="btn" id="profileRename" type="button">Rename</button>
          <button class="btn" id="profileDuplicate" type="button">Duplicate</button>
          <button class="btn" id="profileDelete" type="button">Delete</button>
          <button class="btn" id="settingsProfileExport" type="button">Export</button>
          <label class="btn file">Import<input id="profileFile" type="file" accept=".limeprofile.json,application/json" /></label>
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

export function applyPreset(next: PresetSettings) {
  noteEdit();
  for (const key of presetKeys()) {
    (state as unknown as Record<string, unknown>)[key] = next[key];
  }
  state.splitCustom = true;
  if (state.blendKind === "byRegion") fx.realignSplit("open");
  touch();
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
  const head = document.querySelector(".panel-head");
  let node = head?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return node;
    node = node.parentElement;
  }
  return document.querySelector("#left");
}

export function syncFindStuck() {
  const head = document.querySelector(".panel-head");
  const scroller = settingsScroller();
  if (!head || !scroller) return;
  const style = getComputedStyle(scroller);
  const fromTop = head.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const stickyLine = (parseFloat(style.paddingTop) || 0) + 2;
  const stuck = scroller.scrollTop > 2 && fromTop <= stickyLine;
  head.classList.toggle("is-stuck", stuck);
}

export function scrollSettingsToQuery() {
  const scroller = settingsScroller();
  if (!scroller) return;
  const q = state.query.trim();
  const match = q ? document.querySelector<HTMLElement>("#left .setting:not(.hidden)") : null;
  if (!match) {
    scroller.scrollTop = 0;
  } else {
    const head = document.querySelector(".panel-head");
    const gap = (head?.getBoundingClientRect().height ?? 0) + 4;
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

function rowTier(el: HTMLElement): Tier {
  const tier = el.dataset.level;
  return tier === "advanced" || tier === "expert" ? tier : "simple";
}

/**
 * Search rows across every tier, and in a tier hide the groups and slots with nothing left to
 * show. A search opens the groups it matches in; clearing it puts the remembered collapse back.
 */
export function applyFilter() {
  const q = state.query.trim();
  const level = loadSettingsLevel();
  const left = document.querySelector("#left");
  left?.classList.toggle("is-searching", !!q);
  const shows = (el: HTMLElement) => !el.classList.contains("hidden") && (!!q || shownAtLevel(rowTier(el), level));
  document.querySelectorAll<HTMLElement>("#left .setting").forEach((el) => {
    const control = el.querySelector("input, select, textarea");
    const id = control instanceof HTMLElement ? control.id : "";
    const keywords = `${el.dataset.keywords ?? ""} ${keywordsOf(id)}`;
    const match = settingMatches(q, el.dataset.label ?? "", keywords);
    el.classList.toggle("hidden", !match);
    el.classList.toggle("is-match", !!q && match);
  });
  document.querySelectorAll<HTMLElement>("#left .slot").forEach((slot) => {
    const settings = [...slot.querySelectorAll<HTMLElement>(".setting")];
    slot.classList.toggle("hidden", !!q && !settings.some((el) => !el.classList.contains("hidden")));
  });
  document.querySelectorAll<HTMLDetailsElement>("#left .group").forEach((group) => {
    const rows = [...group.querySelectorAll<HTMLElement>(".setting, .slot")];
    const any = q ? rows.some((el) => el.classList.contains("setting") && shows(el)) : shownAtLevel(rowTier(group), level) && rows.some(shows);
    group.classList.toggle("hidden", !any);
    if (q && any) group.open = true;
    else if (!q) group.open = !closedGroups.has(group.dataset.group ?? "");
  });
}

export function onBlend(ev: Event) {
  noteEdit();
  markProjectDirty();
  const t = ev.target as HTMLInputElement;
  if (t.id === "weight") {
    state.toughness = Number(t.value) / 100;
    const out = document.querySelector("#weightLabel .row-out");
    if (out) out.textContent = `${(state.toughness * 100).toFixed(0)}%`;
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
  }
  markStale();
  fx.paintSlider();
  fx.draw();
  const node = document.querySelector("#resolved");
  if (node) node.innerHTML = paramTable(resolved(currentWeight(), state.layerHeight));
}

/** Picks the strategy a row stands for. */
export function pickStrategy(id: CardId) {
  noteEdit();
  if (id === "speed") { state.blendKind = "single"; state.strategy = "speed"; }
  else if (id === "toughness") { state.blendKind = "single"; state.strategy = "toughness"; }
  else if (id === "efficiency") { state.blendKind = "weight"; state.toughness = 0.5; }
  else if (id === "layer") state.blendKind = "byLayer";
  else {
    state.blendKind = "byRegion";
    fx.realignSplit("open");
  }
  touch();
}

/** The number a field holds, or the factory value when the text is not one. */
function readNumber(spec: ControlSpec, raw: string): number {
  const n = Number(raw);
  const min = spec.kind.type === "number" || spec.kind.type === "range" ? spec.kind.min : 0;
  if (Number.isFinite(n) && raw.trim() !== "" && !(n === 0 && min > 0)) return n;
  const fallback = spec.preset ? DEFAULT_PRESET[spec.preset] : spec.get?.(state);
  return typeof fallback === "number" ? fallback : 0;
}

/** What follows a stored value besides a stale mark: printer profile writes, the retract store, and estimate repaints. */
function afterSet(spec: ControlSpec, value: number | boolean | string): "stale" | "done" {
  switch (spec.id) {
    case "supports":
      setSmartSupports(value as boolean);
      return "stale";
    case "retractset":
      if (value) noteRetract(state.retractLength, Math.abs(state.retractSpeed - 30) < 1e-6 ? null : state.retractSpeed);
      else noteRetract(null, null);
      return "stale";
    case "retractlen":
      noteRetract(state.retractLength, state.retractSpeed);
      return "stale";
    case "retractspd":
      noteRetract(state.retractLength, state.retractSpeed);
      return "stale";
    case "bedx":
    case "bedy":
    case "bedz":
      saveProfileFromState();
      fx.prepare.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
      fx.view3d.setBed(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
      fx.applyPlace(false);
      return "done";
    case "density":
    case "cost":
      saveProfileFromState();
      paintEstimate();
      return "done";
    case "vol":
    case "accel":
      saveProfileFromState();
      return "stale";
    case "autoslice":
      paintSettingMarks(currentPreset());
      return "done";
    default:
      return spec.group === "calibrate" ? "done" : "stale";
  }
}

function saveProfileFromState() {
  state.profile.pressureAdvance = state.pressureAdvance;
  state.profile.linearAdvance = state.linearAdvance;
  saveProfile(state.profile);
}

export function onSettings(ev: Event) {
  const t = ev.target as HTMLInputElement;
  if (!t?.id || TYPED_FIELDS.includes(t.id)) return;
  if (t.id === "find") {
    state.query = t.value;
    applyFilter();
    scrollSettingsToQuery();
    return;
  }
  if (t.id === "levelPick") {
    const level = t.value;
    if (level === "simple" || level === "advanced" || level === "expert") setSettingsLevel(level);
    markProjectDirty();
    applyFilter();
    return;
  }
  if (t.id === "profileName" || t.id === "profilePick" || t.id === "machineName") return;
  if (t.id === "machineStart" || t.id === "machineEnd") {
    const start = document.querySelector<HTMLTextAreaElement>("#machineStart")?.value ?? "";
    const end = document.querySelector<HTMLTextAreaElement>("#machineEnd")?.value ?? "";
    noteGcode(start, end);
    return;
  }
  if (t.id === "machineHost" || t.id === "machineKey" || t.id === "machineStartPrint") {
    rememberPrusaForm();
    return;
  }
  if (t.id === "machineAdvance") {
    const value = Number(t.value) || 0;
    const key = ADVANCE[currentRules().firmware].key;
    noteAdvance(key === "pressureAdvance" ? value : state.pressureAdvance, key === "linearAdvance" ? value : state.linearAdvance);
    markProjectDirty();
    markStale();
    return;
  }
  if (t.id === "machineFirmware") {
    noteFirmware(t.value);
    markProjectDirty();
    return;
  }
  if (t.id === "machineFlow") {
    noteFlow(Number(t.value));
    markProjectDirty();
    markStale();
    return;
  }
  if (t.closest("[data-override-card]")) return;
  if (t.id === "partScale") {
    noteEdit();
    markProjectDirty();
    state.partScale = (Number(t.value) || 100) / 100;
    fx.applyPlace(false);
    return;
  }
  if (t.id === "stepTol") {
    noteEdit();
    markProjectDirty();
    const value = Number(t.value);
    state.stepTolerance = Number.isFinite(value) ? value : 0.1;
    window.clearTimeout(session.stepTimer);
    session.stepTimer = window.setTimeout(() => { void fx.refreshStepPreview(); }, 250);
    return;
  }
  if (t.id === "printOrder") {
    noteEdit();
    markProjectDirty();
    state.printOrder = t.value === "sequential" ? "sequential" : "all-at-once";
    renderChrome();
    markStale();
    return;
  }
  const spec = controlById(t.id);
  if (!spec?.set) return;
  if (spec.group === "strategy") {
    onBlend(ev);
    return;
  }
  noteEdit();
  markProjectDirty();
  const value = spec.kind.type === "check" ? t.checked : spec.kind.type === "select" ? t.value : readNumber(spec, t.value);
  spec.set(state, value);
  if (t.id === "ironspace") state.ironingSpacing = Math.min(state.ironingSpacing, ironingSpacingMax(fx.lineWidth()));
  const next = afterSet(spec, value);
  if (next === "done") return;
  if (isStructural(t.id)) renderChrome();
  markStale();
}

export function touch() {
  markProjectDirty();
  state.notice = "";
  renderChrome();
  fx.draw();
  fx.scheduleAuto();
}

/** Export is on whenever a mesh is loaded. Without a current slice it slices first, then saves. */
function paintExport(button: HTMLButtonElement | null, isStale: boolean) {
  if (!button) return;
  const current = !!state.result && !isStale;
  button.disabled = !state.mesh || state.busy;
  button.dataset.slice = current ? "current" : "first";
  button.dataset.tip = current ? "Save G-code" : "Slice, then save G-code";
}

export function markStale() {
  const sliceBtn = document.querySelector<HTMLButtonElement>("#slice");
  const forceBtn = document.querySelector<HTMLButtonElement>("#force");
  const exp = document.querySelector<HTMLButtonElement>("#export");
  const isStale = stale();
  if (sliceBtn) fx.paintSliceButton(sliceBtn);
  if (forceBtn) fx.paintForceButton(forceBtn);
  paintExport(exp, isStale);
  syncSendButtons();
  const warn = staleWarning();
  document.querySelector("#stage")?.classList.toggle("stale", warn);
  paintBanner();
  paintGroupSummaries();
  paintSettingMarks(currentPreset());
  fx.scheduleAuto();
  fx.draw();
}

/** Header summaries follow a value change without a rebuild. */
function paintGroupSummaries() {
  const ctx = schemaContext();
  for (const group of GROUPS) {
    const node = document.querySelector(`#left .group[data-group="${group.id}"] .group-sum`);
    if (node) node.textContent = group.summary(state, ctx);
  }
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
  paintBanner();
}

Object.assign(fx, { apiBase, apiToken, card, stale, settingsHash, blend, currentWeight, renderChrome, markEngineDown, markEngineUp, paintEngineLink, markBusy, busyText, bannerLine, toastTransient, takeTransient, paintBanner, paramLine, paramTable, layerReadout, triangleLine, triangleMeta, formatMs, stageHtml, estimateHtml, isStepName, needsEngine, paretoHtml, formatTime, chips, pct, signed, currentPreset, applyPreset, applyFilter, onBlend, onSettings, pickStrategy, touch, markStale, staleWarning, escapeHtml, probe, fieldRow, revealPrinterDetails, revealResults, setCalibrate });
