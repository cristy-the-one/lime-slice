/** Extrude from the open sketch. */
import { S } from "./state";
import { demoMade } from "./demo";
import { afterFeature, armProbe, committed, featureEdit, withSketchName } from "./feature";
import { add3, ghostSpan, scale3, unit3 } from "./helpers";
import { leaveEditing } from "./keys";
import { endLoft } from "./loft";
import { endRevolve } from "./revolve";
import { featureBlocked } from "./starts";
import { endSweep } from "./sweep";
import { drawingFrame, publish } from "./view";
import { type HudField } from "../../interact/hud";
import { dragAxis } from "../../interact/drag-axis";
import { regionExtrude } from "../../interact/ghosts";
import { inPlaceArrow } from "../../interact/in-place-arrow";
import { formatMm } from "../../model-plane";
import { type ModelOp } from "../../model-tree";
import { type SketchData, type Vec3 } from "../../sketch/model";
import { rayOnPlane, type SketchFrame, toWorld } from "../../sketch/frame";
import { beginChoose, activeSketch } from "../../sketch/session";
import { featureTitle } from "../../sketch/hints";
import { REASON } from "../../sketch/reasons";
import { withExprs } from "../../modeling/params.ts";
import { state } from "../state";
import { chooseRegions, regionsOfOutlines, sketchTouchesSolid, resolveExtrudeMode, buildSketchExtrude, modeLabel, regionsCentroid, solidFrameOf, regionSamples } from "../../sketch/extrude";
import { type Region, regionAt, sketchRegions } from "../../sketch/regions";

/** H1: keep this sketch as a card and pick a face for the holes. */
export function startOnFace() {
  if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
  S.drillAsk = null;
  S.faceForHoles = true;
  leaveEditing(beginChoose(S.editor));
}

export function beginExtrude() {
  if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
  if (S.revolve) endRevolve();
  if (S.loft) endLoft();
  if (S.sweep) endSweep();
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.phase !== "editing") return;
  const chosen = editedRegions(sketch) ?? chooseRegions(sketch, S.editor.selection.entities, S.editor.cursor);
  if (chosen.length === 0) {
    S.host.readout(REASON.pickExtrude);
    return;
  }
  S.gesture = {
    slots: 1,
    distance: 10,
    depth2: null,
    draft: null,
    upTo: null,
    choice: featureEdit() === "root" ? "new" : "auto",
    regions: chosen,
    dragging: false,
    guide: null,
    down: null,
  };
  publish("open");
  armProbe();
}

/** In a History Edit with nothing selected, the regions the step was applied to. Null otherwise. */
export function editedRegions(sketch: SketchData): Region[] | null {
  if (!S.editSession || S.editOutlines.length === 0 || S.editor.selection.entities.length > 0) return null;
  const found = regionsOfOutlines(sketch, S.editOutlines);
  return found.length > 0 ? found : null;
}

export function endExtrude() {
  if (!S.gesture) return;
  S.gesture = null;
  window.clearTimeout(S.probeTimer);
  S.host.view.setHandles([]);
  S.host.view.setGhost(null);
  S.host.clearExtrudePreview();
  publish("open");
}

export function takeValues(values: readonly number[]) {
  if (!S.gesture) return;
  const distance = values[0];
  if (distance != null && Number.isFinite(distance)) S.gesture = { ...S.gesture, distance, upTo: null, guide: null };
  if (S.gesture.slots >= 2) S.gesture = { ...S.gesture, depth2: values[1] ?? S.gesture.depth2 };
  if (S.gesture.slots >= 3) S.gesture = { ...S.gesture, draft: values[2] ?? S.gesture.draft };
}

export function resolvedMode() {
  const sketch = activeSketch(S.editor);
  const frame = drawingFrame();
  const touches = !!sketch && !!frame && !!S.gesture && sketchTouchesSolid(frame, S.gesture.regions, S.host.bounds(), sketch.on?.kind === "face");
  return resolveExtrudeMode({
    choice: S.gesture?.choice ?? "auto",
    hasSolid: S.host.solid() != null,
    touches,
    distance: S.gesture?.distance ?? 0,
    lockNew: featureEdit() === "root",
    stepEdit: featureEdit() === "step",
  });
}

function builtExtrude(): { op: ModelOp } | { error: string } | null {
  const sketch = activeSketch(S.editor);
  if (!sketch || !S.gesture || S.gesture.regions.length === 0) return null;
  return buildSketchExtrude({
    sketch: withSketchName(sketch, S.editor.active),
    regions: S.gesture.regions,
    distance: S.gesture.distance,
    depth2: S.gesture.slots >= 2 ? S.gesture.depth2 : null,
    draftDeg: S.gesture.slots >= 3 ? S.gesture.draft : null,
    upTo: S.gesture.upTo,
    mode: resolvedMode(),
  });
}

export function currentOp(): ModelOp | null {
  const built = builtExtrude();
  return built && "op" in built ? built.op : null;
}

/** Everything an Apply of the open extrude depends on. A refusal is shown until one of these changes. */
function extrudeKey(): string {
  if (!S.gesture) return "";
  const fields = [S.gesture.slots, S.gesture.distance, S.gesture.depth2, S.gesture.draft, S.gesture.upTo, resolvedMode()];
  const regions = S.gesture.regions.map((region) => [region.area.toFixed(4), region.outer.start.map((value) => value.toFixed(4))]);
  return JSON.stringify([fields, regions]);
}

/**
 * Why the open extrude will not apply, or "". A refusal found before sending shows as soon as the values make it,
 * so the box says it before Enter; one the modeler gave stays until the extrude changes.
 */
export function extrudeNote(): string {
  if (!S.gesture) return "";
  const key = extrudeKey();
  if (S.gesture.refused && S.gesture.refused.key === key) return S.gesture.refused.text;
  // A pointer move asks twice (the readout and the box) and changes nothing the op is built from: build once per change.
  const sketch = activeSketch(S.editor);
  if (S.noteMemo && S.noteMemo.sketch === sketch && S.noteMemo.key === key) return S.noteMemo.text;
  const built = builtExtrude();
  const text = built && "error" in built ? built.error : "";
  S.noteMemo = sketch ? { sketch, key, text } : null;
  return text;
}

/**
 * Enter and Apply always end in something seen: the step (or the new object), or the refusal under the box and in
 * the status line, with the extrude left open to change.
 */
export async function commitExtrude() {
  if (!S.gesture || (S.applying || S.holding)) return;
  const built = builtExtrude();
  if (!built) {
    // Nothing picked yet: the same sentence as the Apply tooltip and the card's prompt.
    const why = featureBlocked();
    if (why) S.host.readout(why);
    return;
  }
  if ("error" in built) {
    refuseExtrude(built.error);
    return;
  }
  const op = withExprs(built.op, S.gesture.texts);
  const mode = resolvedMode();
  const key = extrudeKey();
  if (S.demo) {
    demoMade(op);
    return;
  }
  const error = await committed(S.host.commitExtrude(op, mode === "new" ? "new" : "on-solid"));
  if (error === undefined) return;
  if (error) {
    refuseExtrude(error, key);
    return;
  }
  afterFeature();
}

function refuseExtrude(text: string, key = extrudeKey()) {
  if (!S.gesture) return;
  S.gesture = { ...S.gesture, refused: { key, text } };
  publish("skip");
  S.host.readout(text);
}

export function extrudeFields(): HudField[] {
  const gestureNow = S.gesture;
  if (!gestureNow) return [];
  const fields: HudField[] = [{ id: "distance", label: "Distance", unit: "mm", value: gestureNow.distance }];
  if (gestureNow.slots >= 2) fields.push({ id: "depth2", label: "Other side", unit: "mm", value: gestureNow.depth2 ?? 0 });
  if (gestureNow.slots >= 3) fields.push({ id: "draft", label: "Draft", unit: "°", value: gestureNow.draft ?? 0 });
  return fields;
}

export function extrudeReadout(): string {
  if (!S.gesture) return "";
  const note = extrudeNote();
  if (note) return `${note} Esc returns to the sketch.`;
  const mode = modeLabel(resolvedMode());
  const past = tooBig();
  const detail = S.gesture.upTo != null ? `${formatMm(S.gesture.distance)} mm · up to face` : past ? `${formatMm(S.gesture.distance)} mm · past the bed` : `${formatMm(S.gesture.distance)} mm · ${mode}`;
  return featureTitle("extrude", detail);
}

/** --- B28. A depth past the printer's build volume along the extrude is said first; it is not refused. --- */
function tooBig(): string {
  const frame = drawingFrame();
  if (!S.gesture || !frame || S.gesture.upTo != null) return "";
  const span = Math.abs(S.gesture.distance) + (S.gesture.slots >= 2 && S.gesture.depth2 != null ? S.gesture.depth2 : 0);
  const upright = Math.abs(frame.w[2]) > 0.7;
  const limit = upright ? state.profile.bedZ : Math.max(state.profile.bedX, state.profile.bedY);
  if (!(limit > 0) || span <= limit) return "";
  return `${formatMm(span)} mm is more than the printer's ${formatMm(limit)} mm build ${upright ? "height" : "width"}. `;
}

export function extrudePointer(ev: { phase: "down" | "move" | "up"; x: number; y: number; shift: boolean; ctrl: boolean; alt: boolean }, frame: ReturnType<typeof drawingFrame>) {
  if (!S.gesture || !frame) return;
  if (ev.phase === "down") {
    S.gesture = { ...S.gesture, down: { x: ev.x, y: ev.y, distance: S.gesture.distance }, dragging: false };
    return;
  }
  if (ev.phase === "move" && S.gesture.down) {
    const moved = Math.hypot(ev.x - S.gesture.down.x, ev.y - S.gesture.down.y);
    if (moved < 3 && !S.gesture.dragging) return;
    const distance = dragDistance(ev, frame, S.gesture.down);
    if (distance == null) return;
    S.gesture = { ...S.gesture, dragging: true, distance, upTo: null, guide: null };
    snapFace(ev, frame);
    S.host.clearExtrudePreview();
    publish("values");
    return;
  }
  if (ev.phase === "move") {
    const sketch = activeSketch(S.editor);
    if (sketch && S.editor.selection.entities.length === 0 && !S.editSession && !S.gesture.picked) {
      const hit = rayOnPlane(frame, S.host.view.pointerRay(ev.x, ev.y).origin, S.host.view.pointerRay(ev.x, ev.y).direction);
      const chosen = chooseRegions(sketch, [], hit?.uv ?? null);
      if (chosen.length > 0) S.gesture = { ...S.gesture, regions: chosen };
    }
    publish("skip");
    return;
  }
  if (ev.phase === "up" && S.gesture.down) {
    const moved = Math.hypot(ev.x - S.gesture.down.x, ev.y - S.gesture.down.y);
    S.gesture = { ...S.gesture, down: null, dragging: false };
    if (moved < 4) {
      // A click picks the region under it, as in Fusion. Shift or Ctrl adds or drops one. Enter or Apply keeps the extrude.
      const regions = clickedRegions(ev, frame, S.gesture.regions);
      if (regions) S.gesture = { ...S.gesture, regions, picked: true };
    }
    publish("open");
    armProbe();
  }
}

/**
 * The regions after a click during an extrude or revolve: the one under the pointer, or with Shift or Ctrl the
 * current ones with it added or dropped. Null when the click is on no region, so the pick stays.
 */
export function clickedRegions(ev: { x: number; y: number; shift: boolean; ctrl: boolean }, frame: SketchFrame, current: readonly Region[]): Region[] | null {
  const sketch = activeSketch(S.editor);
  if (!sketch) return null;
  const ray = S.host.view.pointerRay(ev.x, ev.y);
  const hit = rayOnPlane(frame, ray.origin, ray.direction);
  const region = hit ? regionAt(sketchRegions(sketch), hit.uv) : null;
  if (!region) return null;
  if (!(ev.shift || ev.ctrl)) return [region];
  const kept = current.filter((item) => item !== region);
  if (kept.length === current.length) return [...current, region];
  return kept.length > 0 ? kept : null;
}

function dragDistance(ev: { x: number; y: number; ctrl: boolean; shift: boolean }, frame: NonNullable<ReturnType<typeof drawingFrame>>, down: { x: number; y: number; distance: number }): number | null {
  const centre = regionsCentroid(S.gesture?.regions ?? []);
  const origin = toWorld(frame, centre);
  const dir = frame.w;
  const ray = S.host.view.pointerRay(ev.x, ev.y);
  const rayDir = unit3(ray.direction);
  const axis = unit3(dir);
  const parallel = rayDir && axis ? Math.abs(rayDir[0] * axis[0] + rayDir[1] * axis[1] + rayDir[2] * axis[2]) : 1;
  const mm = S.host.view.sketchView().mmPerPx;
  const endOn = axisOnScreen(origin, dir, mm);
  let distance: number | null = null;
  // A ray along W cannot measure a distance on W. The screen mapping is the drag then.
  if (!endOn && parallel < 0.85) {
    distance = dragAxis(ray, { origin, direction: dir }, { round: ev.ctrl, fine: ev.shift, mmPerPx: mm })?.distance ?? null;
  }
  if (distance == null) {
    const delta = screenAlong(origin, dir, down, ev, mm);
    distance = down.distance + delta;
    if (ev.ctrl) distance = Math.round(distance);
    else if (ev.shift) distance = Math.round(distance * 100) / 100;
    else distance = Math.round(distance * 10) / 10;
  }
  return Number.isFinite(distance) ? distance : null;
}

/** True when 1 mm of `dir` is plainly across the screen, so the pointer can drag along it. */
function axisOnScreen(origin: Vec3, dir: Vec3, mmPerPx: number): boolean {
  const start = S.host.view.projectPoint(origin);
  const end = S.host.view.projectPoint([origin[0] + dir[0], origin[1] + dir[1], origin[2] + dir[2]]);
  if (!start || !end) return false;
  const across = mmPerPx > 1e-6 ? 1 / mmPerPx : 0;
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  return length >= 2 && length >= across * 0.35;
}

function screenAlong(origin: Vec3, dir: Vec3, down: { x: number; y: number }, ev: { x: number; y: number }, mmPerPx: number): number {
  const start = S.host.view.projectPoint(origin);
  const end = S.host.view.projectPoint([origin[0] + dir[0], origin[1] + dir[1], origin[2] + dir[2]]);
  if (!start || !end || !axisOnScreen(origin, dir, mmPerPx)) return (down.y - ev.y) * mmPerPx;
  const sx = end.x - start.x;
  const sy = end.y - start.y;
  const length = Math.hypot(sx, sy);
  const pixels = ((ev.x - down.x) * sx + (ev.y - down.y) * sy) / Math.max(length, 1e-6);
  return pixels * mmPerPx;
}

function snapFace(ev: { x: number; y: number }, frame: NonNullable<ReturnType<typeof drawingFrame>>) {
  if (!S.gesture) return;
  const hit = S.host.view.pickSolid(ev.x, ev.y);
  const own = activeSketch(S.editor)?.on;
  if (!hit || (own?.kind === "face" && own.face.index === hit.face)) return;
  const info = S.host.faceInfo(hit.face);
  if (!info) return;
  const centre = toWorld(frame, regionsCentroid(S.gesture.regions));
  const height = (info.plane.point[0] - centre[0]) * frame.w[0] + (info.plane.point[1] - centre[1]) * frame.w[1] + (info.plane.point[2] - centre[2]) * frame.w[2];
  // A fat pixel tolerance swallowed the whole drag when the camera was close to the face.
  if (Math.abs(height - S.gesture.distance) > 0.75) return;
  const at: Vec3 = [centre[0] + frame.w[0] * height, centre[1] + frame.w[1] * height, centre[2] + frame.w[2] * height];
  S.gesture = { ...S.gesture, distance: height, upTo: info.ref, depth2: null, guide: [at, info.plane.point] };
}

export function paintExtrude() {
  if (!S.gesture || S.editor.phase !== "editing") return;
  const frame = drawingFrame();
  const sketch = activeSketch(S.editor);
  if (!frame || !sketch || S.gesture.regions.length === 0) {
    S.host.view.setHandles([]);
    S.host.view.setGhost(null);
    return;
  }
  const centre = toWorld(frame, regionsCentroid(S.gesture.regions));
  S.host.view.setHandles([inPlaceArrow({ at: centre, dir: frame.w, outward: frame.w, distance: S.gesture.distance, id: "extrude", label: "Distance" })]);
  const solid = solidFrameOf(sketch);
  const span = ghostSpan(S.gesture.distance, S.gesture.slots >= 2 ? S.gesture.depth2 : null);
  const shifted = { origin: add3(solid.origin, scale3(solid.w, span.from)) as Vec3, u: solid.u, v: solid.v };
  const parts: number[] = [];
  for (const region of S.gesture.regions) {
    const soup = regionExtrude(shifted, regionSamples(region), span.to - span.from);
    parts.push(...soup);
  }
  S.host.view.setGhost(parts.length > 0 ? { kind: "soup", positions: new Float32Array(parts) } : null);
}
