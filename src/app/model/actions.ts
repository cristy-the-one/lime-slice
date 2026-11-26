/**
 * One gate for Model actions that start kernel work or step the part's history.
 * S.busy and S.jumping stay the only busy flags. A build that ends inside MODEL_BUSY_SHOW_MS
 * never paints its buttons disabled, so a fast step does not flash; the handlers and the palette
 * still refuse the click at once.
 */
import { state } from "../state.ts";
import { S } from "./shared.ts";

export const MODEL_BUILDING = "Model is still building.";

/** How long a build must last before the buttons look disabled. */
export const MODEL_BUSY_SHOW_MS = 100;

let shown = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let repaint = () => {};
let localHistory = () => false;

/** False while the modeler is building or jumping. A sketch, Stress, or the cut card is not this. */
export function modelActionsEnabled(): boolean {
  return !S.busy && !S.jumping;
}

/** True once a build has lasted long enough that the buttons should look disabled. */
export function modelActionsShownBusy(): boolean {
  return shown;
}

/** Undo and Redo that step a local stack, not the part. The Model view registers this. */
export function bindModelHistoryLocal(read: () => boolean): void {
  localHistory = read;
}

/** Repaint the buttons when a build has lasted long enough to show. syncUndo registers itself. */
export function bindModelActionRepaint(paint: () => void): void {
  repaint = paint;
}

/**
 * Call from syncUndo, which runs wherever S.busy or S.jumping changes.
 * A build that finishes before the timer never changes the buttons.
 */
export function noteModelActions(): void {
  if (modelActionsEnabled()) {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    shown = false;
    return;
  }
  if (shown || timer != null) return;
  timer = setTimeout(() => {
    timer = null;
    if (modelActionsEnabled()) return;
    shown = true;
    repaint();
  }, MODEL_BUSY_SHOW_MS);
}

/** The palette sentence for a kernel action, or null when that action can run. */
export function modelActionReason(id: string): string | null {
  if (state.stage !== "model" || modelActionsEnabled()) return null;
  if (id === "model-apply" || id === "model-edit-step") return MODEL_BUILDING;
  if ((id === "undo" || id === "redo") && !localHistory()) return MODEL_BUILDING;
  return null;
}
