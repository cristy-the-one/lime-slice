/** Switch supports on, as Automatic, for what the user is about to do, as one undo step. */
import { flushEdit, noteEdit } from "./history.ts";
import { setSupportMode } from "./machine-actions.ts";
import { state } from "./state.ts";
import { markProjectDirty } from "../project-dirty.ts";
import { renderChrome } from "./settings.ts";
import { runSlice } from "./slice-run.ts";

/**
 * Turn supports on as Automatic, as Organic tree when `tree`, and slice. A belt raft is
 * cleared by `setSupportMode`, so this never leaves the engine a refused pair.
 */
export function turnOnSupports(options: { tree?: boolean } = {}) {
  noteEdit();
  // Painted only already has supports on, and stays.
  if (!state.supports) setSupportMode("auto");
  if (options.tree) state.supportStyle = "tree";
  markProjectDirty();
  flushEdit();
  renderChrome();
  void runSlice(false);
}
