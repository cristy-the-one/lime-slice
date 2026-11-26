/**
 * Model's action gate: while a build or a jump is in flight, the palette says why the kernel actions cannot run,
 * and a build that finishes inside the show delay never paints the buttons disabled.
 */
import { register } from "node:module";

register(new URL("../model-view/resolve-ts.mjs", import.meta.url).href, import.meta.url);
(globalThis as { Worker?: unknown }).Worker = class {
  postMessage() {}
  addEventListener() {}
  terminate() {}
};

const { S } = await import("./model/shared.ts");
const { state } = await import("./state.ts");
const { actionReason, bindModelActionReason } = await import("./command-reasons.ts");
const { MODEL_BUILDING, MODEL_BUSY_SHOW_MS, bindModelActionRepaint, bindModelHistoryLocal, modelActionReason, modelActionsEnabled, modelActionsShownBusy, noteModelActions } = await import("./model/actions.ts");

bindModelActionReason(modelActionReason);

const stage = state.stage;
const busy = S.busy;
const jumping = S.jumping;

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

state.stage = "model";
S.busy = true;
S.jumping = false;
check("a build blocks the actions at once", modelActionsEnabled() === false);
check("Apply's palette reason while Model is busy", actionReason("model-apply") === MODEL_BUILDING, JSON.stringify(actionReason("model-apply")));
check("Edit step's palette reason while Model is busy", actionReason("model-edit-step") === MODEL_BUILDING, JSON.stringify(actionReason("model-edit-step")));
check("Undo's palette reason while Model is busy", actionReason("undo") === MODEL_BUILDING, JSON.stringify(actionReason("undo")));
check("Redo's palette reason while Model is busy", actionReason("redo") === MODEL_BUILDING, JSON.stringify(actionReason("redo")));
check("View stays available while Model is busy", actionReason("model-view") === null, JSON.stringify(actionReason("model-view")));

bindModelHistoryLocal(() => true);
check("a sketch's Undo is not the build", actionReason("undo") === null, JSON.stringify(actionReason("undo")));
bindModelHistoryLocal(() => false);
check("the rail's Undo is the build again", actionReason("undo") === MODEL_BUILDING, JSON.stringify(actionReason("undo")));

S.busy = false;
S.jumping = true;
check("a jump blocks the actions", modelActionsEnabled() === false);
check("Apply's palette reason while Model is jumping", actionReason("model-apply") === MODEL_BUILDING, JSON.stringify(actionReason("model-apply")));

S.jumping = false;
check("Apply can run when Model is idle", modelActionsEnabled() && actionReason("model-apply") === null, JSON.stringify(actionReason("model-apply")));

state.stage = "prepare";
S.busy = true;
check("Prepare's Undo is not Model's build", actionReason("undo") === null, JSON.stringify(actionReason("undo")));
state.stage = "model";

let paints = 0;
bindModelActionRepaint(() => {
  paints += 1;
});
noteModelActions();
check("a fresh build is not shown yet", modelActionsShownBusy() === false && paints === 0);
await new Promise((resolve) => setTimeout(resolve, 40));
S.busy = false;
noteModelActions();
await new Promise((resolve) => setTimeout(resolve, MODEL_BUSY_SHOW_MS));
check("a build under 100 ms never shows", modelActionsShownBusy() === false && paints === 0);

S.busy = true;
noteModelActions();
await new Promise((resolve) => setTimeout(resolve, MODEL_BUSY_SHOW_MS + 40));
check("a build that lasts shows, and repaints once", modelActionsShownBusy() === true && paints === 1, `shown=${modelActionsShownBusy()} paints=${paints}`);
noteModelActions();
check("another note while it is showing does not repaint again", paints === 1);
S.busy = false;
noteModelActions();
check("clearing the build hides it", modelActionsShownBusy() === false);

state.stage = stage;
S.busy = busy;
S.jumping = jumping;
bindModelHistoryLocal(() => false);
bindModelActionRepaint(() => {});
bindModelActionReason(() => null);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model actions: busy and jumping block the kernel commands, and a short build does not show");
