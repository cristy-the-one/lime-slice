import { installDocks } from "./dock-reveal";
import { ChevronLeft, ChevronRight, createElement } from "lucide";
import {
  dockMode,
  DRAWER_PX,
  dragMax,
  fitDocks,
  LEFT_MAX,
  LEFT_MIN,
  resultsOpenByDefault,
  RIGHT_MAX,
  RIGHT_MIN,
  type DockFit,
  type DockMode,
  type DockSide,
} from "./panel-budget";

const WIDTH_KEY: Record<DockSide, string> = { left: "lime-slice-panel-left", right: "lime-slice-panel-right" };
/** "1" closed, "0" open; unset follows the window's default. */
const CLOSED_KEY: Record<DockSide, string> = { left: "lime-slice-panel-left-collapsed", right: "lime-slice-panel-right-collapsed" };
const DOCK_ID: Record<DockSide, string> = { left: "#leftDock", right: "#rightDock" };
const NAME: Record<DockSide, string> = { left: "settings", right: "results" };
/** The control that opens each dock; a closing dock hands it the focus. */
const OPENER: Record<DockSide, string> = { left: "#leftToggle", right: "#timing" };
const LAST_KEY = "lime-slice-dock-last";
let fitting = false;
/** Drawers (961–1200 px) start closed each visit and are not stored, so a narrow window never rewrites the docks. */
const drawerOpen: Record<DockSide, boolean> = { left: false, right: false };
/** E3. A dock a Model tool opened for its panel: shown for now, not remembered, and closed again with the tool. */
const revealed: Record<DockSide, boolean> = { left: false, right: false };
/**
 * E3. Who holds each dock open for now (a tool's card, the sketch card): the last to let go closes it, the way it was
 * opened. A user's own toggle, or leaving Model, ends the hold; `generation` turns older release functions into no-ops.
 */
const holds: Record<DockSide, { count: number; how: "dock" | "drawer" | "stacked" | null; generation: number }> = {
  left: { count: 0, how: null, generation: 0 },
  right: { count: 0, how: null, generation: 0 },
};
let shownMode: DockMode | "compact" | null = null;

function mode(): DockMode | "compact" {
  return compact() ? "compact" : dockMode(window.innerWidth);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage off: the docks still work for this visit */
  }
}

function storedWidth(side: DockSide): number | null {
  const value = Number(read(WIDTH_KEY[side]));
  const [min, max] = side === "left" ? [LEFT_MIN, LEFT_MAX] : [RIGHT_MIN, RIGHT_MAX];
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** Whether the user wants this dock open, before the window's room is counted. */
function wantsOpen(side: DockSide): boolean {
  if (revealed[side]) return true;
  const stored = read(CLOSED_KEY[side]);
  if (stored === "1") return false;
  if (stored === "0") return true;
  return side === "left" || resultsOpenByDefault(window.innerWidth);
}

function workspace() {
  return document.querySelector<HTMLElement>(".workspace");
}

function compact() {
  return document.documentElement.classList.contains("layout-compact");
}

/** The dock is on screen: open and not folded for room. */
export function dockShown(side: DockSide): boolean {
  const ws = workspace();
  return !!ws && !ws.classList.contains(side === "left" ? "is-left-collapsed" : "is-right-collapsed");
}

/** Open or close a dock, as its chevron, the rail foot, the estimate, Ctrl+B and Ctrl+Alt+B do. Remembered. */
export function toggleDock(side: DockSide) {
  const ws = workspace();
  // The phone layout has its own sheets.
  if (!ws || compact()) return;
  // A narrow window stacks a dock over the stage on demand; the top bar's Settings and Results buttons do the same.
  if (mode() === "narrow") {
    dropHold(side);
    ws.classList.toggle(side === "left" ? "show-left" : "show-right");
    paintToggles(ws.classList.contains("show-left"), ws.classList.contains("show-right"));
    return;
  }
  setDock(side, !dockShown(side));
}

/**
 * E3. Show a dock for something that needs it now, as a Model tool needs its panel: a closed dock opens without the
 * choice being remembered (a drawer opens over the view). The returned function closes it again, unless the user
 * opened or closed that dock in the meantime. A dock already shown, or the phone layout, is left alone.
 */
export function revealDock(side: DockSide): () => void {
  if (compact()) return () => {};
  const hold = holds[side];
  if (hold.count === 0) {
    const ws = workspace();
    const stacked = side === "left" ? "show-left" : "show-right";
    const now = mode();
    // A dock already on screen is the user's: nothing to give back.
    if (!ws || (now === "narrow" ? ws.classList.contains(stacked) : dockShown(side))) return () => {};
    hold.how = now === "narrow" ? "stacked" : now === "drawer" ? "drawer" : "dock";
    if (hold.how === "stacked") {
      // A narrow window stacks the dock over the stage, as its top bar button does.
      ws.classList.add(stacked);
      paintToggles(ws.classList.contains("show-left"), ws.classList.contains("show-right"));
      window.dispatchEvent(new Event("resize"));
    } else {
      if (hold.how === "drawer") {
        drawerOpen[side] = true;
        drawerOpen[side === "left" ? "right" : "left"] = false;
      }
      revealed[side] = true;
      applyFit();
    }
  }
  hold.count += 1;
  const generation = hold.generation;
  let released = false;
  return () => {
    if (released || hold.generation !== generation) return;
    released = true;
    hold.count -= 1;
    if (hold.count === 0) endHold(side);
  };
}

/** Close a dock its holders opened, the way it was opened. */
function endHold(side: DockSide) {
  const hold = holds[side];
  const how = hold.how;
  hold.count = 0;
  hold.how = null;
  hold.generation += 1;
  revealed[side] = false;
  const ws = workspace();
  if (how === "stacked") {
    const stacked = side === "left" ? "show-left" : "show-right";
    if (ws?.classList.contains(stacked)) {
      ws.classList.remove(stacked);
      paintToggles(ws.classList.contains("show-left"), ws.classList.contains("show-right"));
      window.dispatchEvent(new Event("resize"));
    }
    return;
  }
  if (how === "drawer" && mode() === "drawer") drawerOpen[side] = false;
  if (how) applyFit();
}

/** Leaving Model: a dock its tools held open goes back to the user's choice. */
export function endReveals() {
  for (const side of ["left", "right"] as const) if (holds[side].count > 0) endHold(side);
}

/** The user took the dock: its holders no longer close it. */
function dropHold(side: DockSide) {
  const hold = holds[side];
  hold.count = 0;
  hold.how = null;
  hold.generation += 1;
  revealed[side] = false;
}

export function setDock(side: DockSide, open: boolean) {
  // The user's own choice ends a reveal: the dock is theirs again.
  dropHold(side);
  const dock = document.querySelector(DOCK_ID[side]);
  const hadFocus = !!dock?.contains(document.activeElement);
  const other: DockSide = side === "left" ? "right" : "left";
  const otherHadFocus = !!document.querySelector(DOCK_ID[other])?.contains(document.activeElement);
  const drawers = mode() === "drawer";
  if (drawers) {
    // One drawer at a time, over the view.
    drawerOpen[side] = open;
    if (open) drawerOpen[other] = false;
  } else {
    if (open) write(LAST_KEY, side);
    write(CLOSED_KEY[side], open ? "0" : "1");
  }
  applyFit();
  if (hadFocus && !dockShown(side)) document.querySelector<HTMLElement>(OPENER[side])?.focus();
  // A drawer that takes the other's place takes its focus too, rather than leaving it on the rail.
  if (drawers && open && otherHadFocus) document.querySelector<HTMLElement>(`${DOCK_ID[side]} .dock-close`)?.focus();
}

/** Escape closes an open drawer from inside it, unless a field or menu in it used the key. */
function bindDrawerEscape(side: DockSide) {
  document.querySelector(DOCK_ID[side])?.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key !== "Escape" || e.defaultPrevented || mode() !== "drawer" || !drawerOpen[side]) return;
    // E3. In Model, Esc first ends what is open there (a tool, the Features menu, a sketch); only then the drawer.
    if (document.documentElement.dataset.stage === "model" && document.querySelector('#modelBar[data-tool], #modelFeatureMenu:not([hidden]), #model:is([data-sketch="editing"], [data-sketch="choosing"])')) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("textarea, select, [contenteditable=true], input:not([type=checkbox]):not([type=radio]):not([type=range])")) return;
    e.preventDefault();
    setDock(side, false);
  });
}

function lastOpened(): DockSide {
  return read(LAST_KEY) === "left" ? "left" : "right";
}

export function mountSplitters() {
  const ws = workspace();
  if (!ws || ws.querySelector(".splitter")) return;
  installDocks({ reveal: revealDock, open: (side) => setDock(side, true) });
  const handles = { left: mountHandle(ws, "left"), right: mountHandle(ws, "right") };
  for (const side of ["left", "right"] as const) {
    const close = document.querySelector(`${DOCK_ID[side]} .dock-close`);
    close?.append(createElement(side === "left" ? ChevronLeft : ChevronRight, { width: 16, height: 16, "aria-hidden": "true", class: "ico" }));
    close?.addEventListener("click", () => setDock(side, false));
    bindDrag(ws, handles[side], side);
    bindDrawerEscape(side);
  }
  applyFit();
  window.addEventListener("resize", () => {
    if (!fitting) applyFit();
  });
  window.addEventListener("lime-layout", () => applyFit());
}

function mountHandle(ws: HTMLElement, side: DockSide) {
  const handle = document.createElement("div");
  handle.className = `splitter splitter-${side}`;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", `Resize ${NAME[side]}`);
  ws.append(handle);
  return handle;
}

function bindDrag(ws: HTMLElement, handle: HTMLElement, side: DockSide) {
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !dockShown(side)) return;
    ev.preventDefault();
    handle.classList.add("is-drag");
    handle.setPointerCapture(ev.pointerId);
    const other = side === "left" ? "right" : "left";
    const move = (e: PointerEvent) => {
      const rect = ws.getBoundingClientRect();
      const dock = document.querySelector<HTMLElement>(DOCK_ID[side])?.getBoundingClientRect();
      const raw = side === "left" ? e.clientX - (dock?.left ?? rect.left) : rect.right - e.clientX;
      const shownOther = dockShown(other) ? (document.querySelector<HTMLElement>(DOCK_ID[other])?.offsetWidth ?? 0) : 0;
      const max = dragMax(side, window.innerWidth, shownOther);
      const px = Math.round(Math.min(max, Math.max(side === "left" ? LEFT_MIN : RIGHT_MIN, raw)));
      write(WIDTH_KEY[side], String(px));
      applyFit();
    };
    const up = () => {
      handle.classList.remove("is-drag");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => {
    write(WIDTH_KEY[side], null);
    applyFit();
  });
}

/**
 * Widths and folds for the current window: docks beside the stage, drawers over it from 961 to 1200 px, and below
 * that the stylesheet's stacked layout.
 */
function currentFit(): DockFit {
  if (mode() === "drawer") {
    return { left: drawerOpen.left ? DRAWER_PX : 0, right: drawerOpen.right ? DRAWER_PX : 0 };
  }
  const leftOpen = wantsOpen("left");
  const rightOpen = wantsOpen("right");
  const fit = mode() === "compact"
    ? null
    : fitDocks({
      width: window.innerWidth,
      leftOpen,
      rightOpen,
      leftDesired: storedWidth("left"),
      rightDesired: storedWidth("right"),
      // A revealed dock stays when both cannot: it is the one the open tool needs.
      last: revealed.left ? "left" : revealed.right ? "right" : lastOpened(),
    });
  if (fit) return fit;
  return { left: leftOpen ? (storedWidth("left") ?? -1) : 0, right: rightOpen ? (storedWidth("right") ?? -1) : 0 };
}

function applyFit() {
  const ws = workspace();
  if (!ws || fitting) return;
  const fit = currentFit();
  const next = {
    left: fit.left > 0 ? `${fit.left}px` : fit.left === 0 ? "0px" : "",
    right: fit.right > 0 ? `${fit.right}px` : fit.right === 0 ? "0px" : "",
  };
  const leftClosed = fit.left === 0;
  const rightClosed = fit.right === 0;
  for (const [side, closed] of [["left", leftClosed], ["right", rightClosed]] as const) {
    if (closed && document.querySelector(DOCK_ID[side])?.contains(document.activeElement)) document.querySelector<HTMLElement>(OPENER[side])?.focus();
  }
  paintToggles(!leftClosed, !rightClosed);
  const now = mode();
  const drawers = now === "drawer";
  const modeChanged = now !== shownMode;
  shownMode = now;
  if (
    !modeChanged
    && ws.style.getPropertyValue("--panel-left") === next.left
    && ws.style.getPropertyValue("--panel-right") === next.right
    && ws.classList.contains("is-left-collapsed") === leftClosed
    && ws.classList.contains("is-right-collapsed") === rightClosed
  ) return;
  fitting = true;
  ws.classList.toggle("is-drawers", drawers);
  ws.classList.toggle("is-left-collapsed", leftClosed);
  ws.classList.toggle("is-right-collapsed", rightClosed);
  for (const side of ["left", "right"] as const) {
    const prop = side === "left" ? "--panel-left" : "--panel-right";
    if (next[side]) ws.style.setProperty(prop, next[side]);
    else ws.style.removeProperty(prop);
  }
  // A drawer opens over the view, so the canvas keeps its size and nothing needs to fit again.
  if (!drawers || modeChanged) window.dispatchEvent(new Event("resize"));
  fitting = false;
  paintDrawerHint(drawers && leftClosed);
}

/**
 * While settings sit in a closed drawer (961–1200 px) the status line says where they are. The hint is its own span,
 * outside the live status text, so opening and closing a drawer is not read out again.
 */
function paintDrawerHint(show: boolean) {
  const hint = document.querySelector<HTMLElement>("#statusHint");
  if (hint && hint.hidden === show) hint.hidden = !show;
}

let rightWasShown = false;

function paintToggles(leftShown: boolean, rightShown: boolean) {
  document.querySelector("#leftToggle")?.setAttribute("aria-expanded", String(leftShown));
  document.querySelector("#timing")?.setAttribute("aria-expanded", String(rightShown));
  // E3. Inspect fills its rows only while it is on screen: it catches up when it comes back.
  if (rightShown && !rightWasShown) queueMicrotask(() => window.dispatchEvent(new Event("lime-inspect")));
  rightWasShown = rightShown;
}
