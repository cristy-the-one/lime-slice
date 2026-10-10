/** Switch Smart supports on for what the user is about to do, as one undo step. */
import { flushEdit, noteEdit } from "./history.ts";
import { setSmartSupports } from "./machine-actions.ts";
import { state } from "./state.ts";
import { markProjectDirty } from "../project-dirty.ts";
import { renderChrome } from "./settings.ts";
import { runSlice } from "./slice-run.ts";

/**
 * Tick Smart supports, as Organic tree when `tree`, and slice. A belt raft is
 * cleared by `setSmartSupports`, so this never leaves the engine a refused pair.
 */
export function turnOnSupports(options: { tree?: boolean } = {}) {
  noteEdit();
  setSmartSupports(true);
  if (options.tree) state.supportStyle = "tree";
  markProjectDirty();
  flushEdit();
  renderChrome();
  void runSlice(false);
}
