import { state } from "../app/state";
import { resolveKey, type KeyContext } from "./commands";
import { runCommand } from "./palette";

function isTyping(target: HTMLElement | null): boolean {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || !!target?.isContentEditable;
}

function keyContext(ev: KeyboardEvent): KeyContext {
  const target = ev.target instanceof HTMLElement ? ev.target : null;
  const typing = isTyping(target);
  const root = document.documentElement.dataset;
  return {
    helpOpen: state.help,
    typing,
    stage: state.stage,
    hasResult: !!state.result,
    running: state.busy,
    searching: target?.id === "find" || (!!state.query && !typing),
    brushOn: root.supportPaint === "1" || root.seamPaint === "1",
    editingSupports: document.querySelector('#toolRail [data-tool="supports"]')?.getAttribute("aria-pressed") === "true",
    inGcode: !!target && !!document.querySelector("#gcodePane")?.contains(target),
  };
}

/**
 * The only key handler for app commands. A tool keeps its own Esc, Del and Shift while it is on; it runs first
 * (capture) and marks the event handled. The palette owns every key while it is open.
 */
export function mountKeys() {
  window.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || document.documentElement.dataset.overlay) return;
    const command = resolveKey(ev, keyContext(ev));
    if (!command) return;
    ev.preventDefault();
    runCommand(command.id);
  });
}
