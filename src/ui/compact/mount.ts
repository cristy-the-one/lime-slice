import { Box, createElement, Layers, MoreHorizontal, Printer, Search, SlidersHorizontal, type IconNode } from "lucide";
import { engineMode, pickModelFile, saveGcode, saveLayoutChoice, type LayoutChoice } from "../../platform";
import { haptic } from "../haptics";
import { pushToast } from "../toasts";
import { MOCK_ON_DEVICE_LABEL, MOCK_PLAYBACK_SPEED } from "./mocks";
import { sheetHeight, snapDetent, type Detent } from "./sheet";
import { mountCompactTouch } from "./touch";
import "./compact.css";

type CompactTab = "prepare" | "settings" | "preview" | "device";

let active = false;
let tab: CompactTab = "prepare";
let detent: Detent = "peek";
let home: {
  left: HTMLElement;
  leftParent: HTMLElement;
  slice: HTMLElement;
  cancel: HTMLElement;
  action: HTMLElement;
  connection: HTMLElement | null;
  gear: HTMLElement | null;
} | null = null;

export function mountCompact() {
  if (document.querySelector("#compactTop")) return;
  const app = document.querySelector(".app");
  if (!app) return;
  app.append(topBar(), sheet(), tabs(), devicePage(), menu());
  const stage = document.querySelector("#stage");
  stage?.append(isoButton(), progressLine());
  const preview = document.querySelector("#previewBody");
  preview?.append(layerTip());
  const playback = document.querySelector(".playback");
  if (playback && !playback.querySelector("#compactPlaySpeed")) {
    const speed = document.createElement("span");
    speed.id = "compactPlaySpeed";
    speed.title = "Mock: playback speed does not change the toolpath";
    speed.dataset.mock = "playback-speed";
    speed.textContent = MOCK_PLAYBACK_SPEED;
    playback.append(speed);
  }
  mountCompactTouch({
    toggleChrome,
    onFit: () => document.querySelector<HTMLButtonElement>("#viewPresets button:last-child")?.click(),
    onLongPress: openMenu,
  });
  document.addEventListener("click", (ev) => {
    if (!active) return;
    const target = ev.target as Element | null;
    if (target?.closest("#layflat")) pushToast("Lay flat applied", "success");
  });
  window.addEventListener("lime-layout", sync);
  sync();
}

function icon(node: IconNode) {
  return createElement(node, { width: 18, height: 18, "aria-hidden": "true", class: "ico" });
}

function topBar() {
  const bar = document.createElement("header");
  bar.id = "compactTop";
  const file = document.createElement("button");
  file.type = "button";
  file.className = "compact-file";
  file.id = "compactFile";
  file.innerHTML = `<b>No mesh</b><span>Open a sample or a file</span>`;
  file.addEventListener("click", () => {
    haptic("tap");
    pickModelFile();
  });
  const search = document.createElement("button");
  search.type = "button";
  search.className = "compact-icon";
  search.setAttribute("aria-label", "Search");
  search.append(icon(Search));
  search.addEventListener("click", () => {
    haptic("tap");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  });
  const more = document.createElement("details");
  more.className = "compact-overflow";
  const summary = document.createElement("summary");
  summary.className = "compact-icon";
  summary.setAttribute("aria-label", "More");
  summary.append(icon(MoreHorizontal));
  const nav = document.createElement("nav");
  for (const [label, run] of [
    ["20 mm cube", () => document.querySelector<HTMLButtonElement>('[data-sample="calibration_cube_20mm.stl"]')?.click()],
    ["60 mm hull", () => document.querySelector<HTMLButtonElement>('[data-sample="lime_hull.stl"]')?.click()],
    ["Open mesh", () => pickModelFile()],
    ["Export G-code", () => void saveGcode()],
    ["Force re-slice", () => document.querySelector<HTMLButtonElement>("#force")?.click()],
    ["Shortcuts", () => document.dispatchEvent(new CustomEvent("lime-open-help"))],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      more.open = false;
      run();
    });
    nav.append(button);
  }
  more.append(summary, nav);
  bar.append(file, search, more);
  return bar;
}

function sheet() {
  const el = document.createElement("section");
  el.id = "compactSheet";
  el.dataset.detent = "peek";
  const handle = document.createElement("button");
  handle.type = "button";
  handle.id = "compactSheetHandle";
  handle.setAttribute("aria-label", "Resize settings");
  const body = document.createElement("div");
  body.id = "compactSheetBody";
  handle.addEventListener("pointerdown", (ev) => beginDrag(ev, el, handle));
  el.append(handle, body);
  return el;
}

function beginDrag(ev: PointerEvent, sheetEl: HTMLElement, handle: HTMLButtonElement) {
  if (!active || (tab !== "prepare" && tab !== "settings")) return;
  ev.preventDefault();
  handle.setPointerCapture(ev.pointerId);
  const originY = ev.clientY;
  const origin = sheetHeight(detent, window.innerHeight);
  const move = (event: PointerEvent) => {
    const next = origin + (originY - event.clientY);
    applyHeights(Math.max(PEEK_MIN, Math.min(window.innerHeight - 80, next)), false);
  };
  const end = (event: PointerEvent) => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    const height = origin + (originY - event.clientY);
    detent = snapDetent(height, window.innerHeight);
    sheetEl.dataset.detent = detent;
    applyHeights(sheetHeight(detent, window.innerHeight), true);
    haptic("snap");
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

const PEEK_MIN = 56;

function tabs() {
  const nav = document.createElement("nav");
  nav.id = "compactTabs";
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Compact");
  const specs: [CompactTab, string, IconNode][] = [
    ["prepare", "Prepare", Box],
    ["settings", "Settings", SlidersHorizontal],
    ["preview", "Preview", Layers],
    ["device", "Device", Printer],
  ];
  for (const [id, label, node] of specs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "compact-tab";
    button.dataset.tab = id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", id === "prepare" ? "true" : "false");
    button.append(icon(node), document.createTextNode(label));
    button.addEventListener("click", () => selectTab(id));
    nav.append(button);
  }
  return nav;
}

function isoButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "compactIso";
  button.textContent = "Iso";
  button.addEventListener("click", () => {
    haptic("tap");
    document.querySelector<HTMLButtonElement>("#viewPresets button:last-child")?.click();
  });
  return button;
}

function progressLine() {
  const line = document.createElement("div");
  line.id = "compactProgress";
  line.innerHTML = `<span></span><i></i>`;
  return line;
}

function layerTip() {
  const tip = document.createElement("div");
  tip.id = "compactLayerTip";
  tip.textContent = "Layer";
  return tip;
}

function devicePage() {
  const page = document.createElement("section");
  page.id = "compactDevice";
  page.innerHTML = `
    <h2>Device</h2>
    <p class="compact-kicker">Engine and printer</p>
    <h3>Slicing engine</h3>
    <div class="compact-seg" role="group" aria-label="Slicing engine">
      <button type="button" id="engineRemote" aria-pressed="true">Remote</button>
      <button type="button" id="engineLocal" disabled title="Mock: an on-device engine is not built">${MOCK_ON_DEVICE_LABEL}</button>
    </div>
    <div class="compact-status" id="compactEngine" data-state="pending">
      <div><b>Engine …</b><span id="compactEngineMeta"></span></div>
      <i></i>
    </div>
    <div id="compactConnection"></div>
    <h3>Printer</h3>
    <div class="compact-row"><div><b>Profile</b><div id="compactBed">Bed</div></div><button type="button" id="compactEditPrinter">Edit</button></div>
    <h3>Output</h3>
    <div class="compact-row"><div><b>Last G-code</b><div id="compactGcode">Slice to export</div></div><button type="button" id="compactShare">Share</button></div>
    <p class="compact-note">Local-network access must be allowed for a later iOS build. The engine is reachable over LAN or Tailscale from the browser today.</p>
    <label class="field">Interface layout
      <select id="layoutChoiceCompact" aria-label="Interface layout">
        <option value="auto">Auto</option>
        <option value="desktop">Desktop</option>
        <option value="compact">Compact (phone)</option>
      </select>
    </label>
  `;
  page.querySelector("#compactEditPrinter")?.addEventListener("click", () => selectTab("settings"));
  page.querySelector("#compactShare")?.addEventListener("click", () => void saveGcode());
  const select = page.querySelector<HTMLSelectElement>("#layoutChoiceCompact");
  select?.addEventListener("change", () => {
    saveLayoutChoice((select.value as LayoutChoice) || "auto");
    const gear = document.querySelector<HTMLSelectElement>("#layoutChoice");
    if (gear) gear.value = select.value;
  });
  return page;
}

function menu() {
  const el = document.createElement("div");
  el.id = "compactMenu";
  el.hidden = true;
  el.setAttribute("role", "menu");
  for (const [label, run] of [
    ["Fit view", () => document.querySelector<HTMLButtonElement>("#viewPresets button:last-child")?.click()],
    ["Lay flat", () => document.querySelector<HTMLButtonElement>("#layflat")?.click()],
    ["Section", () => document.querySelector<HTMLButtonElement>("#toolRail [data-tool=section]")?.click()],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      el.hidden = true;
      run();
    });
    el.append(button);
  }
  document.addEventListener("pointerdown", (ev) => {
    if (el.hidden) return;
    if (!(ev.target as Element | null)?.closest("#compactMenu")) el.hidden = true;
  });
  return el;
}

function openMenu(x: number, y: number) {
  const el = document.querySelector<HTMLElement>("#compactMenu");
  if (!el) return;
  el.hidden = false;
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 180))}px`;
  el.style.top = `${Math.max(8, y)}px`;
  haptic("snap");
}

function toggleChrome() {
  document.documentElement.classList.toggle("chrome-hidden");
  applyHeights(sheetHeight(detent, window.innerHeight), true);
  haptic("tap");
}

function selectTab(next: CompactTab) {
  tab = next;
  document.documentElement.dataset.compactTab = next;
  document.querySelectorAll<HTMLButtonElement>("#compactTabs .compact-tab").forEach((button) => {
    button.setAttribute("aria-selected", button.dataset.tab === next ? "true" : "false");
  });
  if (next === "prepare") {
    detent = "peek";
    document.querySelector<HTMLButtonElement>("#tabPrepare")?.click();
  } else if (next === "settings") {
    detent = "half";
    document.querySelector<HTMLButtonElement>("#tabPrepare")?.click();
  } else if (next === "preview") {
    document.querySelector<HTMLButtonElement>("#tabPreview")?.click();
    document.querySelector<HTMLButtonElement>('[data-mode="solid"]')?.click();
  }
  const sheetEl = document.querySelector<HTMLElement>("#compactSheet");
  if (sheetEl) sheetEl.dataset.detent = next === "preview" || next === "device" ? "closed" : detent;
  applyHeights(sheetHeight(detent, window.innerHeight), true);
  haptic("tap");
  window.dispatchEvent(new Event("resize"));
}

function applyHeights(sheetPx: number, animate: boolean) {
  const root = document.documentElement;
  const hidden = root.classList.contains("chrome-hidden");
  const short = window.innerHeight < 500;
  const showSheet = !hidden && (tab === "prepare" || tab === "settings") && !(short && tab === "prepare" && detent === "peek");
  root.style.transition = animate ? "" : "none";
  root.style.setProperty("--compact-sheet", hidden || !showSheet ? "0px" : `${Math.round(sheetPx)}px`);
}

function sync() {
  const on = document.documentElement.classList.contains("layout-compact");
  if (on === active) {
    if (on) refresh();
    return;
  }
  active = on;
  if (on) enter();
  else leave();
}

function enter() {
  const left = document.querySelector<HTMLElement>("#left");
  const slice = document.querySelector<HTMLElement>("#slice");
  const cancel = document.querySelector<HTMLElement>("#cancel");
  const action = document.querySelector<HTMLElement>(".action-row");
  const workspace = document.querySelector(".workspace");
  const body = document.querySelector("#compactSheetBody");
  if (!left || !slice || !cancel || !action || !workspace || !body || !left.parentElement) return;
  const connection = document.querySelector<HTMLElement>("#connection");
  home = {
    left,
    leftParent: left.parentElement,
    slice,
    cancel,
    action,
    connection,
    gear: connection?.parentElement ?? null,
  };
  body.append(left);
  workspace.append(slice, cancel);
  const host = document.querySelector("#compactConnection");
  if (connection && host) host.append(connection);
  document.documentElement.dataset.compactTab = tab;
  selectTab(tab);
  observe();
  refresh();
}

function leave() {
  if (!home) return;
  const rail = document.querySelector("#toolRail");
  if (rail) home.leftParent.insertBefore(home.left, rail);
  else home.leftParent.prepend(home.left);
  const exportButton = home.action.querySelector("#export");
  if (exportButton) {
    home.action.insertBefore(home.slice, exportButton);
    home.action.insertBefore(home.cancel, exportButton);
  } else home.action.prepend(home.slice, home.cancel);
  if (home.connection && home.gear) home.gear.append(home.connection);
  home = null;
  document.documentElement.classList.remove("chrome-hidden");
  delete document.documentElement.dataset.compactTab;
  window.dispatchEvent(new Event("resize"));
}

let watching = false;
function observe() {
  if (watching) return;
  watching = true;
  const tick = () => refresh();
  const left = document.querySelector("#leftBody");
  if (left) new MutationObserver(tick).observe(left, { childList: true, subtree: true, characterData: true });
  for (const id of ["#engineLink", "#timing", "#sliceMeter", "#readHigh", "#rangeHigh"]) {
    const el = document.querySelector(id);
    if (el) new MutationObserver(tick).observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
  }
  document.querySelector("#rangeHigh")?.addEventListener("input", tick);
}

function refresh() {
  if (!active) return;
  const file = document.querySelector("#compactFile");
  const name = document.querySelector(".obj b")?.textContent?.trim();
  const meta = document.querySelector(".obj span")?.textContent?.trim();
  if (file) file.innerHTML = `<b>${escape(name || "No mesh")}</b><span>${escape(meta || "Open a sample or a file")}</span>`;
  const engine = document.querySelector<HTMLElement>("#engineLink");
  const card = document.querySelector<HTMLElement>("#compactEngine");
  const engineMeta = document.querySelector("#compactEngineMeta");
  if (card && engine) {
    card.dataset.state = engine.dataset.state ?? "pending";
    const title = card.querySelector("b");
    if (title) title.textContent = engine.textContent || "Engine";
  }
  const using = document.querySelector("#apiUsing")?.textContent?.replace(/^Using\s/, "") ?? "";
  const rtt = document.querySelector<HTMLElement>("#apiTestResult")?.dataset.rtt;
  if (engineMeta) {
    const mode = engineMode() === "invoke" ? "In-process" : using || "HTTP";
    engineMeta.textContent = rtt ? `${mode} · ${rtt} ms` : mode;
  }
  const remote = document.querySelector<HTMLButtonElement>("#engineRemote");
  if (remote) remote.setAttribute("aria-pressed", engineMode() === "http" ? "true" : "false");
  const bedX = document.querySelector<HTMLInputElement>("#bedx")?.value;
  const bedY = document.querySelector<HTMLInputElement>("#bedy")?.value;
  const bed = document.querySelector("#compactBed");
  if (bed) bed.textContent = bedX && bedY ? `Bed ${bedX} × ${bedY} mm` : "Bed";
  const exportButton = document.querySelector<HTMLButtonElement>("#export");
  const gcode = document.querySelector("#compactGcode");
  if (gcode) gcode.textContent = exportButton && !exportButton.disabled ? "Ready to share" : "Slice to export";
  const high = document.querySelector<HTMLInputElement>("#rangeHigh");
  const z = document.querySelector("#readHigh")?.textContent ?? "";
  const tip = document.querySelector("#compactLayerTip");
  if (tip && high && Number(high.max) > 0) {
    tip.textContent = `L${Number(high.value) + 1} / ${Number(high.max) + 1} · ${z}`;
  }
  const progress = document.querySelector<HTMLElement>("#compactProgress");
  const timing = document.querySelector("#timing")?.textContent ?? "";
  const meter = document.querySelector("#sliceMeter")?.textContent ?? "";
  const busy = document.querySelector<HTMLButtonElement>("#cancel")?.disabled === false;
  if (progress) {
    progress.dataset.on = busy ? "1" : "0";
    const span = progress.querySelector("span");
    if (span) span.textContent = [timing, meter].filter(Boolean).join(" · ");
    const bar = progress.querySelector<HTMLElement>("i");
    const match = meter.match(/(\d+)%/);
    if (bar) bar.style.width = match ? `${match[1]}%` : "0%";
  }
  const gear = document.querySelector<HTMLSelectElement>("#layoutChoice");
  const compactChoice = document.querySelector<HTMLSelectElement>("#layoutChoiceCompact");
  if (gear && compactChoice && compactChoice.value !== gear.value) compactChoice.value = gear.value;
}

function escape(value: string) {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
