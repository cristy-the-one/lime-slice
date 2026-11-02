/**
 * Model's History panel: the open solid's history tree as a git graph, at the bottom left of the
 * canvas, or as a sheet at phone width. A click or Enter shows a step, arrows move and show it
 * after a typing pause, Left and Right switch branches. Rows are rebuilt only when the tree changes,
 * and only while the panel can be seen. Nothing here asks the engine anything.
 */
import { ChevronDown, ChevronRight, Ellipsis, History, Move3d, Pencil, Puzzle, RotateCcw, TriangleAlert, X, createElement, type IconNode } from "lucide";
import { historyFolds, historyKey, historyLayout, pluginStepView, positionText, presentedRows, readRow, rowCount, rowKey, type HistoryLayout, type HistoryRow, type PluginEnv, type PluginStepView, type PluginTitle, type RecipeNote, type RowKey } from "../model-history";
import type { ObjectFrame, PlaceFields } from "../model-space";
import { toolKeys, type ModelTree, type PluginStamp } from "../model-tree";
import { isMobileLayout } from "../platform";
import { state } from "../app/state";
import { openDock } from "./dock-reveal";

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
  /** Whether this row is a split to print for an export target, whose menu offers Export…. */
  exportable?(row: RowKey): boolean;
  /** Export… on that row: the save dialog for the pieces it left in Model. */
  exportPieces?(row: RowKey): void;
  /** The Position row was clicked: Place opens. */
  openPlace(): void;
  /** The Position row's Reset: the open object goes back to where its file put it, as one Place step. */
  resetPosition(): void;
  /** --- A10. The row under the pointer or focus, so its faces can tint. Null when neither is on a row. */
  highlight?(id: number | null): void;
  /**
   * --- A4. Ctrl-click (Cmd-click) a row while Pattern or Mirror is open. True consumes the click, so the view stays.
   * Absent, a Ctrl-click jumps as any other click does.
   */
  pickSource?(row: RowKey): boolean;
  /**
   * --- D29. Whether Pattern or Mirror is open. Then a click or a tap, Ctrl or not, and Enter or Space choose rows to
   * repeat, the arrows move without showing a step, and each row's `aria-selected` says whether it is chosen.
   */
  picking?(): boolean;
  /** --- Print transitions (decision 5). Re-aim: the stale steps rebuilt with the build direction of this pose. */
  reaim?(): void;
  /** Keep: the stale steps stay as built, and the note goes for this pose. */
  keepPose?(): void;
  /** --- Plugin steps (milestone 6). Null when plugins run here, else the sentence that says why not. */
  pluginRunner?(): Promise<string | null>;
  /**
   * Rebuild the row's plugin step with these values changed (and the code changed outside the app, when `edited`): the
   * row of the new run, or null when nothing was rebuilt (the readout says why).
   */
  pluginRebuild?(row: RowKey, changes: Record<string, number | boolean | string>, edited: boolean): Promise<{ row: RowKey } | { reason: string }>;
  /** --- Milestone 7, D9. Use vN: rebuild the row's plugin step with the library's newer version, values carried by name. */
  pluginUseVersion?(row: RowKey): Promise<{ row: RowKey } | { reason: string }>;
  /** --- Milestone 7, D1. Save as plugin…: keep the row's draft in the library with these words. */
  pluginSave?(row: RowKey, words: PluginSaveWords): Promise<{ text: string } | { reason: string }>;
  /** The "Plugin author" setting, to fill the dialog. */
  pluginAuthor?(): string;
}

/** What the Save as plugin… dialog asks for (D1). */
export interface PluginSaveWords {
  title: string;
  description: string;
  author: string;
}

/** --- A10. Colour by step paints a swatch on each row. Off, the swatches go and the rows repaint. */
let stepColourOf: ((id: number) => string) | null = null;

/**
 * A row's step colour. A tool lane's row is a step of another tree: its id names no face of this solid (the join
 * owns those), so it has no colour.
 */
function ownColour(row: { via: readonly number[]; id: number }): string | null {
  return stepColourOf && row.via.length === 0 ? stepColourOf(row.id) : null;
}

export function syncStepColours(on: boolean, colour: (id: number) => string) {
  stepColourOf = on ? colour : null;
  rowSigs.clear();
  drawn = null;
  sync();
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
/** The layout before composite runs are folded, so rows stay put while someone works in the list. */
let raw: HistoryLayout | null = null;
/** Runs the user opened, and runs they folded again. A run starts folded. */
const foldOpen = new Set<string>();
const foldShut = new Set<string>();
let recipeEl: HTMLElement | null = null;
/** --- Plugin steps (D8, D9). What the project carries of its plugins' code, the titles it gives their rows, and the card. */
let pluginEnv: PluginEnv | null = null;
let pluginTitle: PluginTitle | undefined;
let pluginEnvKey = 0;
let pluginCard: HTMLElement | null = null;
let pluginCardRow: RowKey | null = null;
/** The plugin the card shows, so it follows the step when a rebuild, Undo or Redo gives the run new rows. */
let pluginCardPlugin: string | null = null;
/** The card's step was on the way to the step shown, so the card moves with the part when an Undo changes branch. */
let pluginCardFollows = false;
/** The values typed into the card and not rebuilt yet, by name; kept while History repaints. */
const pluginDraft = new Map<string, number | boolean | string>();
/** Why plugins cannot run here (null: they can; undefined: not asked yet). */
let pluginRunnerNote: string | null | undefined;
/** A rebuild on its way: the card's controls wait for it. */
let pluginBusy = false;
/** --- D9. The project's copy was edited: the first Rebuild asks, the second runs the changed code. */
let pluginAsking = false;
/** Why the last Rebuild did not rebuild, shown until a value changes. */
let pluginFailure: string | null = null;
let sourceSheet: HTMLElement | null = null;
let sourceReturn: HTMLElement | null = null;
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
/** --- A4. History steps Pattern or Mirror will repeat. Only the open solid's own rows, via empty, are marked. --- */
let repeatIds = new Set<number>();
/** --- Print transitions. The open solid's steps made for another pose, and the note that says so with Re-aim and Keep. */
let staleIds = new Set<number>();
let staleKey = "";
let staleEl: HTMLElement | null = null;

/** The open solid's print transitions that were made for another pose: their rows turn amber, and the note offers Re-aim and Keep. */
export function syncTransitionStale(next: { ids: readonly number[]; text: string } | null) {
  const key = next && next.ids.length > 0 ? `${next.ids.join(",")}|${next.text}` : "";
  if (key === staleKey) return;
  staleKey = key;
  staleIds = new Set(next?.ids ?? []);
  if (staleEl) {
    staleEl.hidden = key === "";
    const text = staleEl.querySelector<HTMLElement>(".mh-stale-text");
    if (text) text.textContent = next?.text ?? "";
  }
  rowSigs.clear();
  drawn = null;
  sync();
}

/** Mark the open solid's own rows that a pattern or a mirror repeats. An empty list clears the marks. */
export function paintRepeatSources(ids: readonly number[]) {
  repeatIds = new Set(ids);
  if (!layout) return;
  for (const row of layout.rows) {
    const el = rowEls.get(row.key);
    if (el) paintChosen(el, row);
  }
}

function picking(): boolean {
  return hooks?.picking?.() ?? false;
}

/** --- D29. A row chosen to repeat, and what `aria-selected` says: the chosen rows while picking, else the shown step. */
function paintChosen(el: HTMLElement, row: HistoryRow) {
  const chosen = row.via.length === 0 && repeatIds.has(row.id);
  el.toggleAttribute("data-repeat", chosen);
  const on = picking();
  el.setAttribute("aria-selected", (on ? chosen : row.state === "current") ? "true" : "false");
  if (on) el.setAttribute("aria-current", row.state === "current" ? "step" : "false");
  else el.removeAttribute("aria-current");
  list?.setAttribute("aria-multiselectable", on ? "true" : "false");
}

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
  // --- A8. The recipe line sits with the header, so it shows while the tree is collapsed. ---
  recipeEl = document.querySelector<HTMLElement>("#modelRecipe");
  if (!recipeEl) {
    recipeEl = document.createElement("p");
    recipeEl.id = "modelRecipe";
    recipeEl.className = "mh-recipe";
    recipeEl.hidden = true;
    document.querySelector("#modelPosition")?.before(recipeEl);
  }
  staleEl = document.createElement("div");
  staleEl.className = "mh-stale";
  staleEl.id = "modelStaleNote";
  staleEl.setAttribute("role", "status");
  staleEl.hidden = true;
  const staleText = document.createElement("p");
  staleText.className = "mh-stale-text";
  const reaim = Object.assign(document.createElement("button"), { type: "button", className: "btn", id: "modelStaleReaim", textContent: "Re-aim" });
  reaim.dataset.tip = "Rebuild these steps with the build direction of this pose. The steps after them rebuild too.";
  const keep = Object.assign(document.createElement("button"), { type: "button", className: "btn", id: "modelStaleKeep", textContent: "Keep" });
  keep.dataset.tip = "Keep them as they are, made for the other pose. The note comes back if the pose changes again.";
  const actions = document.createElement("div");
  actions.className = "mh-stale-actions";
  actions.append(reaim, keep);
  staleEl.append(staleText, actions);
  reaim.addEventListener("click", () => hooks?.reaim?.());
  keep.addEventListener("click", () => hooks?.keepPose?.());
  list.before(staleEl);
  pluginCard = buildPluginCard();
  list.before(pluginCard);
  sourceSheet = buildSourceSheet();
  document.body.append(sourceSheet);
  saveSheet = buildSaveSheet();
  document.body.append(saveSheet);
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
    // --- A10.
    hooks?.highlight?.(rowNode(ev.target));
  });
  const rows = list;
  rows.addEventListener("pointerover", (ev) => hooks?.highlight?.(rowNode(ev.target)));
  rows.addEventListener("pointerleave", () => hooks?.highlight?.(rows.contains(document.activeElement) ? rowNode(document.activeElement) : null));
  rows.addEventListener("focusout", (ev) => {
    if (!rows.contains(ev.relatedTarget as Node) && !rows.matches(":hover")) hooks?.highlight?.(null);
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
    raw = null;
    foldOpen.clear();
    foldShut.clear();
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
  return [tree, shownKey(), staleKey, ...used];
}

/** A row of the open solid's own that is a print transition made for another pose. */
function staleRow(row: { via: readonly number[]; id: number }): boolean {
  return row.via.length === 0 && staleIds.has(row.id);
}

function changed(now = inputs()): boolean {
  return !same(drawn, now);
}

function same(was: readonly unknown[] | null, now: readonly unknown[]): boolean {
  return !!was && was.length === now.length && now.every((value, i) => was[i] === value);
}

/**
 * The Position row: the open object's pose as Place reads it, and Reset while it is not where its file put it. Only the
 * row's own text changes, so a Place drag never repaints the tree. Null with nothing open.
 */
export function syncModelPosition(fields: PlaceFields | null, atFile: boolean, frame: ObjectFrame | null = null) {
  // --- Assemblies M11. The row is the pose in model space, as the Place fields are; a member's tip names its frame.
  const text = fields ? positionText(fields) : "";
  const label = document.querySelector("#modelPositionText");
  const open = document.querySelector<HTMLElement>("#modelPositionOpen");
  const row = document.querySelector<HTMLElement>("#modelPosition");
  if (label && open && (label.textContent !== text || (row?.dataset.frame ?? "") !== (frame ?? ""))) {
    label.textContent = text;
    const numbers = frame === "part" ? " Its Model numbers are in its own frame." : frame === "model" ? " Its Model numbers are in model space." : "";
    open.setAttribute("aria-label", `Position: ${text}.${numbers} Opens Place.`);
    open.dataset.tip = `Where this ${frame ? "part sits in its assembly, in model space" : "object sits in model space"}: ${text}.${numbers} Click to open Place.`;
  }
  if (row) row.dataset.frame = frame ?? "";
  row?.classList.toggle("is-file", atFile && !!fields);
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
  else {
    // E3. History is in the Model dock: a closed dock opens, as the user asked for History.
    if (!panel.checkVisibility()) openDock("left");
    if (collapsed) setCollapsed(false);
  }
  focusRow(focusId ?? shownKey());
}

/** Someone is pointing or typing in the panel: rows must not move under them. */
function working(focused: EventTarget | null): boolean {
  return pointerIn || (focused instanceof Node && !!panel?.contains(focused));
}

/** Once nobody is working in the panel, the shown step's path moves onto the main rail. */
function relayout(focused: EventTarget | null) {
  if (!visible() || working(focused) || !raw || !tree) return;
  const fresh = historyLayout(tree, undefined, trees, shownKey());
  if (fresh.rows.every((row, i) => raw!.rows[i]?.key === row.key && raw!.rows[i]?.lane === row.lane)) return;
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
  else if (changed(now)) render();
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
  raw = historyLayout(tree, raw && working(document.activeElement) ? raw.main : undefined, trees, shownKey());
  const open = openFolds(raw);
  layout = { ...raw, rows: presentedRows(raw.rows, open, pluginTitle) };
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
    // --- A10. The swatch colour is part of the signature, so turning colour by step on repaints the rows.
    const sig = JSON.stringify([row, layout!.lanes, ownColour(row) ?? "", staleRow(row), row.plugin ? pluginEnvKey : 0]);
    // A row being renamed keeps its field; it is painted when the name is done.
    if (row.key !== renaming && rowSigs.get(row.key) !== sig) {
      paintRow(el, row, layout!.lanes);
      rowSigs.set(row.key, sig);
    }
    return el;
  });
  const order = [...list.children];
  if (order.length !== els.length || els.some((el, i) => order[i] !== el)) list.replaceChildren(...els);
  refreshPluginCard();
  applyTabIndex();
  const onScreen = rowEls.get(hadFocus ? focusId ?? shownRow() : shownRow());
  if (hadFocus) onScreen?.focus({ preventScroll: true });
  if (onScreen) reveal(onScreen);
}

/** Runs the user has opened. A run starts folded, including the one the view is inside. */
function openFolds(base: HistoryLayout): Set<string> {
  const live = new Set(historyFolds(base.rows).map((fold) => fold.id));
  for (const id of foldOpen) if (!live.has(id)) foldOpen.delete(id);
  for (const id of foldShut) if (!live.has(id)) foldShut.delete(id);
  const open = new Set<string>();
  for (const id of live) if (foldOpen.has(id) && !foldShut.has(id)) open.add(id);
  return open;
}

/** The row that stands for `key` while its composite is folded. */
function shownRow(): RowKey {
  const key = shownKey();
  const fold = layout?.rows.find((row) => row.fold && !row.fold.expanded && row.fold.keys.includes(key));
  return fold?.key ?? key;
}

/** A click or Enter on a folded row shows its last step. The view stays on that node. */
function jumpRow(id: RowKey): RowKey {
  const row = layout?.rows.find((item) => item.key === id);
  return row?.fold && !row.fold.expanded ? row.fold.lastKey : id;
}

function toggleFold(id: string) {
  const base = raw ?? layout;
  const fold = base ? historyFolds(base.rows).find((item) => item.id === id) : undefined;
  if (!fold) return;
  const open = foldOpen.has(id) && !foldShut.has(id);
  if (open) {
    foldOpen.delete(id);
    foldShut.add(id);
    focusId = id;
  } else {
    foldShut.delete(id);
    foldOpen.add(id);
    const shown = shownKey();
    focusId = fold.keys.includes(shown) ? shown : fold.keys[0]!;
  }
  drawn = null;
  sync();
}

/** The recipe the open object was built from, or nothing. The line is read-only. */
export function syncModelRecipe(note: RecipeNote | null) {
  if (!recipeEl) return;
  const text = note ? `${note.title}${note.detail ? ` ${note.detail}` : ""}` : "";
  if (recipeEl.textContent === text && recipeEl.hidden === !note) return;
  recipeEl.hidden = !note;
  recipeEl.replaceChildren();
  if (!note) return;
  const title = document.createElement("strong");
  title.textContent = note.title;
  recipeEl.append(title);
  if (note.detail) recipeEl.append(document.createTextNode(` ${note.detail}`));
}

function paintRow(el: HTMLElement, row: HistoryRow, lanes: number) {
  el.dataset.state = row.state;
  paintChosen(el, row);
  el.toggleAttribute("data-broken", !!row.broken);
  el.toggleAttribute("data-blocked", row.blocked);
  el.toggleAttribute("data-stale", staleRow(row));
  el.setAttribute("aria-level", String(row.level));
  // A folded composite hides its steps. A fork, and a join with its tool's lane, stay expanded: their rows are drawn.
  if (row.fold?.head) el.setAttribute("aria-expanded", row.fold.expanded ? "true" : "false");
  else if (row.fork || row.owns.length > 0) el.setAttribute("aria-expanded", "true");
  else el.removeAttribute("aria-expanded");
  const owned = [...row.owns, ...(row.fold?.head && row.fold.expanded ? row.fold.keys.slice(1) : [])];
  if (owned.length > 0) el.setAttribute("aria-owns", owned.map(rowElementId).join(" "));
  else el.removeAttribute("aria-owns");
  el.toggleAttribute("data-tool", row.tool != null);
  // --- Plugin steps (D9). A plugin step's row says, in one sentence, why it cannot be rebuilt.
  const view = pluginView(row);
  el.toggleAttribute("data-plugin", !!view);
  const notes = [row.broken ? "cannot be rebuilt" : "", row.blocked ? "after a step that cannot be rebuilt" : "", staleRow(row) ? "made for another pose" : "", row.plate ? "on the plate" : "", view ? `${view.kind}` : ""].filter(Boolean);
  const called = row.tool != null ? `${row.tool}: ${row.label}` : row.label;
  el.setAttribute("aria-label", [called, ...notes].join(", "));
  // A label can be longer than the row, which ellipsizes it: the tip has it whole. The description adds
  // only what the name does not say: a renamed step's op, why a step is broken, and whose step a tool's is.
  const whose = row.tool != null ? `A step of ${row.tool}, as this part's join takes it. Click to look at it; Edit step changes it here` : "";
  const extra = [row.opLabel, row.broken, staleRow(row) ? "Made for another pose: the layers have turned since. Re-aim or Keep it in the note above" : "", whose, view?.note?.replace(/\.$/, "") ?? ""].filter(Boolean).join(". ");
  el.dataset.tip = [row.label, extra].filter(Boolean).join(". ");
  if (extra) el.setAttribute("aria-description", extra);
  else el.removeAttribute("aria-description");

  // The label and the buttons stay in place, so a double-click across a repaint still lands on one label.
  let label = el.querySelector<HTMLElement>(":scope > .mh-label");
  let edit = el.querySelector<HTMLButtonElement>(":scope > .mh-edit");
  let more = el.querySelector<HTMLElement>(":scope > .mh-more");
  let foldBtn = el.querySelector<HTMLButtonElement>(":scope > .mh-fold");
  if (!label || !edit || !more || !foldBtn) {
    label = document.createElement("span");
    label.className = "mh-label";
    foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = "mh-fold";
    foldBtn.tabIndex = -1;
    foldBtn.append(icon(ChevronRight, 12));
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
    el.replaceChildren(foldBtn, label, edit, more);
  }
  label.textContent = row.label;
  const folding = !!row.fold?.head;
  foldBtn.hidden = !folding;
  if (folding) {
    const verb = row.fold!.expanded ? "Collapse" : "Expand";
    foldBtn.setAttribute("aria-label", `${verb} ${row.label}`);
    foldBtn.dataset.tip = row.fold!.expanded ? "Hide these steps" : "Show these steps";
  }
  // A folded run is not one step. A step that cannot be edited shows no pencil; its menu says why.
  edit.hidden = (!!row.fold && !row.fold.expanded) || !!hooks?.editRefusal(row.key);
  edit.setAttribute("aria-label", `Edit step: ${row.label}`);
  edit.dataset.tip = "Edit step";
  // A plugin step's pencil opens its values: the run is one step, whether folded or not.
  if (view) {
    edit.hidden = false;
    edit.setAttribute("aria-label", `Plugin values: ${row.label}`);
    edit.dataset.tip = "Plugin values";
  }
  el.querySelectorAll(":scope > .mh-rail, :scope > .mh-warn, :scope > .mh-plate, :scope > .mh-tool, :scope > .mh-swatch, :scope > .mh-plugin-mark").forEach((node) => node.remove());
  label.before(railSvg(row, lanes));
  // --- A10. The swatch sits after the rail and before the label, and only while colour by step is on.
  const colour = ownColour(row);
  if (colour) {
    const swatch = document.createElement("span");
    swatch.className = "mh-swatch";
    swatch.style.background = colour;
    swatch.setAttribute("aria-hidden", "true");
    label.before(swatch);
  }
  if (row.toolStart && row.tool != null && row.tool !== row.label) {
    // The lane's first row names whose steps these are, so the merge reads at a glance.
    const chip = document.createElement("span");
    chip.className = "mh-tool";
    chip.textContent = row.tool;
    chip.setAttribute("aria-hidden", "true");
    label.before(chip);
  }
  if (view) {
    const mark = document.createElement("span");
    mark.className = "mh-plugin-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.append(icon(Puzzle, 12));
    label.before(mark);
  }
  if (row.broken || staleRow(row) || view?.note) {
    const warn = document.createElement("span");
    warn.className = "mh-warn";
    warn.append(icon(TriangleAlert, 12));
    if (view?.note && !row.broken) warn.dataset.tip = view.note;
    edit.before(warn);
  }
  if (row.plate) {
    const chip = document.createElement("span");
    chip.className = "mh-plate";
    chip.textContent = "Plate";
    chip.dataset.tip = "This step is what the plate slices.";
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
  const target = focusId ?? (tree ? shownRow() : null);
  for (const [key, el] of rowEls) el.tabIndex = key === target ? 0 : -1;
}

function rowOf(target: EventTarget | null): RowKey | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(".mh-row") : null;
  return el?.dataset.row ?? null;
}

/** --- A10. The history node of the row under `target`, when it is a step of this solid; a tool lane's row is not. */
function rowNode(target: EventTarget | null): number | null {
  const key = rowOf(target);
  const row = key == null ? null : readRow(key);
  return row && row.via.length === 0 ? row.id : null;
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
  hooks?.jump(jumpRow(id));
}

/** The tree is `aria-busy` while a step waits out the typing pause. */
function jumpSoon(id: RowKey) {
  cancelJump();
  list?.setAttribute("aria-busy", "true");
  jumpTimer = window.setTimeout(() => {
    list?.removeAttribute("aria-busy");
    hooks?.jump(jumpRow(id));
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
  if ((ev.target as Element).closest(".mh-fold")) {
    const row = layout?.rows.find((item) => item.key === id);
    if (row?.fold) toggleFold(row.fold.id);
    return;
  }
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
  // --- A4, D29. While Pattern or Mirror is open, a click or a tap chooses a step to repeat and leaves the solid on
  // screen where it is. Ctrl-click does too, as before.
  if ((picking() || ev.ctrlKey || ev.metaKey) && hooks?.pickSource?.(id)) return;
  // A row Pattern cannot take says so and stays: a click while picking never shows another step.
  if (picking()) return;
  jumpNow(id);
}

function onDoubleClick(ev: MouseEvent) {
  if (!(ev.target as Element).closest(".mh-label")) return;
  const id = rowOf(ev.target);
  const row = id == null ? undefined : layout?.rows.find((item) => item.key === id);
  if (row?.fold && !row.fold.expanded) return;
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
  const action = historyKey(ev, tree, layout, focused, picking());
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
      if (!picking()) jumpSoon(action.to);
      return;
    case "pick":
      hooks?.pickSource?.(action.id);
      return;
    case "jump":
      jumpNow(action.to);
      return;
    case "expand":
    case "collapse":
      toggleFold(action.id);
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
  const staying = focusId == null ? null : jumpRow(focusId);
  if (staying != null && tree && staying !== shownKey()) hooks?.jump(staying);
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
  const own = layout?.rows.find((row) => row.key === id);
  if (own && pluginView(own)) {
    openPluginCard(id);
    return;
  }
  const folded = own?.fold;
  if (folded && !folded.expanded) {
    showNote("Expand the group to change one of its steps.");
    return;
  }
  const refusal = hooks?.editRefusal(id) ?? null;
  if (refusal) showNote(refusal);
  else if (isMobileLayout()) setSheet(false, false);
  hooks?.edit(id);
}

function dropBranch(id: RowKey) {
  if (!tree || !hooks) return;
  const folded = layout?.rows.find((row) => row.key === id)?.fold;
  if (folded && !folded.expanded) {
    showNote("Expand the group to change one of its steps.");
    return;
  }
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
    <button type="button" role="menuitem" data-act="values" hidden><span>Plugin values…</span></button>
    <button type="button" role="menuitem" data-act="source" hidden><span>View source</span><small class="mh-why"></small></button>
    <button type="button" role="menuitem" data-act="use" hidden data-tip="Rebuild this step with the newer version in your library. Values carry over by name; Undo goes back."><span>Use v2</span><small class="mh-why"></small></button>
    <button type="button" role="menuitem" data-act="save" hidden data-tip="Keep this recipe in your plugin library, with a title and a description, to run it on other parts."><span>Save as plugin…</span><small class="mh-why"></small></button>
    <button type="button" role="menuitem" data-act="rename"><span>Rename</span><kbd>F2</kbd></button>
    <button type="button" role="menuitem" data-act="export" hidden><span>Export…</span></button>
    <button type="button" role="menuitem" data-act="drop"><span>Delete branch</span><kbd>Del</kbd><small class="mh-why"></small></button>`;
  root.addEventListener("click", (ev) => {
    const item = (ev.target as Element).closest<HTMLButtonElement>("[role=menuitem]");
    const id = root.dataset.row;
    if (!item || id == null) return;
    if (item.getAttribute("aria-disabled") === "true") return;
    closeMenu(false);
    if (item.dataset.act === "edit") editStep(id);
    else if (item.dataset.act === "values") openPluginCard(id);
    else if (item.dataset.act === "source") openSource(id);
    else if (item.dataset.act === "use") void useNewer(id);
    else if (item.dataset.act === "save") openSaveDialog(id);
    else if (item.dataset.act === "export") hooks?.exportPieces?.(id);
    else if (item.dataset.act === "rename") startRename(id);
    else dropBranch(id);
  });
  root.addEventListener("keydown", (ev) => {
    const items = [...root.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([hidden])")];
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
  const folded = layout?.rows.find((row) => row.key === id)?.fold;
  const held = folded && !folded.expanded ? "Expand the group to change one of its steps." : null;
  const rename = menu.querySelector<HTMLElement>('[data-act="rename"]')!;
  rename.setAttribute("aria-disabled", held ? "true" : "false");
  menu.querySelector<HTMLElement>('[data-act="export"]')!.hidden = !hooks.exportable?.(id);
  // --- Plugin steps: the values and the code. Edit step is for one op, so a folded plugin run offers these instead.
  const view = pluginView(layout?.rows.find((row) => row.key === id));
  menu.querySelector<HTMLElement>('[data-act="values"]')!.hidden = !view;
  const source = menu.querySelector<HTMLElement>('[data-act="source"]')!;
  source.hidden = !view;
  source.setAttribute("aria-disabled", view && !view.source ? "true" : "false");
  source.querySelector(".mh-why")!.textContent = view && !view.source ? "This project does not carry the code." : "";
  // --- Milestone 7: Use vN for a newer library version (D9), Save as plugin… for a draft (D1).
  const use = menu.querySelector<HTMLElement>('[data-act="use"]')!;
  use.hidden = !view?.newer;
  use.querySelector("span")!.textContent = view?.newer ? `Use v${view.newer.version}` : "Use";
  const useWhy = view?.newer ? useRefusal(view) : null;
  use.setAttribute("aria-disabled", useWhy ? "true" : "false");
  use.querySelector(".mh-why")!.textContent = useWhy ?? "";
  const save = menu.querySelector<HTMLElement>('[data-act="save"]')!;
  save.hidden = !view?.draft || !hooks.pluginSave;
  const saveWhy = view?.draft ? saveRefusal(view) : null;
  save.setAttribute("aria-disabled", saveWhy ? "true" : "false");
  save.querySelector(".mh-why")!.textContent = saveWhy ?? "";
  menu.querySelector<HTMLElement>('[data-act="edit"]')!.hidden = !!view && !!folded && !folded.expanded;
  for (const [act, refusal] of [["edit", held ?? hooks.editRefusal(id)], ["drop", held ?? hooks.dropRefusal(id)]] as const) {
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

/**
 * --- Plugin steps (D8, D9). What the open project carries of its plugins: their checked copies, its drafts, and
 * whether this app could run them. Rows of plugin steps are painted again with their titles and sentences.
 */
export function syncPluginSteps(env: PluginEnv | null) {
  pluginEnv = env;
  pluginEnvKey += 1;
  pluginTitle = env ? (stamp) => env.copies.get(stamp.sha256)?.file?.title : undefined;
  drawn = null;
  sync();
  refreshPluginCard();
}

/** The title the project's copy gives a plugin step, for the readout's "Stud row · plugin v3 undone." */
export function pluginStepTitle(stamp: PluginStamp): string | undefined {
  return pluginTitle?.(stamp);
}

/** A plugin run's own row (folded, a one-step run, or the first step of an open run): its card's contents. */
function pluginView(row: HistoryRow | undefined): PluginStepView | null {
  if (!row?.plugin || row.via.length > 0) return null;
  if (row.run?.n !== 1 && !row.fold?.head) return null;
  return pluginStepView(row.plugin, pluginEnv ?? { copies: new Map(), drafts: new Map(), mac: false });
}

function buildPluginCard(): HTMLElement {
  const card = document.createElement("section");
  card.className = "mh-plugin";
  card.id = "modelPluginCard";
  card.setAttribute("aria-labelledby", "modelPluginTitle");
  card.hidden = true;
  const head = document.createElement("div");
  head.className = "mh-plugin-head";
  const title = Object.assign(document.createElement("h3"), { id: "modelPluginTitle", className: "mh-plugin-title" });
  const kind = Object.assign(document.createElement("span"), { className: "mh-plugin-kind" });
  const close = Object.assign(document.createElement("button"), { type: "button", className: "mh-plugin-close" });
  close.setAttribute("aria-label", "Close plugin values");
  close.append(icon(X, 14));
  close.addEventListener("click", () => closePluginCard(true));
  head.append(icon(Puzzle, 14), title, kind, close);
  const meta = Object.assign(document.createElement("p"), { className: "mh-plugin-meta" });
  const note = Object.assign(document.createElement("p"), { className: "mh-plugin-note" });
  note.setAttribute("role", "status");
  const fields = Object.assign(document.createElement("div"), { className: "mh-plugin-fields" });
  fields.setAttribute("role", "group");
  fields.setAttribute("aria-label", "Values this step was built with");
  const hint = Object.assign(document.createElement("p"), { className: "mh-plugin-hint" });
  const actions = Object.assign(document.createElement("div"), { className: "mh-plugin-actions" });
  const view = Object.assign(document.createElement("button"), { type: "button", className: "btn", id: "modelPluginSourceOpen", textContent: "View source" });
  view.addEventListener("click", () => {
    if (pluginCardRow) openSource(pluginCardRow);
  });
  // --- Milestone 6. Reset puts back the values the step was built with; Rebuild runs the plugin with the new ones.
  const reset = Object.assign(document.createElement("button"), { type: "button", className: "btn", id: "modelPluginReset", textContent: "Reset" });
  reset.dataset.tip = "Back to the values this step was built with";
  reset.addEventListener("click", () => {
    pluginDraft.clear();
    pluginAsking = false;
    pluginFailure = null;
    refreshPluginCard();
  });
  const rebuild = Object.assign(document.createElement("button"), { type: "button", className: "btn primary", id: "modelPluginRebuild", textContent: "Rebuild" });
  rebuild.addEventListener("click", () => void rebuildFromCard());
  // --- Milestone 7. Use vN (a newer version in the library, D9) and Save as plugin… (a draft, D1).
  const use = Object.assign(document.createElement("button"), { type: "button", className: "btn", id: "modelPluginUse", textContent: "Use v2", hidden: true });
  use.addEventListener("click", () => {
    if (pluginCardRow) void useNewer(pluginCardRow);
  });
  const save = Object.assign(document.createElement("button"), { type: "button", className: "btn", id: "modelPluginSave", textContent: "Save as plugin…", hidden: true });
  save.addEventListener("click", () => {
    if (pluginCardRow) openSaveDialog(pluginCardRow);
  });
  actions.append(view, use, save, reset, rebuild);
  card.append(head, meta, note, fields, hint, actions);
  card.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closePluginCard(true);
  });
  return card;
}

function openPluginCard(id: RowKey) {
  if (pluginCardRow !== id) {
    pluginDraft.clear();
    pluginAsking = false;
    pluginFailure = null;
  }
  pluginCardRow = id;
  pluginCardPlugin = layout?.rows.find((row) => row.key === id)?.plugin?.plugin ?? null;
  if (pluginRunnerNote === undefined && hooks?.pluginRunner) {
    void hooks.pluginRunner().then((why) => {
      pluginRunnerNote = why;
      refreshPluginCard();
    });
  }
  refreshPluginCard();
  if (isMobileLayout()) setSheet(true, false);
  pluginCard?.querySelector<HTMLElement>(".mh-plugin-close")?.focus({ preventScroll: true });
}

function closePluginCard(refocus: boolean) {
  const id = pluginCardRow;
  pluginCardRow = null;
  pluginCardPlugin = null;
  pluginDraft.clear();
  pluginAsking = false;
  pluginFailure = null;
  if (pluginCard) pluginCard.hidden = true;
  if (refocus && id != null && rowEls.has(id)) focusRow(id);
}

/** The card follows its row: new values after a rebuild, gone when the row is. */
function refreshPluginCard() {
  if (!pluginCard) return;
  let row = pluginCardRow == null ? undefined : layout?.rows.find((item) => item.key === pluginCardRow);
  // A rebuild, an Undo or a Redo shows the run under other rows: the card follows the same plugin's step on the way to
  // the step shown. The other branch, still drawn beside it, is not the part as it stands.
  const onPath = (item: HistoryRow) => item.state === "current" || item.state === "past";
  // A card opened on the other branch on purpose stays there.
  if (pluginCardPlugin && (!row || (!onPath(row) && pluginCardFollows))) {
    const same = (layout?.rows ?? []).filter((item) => item.via.length === 0 && item.plugin?.plugin === pluginCardPlugin);
    const shown = [...same].reverse().find(onPath);
    const moved = shown ?? (row ? undefined : same.at(-1));
    if (moved && moved.key !== row?.key) {
      row = moved;
      pluginCardRow = row.key;
      pluginDraft.clear();
      pluginAsking = false;
      pluginFailure = null;
    }
  }
  pluginCardFollows = !!row && onPath(row);
  const view = pluginView(row);
  if (!view || !visible()) {
    pluginCard.hidden = true;
    if (!view) pluginCardRow = null;
    return;
  }
  pluginCard.hidden = false;
  pluginCard.querySelector(".mh-plugin-title")!.textContent = view.title;
  pluginCard.querySelector(".mh-plugin-kind")!.textContent = view.kind;
  const meta = pluginCard.querySelector<HTMLElement>(".mh-plugin-meta")!;
  meta.textContent = [view.description, view.author ? `By ${view.author}` : "", view.madeBy ? `made with ${view.madeBy}` : ""].filter(Boolean).join(" · ");
  meta.hidden = !meta.textContent;
  const note = pluginCard.querySelector<HTMLElement>(".mh-plugin-note")!;
  note.textContent = view.note ?? "";
  note.hidden = !view.note;
  const editable = view.rebuild !== "no" && pluginRunnerNote === null && !!hooks?.pluginRebuild;
  const fields = pluginCard.querySelector<HTMLElement>(".mh-plugin-fields")!;
  const focused = document.activeElement instanceof HTMLElement && fields.contains(document.activeElement) ? document.activeElement.dataset.name : undefined;
  fields.replaceChildren(...view.fields.map((field) => pluginField(field, editable && !pluginBusy)));
  if (focused) fields.querySelector<HTMLElement>(`[data-name="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  if (view.fields.length === 0) fields.append(Object.assign(document.createElement("p"), { className: "mh-plugin-empty", textContent: "This plugin takes no values." }));
  const hint = pluginCard.querySelector<HTMLElement>(".mh-plugin-hint")!;
  const problem = editable ? (draftProblem(view) ?? pluginFailure) : null;
  hint.textContent = pluginBusy
    ? "Rebuilding the step and the steps after it…"
    : pluginAsking
      ? "The step was built with other code. Rebuild with the project's changed copy? Its stamp then names the changed code."
      : problem
        ? problem
        : view.rebuild === "no"
          ? "The part stays as it was built, with every step after it."
          : pluginRunnerNote === undefined
              ? "Checking whether plugins run here…"
              : pluginRunnerNote
                ? `${pluginRunnerNote} The part stays as it was built.`
                : "Change a value, then Rebuild. The steps after it are built again, and Undo goes back to these values.";
  hint.classList.toggle("is-problem", !!problem && !pluginBusy && !pluginAsking);
  const changed = draftChanges(view);
  const rebuild = pluginCard.querySelector<HTMLButtonElement>("#modelPluginRebuild")!;
  const reset = pluginCard.querySelector<HTMLButtonElement>("#modelPluginReset")!;
  rebuild.hidden = !editable;
  reset.hidden = !editable;
  // Unchanged values rebuild too: that is how a person checks the plugin still builds what it built.
  rebuild.disabled = pluginBusy || (editable && !!draftProblem(view));
  rebuild.textContent = pluginBusy ? "Rebuilding…" : pluginAsking ? "Confirm" : "Rebuild";
  rebuild.dataset.tip = Object.keys(changed).length ? "Run the plugin with these values; one Undo goes back" : "Run the plugin again with the same values";
  reset.disabled = pluginBusy || (pluginDraft.size === 0 && !pluginAsking);
  pluginCard.toggleAttribute("aria-busy", pluginBusy);
  const source = pluginCard.querySelector<HTMLButtonElement>("#modelPluginSourceOpen")!;
  source.disabled = !view.source;
  source.dataset.tip = view.source ? "The plugin's code, read-only" : "This project does not carry the code.";
  // --- Milestone 7, D9: "v5 is in your library", with Use v5. Never automatic.
  note.classList.toggle("is-info", !!view.newer && !view.note);
  if (view.newer && !view.note) {
    note.textContent = `v${view.newer.version} is in your library.`;
    note.hidden = false;
  }
  const use = pluginCard.querySelector<HTMLButtonElement>("#modelPluginUse")!;
  use.hidden = !view.newer;
  use.textContent = view.newer ? `Use v${view.newer.version}` : "Use";
  const useWhy = view.newer ? useRefusal(view) : null;
  use.disabled = pluginBusy || !!useWhy;
  use.dataset.tip = useWhy ?? `Rebuild this step with v${view.newer?.version ?? ""} from your library. Values carry over by name; one Undo goes back.`;
  const save = pluginCard.querySelector<HTMLButtonElement>("#modelPluginSave")!;
  save.hidden = !view.draft || !hooks?.pluginSave;
  const saveWhy = saveRefusal(view);
  save.disabled = pluginBusy || !!saveWhy;
  save.dataset.tip = saveWhy ?? "Keep this recipe in your plugin library, with a title and a description, to run it on other parts.";
}

/** Why Use vN cannot run here, naming what to do, or null. */
function useRefusal(view: PluginStepView): string | null {
  if (!view.newer) return null;
  if (!hooks?.pluginUseVersion) return "Using another version needs the desktop app.";
  if (pluginRunnerNote) return `${pluginRunnerNote} The step stays as built.`;
  return null;
}

/** Why Save as plugin… cannot run here, naming what to do, or null. */
function saveRefusal(view: PluginStepView): string | null {
  if (!view.draft) return null;
  if (!hooks?.pluginSave) return "Saving a plugin needs the desktop app, which reads your plugin library.";
  if (pluginRunnerNote) return `${pluginRunnerNote} A save checks the plugin once with lust, so it waits for an app that has it.`;
  if (!view.source) return "This project does not carry the recipe's code, so it cannot be kept.";
  return null;
}

/** Use vN: the step rebuilds with the library's version; the card follows the new run. */
async function useNewer(id: RowKey) {
  const row = layout?.rows.find((item) => item.key === id);
  const view = pluginView(row);
  if (!view?.newer || !hooks?.pluginUseVersion || pluginBusy || useRefusal(view)) return;
  pluginBusy = true;
  refreshPluginCard();
  let done: { row: RowKey } | { reason: string } = { reason: "The step was not rebuilt." };
  try {
    done = await hooks.pluginUseVersion(id);
  } finally {
    pluginBusy = false;
  }
  if ("row" in done) {
    pluginDraft.clear();
    pluginFailure = null;
    if (pluginCardRow != null) pluginCardRow = done.row;
  } else pluginFailure = done.reason;
  refreshPluginCard();
}

// ---------------------------------------------------------------------------
// --- Milestone 7, D1. Save as plugin…: a small dialog, title, description and author, then the save's checks.
// ---------------------------------------------------------------------------

let saveSheet: HTMLElement | null = null;
let saveRow: RowKey | null = null;
let saveReturn: HTMLElement | null = null;

function buildSaveSheet(): HTMLElement {
  const sheet = document.createElement("div");
  sheet.id = "modelPluginSaveSheet";
  sheet.className = "sheet";
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "modelPluginSaveTitle");
  sheet.innerHTML = `
    <form class="sheet-card mh-save-card" novalidate>
      <div class="sheet-head"><h2 id="modelPluginSaveTitle">Save as plugin</h2></div>
      <p class="mh-save-sub">Keeps this recipe in your plugin library, so the Plugins panel and agents can run it on other parts. Saving builds it once with its own defaults.</p>
      <label class="mh-save-field"><span>Title</span><input id="modelPluginSaveName" type="text" maxlength="60" required spellcheck="false" autocomplete="off"></label>
      <label class="mh-save-field"><span>Description</span><textarea id="modelPluginSaveDesc" maxlength="280" rows="3"></textarea></label>
      <label class="mh-save-field"><span>Author</span><input id="modelPluginSaveAuthor" type="text" maxlength="60" placeholder="unknown" spellcheck="false" autocomplete="off"></label>
      <p class="mh-save-status" id="modelPluginSaveStatus" role="status" hidden></p>
      <div class="mh-save-actions"><button class="btn" type="button" data-act="cancel">Cancel</button><button class="btn primary" type="submit" id="modelPluginSaveGo">Save</button></div>
    </form>`;
  const form = sheet.querySelector("form")!;
  sheet.querySelector('[data-act="cancel"]')!.addEventListener("click", () => closeSaveDialog());
  sheet.addEventListener("pointerdown", (ev) => {
    if (ev.target === sheet) closeSaveDialog();
  });
  sheet.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closeSaveDialog();
  });
  sheet.querySelector("#modelPluginSaveName")!.addEventListener("input", () => paintSaveStatus(null));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void submitSave();
  });
  return sheet;
}

function openSaveDialog(id: RowKey) {
  const view = pluginView(layout?.rows.find((row) => row.key === id));
  if (!saveSheet || !view?.draft || saveRefusal(view)) return;
  saveRow = id;
  saveReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const name = saveSheet.querySelector<HTMLInputElement>("#modelPluginSaveName")!;
  name.value = view.title.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()).slice(0, 60);
  saveSheet.querySelector<HTMLTextAreaElement>("#modelPluginSaveDesc")!.value = view.description ?? "";
  saveSheet.querySelector<HTMLInputElement>("#modelPluginSaveAuthor")!.value = hooks?.pluginAuthor?.() ?? "";
  paintSaveStatus(null);
  saveSheet.hidden = false;
  name.focus();
  name.select();
}

function closeSaveDialog() {
  if (!saveSheet || saveSheet.hidden) return;
  saveSheet.hidden = true;
  saveRow = null;
  if (saveReturn?.isConnected) saveReturn.focus({ preventScroll: true });
  saveReturn = null;
}

function paintSaveStatus(text: string | null, problem = false) {
  const status = saveSheet?.querySelector<HTMLElement>("#modelPluginSaveStatus");
  if (!status) return;
  status.textContent = text ?? "";
  status.hidden = !text;
  status.classList.toggle("is-problem", problem);
}

async function submitSave() {
  if (!saveSheet || saveRow == null || !hooks?.pluginSave) return;
  const title = saveSheet.querySelector<HTMLInputElement>("#modelPluginSaveName")!.value.trim();
  if (!title) {
    paintSaveStatus("A plugin needs a title. Type one line, at most 60 characters.", true);
    saveSheet.querySelector<HTMLInputElement>("#modelPluginSaveName")!.focus();
    return;
  }
  const go = saveSheet.querySelector<HTMLButtonElement>("#modelPluginSaveGo")!;
  go.disabled = true;
  paintSaveStatus("Checking the plugin: one describe run, then one run with its defaults…");
  let done: { text: string } | { reason: string };
  try {
    done = await hooks.pluginSave(saveRow, {
      title,
      description: saveSheet.querySelector<HTMLTextAreaElement>("#modelPluginSaveDesc")!.value,
      author: saveSheet.querySelector<HTMLInputElement>("#modelPluginSaveAuthor")!.value,
    });
  } catch (err) {
    done = { reason: err instanceof Error ? err.message : String(err) };
  } finally {
    go.disabled = false;
  }
  if ("reason" in done) {
    paintSaveStatus(done.reason, true);
    return;
  }
  closeSaveDialog();
  refreshPluginCard();
}

/** A plugin's code, read-only, in the source sheet: the Plugins panel's View source. */
export function showPluginSource(title: string, sub: string, text: string) {
  if (!sourceSheet) return;
  sourceReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  sourceSheet.querySelector("#modelPluginSourceTitle")!.textContent = title;
  sourceSheet.querySelector(".mh-source-sub")!.textContent = sub;
  sourceSheet.querySelector(".mh-source code")!.textContent = text;
  sourceSheet.hidden = false;
  sourceSheet.querySelector<HTMLElement>('[data-act="close"]')?.focus();
}

/** One value: the one typed and not rebuilt yet, else the one the step was built with. Read-only where it cannot change. */
function pluginField(field: PluginStepView["fields"][number], editable: boolean): HTMLElement {
  const row = document.createElement("label");
  row.className = "mh-plugin-field";
  if (field.help) row.dataset.tip = field.help;
  const name = Object.assign(document.createElement("span"), { className: "mh-plugin-name", textContent: field.label });
  const value = pluginDraft.has(field.name) ? pluginDraft.get(field.name)! : field.value;
  const typed = pluginDraft.has(field.name) && String(pluginDraft.get(field.name)) !== String(field.value);
  const tail = Object.assign(document.createElement("span"), { className: "mh-plugin-unit" });
  let control: HTMLInputElement | HTMLSelectElement;
  if (field.kind === "toggle") {
    control = Object.assign(document.createElement("input"), { type: "checkbox", checked: value === true, disabled: !editable });
    control.addEventListener("change", () => noteDraft(field, (control as HTMLInputElement).checked));
  } else if (field.kind === "choice") {
    const select = document.createElement("select");
    select.disabled = !editable;
    for (const option of field.options?.length ? field.options : [String(value)]) select.append(new Option(option, option, false, option === String(value)));
    select.addEventListener("change", () => noteDraft(field, select.value));
    control = select;
  } else {
    const input = Object.assign(document.createElement("input"), { type: "text", readOnly: !editable, value: String(value) });
    input.inputMode = field.kind === "number" ? "decimal" : field.kind === "count" ? "numeric" : "text";
    input.spellcheck = false;
    input.addEventListener("input", () => {
      noteDraft(field, input.value, false);
      const changed = input.value.trim() !== String(field.value);
      input.toggleAttribute("data-typed", changed);
      tail.textContent = unitText(field, changed);
    });
    input.addEventListener("change", () => noteDraft(field, input.value));
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      noteDraft(field, input.value);
      void rebuildFromCard();
    });
    control = input;
  }
  control.classList.add("mh-plugin-control");
  control.dataset.name = field.name;
  control.toggleAttribute("data-typed", typed);
  control.setAttribute("aria-label", field.label);
  const range = field.kind === "number" || field.kind === "count" ? rangeText(field) : "";
  tail.textContent = unitText(field, typed);
  if (range) tail.title = range;
  row.append(name, control, tail);
  return row;
}

/** What follows a value: its unit, then "changed" for a typed one not rebuilt yet, else "default" when it was not given. */
function unitText(field: PluginStepView["fields"][number], changed: boolean): string {
  return [field.unit ?? "", changed ? "changed" : field.isDefault ? "default" : ""].filter(Boolean).join(" · ");
}

/** "1 to 10", for a number's tip and its refusal. */
function rangeText(field: PluginStepView["fields"][number]): string {
  if (field.min !== undefined && field.max !== undefined) return `${field.min} to ${field.max}`;
  if (field.min !== undefined) return `at least ${field.min}`;
  if (field.max !== undefined) return `at most ${field.max}`;
  return "";
}

/** A typed value kept in the draft, as text while it is being typed; `repaint` refreshes the card around it. */
function noteDraft(field: PluginStepView["fields"][number], raw: string | boolean, repaint = true) {
  pluginAsking = false;
  pluginFailure = null;
  if (typeof raw === "boolean" || field.kind === "choice" || field.kind === "text") pluginDraft.set(field.name, raw);
  else pluginDraft.set(field.name, raw.trim());
  if (repaint) refreshPluginCard();
  else syncRebuildButton();
}

/** While a value is typed, only the button and the hint follow; the field keeps the caret. */
function syncRebuildButton() {
  const row = pluginCardRow == null ? undefined : layout?.rows.find((item) => item.key === pluginCardRow);
  const view = pluginView(row);
  if (!pluginCard || !view) return;
  const problem = draftProblem(view);
  const hint = pluginCard.querySelector<HTMLElement>(".mh-plugin-hint")!;
  if (problem) hint.textContent = problem;
  else if (hint.classList.contains("is-problem")) hint.textContent = "Change a value, then Rebuild. The steps after it are built again, and Undo goes back to these values.";
  hint.classList.toggle("is-problem", !!problem);
  const rebuild = pluginCard.querySelector<HTMLButtonElement>("#modelPluginRebuild")!;
  rebuild.disabled = pluginBusy || !!problem;
  const reset = pluginCard.querySelector<HTMLButtonElement>("#modelPluginReset")!;
  reset.disabled = pluginBusy || pluginDraft.size === 0;
}

/** A typed number read as one, or null. Counts are whole. */
function draftNumber(field: PluginStepView["fields"][number], raw: number | boolean | string): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
  if (String(raw).trim() === "" || !Number.isFinite(n)) return null;
  return field.kind === "count" && !Number.isInteger(n) ? null : n;
}

/** The first typed value that cannot be built, said in one sentence; null when they all can. */
function draftProblem(view: PluginStepView): string | null {
  for (const field of view.fields) {
    if (!pluginDraft.has(field.name) || (field.kind !== "number" && field.kind !== "count")) continue;
    const n = draftNumber(field, pluginDraft.get(field.name)!);
    if (n === null) return field.kind === "count" ? `${field.label} is a whole number.` : `${field.label} is a number.`;
    const range = rangeText(field);
    if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) return `${field.label} is ${range}${field.unit ? ` ${field.unit}` : ""}.`;
  }
  return null;
}

/** The typed values that differ from the step's, as the plugin takes them. */
function draftChanges(view: PluginStepView): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const field of view.fields) {
    if (!pluginDraft.has(field.name)) continue;
    const raw = pluginDraft.get(field.name)!;
    const value = field.kind === "number" || field.kind === "count" ? draftNumber(field, raw) : raw;
    if (value === null || value === field.value) continue;
    out[field.name] = value;
  }
  return out;
}

/** Rebuild: the plugin runs with the card's values; the card then shows the new run's. */
async function rebuildFromCard() {
  const id = pluginCardRow;
  const row = id == null ? undefined : layout?.rows.find((item) => item.key === id);
  const view = pluginView(row);
  if (!id || !view || pluginBusy || !hooks?.pluginRebuild || view.rebuild === "no" || pluginRunnerNote !== null || draftProblem(view)) return;
  if (view.rebuild === "ask" && !pluginAsking) {
    pluginAsking = true;
    refreshPluginCard();
    pluginCard?.querySelector<HTMLElement>("#modelPluginRebuild")?.focus({ preventScroll: true });
    return;
  }
  const changes = draftChanges(view);
  pluginBusy = true;
  refreshPluginCard();
  let done: { row: RowKey } | { reason: string } = { reason: "The step was not rebuilt." };
  try {
    done = await hooks.pluginRebuild(id, changes, view.rebuild === "ask");
  } finally {
    pluginBusy = false;
    pluginAsking = false;
  }
  if ("row" in done) {
    pluginDraft.clear();
    pluginCardRow = done.row;
    pluginFailure = null;
  } else pluginFailure = done.reason;
  refreshPluginCard();
  pluginCard?.querySelector<HTMLElement>("#modelPluginRebuild")?.focus({ preventScroll: true });
}

function buildSourceSheet(): HTMLElement {
  const sheet = document.createElement("div");
  sheet.id = "modelPluginSource";
  sheet.className = "sheet";
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "modelPluginSourceTitle");
  sheet.innerHTML = `
    <div class="sheet-card mh-source-card">
      <div class="sheet-head"><h2 id="modelPluginSourceTitle"></h2><button class="btn" type="button" data-act="close">Close</button></div>
      <p class="mh-source-sub"></p>
      <pre class="mh-source" tabindex="0"><code></code></pre>
    </div>`;
  sheet.querySelector('[data-act="close"]')!.addEventListener("click", () => closeSource());
  sheet.addEventListener("pointerdown", (ev) => {
    if (ev.target === sheet) closeSource();
  });
  sheet.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closeSource();
  });
  return sheet;
}

/** The plugin's code in a read-only sheet: the file as the project carries it, or a draft's source. */
function openSource(id: RowKey) {
  const view = pluginView(layout?.rows.find((row) => row.key === id));
  if (!sourceSheet || !view?.source) return;
  sourceReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  sourceSheet.querySelector("#modelPluginSourceTitle")!.textContent = `${view.title} · ${view.kind}`;
  sourceSheet.querySelector(".mh-source-sub")!.textContent = "Read-only. This is the code the step was built with, as the project carries it.";
  sourceSheet.querySelector(".mh-source code")!.textContent = view.source;
  sourceSheet.hidden = false;
  sourceSheet.querySelector<HTMLElement>('[data-act="close"]')?.focus();
}

function closeSource() {
  if (!sourceSheet || sourceSheet.hidden) return;
  sourceSheet.hidden = true;
  if (sourceReturn?.isConnected) sourceReturn.focus({ preventScroll: true });
  sourceReturn = null;
}
