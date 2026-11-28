/**
 * Pose's Move: one part, free or in an assembly, in design space (model pose). The print layout stays.
 * A drag or a typed field is one undo step. Snap follows the other parts; Alt turns it off; Shift is 1 mm and 15°.
 */
import { assemblyOf, samePose } from "../assembly.ts";
import { setSettleOn, settleOn } from "../bed-rest-pref.ts";
import { snapStep } from "../gizmo-math.ts";
import { boundsOf } from "../mesh-place.ts";
import { turnPoseAbout } from "../model-grab.ts";
import { lowestZ, settledPose, solidHull } from "../model-settle.ts";
import {
  applyPose,
  placeFields,
  poseFromPlace,
  seatLift,
  thenPose,
  type Affine,
  type ObjectFrame,
  type PlaceFields,
  type Turn,
} from "../model-space.ts";
import { meshSeat, meshToModel, modelPoseOf, withFrame, withModelPose, type PlateObject } from "../plate.ts";
import { alignDelta, footprintOf, snapMove, ALIGN_LABELS, ALIGN_RELATIONS, type AlignRelation, type Screen } from "../place-snap.ts";
import type { GrabAxis } from "../viewport-grab.ts";
import { followAssemblyMove, liveAssemblies } from "./assemblies.ts";
import { fx } from "./fx.ts";
import { beginEdit, cancelEdit, flushEdit, holdEdit } from "./history.ts";
import { refreshObjectList } from "./settings.ts";
import { state } from "./state.ts";
import { markProjectDirty } from "../project-dirty.ts";
import type { Vec3 } from "../model-tree.ts";

export type MoveEvent =
  | { phase: "start"; kind: "move" | "turn"; object: string }
  | { phase: "change"; kind: "move"; delta: [number, number, number]; shift: boolean; alt: boolean; screen: Screen }
  | { phase: "change"; kind: "turn"; axis: GrabAxis; degrees: number; shift: boolean }
  | { phase: "end" }
  | { phase: "cancel" };

const turns = new Map<string, Turn>();

function poseKey(id: string, pose: Affine): string {
  return `${id}:${pose.m.map((n) => n.toFixed(5)).join(",")}:${pose.t.map((n) => n.toFixed(5)).join(",")}`;
}

/** The turn the Move fields showed for this pose, so a later read keeps the angles that were typed. */
export function shownTurnFor(id: string, pose: Affine): Turn | undefined {
  return turns.get(poseKey(id, pose));
}

function remember(id: string, pose: Affine, turn: Turn | undefined) {
  if (turn) turns.set(poseKey(id, pose), turn);
}

function objectOf(id: string): PlateObject | undefined {
  return state.plate.objects.find((item) => item.id === id);
}

function pivotOf(obj: PlateObject): Vec3 {
  const box = boundsOf(obj.sourcePos);
  if (!box) return [0, 0, 0];
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}

function atPose(obj: PlateObject, pose: Affine): Affine {
  const seat = meshSeat(obj.bytes) ?? 0;
  return seat === 0 ? pose : thenPose(seatLift(seat), pose);
}

function showNum(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Object.is(rounded, -0) || Math.abs(rounded) < 5e-4) return "0";
  return String(rounded);
}

function paintFields(id: string) {
  const obj = objectOf(id);
  if (!obj) return;
  const pose = modelPoseOf(obj);
  const fields = placeFields(pose, pivotOf(obj), shownTurnFor(id, pose));
  for (const key of ["x", "y", "z", "rx", "ry", "rz"] as const) {
    const input = document.querySelector<HTMLInputElement>(`#${FIELD_ID[key]}`);
    if (input && document.activeElement !== input) input.value = showNum(fields[key]);
  }
}

const FIELD_ID: Record<keyof PlaceFields, string> = {
  x: "poseMoveX",
  y: "poseMoveY",
  z: "poseMoveZ",
  rx: "poseMoveRx",
  ry: "poseMoveRy",
  rz: "poseMoveRz",
};

function canvasOf(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>("#pose");
}

function paintSnap(label: string, target: string) {
  const canvas = canvasOf();
  if (!canvas) return;
  canvas.dataset.snap = label;
  canvas.dataset.snapTarget = target;
}

function clearSnap() {
  paintSnap("", "");
}

let drag: { id: string; start: Affine; pivot: Vec3; turn: Turn } | null = null;

function writePose(id: string, pose: Affine, turn: Turn | undefined) {
  remember(id, pose, turn);
  state.plate = withModelPose(state.plate, id, pose);
  followAssemblyMove(id, pose);
  markProjectDirty();
  paintFields(id);
  fx.syncPose?.();
}

function turnOf(fields: PlaceFields): Turn {
  return { rx: fields.rx, ry: fields.ry, rz: fields.rz };
}

/** A pointer gesture on the Pose view while Move is the tool. */
export function onPoseMove(event: MoveEvent): void {
  if (event.phase === "start") {
    const obj = objectOf(event.object);
    if (!obj) return;
    const start = modelPoseOf(obj);
    drag = { id: event.object, start, pivot: pivotOf(obj), turn: turnOf(placeFields(start, pivotOf(obj), shownTurnFor(event.object, start))) };
    holdEdit();
    clearSnap();
    return;
  }
  if (event.phase === "cancel") {
    drag = null;
    cancelEdit();
    clearSnap();
    fx.syncPose?.();
    return;
  }
  if (event.phase === "end") {
    const id = drag?.id;
    drag = null;
    flushEdit();
    clearSnap();
    if (id) paintFields(id);
    refreshObjectList();
    return;
  }
  if (!drag) return;
  const obj = objectOf(drag.id);
  if (!obj) return;
  if (event.kind === "move") applyMove(obj, event.delta, event.shift, event.alt, event.screen);
  else applyTurn(obj, event.axis, event.degrees, event.shift);
}

function applyMove(obj: PlateObject, raw: Vec3, shift: boolean, alt: boolean, screen: Screen) {
  if (!drag) return;
  const stepped: Vec3 = shift ? [snapStep(raw[0], true, 1), snapStep(raw[1], true, 1), snapStep(raw[2], true, 1)] : [raw[0], raw[1], raw[2]];
  const candidate: Affine = { m: [...drag.start.m] as Affine["m"], t: [drag.start.t[0] + stepped[0], drag.start.t[1] + stepped[1], drag.start.t[2] + stepped[2]] };
  let next = candidate;
  let label = "";
  let target = "";
  if (!shift && !alt) {
    const moving = footprintOf(obj.sourcePos, atPose(obj, candidate));
    const targets = state.plate.objects.filter((item) => item.id !== obj.id && item.sourcePos.length >= 9).map((item) => ({
      id: item.id,
      name: item.name,
      foot: footprintOf(item.sourcePos, meshToModel(item)),
    }));
    const hit = snapMove({ moving, targets, bed: null, axes: ["x", "y"], screen });
    if (hit) {
      next = { m: candidate.m, t: [candidate.t[0] + hit.delta[0], candidate.t[1] + hit.delta[1], candidate.t[2] + hit.delta[2]] };
      label = hit.label;
      target = hit.targetId ?? "";
    }
  }
  paintSnap(label, target);
  writePose(obj.id, next, drag.turn);
}

function applyTurn(obj: PlateObject, axis: GrabAxis, degrees: number, shift: boolean) {
  if (!drag) return;
  const angle = snapStep(degrees, shift, 15);
  const centre = applyPose(drag.start, drag.pivot);
  let next = turnPoseAbout(drag.start, centre, axis, angle);
  const hull = settleOn() ? solidHull(obj.sourcePos) : null;
  if (hull) {
    const floor = lowestZ(hull, drag.start);
    next = settledPose(hull, next, drag.pivot, floor).pose;
  }
  const fields = placeFields(next, drag.pivot, hull ? undefined : { ...drag.turn, [axis === "x" ? "rx" : axis === "y" ? "ry" : "rz"]: angle });
  writePose(obj.id, next, turnOf(fields));
}

export function moveFieldChanged(input: HTMLInputElement): void {
  const id = state.plate.selectedId;
  const key = (Object.entries(FIELD_ID).find(([, field]) => field === input.id)?.[0] ?? "") as keyof PlaceFields | "";
  if (!id || !key) return;
  if (input.value.trim() === "" || !Number.isFinite(Number(input.value))) return;
  const obj = objectOf(id);
  if (!obj) return;
  const from = modelPoseOf(obj);
  const pivot = pivotOf(obj);
  const near = shownTurnFor(id, from);
  const value = Number(input.value);
  const next = poseFromPlace(from, pivot, key, value, near);
  if (samePose(next, from)) return;
  const now = placeFields(from, pivot, near);
  const turn = turnOf({ ...now, [key]: value });
  beginEdit();
  writePose(id, next, key === "x" || key === "y" || key === "z" ? (near ?? turnOf(now)) : turn);
  flushEdit();
  refreshObjectList();
}

export function setMoveFrame(frame: ObjectFrame): void {
  const id = state.plate.selectedId;
  const obj = id ? objectOf(id) : undefined;
  if (!id || !obj || !assemblyOf(liveAssemblies(), id)) return;
  const now: ObjectFrame = obj.frame === "part" ? "part" : "model";
  if (now === frame) return;
  beginEdit();
  state.plate = withFrame(state.plate, id, frame);
  markProjectDirty();
  flushEdit();
  fx.syncPose?.();
  refreshObjectList();
}

export function highlightAlign(targetId: string): void {
  const canvas = canvasOf();
  if (canvas) canvas.dataset.snapTarget = targetId;
}

export function alignMove(targetId: string, how: AlignRelation): void {
  const id = state.plate.selectedId;
  const obj = id ? objectOf(id) : undefined;
  const target = objectOf(targetId);
  if (!id || !obj || !target || target.id === id) return;
  const pose = modelPoseOf(obj);
  const delta = alignDelta(footprintOf(obj.sourcePos, atPose(obj, pose)).box, footprintOf(target.sourcePos, meshToModel(target)).box, how, false);
  if (!delta) return;
  const next: Affine = { m: [...pose.m] as Affine["m"], t: [pose.t[0] + delta[0], pose.t[1] + delta[1], pose.t[2] + delta[2]] };
  if (samePose(next, pose)) return;
  beginEdit();
  writePose(id, next, shownTurnFor(id, pose));
  flushEdit();
  clearSnap();
  refreshObjectList();
}

export function poseSettleChanged(on: boolean): void {
  setSettleOn(on);
  const prepare = document.querySelector<HTMLInputElement>("#settleOn");
  if (prepare) prepare.checked = on;
}

/** The Move card: typed design-space numbers, the frame switch, align, and settle. */
export function appendMoveCard(panel: HTMLElement): void {
  const id = state.plate.selectedId;
  const obj = id ? objectOf(id) : undefined;
  const card = document.createElement("div");
  card.id = "poseMove";
  card.className = "pose-move";
  if (id) card.dataset.moveFor = id;
  if (!obj) {
    const note = document.createElement("p");
    note.textContent = "Select a part to move it in design space.";
    card.append(note);
    panel.append(card);
    return;
  }
  const pose = modelPoseOf(obj);
  const fields = placeFields(pose, pivotOf(obj), shownTurnFor(obj.id, pose));
  const member = assemblyOf(liveAssemblies(), obj.id);
  if (member) {
    const frame = obj.frame === "part" ? "part" : "model";
    const row = document.createElement("div");
    row.id = "poseMoveFrame";
    row.className = "modes";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Numbers in");
    for (const [value, label, tip] of [
      ["part", "Part frame", "Numbers in this part's own frame, as its drawing gives them. Model draws the part as it was modelled."],
      ["model", "Model frame", "Numbers in model space, where the assembly puts the part."],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.dataset.placeFrame = value;
      button.dataset.poseAction = "move-frame";
      button.textContent = label;
      button.dataset.tip = tip;
      button.setAttribute("aria-pressed", String(frame === value));
      row.append(button);
    }
    card.append(row);
  }
  const grid = document.createElement("div");
  grid.className = "pose-move-fields";
  for (const key of ["x", "y", "z", "rx", "ry", "rz"] as const) {
    const label = document.createElement("label");
    label.className = "pose-field";
    const name = key === "rx" ? "Turn X" : key === "ry" ? "Turn Y" : key === "rz" ? "Turn Z" : key.toUpperCase();
    const span = document.createElement("span");
    span.textContent = name;
    const input = document.createElement("input");
    input.id = FIELD_ID[key];
    input.type = "number";
    input.step = key.startsWith("r") ? "1" : "0.1";
    input.value = showNum(fields[key]);
    input.setAttribute("aria-label", key.startsWith("r") ? `Turn in design space about ${key[1]}, degrees` : `Move in design space ${key}`);
    label.append(span, input);
    grid.append(label);
  }
  card.append(grid);
  const others = state.plate.objects.filter((item) => item.id !== obj.id);
  const align = document.createElement("div");
  align.id = "poseAlign";
  align.className = "pose-move-align";
  const toLabel = document.createElement("label");
  const toSpan = document.createElement("span");
  toSpan.textContent = "Align to…";
  const to = document.createElement("select");
  to.id = "poseAlignTo";
  to.setAttribute("aria-label", "Align to");
  for (const item of others) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    to.append(option);
  }
  to.disabled = others.length === 0;
  toLabel.append(toSpan, to);
  const howLabel = document.createElement("label");
  const howSpan = document.createElement("span");
  howSpan.textContent = "How";
  const how = document.createElement("select");
  how.id = "poseAlignHow";
  how.setAttribute("aria-label", "Align how");
  for (const relation of ALIGN_RELATIONS) {
    const option = document.createElement("option");
    option.value = relation;
    option.textContent = ALIGN_LABELS[relation];
    how.append(option);
  }
  howLabel.append(howSpan, how);
  const go = document.createElement("button");
  go.id = "poseAlignGo";
  go.type = "button";
  go.className = "btn";
  go.dataset.poseAction = "move-align";
  go.textContent = "Align";
  go.disabled = others.length === 0;
  go.dataset.tip = "Move this part to line up with the pick, as one Move step.";
  align.append(toLabel, howLabel, go);
  card.append(align);
  const settle = document.createElement("label");
  settle.className = "pose-field";
  const box = document.createElement("input");
  box.id = "poseSettleOn";
  box.type = "checkbox";
  box.checked = settleOn();
  settle.append(box, document.createTextNode(" Settle on the bed"));
  settle.dataset.tip = "While you turn the part, snap it to the flat face that touches most, near the angle you hold. Prepare's switch too.";
  card.append(settle);
  panel.append(card);
}

/** The Move card whose number field has focus, for the selected part, or null: a panel rebuild keeps it in place. */
export function heldMoveCard(panel: HTMLElement): HTMLElement | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLInputElement) || !Object.values(FIELD_ID).includes(focused.id)) return null;
  const card = focused.closest<HTMLElement>("#poseMove");
  return card?.parentElement === panel && card.dataset.moveFor === state.plate.selectedId ? card : null;
}

/**
 * After a rebuild around a held Move card: the new panel's order is kept, and the new card's content replaces the held
 * one's, all but the focused field, which keeps its typed text and its focus. A card that no longer fits gives way.
 */
export function keepMoveCard(held: HTMLElement): void {
  const fresh = [...(held.parentElement?.children ?? [])].find((node): node is HTMLElement => node !== held && node.id === "poseMove");
  if (!fresh) {
    held.remove();
    return;
  }
  while (held.nextSibling && held.nextSibling !== fresh) held.before(held.nextSibling);
  const focused = document.activeElement;
  if (focused && adopt(held, fresh, focused)) fresh.remove();
  else held.replaceWith(fresh);
}

/** Moves `fresh`'s nodes into `old`, the branch down to `focused` kept in place; false, changing nothing, when they differ. */
function adopt(old: Element, fresh: Element, focused: Element): boolean {
  if (old === focused) return fresh.id === focused.id;
  if (old.tagName !== fresh.tagName || old.childNodes.length !== fresh.childNodes.length) return false;
  const pairs = [...old.childNodes].map((node, i) => [node, fresh.childNodes[i]!] as const);
  const path = pairs.find(([node]) => node.contains(focused));
  if (!path || !(path[1] instanceof Element) || !adopt(path[0] as Element, path[1], focused)) return false;
  for (const [was, now] of pairs) if (was !== path[0]) was.replaceWith(now);
  return true;
}
