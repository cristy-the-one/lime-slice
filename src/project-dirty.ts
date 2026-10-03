/** Whether the open mesh has changes that are not in a saved project. */
import { session, state } from "./app/state.ts";

export function markProjectDirty() {
  if (session.projectRestoring || !state.mesh) return;
  session.projectDirty = true;
}

export function markProjectClean() {
  session.projectDirty = false;
}

/** `true` when the user is willing to drop unsaved work, including when there is none. */
export function confirmDiscard(): boolean {
  if (!session.projectDirty) return true;
  return window.confirm("This project has unsaved changes. Discard them?");
}
