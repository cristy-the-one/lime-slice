/**
 * P3. The selection bar on the model view.
 * Buttons come from `registerContextAction`. This file only places them and runs them.
 */
import {
  actionsFor,
  boxesOverlap,
  CONTEXT_FADE_MS,
  CONTEXT_GAP_PX,
  CONTEXT_HOVER_PX,
  onContextActions,
  seatContextBar,
  type ContextAction,
  type ContextBox,
  type ContextKind,
  type ContextMenuItem,
  type ContextPick,
  type Vec3,
} from "./context-bar.ts";

export interface ContextBarState {
  kind: ContextKind;
  picks: readonly ContextPick[];
  /** The click, in page pixels. Null when the bar is following a selection with no fresh click. */
  pointer: { x: number; y: number } | null;
  /** A model-space point the bar follows while the camera moves. */
  anchor: Vec3 | null;
}

interface ContextBarHooks {
  /** A model-space point, in page pixels. Null when it is behind the camera. */
  project(at: Vec3): { x: number; y: number } | null;
}

const VIEW_CUBE_PX = 128;
// E3. Over the view sit only the pick filter, the empty card and a drag's sizes; a drawer covers the view too, and on the
// phone the readout, its chips and the Model sheets do.
const OBSTACLES = ["#modelPick", "#modelEmpty", ".interact-hud", ".workspace.is-drawers .dock", "#compactModelFoot", ".layout-compact #modelDock > :is(#modelPanel, #sketchCards, #modelHistory, #modelParams)"];

let hooks: ContextBarHooks | null = null;
let bar: HTMLElement | null = null;
let menu: HTMLElement | null = null;
let pending: ContextBarState | null = null;
let anchorPage: { x: number; y: number } | null = null;
/** The camera text when the bar was shown. A later change follows the selection instead of the click. */
let shownCamera: string | null = null;
let timer = 0;
let faded = false;
let menuAction: ContextAction | null = null;

function host(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#modelBody");
}

function canvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>("#model");
}

function toolOpen(): boolean {
  return !!document.querySelector<HTMLElement>("#modelBar")?.dataset.tool;
}

/** A sketch is being chosen or drawn: its card and tools own the view, and the face's actions are not for it. A pinned card does not. */
function sketching(): boolean {
  const phase = canvas()?.dataset.sketch;
  return phase === "editing" || phase === "choosing";
}

function pageBox(node: Element): ContextBox | null {
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function hidden(node: Element): boolean {
  return node instanceof HTMLElement && node.hidden;
}

/** Chrome and messages, in page pixels, inflated a little so the bar is not flush against them. */
function obstacleBoxes(): ContextBox[] {
  const boxes: ContextBox[] = [];
  const pad = 4;
  for (const selector of OBSTACLES) {
    for (const node of document.querySelectorAll(selector)) {
      if (hidden(node) || node.closest("[hidden]")) continue;
      const box = pageBox(node);
      if (box) boxes.push({ x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 });
    }
  }
  for (const node of document.querySelectorAll("#modelBody .measure text, #modelBody .measure .m-scale")) {
    const box = pageBox(node);
    if (box) boxes.push(box);
  }
  return boxes;
}

/** The solid's screen box and the view cube, in page pixels. */
function solidAndCube(): { solid: ContextBox | null; cube: ContextBox | null } {
  const node = canvas();
  if (!node) return { solid: null, cube: null };
  const frame = node.getBoundingClientRect();
  const text = node.dataset.solidScreen;
  let solid: ContextBox | null = null;
  if (text) {
    const [x, y, width, height] = text.split(",").map(Number);
    if ([x, y, width, height].every((value) => Number.isFinite(value)) && width > 1 && height > 1) {
      solid = { x: frame.left + x!, y: frame.top + y!, width: width!, height: height! };
    }
  }
  const cube: ContextBox = {
    x: frame.right - VIEW_CUBE_PX,
    y: frame.bottom - VIEW_CUBE_PX,
    width: VIEW_CUBE_PX,
    height: VIEW_CUBE_PX,
  };
  return { solid, cube };
}

function toolbarReady(selector: string | undefined): boolean {
  if (!selector) return true;
  const button = document.querySelector<HTMLButtonElement>(selector);
  return !!button && !button.disabled;
}

function listed(action: ContextAction): boolean {
  return toolbarReady(action.toolbar);
}

function pressToolbar(selector: string | undefined): void {
  if (!selector) return;
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button || button.disabled) return;
  // The toolbar toggles. A second press would close the tool the bar just opened.
  if (button.getAttribute("aria-pressed") === "true") return;
  button.click();
}

/** `keyboard` is an activation from Enter or Space (a click with no pointer detail): only then the focus follows. */
function activate(toolbar: string | undefined, then: string | undefined, run: (() => void) | undefined, keyboard = false): void {
  pressToolbar(toolbar);
  if (then) document.querySelector<HTMLButtonElement>(then)?.click();
  run?.();
  closeMenu();
  if (keyboard) focusPanel();
}

/**
 * The bar hides once its action opens a tool, and the focus would fall to the page. It goes to the panel's first
 * field instead, so the size can be typed at once and the keyboard stays where the work is.
 */
function focusPanel() {
  const panel = document.querySelector<HTMLElement>("#modelPanel");
  if (!panel || panel.hidden) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !bar?.contains(active) && !menu?.contains(active)) return;
  const shown = (node: HTMLElement) => !node.closest("[hidden]") && !(node as HTMLInputElement).disabled && node.getClientRects().length > 0;
  // A size field first (Fillet's Size, not its Picked mode button), then any control.
  const field = [...panel.querySelectorAll<HTMLElement>("input:not([type=hidden]):not([type=checkbox]), select, textarea")].find(shown)
    ?? [...panel.querySelectorAll<HTMLElement>("input, button")].find(shown);
  field?.focus();
  if (field instanceof HTMLInputElement && field.type !== "checkbox") field.select();
}

function publish(kind: string) {
  const node = canvas();
  if (!node) return;
  if (kind) node.dataset.selectionBar = kind;
  else delete node.dataset.selectionBar;
}

/** Escape collapses onto the chip; the focus that follows must not immediately open the bar again. */
let collapseLock = false;

function restoreButton(): HTMLButtonElement | null {
  return bar?.querySelector<HTMLButtonElement>("#contextBarRestore") ?? null;
}

/** The buttons a key should move through: the chip while faded, the actions otherwise. */
function barButtons(): HTMLButtonElement[] {
  if (!bar) return [];
  return [...bar.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    faded ? button.id === "contextBarRestore" : button.id !== "contextBarRestore",
  );
}

/**
 * Faded, the actions hide and a "Selection" chip stays where the bar was. The chip is the way back:
 * click it, tab to it, or press Ctrl+.
 */
function setFaded(next: boolean) {
  const was = faded;
  if (was === next) return;
  faded = next;
  if (!bar) return;
  bar.classList.toggle("is-faded", next);
  bar.dataset.faded = next ? "1" : "0";
  const restore = restoreButton();
  bar.querySelectorAll<HTMLButtonElement>("button:not(#contextBarRestore)").forEach((button) => {
    button.setAttribute("aria-hidden", next ? "true" : "false");
    if (next) button.tabIndex = -1;
  });
  if (restore) restore.tabIndex = next ? 0 : -1;
  if (!next) rove(null);
  if (was && !next && document.activeElement === restore) barButtons()[0]?.focus();
  if (was !== next) requestAnimationFrame(() => reseat());
}

function armFade() {
  window.clearTimeout(timer);
  if (faded) setFaded(false);
  else if (bar) bar.dataset.faded = "0";
  timer = window.setTimeout(() => {
    // A keyboard user reading the bar keeps it: it fades once the focus has left.
    if (bar?.contains(document.activeElement)) return;
    setFaded(true);
  }, CONTEXT_FADE_MS);
}

function stopFade() {
  window.clearTimeout(timer);
  if (faded) setFaded(false);
  if (bar) delete bar.dataset.faded;
}

function nearSelection(ev: { clientX: number; clientY: number }): boolean {
  if (!bar) return false;
  const rect = bar.getBoundingClientRect();
  const grown = { x: rect.x - 8, y: rect.y - 8, width: rect.width + 16, height: rect.height + 16 };
  if (boxesOverlap(grown, { x: ev.clientX, y: ev.clientY, width: 1, height: 1 })) return true;
  if (!anchorPage) return false;
  return Math.hypot(ev.clientX - anchorPage.x, ev.clientY - anchorPage.y) <= CONTEXT_HOVER_PX;
}

function closeMenu() {
  if (!menu) return;
  menu.hidden = true;
  menu.replaceChildren();
  menuAction = null;
  bar?.querySelectorAll<HTMLButtonElement>("[aria-expanded]").forEach((button) => button.setAttribute("aria-expanded", "false"));
}

function placeMenu(anchor: HTMLElement) {
  if (!menu || menu.hidden) return;
  menu.style.visibility = "hidden";
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const rect = anchor.getBoundingClientRect();
  const { solid } = solidAndCube();
  const obstacles = [...obstacleBoxes(), ...(solid ? [solid] : [])];
  const candidates = [
    { x: rect.left, y: rect.top - height - 4 },
    { x: rect.right - width, y: rect.top - height - 4 },
    { x: rect.left, y: rect.bottom + 4 },
    { x: rect.right - width, y: rect.bottom + 4 },
  ];
  const fits = (at: { x: number; y: number }) => {
    if (at.x < 8 || at.y < 8 || at.x + width > window.innerWidth - 8 || at.y + height > window.innerHeight - 8) return false;
    const box = { ...at, width, height };
    return obstacles.every((obstacle) => !boxesOverlap(box, obstacle));
  };
  const at = candidates.find(fits) ?? candidates[0]!;
  menu.style.left = `${Math.max(8, at.x)}px`;
  menu.style.top = `${Math.max(8, at.y)}px`;
  menu.style.visibility = "";
}

function openMenu(action: ContextAction, anchor: HTMLButtonElement) {
  if (!menu) return;
  if (menuAction?.id === action.id && !menu.hidden) {
    closeMenu();
    return;
  }
  closeMenu();
  menuAction = action;
  anchor.setAttribute("aria-expanded", "true");
  for (const item of action.menu ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-bar-item";
    button.role = "menuitem";
    button.dataset.action = item.id;
    button.textContent = item.label;
    button.addEventListener("click", (ev) => activate(item.toolbar ?? action.toolbar, item.then, item.run, ev.detail === 0));
    menu.append(button);
  }
  menu.hidden = false;
  placeMenu(anchor);
  menu.querySelector<HTMLButtonElement>("button")?.focus();
}

function buttonOf(action: ContextAction, item: ContextMenuItem | null, className: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.action = item?.id ?? action.id;
  button.textContent = item?.label ?? action.label;
  const tip = item?.tip ?? action.tip ?? action.label;
  button.dataset.tip = tip;
  const command = action.command;
  if (command && !item) button.dataset.command = command;
  return button;
}

/** A toolbar is one Tab stop: the arrows move inside it, and the button last focused is the one Tab comes back to. */
function rove(to: HTMLButtonElement | null) {
  if (!bar) return;
  const buttons = barButtons();
  const keep = to && buttons.includes(to) ? to : buttons[0];
  for (const button of buttons) button.tabIndex = button === keep ? 0 : -1;
  const restore = restoreButton();
  if (restore && !faded) restore.tabIndex = -1;
}

function renderButtons(actions: ContextAction[]) {
  if (!bar) return;
  const restore = restoreButton();
  bar.replaceChildren();
  for (const action of actions) {
    if (!action.menu?.length) {
      const button = buttonOf(action, null, "context-bar-btn");
      button.addEventListener("click", (ev) => activate(action.toolbar, undefined, action.run, ev.detail === 0));
      bar.append(button);
      continue;
    }
    const group = document.createElement("span");
    group.className = "context-bar-split";
    const main = buttonOf(action, null, "context-bar-btn");
    main.addEventListener("click", (ev) => activate(action.toolbar, undefined, action.run, ev.detail === 0));
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "context-bar-caret";
    caret.dataset.action = `${action.id}-menu`;
    caret.textContent = "▾";
    caret.setAttribute("aria-label", `${action.label} menu`);
    caret.setAttribute("aria-haspopup", "menu");
    caret.setAttribute("aria-expanded", "false");
    caret.setAttribute("aria-controls", "modelContextMenu");
    caret.dataset.tip = action.tip ?? action.label;
    if (action.command) caret.dataset.command = action.command;
    caret.addEventListener("click", () => openMenu(action, caret));
    group.append(main, caret);
    bar.append(group);
  }
  if (restore) bar.append(restore);
  rove(null);
}

function reseat() {
  if (!bar || bar.hidden || !pending) return;
  const node = canvas();
  const parent = host();
  if (!node || !parent) return;
  const frame = parent.getBoundingClientRect();
  const view = node.getBoundingClientRect();
  const moved = (node.dataset.camera ?? "") !== (shownCamera ?? "");
  const projected = moved && pending.anchor ? hooks?.project(pending.anchor) ?? null : null;
  const point = projected ?? pending.pointer;
  if (!point) return;
  anchorPage = point;
  const { solid, cube } = solidAndCube();
  const local = (box: ContextBox): ContextBox => ({ x: box.x - view.left, y: box.y - view.top, width: box.width, height: box.height });
  const seat = seatContextBar({
    pointer: { x: point.x - view.left, y: point.y - view.top },
    bar: { width: bar.offsetWidth, height: bar.offsetHeight },
    bounds: { width: view.width, height: view.height },
    solid: solid ? local(solid) : null,
    obstacles: [...obstacleBoxes(), ...(cube ? [cube] : [])].map(local),
    gap: CONTEXT_GAP_PX,
  });
  bar.style.left = `${Math.round(view.left - frame.left + seat.x)}px`;
  bar.style.top = `${Math.round(view.top - frame.top + seat.y)}px`;
}

function render(state: ContextBarState) {
  if (!bar) return;
  pending = state;
  if (sketching()) {
    hideContextBar();
    return;
  }
  if (toolOpen() || host()?.hidden) {
    bar.hidden = true;
    closeMenu();
    stopFade();
    publish("");
    return;
  }
  const actions = actionsFor(state.kind).filter(listed);
  if (actions.length === 0) {
    hideContextBar();
    return;
  }
  renderButtons(actions);
  bar.dataset.kind = state.kind;
  bar.dataset.actions = actions.map((action) => action.id).join(",");
  bar.hidden = false;
  bar.setAttribute("aria-hidden", "false");
  publish(state.kind);
  if (shownCamera == null) shownCamera = canvas()?.dataset.camera ?? "";
  reseat();
  armFade();
}

/** Build the bar once. Safe to call again: the second call does nothing. */
export function mountContextBar(next: ContextBarHooks) {
  if (bar) {
    hooks = next;
    return;
  }
  hooks = next;
  const parent = host();
  if (!parent) return;
  bar = document.createElement("div");
  bar.id = "modelContextBar";
  bar.className = "context-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Selection");
  bar.hidden = true;
  const restore = document.createElement("button");
  restore.type = "button";
  restore.id = "contextBarRestore";
  restore.className = "context-bar-btn context-bar-restore";
  restore.textContent = "Selection";
  restore.dataset.tip = "Show selection actions";
  restore.tabIndex = -1;
  restore.addEventListener("click", () => {
    if (!bar || bar.hidden) return;
    armFade();
    barButtons()[0]?.focus();
  });
  bar.append(restore);
  parent.append(bar);

  menu = document.createElement("div");
  menu.id = "modelContextMenu";
  menu.className = "context-bar-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Selection menu");
  menu.hidden = true;
  document.body.append(menu);

  bar.addEventListener("keydown", onBarKey);
  menu.addEventListener("keydown", onMenuKey);
  bar.addEventListener("focusin", (ev) => {
    const onRestore = ev.target instanceof HTMLElement && ev.target.id === "contextBarRestore";
    if (!onRestore) rove(ev.target instanceof HTMLButtonElement ? ev.target : null);
    if (faded && !onRestore && !collapseLock) armFade();
  });
  bar.addEventListener("focusout", (ev) => {
    if (!bar?.contains(ev.relatedTarget as Node | null) && !bar?.hidden) armFade();
  });
  window.addEventListener("pointermove", (ev) => {
    if (!bar || bar.hidden) return;
    if (!faded) {
      armFade();
      return;
    }
    if (nearSelection(ev)) armFade();
  });
  window.addEventListener(
    "pointerdown",
    (ev) => {
      const target = ev.target instanceof Node ? ev.target : null;
      if (!target || bar?.contains(target) || menu?.contains(target)) return;
      closeMenu();
    },
    true,
  );
  const node = canvas();
  if (node) {
    let press: { x: number; y: number } | null = null;
    // On the window, in the capture phase: a face push, the edge knob and a handle drag stop the event on the canvas
    // itself, so a listener there never heard the drag that should take the bar away.
    window.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || ev.target !== node) return;
      press = { x: ev.clientX, y: ev.clientY };
    }, true);
    window.addEventListener("pointermove", (ev) => {
      if (!press || (ev.buttons & 1) === 0) return;
      if ((ev.clientX - press.x) ** 2 + (ev.clientY - press.y) ** 2 > 16) {
        press = null;
        hideContextBar();
      }
    }, true);
    const release = () => {
      press = null;
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    new MutationObserver(() => {
      if (pending && !bar?.hidden) reseat();
    }).observe(node, { attributes: true, attributeFilter: ["data-camera", "data-solid-screen"] });
    new MutationObserver(() => {
      if (sketching()) hideContextBar();
    }).observe(node, { attributes: true, attributeFilter: ["data-sketch"] });
  }
  const modelBar = document.querySelector("#modelBar");
  if (modelBar) {
    new MutationObserver(() => {
      if (pending) render(pending);
    }).observe(modelBar, { attributes: true, attributeFilter: ["data-tool"] });
  }
  new MutationObserver(() => {
    if (pending) render(pending);
  }).observe(parent, { attributes: true, attributeFilter: ["hidden"] });
  onContextActions(() => {
    if (pending) render(pending);
  });
}

/** Show the bar for this selection. A tool panel, or a drag, keeps it hidden. */
export function showContextBar(state: ContextBarState) {
  if (!bar) return;
  render(state);
}

/** Take the bar away until the next selection click. */
export function hideContextBar() {
  pending = null;
  anchorPage = null;
  shownCamera = null;
  if (bar) {
    bar.hidden = true;
    bar.removeAttribute("data-kind");
    bar.removeAttribute("data-actions");
  }
  closeMenu();
  stopFade();
  publish("");
}

function moveFocus(buttons: HTMLButtonElement[], step: number) {
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = buttons[(Math.max(0, index) + step + buttons.length) % buttons.length];
  next?.focus();
}

function onBarKey(ev: KeyboardEvent) {
  if (!bar) return;
  const target = ev.target instanceof HTMLButtonElement ? ev.target : null;
  if (!target || !bar.contains(target)) return;
  if (ev.key === "Escape") {
    // A second Escape, on the chip, clears the selection the way Esc does anywhere in Model.
    if (faded) return;
    ev.preventDefault();
    ev.stopPropagation();
    collapseLock = true;
    setFaded(true);
    restoreButton()?.focus();
    collapseLock = false;
    return;
  }
  if (ev.key === "Enter") {
    ev.stopPropagation();
    return;
  }
  if (ev.key === " ") {
    ev.preventDefault();
    ev.stopPropagation();
    target.click();
    return;
  }
  const buttons = barButtons();
  if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
    ev.preventDefault();
    ev.stopPropagation();
    moveFocus(buttons, ev.key === "ArrowRight" ? 1 : -1);
    return;
  }
  if (ev.key === "ArrowDown" && target.getAttribute("aria-haspopup") === "menu") {
    ev.preventDefault();
    ev.stopPropagation();
    target.click();
  }
}

function onMenuKey(ev: KeyboardEvent) {
  if (!menu || menu.hidden) return;
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    const caret = bar?.querySelector<HTMLButtonElement>("[aria-expanded='true']");
    closeMenu();
    caret?.focus();
    return;
  }
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    ev.stopPropagation();
    moveFocus(buttons, ev.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    ev.stopPropagation();
    if (ev.key === " ") {
      ev.preventDefault();
      (ev.target instanceof HTMLButtonElement ? ev.target : null)?.click();
    }
  }
}
