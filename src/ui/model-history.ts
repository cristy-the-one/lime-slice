/**
 * Model's History panel: the open solid's history tree as a git graph, at the bottom left of the
 * canvas, or as a sheet at phone width. A click or Enter shows a step, arrows move and show it
 * after a typing pause, Left and Right switch branches. Rows are rebuilt only when the tree changes,
 * and only while the panel can be seen. Nothing here asks the engine anything.
 */
import { ChevronDown, Ellipsis, History, Move3d, Pencil, RotateCcw, TriangleAlert, createElement, type IconNode } from "lucide";
import { historyKey, historyLayout, positionText, rowCount, rowKey, type HistoryLayout, type HistoryRow, type RowKey } from "../model-history";
import type { PlaceFields } from "../model-space";
import { toolKeys, type ModelTree } from "../model-tree";
import { isMobileLayout } from "../platform";
import { state } from "../app/state";

/** Rows are named by `RowKey`: an open solid's step, or a step of a tool one of its joins takes ("Booleans between objects"). */
interface ModelHistoryHooks {
  /** Show this step; a tool's step shows read-only. A newer jump supersedes an older one still on its way. */
  jump(row: RowKey): void;
  rename(row: RowKey, name: string): void;
  /** Why this branch cannot be deleted, or null. */
  dropRefusal(row: RowKey): string | null;
  /** Delete the branch from the row's step down. False when it was refused; the readout says why. */
  drop(row: RowKey): boolean;
  /** Why this step cannot be edited, or null. */
  editRefusal(row: RowKey): string | null;
  /** Open this step's tool with its numbers, to change them; null is the step shown. A refusal goes to the readout. */
  edit(row: RowKey | null): void;
  /** The Position row was clicked: Place opens. */
  openPlace(): void;
  /** The Position row's Reset: the open object goes back to where its file put it, as one Place step. */
  resetPosition(): void;
}

/** Arrow keys show their step after this pause, so a run of presses asks for the last one only. */
const JUMP_WAIT_MS = 200;
const COLLAPSED_KEY = "lime-slice-model-history-collapsed";
const LANE_PX = 12;

let hooks: ModelHistoryHooks | null = null;
let panel: HTMLElement | null = null;
let list: HTMLElement | null = null;
let menu: HTMLElement | null = null;
/** The tree to show, the trees its joins take tools from, and the row on screen. `drawn` is what the rows were built from, `counted` what the header's count was. */
let tree: ModelTree | null = null;
let trees: ReadonlyMap<string, ModelTree> = new Map();
let shown: RowKey | null = null;
let drawn: readonly unknown[] | null = null;
let counted: readonly unknown[] | null = null;
let layout: HistoryLayout | null = null;
let focusId: RowKey | null = null;
let jumpTimer = 0;
let collapsed = readCollapsed();
let sheetOpen = false;
let renaming: RowKey | null = null;
/** Where Shift+H came from, so leaving the panel goes back there. */
let returnFocus: HTMLElement | null = null;
let note: HTMLElement | null = null;
/** The pointer is over the panel. With focus in it, that freezes the rows' order (historyLayout's `keep`). */
let pointerIn = false;
const rowEls = new Map<RowKey, HTMLElement>();
const rowSigs = new Map<RowKey, string>();

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(on: boolean) {
  try {
    if (on) localStorage.setItem(COLLAPSED_KEY, "1");
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    /* private window or blocked storage: the panel just opens expanded next time */
  }
}

function icon(node: IconNode, size = 14) {
  return createElement(node, { width: size, height: size, "aria-hidden": "true", class: "ico" });
}

export function mountModelHistory(next: ModelHistoryHooks) {
  hooks = next;
  panel = document.querySelector<HTMLElement>("#modelHistory");
  list = document.querySelector<HTMLElement>("#modelHistoryTree");
  const toggle = document.querySelector<HTMLButtonElement>("#modelHistoryToggle");
  const open = document.querySelector<HTMLButtonElement>("#modelHistoryOpen");
  if (!panel || !list || !toggle) return;
  toggle.prepend(icon(ChevronDown));
  if (open && !open.querySelector(".ico")) {
    const label = open.textContent?.trim() ?? "History";
    const text = document.createElement("span");
    text.className = "model-tool-label";
    text.textContent = label;
    open.replaceChildren(icon(History), text);
  }
  const position = document.querySelector<HTMLButtonElement>("#modelPositionOpen");
  const reset = document.querySelector<HTMLButtonElement>("#modelPositionReset");
  if (position && !position.querySelector(".ico")) position.prepend(icon(Move3d));
  if (reset && !reset.querySelector(".ico")) reset.append(icon(RotateCcw));
  position?.addEventListener("click", () => {
    if (isMobileLayout()) setSheet(false, false);
    hooks?.openPlace();
  });
  reset?.addEventListener("click", () => hooks?.resetPosition());
  menu = buildMenu();
  note = document.createElement("p");
  note.className = "mh-note";
  note.setAttribute("role", "status");
  note.hidden = true;
  panel.append(note, menu);
  const canvas = document.querySelector<HTMLElement>("#model");
  if (canvas && !canvas.hasAttribute("tabindex")) canvas.tabIndex = -1;

  // At phone width the panel is a sheet, and its header closes it.
  toggle.addEventListener("click", () => (isMobileLayout() ? setSheet(false, true) : setCollapsed(!collapsed)));
  open?.addEventListener("click", () => setSheet(!sheetOpen, !sheetOpen));
  list.addEventListener("click", onClick);
  list.addEventListener("dblclick", onDoubleClick);
  list.addEventListener("contextmenu", onContextMenu);
  list.addEventListener("keydown", onKey);
  panel.addEventListener("pointerenter", () => {
    pointerIn = true;
  });
  panel.addEventListener("pointerleave", () => {
    pointerIn = false;
    relayout(document.activeElement);
  });
  panel.addEventListener("focusout", (ev) => relayout(ev.relatedTarget));
  list.addEventListener("focusin", (ev) => {
    const row = rowOf(ev.target);
    if (row != null && row !== focusId) setFocus(row, false);
  });
  window.addEventListener("lime-layout", () => {
    if (!isMobileLayout()) setSheet(false, false);
    sync();
  });
  sync();
}

/**
 * The open solid's tree changed, or there is none, or the trees its joins take tools from, or the row on screen (`row`,
 * null for the tree's current step). Cheap when nothing changed.
 */
export function syncModelHistory(next: ModelTree | null, all: ReadonlyMap<string, ModelTree> = new Map(), row: RowKey | null = null) {
  if (next?.key !== tree?.key) {
    focusId = null;
    layout = null;
    cancelJump();
    closeMenu(false);
    showNote("");
    if (renaming != null) rowSigs.delete(renaming);
    renaming = null;
    if (!next) setSheet(false, false);
  }
  tree = next;
  trees = all;
  shown = row;
  sync();
}

/** The row on screen. */
function shownKey(): RowKey {
  return shown ?? rowKey([], tree?.current ?? 0);
}

/** What the rows are built from: the tree, the row on screen, and every tree its joins reach, at any depth. Rows are built again only when one of them changes. */
function inputs(): unknown[] {
  if (!tree) return [];
  const used: ModelTree[] = [];
  const seen = new Set([tree.key]);
  for (const queue = [...toolKeys(tree)]; queue.length > 0; ) {
    const key = queue.pop()!;
    const tool = trees.get(key);
    if (!tool || seen.has(key)) continue;
    seen.add(key);
    used.push(tool);
    queue.push(...toolKeys(tool));
  }
  return [tree, shownKey(), ...used];
}

function changed(): boolean {
  return !same(drawn, inputs());
}

function same(was: readonly unknown[] | null, now: readonly unknown[]): boolean {
  return !!was && was.length === now.length && now.every((value, i) => was[i] === value);
}

/**
 * The Position row: the open object's pose as Place reads it, and Reset while it is not where its file put it. Only the
 * row's own text changes, so a Place drag never repaints the tree. Null with nothing open.
 */
export function syncModelPosition(fields: PlaceFields | null, atFile: boolean) {
  const text = fields ? positionText(fields) : "";
  const label = document.querySelector("#modelPositionText");
  const open = document.querySelector<HTMLElement>("#modelPositionOpen");
  if (label && open && label.textContent !== text) {
    label.textContent = text;
    open.setAttribute("aria-label", `Position: ${text}. Opens Place.`);
    open.dataset.tip = `Where this object sits in model space: ${text}. Click to open Place.`;
  }
  const reset = document.querySelector<HTMLElement>("#modelPositionReset");
  if (!reset || reset.hidden === atFile) return;
  // Reset hides once the pose is reset: focus stays in the row rather than drop to the page.
  if (atFile && document.activeElement === reset) open?.focus({ preventScroll: true });
  reset.hidden = atFile;
}

/** Shift+H: into the panel, opening it, or back out of it. */
export function toggleModelHistoryFocus() {
  if (!panel || !list || !tree) return;
  if (list.contains(document.activeElement)) {
    leave();
    return;
  }
  const from = document.activeElement;
  returnFocus = from instanceof HTMLElement && from !== document.body && !panel.contains(from) ? from : null;
  if (isMobileLayout()) setSheet(true, true);
  else if (collapsed) setCollapsed(false);
  focusRow(focusId ?? shownKey());
}

/** Someone is pointing or typing in the panel: rows must not move under them. */
function working(focused: EventTarget | null): boolean {
  return pointerIn || (focused instanceof Node && !!panel?.contains(focused));
}

/** Once nobody is working in the panel, the shown step's path moves onto the main rail. */
function relayout(focused: EventTarget | null) {
  if (!visible() || working(focused) || !layout || !tree) return;
  const fresh = historyLayout(tree, undefined, trees, shownKey());
  if (fresh.rows.every((row, i) => layout!.rows[i]?.key === row.key && layout!.rows[i]?.lane === row.lane)) return;
  drawn = null;
  sync();
}

function visible(): boolean {
  return !!tree && state.stage === "model" && (isMobileLayout() ? sheetOpen : !collapsed);
}

function sync() {
  if (!panel || !list) return;
  panel.hidden = !tree;
  panel.dataset.collapsed = collapsed ? "1" : "0";
  panel.dataset.sheet = sheetOpen ? "open" : "closed";
  const now = inputs();
  const counter = document.querySelector("#modelHistoryCount");
  if (counter && !same(counted, now)) {
    counted = now;
    counter.textContent = `· ${tree ? rowCount(tree, trees) : 0}`;
  }
  document.querySelector("#modelHistoryToggle")?.setAttribute("aria-expanded", (isMobileLayout() ? sheetOpen : !collapsed) ? "true" : "false");
  document.querySelector("#modelHistoryOpen")?.setAttribute("aria-expanded", sheetOpen ? "true" : "false");
  list.hidden = collapsed && !isMobileLayout();
  if (state.stage !== "model") closeMenu(false);
  if (!visible()) cancelJump();
  else if (changed()) render();
}

function setCollapsed(on: boolean) {
  const had = !!list?.contains(document.activeElement);
  collapsed = on;
  writeCollapsed(on);
  closeMenu(false);
  sync();
  if (on && had) document.querySelector<HTMLElement>("#modelHistoryToggle")?.focus();
}

function setSheet(on: boolean, moveFocus: boolean) {
  if (sheetOpen === on) return;
  sheetOpen = on;
  closeMenu(false);
  sync();
  if (!moveFocus) return;
  if (on && tree) focusRow(focusId ?? shownKey());
  else if (!on) document.querySelector<HTMLElement>("#modelHistoryOpen")?.focus();
}

/** Build or patch the rows for `tree`. Rows are kept by node id, so focus stays where it was. */
function render() {
  if (!list || !tree) return;
  const hadFocus = list.contains(document.activeElement) && !document.activeElement?.closest(".mh-rename");
  drawn = inputs();
  layout = historyLayout(tree, layout && working(document.activeElement) ? layout.main : undefined, trees, shownKey());
  const ids = new Set(layout.rows.map((row) => row.key));
  for (const id of [...rowEls.keys()]) {
    if (ids.has(id)) continue;
    rowEls.get(id)!.remove();
    rowEls.delete(id);
    rowSigs.delete(id);
  }
  if (focusId != null && !ids.has(focusId)) focusId = null;
  const els = layout.rows.map((row) => {
    let el = rowEls.get(row.key);
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("role", "treeitem");
      el.className = "mh-row";
      el.dataset.row = row.key;
      el.dataset.id = String(row.id);
      el.id = rowElementId(row.key);
      rowEls.set(row.key, el);
    }
    const sig = JSON.stringify([row, layout!.lanes]);
    // A row being renamed keeps its field; it is painted when the name is done.
    if (row.key !== renaming && rowSigs.get(row.key) !== sig) {
      paintRow(el, row, layout!.lanes);
      rowSigs.set(row.key, sig);
    }
    return el;
  });
  const order = [...list.children];
  if (order.length !== els.length || els.some((el, i) => order[i] !== el)) list.replaceChildren(...els);
  applyTabIndex();
  const onScreen = rowEls.get(hadFocus ? focusId ?? shownKey() : shownKey());
  if (hadFocus) onScreen?.focus({ preventScroll: true });
  if (onScreen) reveal(onScreen);
}

function paintRow(el: HTMLElement, row: HistoryRow, lanes: number) {
  el.dataset.state = row.state;
  el.toggleAttribute("data-broken", !!row.broken);
  el.toggleAttribute("data-blocked", row.blocked);
  el.setAttribute("aria-level", String(row.level));
  el.setAttribute("aria-selected", row.state === "current" ? "true" : "false");
  // A fork, and a join with its tool's lane, are parents in the tree: the lane's rows are drawn above the join but belong to it.
  if (row.fork || row.owns.length > 0) el.setAttribute("aria-expanded", "true");
  else el.removeAttribute("aria-expanded");
  if (row.owns.length > 0) el.setAttribute("aria-owns", row.owns.map(rowElementId).join(" "));
  else el.removeAttribute("aria-owns");
  el.toggleAttribute("data-tool", row.tool != null);
  const notes = [row.broken ? "cannot be rebuilt" : "", row.blocked ? "after a step that cannot be rebuilt" : "", row.plate ? "on the plate" : ""].filter(Boolean);
  el.setAttribute("aria-label", [row.tool != null ? `${row.tool}: ${row.label}` : row.label, ...notes].join(", "));
  // A label can be longer than the row, which ellipsizes it: the tip has it whole. The description adds
  // only what the name does not say: a renamed step's op, why a step is broken, and whose step a tool's is.
  const whose = row.tool != null ? `A step of ${row.tool}, as this part's join takes it. Click to look at it; Edit step changes it here` : "";
  const extra = [row.opLabel, row.broken, whose].filter(Boolean).join(". ");
  el.dataset.tip = [row.label, extra].filter(Boolean).join(". ");
  if (extra) el.setAttribute("aria-description", extra);
  else el.removeAttribute("aria-description");

  // The label and the buttons stay in place, so a double-click across a repaint still lands on one label.
  let label = el.querySelector<HTMLElement>(":scope > .mh-label");
  let edit = el.querySelector<HTMLButtonElement>(":scope > .mh-edit");
  let more = el.querySelector<HTMLElement>(":scope > .mh-more");
  if (!label || !edit || !more) {
    label = document.createElement("span");
    label.className = "mh-label";
    edit = document.createElement("button");
    edit.type = "button";
    edit.className = "mh-edit";
    edit.tabIndex = -1;
    edit.dataset.tip = "Edit step";
    edit.append(icon(Pencil, 12));
    more = document.createElement("button");
    (more as HTMLButtonElement).type = "button";
    more.className = "mh-more";
    more.tabIndex = -1;
    more.setAttribute("aria-label", "Step actions");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-controls", "modelHistoryMenu");
    more.setAttribute("aria-expanded", "false");
    more.append(icon(Ellipsis));
    el.replaceChildren(label, edit, more);
  }
  label.textContent = row.label;
  // A step that cannot be edited (the opened file, a step under a broken one) shows no pencil; its menu says why.
  edit.hidden = !!hooks?.editRefusal(row.key);
  edit.setAttribute("aria-label", `Edit step: ${row.label}`);
  el.querySelectorAll(":scope > .mh-rail, :scope > .mh-warn, :scope > .mh-plate, :scope > .mh-tool").forEach((node) => node.remove());
  label.before(railSvg(row, lanes));
  if (row.toolStart && row.tool != null && row.tool !== row.label) {
    // The lane's first row names whose steps these are, so the merge reads at a glance.
    const chip = document.createElement("span");
    chip.className = "mh-tool";
    chip.textContent = row.tool;
    chip.setAttribute("aria-hidden", "true");
    label.before(chip);
  }
  if (row.broken) {
    const warn = document.createElement("span");
    warn.className = "mh-warn";
    warn.append(icon(TriangleAlert, 12));
    edit.before(warn);
  }
  if (row.plate) {
    const chip = document.createElement("span");
    chip.className = "mh-plate";
    chip.textContent = "Plate";
    chip.dataset.tip = "The plate shows this step until you leave Model.";
    edit.before(chip);
  }
}

const SVG = "http://www.w3.org/2000/svg";

/** The row's slice of the graph: lines run the full row height, the dot sits in the middle. */
function railSvg(row: HistoryRow, lanes: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "mh-rail");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", String(lanes * LANE_PX));
  const x = (lane: number) => String(LANE_PX / 2 + lane * LANE_PX);
  const line = (x1: string, y1: string, x2: string, y2: string, hot: boolean) => {
    const el = document.createElementNS(SVG, "line");
    for (const [name, value] of [["x1", x1], ["y1", y1], ["x2", x2], ["y2", y2]] as const) el.setAttribute(name, value);
    el.setAttribute("class", hot ? "hot" : "");
    svg.append(el);
  };
  for (const pass of row.through) line(x(pass.lane), "0", x(pass.lane), "100%", pass.hot);
  if (row.up) line(x(row.lane), "0", x(row.lane), "50%", row.up.hot);
  if (row.down) line(x(row.lane), "50%", x(row.lane), "100%", row.down.hot);
  for (const fork of row.forks) line(x(row.lane), "50%", x(fork.lane), "100%", fork.hot);
  for (const merge of row.merges) line(x(merge.lane), "0", x(row.lane), "50%", merge.hot);
  const dot = document.createElementNS(SVG, "circle");
  dot.setAttribute("cx", x(row.lane));
  dot.setAttribute("cy", "50%");
  dot.setAttribute("r", row.state === "current" ? "4.5" : "3.5");
  svg.append(dot);
  return svg;
}

/** A row's element id, for the join that owns it. */
function rowElementId(key: RowKey): string {
  return `mhRow-${key.replaceAll("/", "-")}`;
}

function applyTabIndex() {
  const target = focusId ?? (tree ? shownKey() : null);
  for (const [key, el] of rowEls) el.tabIndex = key === target ? 0 : -1;
}

function rowOf(target: EventTarget | null): RowKey | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(".mh-row") : null;
  return el?.dataset.row ?? null;
}

function setFocus(id: RowKey, move: boolean) {
  focusId = id;
  applyTabIndex();
  if (move) focusRow(id);
}

function focusRow(id: RowKey) {
  if (visible() && changed()) render();
  const el = rowEls.get(id);
  if (!el) return;
  focusId = id;
  applyTabIndex();
  el.focus({ preventScroll: true });
  reveal(el);
}

/** Scroll the list, and only the list, so the row is in view. */
function reveal(el: HTMLElement) {
  if (!list) return;
  const top = el.offsetTop;
  const bottom = top + el.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

function jumpNow(id: RowKey) {
  cancelJump();
  hooks?.jump(id);
}

/** The tree is `aria-busy` while a step waits out the typing pause. */
function jumpSoon(id: RowKey) {
  cancelJump();
  list?.setAttribute("aria-busy", "true");
  jumpTimer = window.setTimeout(() => {
    list?.removeAttribute("aria-busy");
    hooks?.jump(id);
  }, JUMP_WAIT_MS);
}

function cancelJump() {
  window.clearTimeout(jumpTimer);
  list?.removeAttribute("aria-busy");
}

/** A reason the panel gives itself, for the phone sheet that covers the readout. Empty clears it. */
function showNote(text: string) {
  if (!note) return;
  note.textContent = text;
  note.hidden = !text;
}

function onClick(ev: MouseEvent) {
  const id = rowOf(ev.target);
  if (id == null) return;
  showNote("");
  if ((ev.target as Element).closest(".mh-more")) {
    setFocus(id, true);
    openMenu(id);
    return;
  }
  if ((ev.target as Element).closest(".mh-edit")) {
    setFocus(id, false);
    editStep(id);
    return;
  }
  if ((ev.target as Element).closest(".mh-rename")) return;
  setFocus(id, true);
  jumpNow(id);
}

function onDoubleClick(ev: MouseEvent) {
  if (!(ev.target as Element).closest(".mh-label")) return;
  const id = rowOf(ev.target);
  if (id != null) startRename(id);
}

function onContextMenu(ev: MouseEvent) {
  const id = rowOf(ev.target);
  if (id == null) return;
  ev.preventDefault();
  setFocus(id, true);
  openMenu(id, { x: ev.clientX, y: ev.clientY });
}

function onKey(ev: KeyboardEvent) {
  if (!tree || !layout || (ev.target as Element).closest(".mh-rename")) return;
  const focused = rowOf(ev.target) ?? focusId ?? shownKey();
  const action = historyKey(ev, tree, layout, focused);
  if (!action) {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) ev.preventDefault();
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  showNote("");
  switch (action.kind) {
    case "move":
      setFocus(action.to, true);
      jumpSoon(action.to);
      return;
    case "jump":
      jumpNow(action.to);
      return;
    case "rename":
      startRename(action.id);
      return;
    case "drop":
      dropBranch(action.id);
      return;
    case "menu":
      openMenu(action.id);
      return;
    case "leave":
      leave();
      return;
  }
}

function leave() {
  cancelJump();
  if (focusId != null && tree && focusId !== shownKey()) hooks?.jump(focusId);
  const back = returnFocus?.isConnected ? returnFocus : document.querySelector<HTMLElement>("#model");
  returnFocus = null;
  if (isMobileLayout()) {
    setSheet(false, true);
    return;
  }
  back?.focus({ preventScroll: true });
}

/** Shift+E: edit the step focused in the panel, else the step shown. */
export function editModelStep() {
  if (!tree) return;
  if (list?.contains(document.activeElement)) editStep(focusId ?? shownKey());
  else hooks?.edit(null);
}

/** Edit `id`: its tool opens in the panel above, prefilled; a refusal is said in the readout, and in the sheet at phone width. */
function editStep(id: RowKey) {
  const refusal = hooks?.editRefusal(id) ?? null;
  if (refusal) showNote(refusal);
  else if (isMobileLayout()) setSheet(false, false);
  hooks?.edit(id);
}

function dropBranch(id: RowKey) {
  if (!tree || !hooks) return;
  const own = layout?.rows.find((row) => row.key === id);
  const up = own && own.via.length === 0 ? tree.nodes.get(own.id)?.parent ?? null : null;
  const parent = up == null ? null : rowKey([], up);
  const hadFocus = !!panel?.contains(document.activeElement);
  if (!hooks.drop(id)) {
    showNote(hooks.dropRefusal(id) ?? "");
    return;
  }
  if (hadFocus && parent != null) focusRow(parent);
}

function startRename(id: RowKey) {
  const el = rowEls.get(id);
  const row = layout?.rows.find((item) => item.key === id);
  const node = row ? (row.tree === tree?.key ? tree : trees.get(row.tree))?.nodes.get(row.id) : undefined;
  const label = el?.querySelector<HTMLElement>(".mh-label");
  if (!el || !node || !label) return;
  closeMenu(false);
  window.clearTimeout(jumpTimer);
  const input = document.createElement("input");
  input.className = "mh-rename";
  input.type = "text";
  input.value = node.name?.trim() || node.label;
  input.setAttribute("aria-label", "Step name");
  input.maxLength = 80;
  let done = false;
  const finish = (save: boolean, refocus: boolean) => {
    if (done) return;
    done = true;
    renaming = null;
    rowSigs.delete(id);
    const value = input.value.trim();
    if (save) hooks?.rename(id, value === node.label ? "" : value);
    // An unchanged name leaves the tree as it was: the row is painted again to drop the field.
    if (!changed()) {
      drawn = null;
      sync();
    }
    if (refocus) focusRow(id);
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true, true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false, true);
    }
  });
  input.addEventListener("blur", () => finish(true, false));
  renaming = id;
  label.replaceWith(input);
  input.focus();
  input.select();
}

function buildMenu(): HTMLElement {
  const root = document.createElement("div");
  root.id = "modelHistoryMenu";
  root.className = "mh-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", "Step");
  root.hidden = true;
  root.innerHTML = `
    <button type="button" role="menuitem" data-act="edit"><span>Edit step</span><kbd>Shift+E</kbd><small class="mh-why"></small></button>
    <button type="button" role="menuitem" data-act="rename"><span>Rename</span><kbd>F2</kbd></button>
    <button type="button" role="menuitem" data-act="drop"><span>Delete branch</span><kbd>Del</kbd><small class="mh-why"></small></button>`;
  root.addEventListener("click", (ev) => {
    const item = (ev.target as Element).closest<HTMLButtonElement>("[role=menuitem]");
    const id = root.dataset.row;
    if (!item || id == null) return;
    if (item.getAttribute("aria-disabled") === "true") return;
    closeMenu(false);
    if (item.dataset.act === "edit") editStep(id);
    else if (item.dataset.act === "rename") startRename(id);
    else dropBranch(id);
  });
  root.addEventListener("keydown", (ev) => {
    const items = [...root.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      items[(at + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (ev.key === "Escape" || ev.key === "Tab") {
      ev.preventDefault();
      closeMenu(true);
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    } else {
      return;
    }
    ev.stopPropagation();
  });
  document.addEventListener("pointerdown", (ev) => {
    if (!root.hidden && !(ev.target as Element).closest("#modelHistoryMenu, .mh-more")) closeMenu(false);
  });
  return root;
}

function openMenu(id: RowKey, at?: { x: number; y: number }) {
  const el = rowEls.get(id);
  if (!menu || !el || !hooks) return;
  menu.dataset.row = id;
  for (const [act, refusal] of [["edit", hooks.editRefusal(id)], ["drop", hooks.dropRefusal(id)]] as const) {
    const item = menu.querySelector<HTMLElement>(`[data-act="${act}"]`)!;
    item.setAttribute("aria-disabled", refusal ? "true" : "false");
    item.querySelector(".mh-why")!.textContent = refusal ?? "";
  }
  menu.hidden = false;
  el.querySelector(".mh-more")?.setAttribute("aria-expanded", "true");
  const box = el.getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = Math.min(at?.x ?? box.right - width, window.innerWidth - width - 8);
  const top = Math.min(at?.y ?? box.bottom, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
}

function closeMenu(refocus: boolean) {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const id = menu.dataset.row;
  if (id == null) return;
  rowEls.get(id)?.querySelector(".mh-more")?.setAttribute("aria-expanded", "false");
  if (refocus) focusRow(id);
}
