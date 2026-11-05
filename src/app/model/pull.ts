/** Face push/pull: the live dry-run, its guard, and the diameter sync. */
import { decodeSolid } from "../../model-reply";
import { probeFromBody } from "../../model-feasibility";
import { type ModelOp, type NodeId } from "../../model-tree";
import { probeRequest } from "../../model-request";
import { pullFieldText } from "../../push-pull-ui";
import { depthBehind, pullLimit, pullRefusal } from "../../push-pull";
import { faceTable } from "../../interact/face-table";
import { modelCardOpen, openModelTool, setModelPreview, setModelProbe } from "../../ui/model-chrome";
import { sketchOccupiesView } from "../sketch";
import { state } from "../state";
import { stressPicking } from "../../ui/stress.ts";
import { S } from "./shared";
import { treeOf } from "./edges";
import { treeCall } from "./engine";
import { num } from "./geometry";
import { readout } from "./pick";
import { keepPreview, previewOf, probeName, remember, sendPending } from "./probe";
import { answers, type Body, shaped } from "./shared";
import { boxOf, viewed } from "./view";

let pullGen = 0;

/** P1. Drop a face drag's dry-run. A late answer is ignored. */
export function clearPullPreview() {
  pullGen += 1;
  setModelProbe(null);
  setModelPreview(null);
}

/**
 * P1. The kernel preview for a face drag, after the pointer has been still. It waits in the same single line as the
 * panel's checks: a drag that rests, moves and rests again sends only the newest, after the one running answers.
 * `pullProbe` is the gesture's own hold (`hold`), not set here, so a probe that gives up never leaves it on.
 */
export function probePull(op: ModelOp) {
  const gen = ++pullGen;
  const at = S.open;
  const tree = treeOf(at);
  if (!at || !tree || !pullLiveNow()) return;
  const said = pullGuard(op);
  if (said) {
    setModelProbe({ phase: "done", ok: false, error: said });
    setModelPreview(null);
    readout(said);
    return;
  }
  const node = tree.current;
  const key = probeName(at.key, node, op);
  const known = answers.get(key);
  if (known && !(shaped.has(key) && !previewOf(key))) {
    setModelProbe(known);
    setModelPreview(previewOf(key));
    return;
  }
  setModelProbe({ phase: "checking" });
  S.pendingProbe = () => sendPullProbe(gen, key, at.key, node, op);
  sendPending();
}

async function sendPullProbe(gen: number, key: string, treeKey: string, node: NodeId, op: ModelOp) {
  if (gen !== pullGen || !S.pullProbe) return;
  const body = await treeCall(treeKey, node, probeRequest(treeKey, node, op, state.stepTolerance));
  if (gen !== pullGen || !S.pullProbe || state.stage !== "model") return;
  const view = probeFromBody(body);
  if (typeof body.ok === "boolean") remember(key, view);
  const shape = body.ok === true && body.preview && typeof body.preview === "object" ? decodeSolid(body.preview as Body) : null;
  if (shape && typeof shape !== "string") {
    keepPreview(key, shape);
    shaped.add(key);
  }
  if (gen !== pullGen || !S.pullProbe) return;
  setModelProbe(view);
  setModelPreview(shape && typeof shape !== "string" ? shape : null);
  if (view && view.phase === "done" && !view.ok && view.error) readout(view.error.endsWith(".") ? view.error : `${view.error}.`);
}

/**
 * P1. Why a push or pull is refused before the kernel is asked: a distance past ten bed or part diagonals, a move
 * that pushes a planar face as deep as the part, or a face that is the whole part moved past where it folds or given
 * Alt's prism. Null lets the kernel decide. Each face is read on the solid on screen,
 * so `depths` is false where that solid is the step's own result (a Tab edit), not the one it is built on.
 */
export function pullGuard(op: ModelOp, depths = true): string | null {
  if (op.kind !== "moveFaces" && op.kind !== "faceExtrude") return null;
  const solid = viewed();
  if (!solid) return null;
  const box = boxOf(solid.positions);
  const part = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  const bed = Math.hypot(state.profile.bedX, state.profile.bedY, state.profile.bedZ);
  const limit = pullLimit(part, bed);
  const rows = op.kind === "moveFaces" ? op.faces : [{ face: op.face, distance: op.distance }];
  const table = faceTable(solid.positions, solid.triangles);
  for (const row of rows) {
    const index = typeof row.face === "number" ? row.face : row.face.index;
    const info = solid.faces[index];
    // A face that is the whole part has no plane to measure behind: its centre is inside the part, and its one normal
    // is any direction. The kernel's fold distances bound it instead, read like the depth on the solid the step builds on.
    const closed = depths && info?.closed ? { inMaxMm: info.inMaxMm, outMaxMm: info.outMaxMm, only: solid.faces.length === 1 } : null;
    const normal = info && !info.surface && !closed ? info.normal ?? null : null;
    const centre = table.get(index)?.centre;
    const depth = depths && normal && centre ? depthBehind(solid.positions, centre, normal) : null;
    const said = pullRefusal(op.kind === "moveFaces" ? "move" : "extrude", row.distance, [depth], limit, rows.length === 1, closed);
    if (said) return said;
  }
  return null;
}

/**
 * P1. The panel's Diameter beside Distance, while Push/Pull is open on exactly one cylinder: "Change diameter" then
 * types a diameter, as Shapr3D and Fusion show one for a cylindrical face. Distance stays the offset either way.
 */
export function syncPullDiameter() {
  const row = document.querySelector<HTMLElement>("#modelPullDiameterRow");
  const input = document.querySelector<HTMLInputElement>("#modelPullDiameter");
  if (!row || !input) return;
  const distance = num("#modelPull");
  const diameter = openModelTool() === "pushpull" && S.pullPanel ? S.pullPanel.pickedDiameter(Number.isFinite(distance) ? distance : 0) : null;
  row.hidden = diameter == null;
  if (diameter != null && document.activeElement !== input) input.value = pullFieldText(diameter);
}

/** P1. Face drag is on in Face mode, on an editable solid, when no other tool is open. */
export function pullLiveNow(): boolean {
  // --- S2: a sketch being chosen or edited owns the left button. ---
  if (sketchOccupiesView()) return false;
  if (state.stage !== "model" || S.busy || S.jumping || stressPicking()) return false;
  const tool = openModelTool();
  if ((tool && tool !== "pushpull") || modelCardOpen()) return false;
  if (document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") !== "true") return false;
  const solid = viewed();
  if (!solid?.editable) return false;
  // A History edit, Push/Pull's own included, is typed in its panel: a drag would add a step beside the one edited.
  if (S.lens || S.editing) return false;
  return true;
}
