/**
 * The Model dock as a stack of panes: the open tool, History, Parameters, and Stress. Each pane keeps its header on
 * screen. An open pane starts at its content's height and gives way when the dock is short; the line between two panes
 * drags to share the height out, and the sizes are remembered. Each section still opens and folds itself; this module
 * only lays the open ones out and adds the lines.
 */
import { ChevronDown, createElement } from "lucide";

export type PaneId = "tool" | "history" | "params" | "stress";

export interface PaneHeight {
  id: PaneId;
  height: number;
  min: number;
  /** Its whole content: a pane taller than that would only show empty space. */
  max: number;
}

/**
 * Move the line between `above` and `below` by `delta` px (down is positive): one pane gives what the other takes,
 * neither goes under its min, and neither grows past its content. Every open pane comes back with a height, so the
 * others stay where they are.
 */
export function moveLine(open: readonly PaneHeight[], above: PaneId, below: PaneId, delta: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pane of open) out[pane.id] = Math.round(pane.height);
  const a = open.find((pane) => pane.id === above);
  const b = open.find((pane) => pane.id === below);
  if (!a || !b) return out;
  const lowest = Math.max(a.min - a.height, b.height - b.max);
  const highest = Math.min(b.height - b.min, a.max - a.height);
  const moved = Math.min(Math.max(delta, Math.min(lowest, 0)), Math.max(highest, 0));
  out[above] = Math.round(a.height + moved);
  out[below] = Math.round(b.height - moved);
  return out;
}

interface Pane {
  id: PaneId;
  label: string;
  el: HTMLElement;
  /** The part that scrolls; everything else in the pane is its header and stays. */
  body: () => HTMLElement | null;
  open: () => boolean;
}

const SIZES_KEY = "lime-slice-dock-panes";
/** Rows of an open pane's body kept on screen however short the dock is. */
const BODY_MIN = 56;
const STEP = 16;

let panes: Pane[] = [];
let dock: HTMLElement | null = null;
let sizes: Partial<Record<PaneId, number>> = {};
let laying = false;

function readSizes(): Partial<Record<PaneId, number>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIZES_KEY) ?? "{}") as Record<string, unknown>;
    const out: Partial<Record<PaneId, number>> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "number" && value > 0) out[key as PaneId] = value;
    return out;
  } catch {
    return {};
  }
}

function writeSizes() {
  try {
    if (Object.keys(sizes).length === 0) localStorage.removeItem(SIZES_KEY);
    else localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
  } catch {
    /* storage off: the sizes last for this visit */
  }
}

function compact() {
  return document.documentElement.classList.contains("layout-compact");
}

function shown(pane: Pane) {
  return !pane.el.hidden && pane.el.offsetParent !== null;
}

function minOf(pane: Pane): number {
  const body = pane.body();
  const head = pane.el.offsetHeight - (body?.offsetHeight ?? 0);
  return Math.ceil(head + Math.min(BODY_MIN, body?.scrollHeight ?? 0));
}

function maxOf(pane: Pane): number {
  const body = pane.body();
  return Math.ceil(pane.el.offsetHeight - (body?.offsetHeight ?? 0) + (body?.scrollHeight ?? 0));
}

function measure(pane: Pane): PaneHeight {
  return { id: pane.id, height: pane.el.getBoundingClientRect().height, min: minOf(pane), max: maxOf(pane) };
}

/** The open panes on either side of a line, nearest first, skipping folded ones. */
function neighbours(line: HTMLElement): { above: Pane | null; below: Pane | null } {
  const visible = panes.filter(shown);
  const at = visible.findIndex((pane) => pane.el === line.nextElementSibling);
  if (at < 0) return { above: null, below: null };
  const above = visible.slice(0, at).reverse().find((pane) => pane.open()) ?? null;
  const below = visible.slice(at).find((pane) => pane.open()) ?? null;
  return { above, below };
}

function lineFor(pane: Pane): HTMLElement {
  const before = pane.el.previousElementSibling;
  if (before instanceof HTMLElement && before.classList.contains("pane-line")) return before;
  const line = document.createElement("div");
  line.className = "pane-line";
  line.setAttribute("role", "separator");
  line.setAttribute("aria-orientation", "horizontal");
  pane.el.before(line);
  bindLine(line);
  return line;
}

/** Lay the panes out from what is shown and open now. Safe to call any time. */
export function layoutPanes() {
  if (!dock || laying) return;
  laying = true;
  const off = compact();
  const visible = panes.filter(shown);
  const open = visible.filter((pane) => pane.open());
  const fill = open.at(-1);
  for (const pane of panes) {
    const el = pane.el;
    const isOpen = !off && open.includes(pane);
    el.toggleAttribute("data-pane-open", isOpen);
    el.toggleAttribute("data-pane-fill", !off && pane === fill);
    const size = sizes[pane.id];
    if (isOpen && size) el.style.setProperty("--pane-basis", `${size}px`);
    else el.style.removeProperty("--pane-basis");
    if (isOpen) el.style.setProperty("--pane-min", `${minOf(pane)}px`);
    else el.style.removeProperty("--pane-min");
  }
  for (const pane of panes) {
    const line = lineFor(pane);
    const first = visible[0] === pane;
    const { above, below } = neighbours(line);
    const live = !off && shown(pane) && !first && !!above && !!below;
    // Only a change is written: `hidden` set to its own value still reaches the observer, which would loop.
    const hide = off || !shown(pane) || first;
    if (line.hidden !== hide) line.hidden = hide;
    line.toggleAttribute("data-live", live);
    line.tabIndex = live ? 0 : -1;
    if (live && above && below) {
      line.setAttribute("aria-label", `Resize ${above.label} and ${below.label}`);
      line.setAttribute("aria-valuenow", String(Math.round(above.el.getBoundingClientRect().height)));
    } else {
      line.removeAttribute("aria-label");
      line.removeAttribute("aria-valuenow");
    }
  }
  laying = false;
}

function apply(line: HTMLElement, delta: number) {
  const { above, below } = neighbours(line);
  if (!above || !below) return;
  const open = panes.filter((pane) => shown(pane) && pane.open());
  const next = moveLine(open.map(measure), above.id, below.id, delta);
  for (const pane of open) sizes[pane.id] = next[pane.id];
  layoutPanes();
}

function bindLine(line: HTMLElement) {
  line.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !line.hasAttribute("data-live")) return;
    ev.preventDefault();
    line.setPointerCapture(ev.pointerId);
    line.classList.add("is-drag");
    let last = ev.clientY;
    const move = (e: PointerEvent) => {
      apply(line, e.clientY - last);
      last = e.clientY;
    };
    const up = () => {
      line.classList.remove("is-drag");
      line.removeEventListener("pointermove", move);
      line.removeEventListener("pointerup", up);
      line.removeEventListener("pointercancel", up);
      writeSizes();
    };
    line.addEventListener("pointermove", move);
    line.addEventListener("pointerup", up);
    line.addEventListener("pointercancel", up);
  });
  line.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? STEP * 4 : STEP;
    const delta = { ArrowUp: -step, ArrowDown: step, Home: -1e6, End: 1e6 }[ev.key];
    if (delta === undefined || !line.hasAttribute("data-live")) return;
    ev.preventDefault();
    apply(line, delta);
    writeSizes();
  });
  // Back to each pane's own height.
  line.addEventListener("dblclick", () => {
    sizes = {};
    writeSizes();
    layoutPanes();
  });
}

function byId(selector: string) {
  return document.querySelector<HTMLElement>(selector);
}

export function mountDockPanes() {
  dock = byId("#modelDock");
  if (!dock || panes.length) return;
  const found: (Pane | null)[] = [
    paneOf("tool", "the tool", "#modelPanel", ".model-panel-body", () => true),
    paneOf("history", "History", "#modelHistory", "#modelHistoryTree", () => byId("#modelHistory")?.dataset.collapsed !== "1"),
    paneOf("params", "Parameters", "#modelParams", "#modelParamsMain", () => byId("#modelParamsMain")?.hidden === false),
    paneOf("stress", "Stress", "#modelStress", ".model-stress-scroll", () => byId("#modelStressMain")?.hidden === false),
  ];
  panes = found.filter((pane): pane is Pane => !!pane);
  sizes = readSizes();
  for (const pane of panes) {
    const head = pane.el.querySelector<HTMLElement>("[data-pane-head]");
    if (head && pane.id !== "tool" && !head.querySelector(".pane-chev")) {
      head.querySelector(":scope > .ico")?.remove();
      head.append(createElement(ChevronDown, { width: 14, height: 14, "aria-hidden": "true", class: "ico pane-chev" }));
    }
  }
  // Sections open, fold, appear, and fill in on their own; the layout follows them.
  const watch = new MutationObserver(() => queueMicrotask(layoutPanes));
  watch.observe(dock, { subtree: true, attributes: true, attributeFilter: ["hidden", "data-collapsed"], childList: true });
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  new ResizeObserver(() => layoutPanes()).observe(dock);
  layoutPanes();
}

function paneOf(id: PaneId, label: string, selector: string, bodySelector: string, open: () => boolean): Pane | null {
  const el = byId(selector);
  if (!el) return null;
  el.dataset.pane = id;
  return { id, label, el, body: () => el.querySelector<HTMLElement>(bodySelector), open };
}
