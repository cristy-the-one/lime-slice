import { setActiveSketchEvent, sketchKeyWasHandled } from "../app/sketch-keys";
import { state } from "../app/state";
import { resolveKey, type KeyContext } from "./commands";
import { runCommand } from "./palette";

function isTyping(target: HTMLElement | null): boolean {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || !!target?.isContentEditable;
}

function keyContext(ev: KeyboardEvent): KeyContext {
  const target = ev.target instanceof HTMLElement ? ev.target : null;
  const hud = !!target?.closest(".interact-hud");
  const history = (ev.ctrlKey || ev.metaKey) && /^[zZyY]$/.test(ev.key);
  // The size box keeps Esc and Tab (they drive the feature) and Ctrl+Z (it undoes the sketch).
  // A driving-dimension label keeps Esc. Every other field keeps its own text.
  let typing = isTyping(target);
  if (hud && (history || ev.key === "Escape" || ev.key === "Tab")) typing = false;
  if (target?.dataset.sketchDimInput != null && ev.key === "Escape") typing = false;
  // Escape in Parameters still folds the section. The sketch also sees it, so two presses leave.
  if (target?.closest("#modelParams") && ev.key === "Escape") typing = false;
  const root = document.documentElement.dataset;
  const sketchPhase = document.querySelector("#model")?.getAttribute("data-sketch");
  return {
    helpOpen: state.help,
    typing,
    stage: state.stage,
    hasResult: !!state.result,
    running: state.busy,
    searching: target?.id === "find" || (!!state.query && !typing),
    brushOn: root.supportPaint === "1" || root.seamPaint === "1" || root.reinforcePaint === "1",
    editingSupports: document.querySelector('#toolRail [data-tool="supports"]')?.getAttribute("aria-pressed") === "true",
    inGcode: !!target && !!document.querySelector("#gcodePane")?.contains(target),
    sketchOpen: state.stage === "model" && (sketchPhase === "editing" || sketchPhase === "choosing"),
    sketchFeature: document.querySelector("#model")?.getAttribute("data-sketch-feature") === "1",
    sketchLoft: document.querySelector("#model")?.getAttribute("data-loft") === "pick",
    layout: document.documentElement.classList.contains("layout-compact") ? "compact" : "desktop",
  };
}

/**
 * The only key handler for app commands. A tool keeps its own Esc, Del and Shift while it is on; it runs first
 * (capture) and marks the event handled. The palette owns every key while it is open.
 */
/**
 * Enter and Space on a focused button, link, summary, or menu item press that control, as the browser does. Only
 * Apply itself keeps the Apply shortcut, so the global Enter never swallows another control's press.
 */
function pressesControl(ev: KeyboardEvent): boolean {
  if (ev.key !== "Enter" && ev.key !== " ") return false;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  const target = ev.target instanceof HTMLElement ? ev.target : null;
  const control = target?.closest("button, a[href], summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab]");
  return !!control && control.id !== "modelApply";
}

export function mountKeys() {
  // Capture, and only for the sketch: it has to run before the size box takes Tab. A sketch command
  // that returns false (Tab between the box's fields) is left for that box.
  window.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || document.documentElement.dataset.overlay) return;
    const command = resolveKey(ev, keyContext(ev));
    // Enter on a button presses that button, except loft's Enter, which commits even from a card.
    if (pressesControl(ev) && !(command?.id === "sketch-enter" && document.querySelector("#model")?.getAttribute("data-loft") === "pick")) return;
    if (!command?.id.startsWith("sketch-")) return;
    setActiveSketchEvent(ev);
    try {
      runCommand(command.id);
    } finally {
      setActiveSketchEvent(null);
    }
    if (!sketchKeyWasHandled()) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  window.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || document.documentElement.dataset.overlay) return;
    if (pressesControl(ev)) return;
    const command = resolveKey(ev, keyContext(ev));
    if (!command || command.id.startsWith("sketch-")) return;
    ev.preventDefault();
    runCommand(command.id);
  });
}
