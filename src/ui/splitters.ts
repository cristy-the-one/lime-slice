import { ChevronLeft, ChevronRight, createElement } from "lucide";
import {
  dragMax,
  fitDocks,
  LEFT_MAX,
  LEFT_MIN,
  resultsOpenByDefault,
  RIGHT_MAX,
  RIGHT_MIN,
  type DockFit,
  type DockSide,
} from "./panel-budget";

const WIDTH_KEY: Record<DockSide, string> = { left: "lime-slice-panel-left", right: "lime-slice-panel-right" };
/** "1" closed, "0" open; unset follows the window's default. */
const CLOSED_KEY: Record<DockSide, string> = { left: "lime-slice-panel-left-collapsed", right: "lime-slice-panel-right-collapsed" };
const DOCK_ID: Record<DockSide, string> = { left: "#leftDock", right: "#rightDock" };
const NAME: Record<DockSide, string> = { left: "settings", right: "results" };

let last: DockSide = "right";
let fitting = false;

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
  // A narrow window stacks a dock over the stage on demand; the top bar's Settings and Results buttons do the same.
  if (ws && !compact() && window.innerWidth <= 960) {
    ws.classList.toggle(side === "left" ? "show-left" : "show-right");
    return;
  }
  setDock(side, !dockShown(side));
}

export function setDock(side: DockSide, open: boolean) {
  if (open) last = side;
  write(CLOSED_KEY[side], open ? "0" : "1");
  applyFit();
}

export function mountSplitters() {
  const ws = workspace();
  if (!ws || ws.querySelector(".splitter")) return;
  const handles = { left: mountHandle(ws, "left"), right: mountHandle(ws, "right") };
  for (const side of ["left", "right"] as const) {
    const close = document.querySelector(`${DOCK_ID[side]} .dock-close`);
    close?.append(createElement(side === "left" ? ChevronLeft : ChevronRight, { width: 16, height: 16, "aria-hidden": "true", class: "ico" }));
    close?.addEventListener("click", () => setDock(side, false));
    bindDrag(ws, handles[side], side);
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
      const max = Math.min(side === "left" ? LEFT_MAX : RIGHT_MAX, dragMax(side, window.innerWidth, shownOther));
      const px = Math.round(Math.min(max, Math.max(side === "left" ? LEFT_MIN : RIGHT_MIN, raw)));
      write(WIDTH_KEY[side], String(px));
      applyFit();
    };
    const up = () => {
      handle.classList.remove("is-drag");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => {
    write(WIDTH_KEY[side], null);
    applyFit();
  });
}

/** Widths and folds for the current window. Below the desktop width the docks keep the stylesheet's narrow layout. */
function currentFit(): DockFit {
  const leftOpen = wantsOpen("left");
  const rightOpen = wantsOpen("right");
  const fit = compact()
    ? null
    : fitDocks({
      width: window.innerWidth,
      leftOpen,
      rightOpen,
      leftDesired: storedWidth("left"),
      rightDesired: storedWidth("right"),
      last,
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
  paintToggles(!leftClosed, !rightClosed);
  if (
    ws.style.getPropertyValue("--panel-left") === next.left
    && ws.style.getPropertyValue("--panel-right") === next.right
    && ws.classList.contains("is-left-collapsed") === leftClosed
    && ws.classList.contains("is-right-collapsed") === rightClosed
  ) return;
  fitting = true;
  ws.classList.toggle("is-left-collapsed", leftClosed);
  ws.classList.toggle("is-right-collapsed", rightClosed);
  for (const side of ["left", "right"] as const) {
    const prop = side === "left" ? "--panel-left" : "--panel-right";
    if (next[side]) ws.style.setProperty(prop, next[side]);
    else ws.style.removeProperty(prop);
  }
  window.dispatchEvent(new Event("resize"));
  fitting = false;
}

function paintToggles(leftShown: boolean, rightShown: boolean) {
  document.querySelector("#leftToggle")?.setAttribute("aria-pressed", String(leftShown));
  document.querySelector("#timing")?.setAttribute("aria-expanded", String(rightShown));
}
