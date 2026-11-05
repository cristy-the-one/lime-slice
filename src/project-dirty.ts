/** Whether the open mesh has changes that are not in a saved project. */
import { session, state } from "./app/state.ts";
import { confirmSheet } from "./ui/ask-sheet.ts";

export function markProjectDirty() {
  if (session.projectRestoring || !state.mesh) return;
  session.projectDirty = true;
}

export function markProjectClean() {
  session.projectDirty = false;
}

/**
 * `true` when the user is willing to drop unsaved work, including when there is none: the app's question sheet asks.
 * New project uses this same `session.projectDirty` flag, with Save / Don't save / Cancel. Closing the window keeps
 * the browser's own `beforeunload` prompt (project-io.ts), the only question a page may ask while it unloads.
 */
export async function confirmDiscard(): Promise<boolean> {
  if (!session.projectDirty) return true;
  return confirmSheet({
    title: "Discard unsaved changes?",
    body: "This project has changes that are not saved. Opening another file drops them.",
    confirmLabel: "Discard",
    danger: true,
  });
}
