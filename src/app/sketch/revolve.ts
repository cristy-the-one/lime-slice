/** Revolve from the open sketch. */
import { S } from "./state";
import { demoMade } from "./demo";
import { clickedRegions, editedRegions, endExtrude } from "./extrude";
import { afterFeature, committed, featureEdit, withSketchName } from "./feature";
import { endLoft } from "./loft";
import { featureBlocked } from "./starts";
import { endSweep } from "./sweep";
import { drawingFrame, publish } from "./view";
import { GHOST_PROBE_WAIT_MS, revolveGhost } from "../../interact/ghosts";
import { type ModelOp } from "../../model-tree";
import { type SketchData, type Vec3 } from "../../sketch/model";
import { type SketchStroke } from "../../sketch/draw";
import { rayOnPlane, toWorld, planeWindow } from "../../sketch/frame";
import { activeSketch } from "../../sketch/session";
import { featureTitle } from "../../sketch/hints";
import { REASON } from "../../sketch/reasons";
import { withExprs } from "../../modeling/params.ts";
import { chooseRegions, sketchTouchesSolid, resolveExtrudeMode, modeLabel, sampleLoop, regionsCentroid, solidFrameOf } from "../../sketch/extrude";
import { toLoops } from "../../sketch/regions";
import { type RevolvePreset, regionsForEdit, defaultAxis, regionCrossesAxis, typedAngle, buildSketchRevolve, type RevolveAxis, pickAxis, sketchAxes, edgeAxes, planeAxes, dragAngle, axisWorld, perpPixels, clipAxis, dashSegment, revolveRing } from "../../sketch/revolve";

// --- F2. Revolve from the open sketch. The ring is drawn; the angle is this pointer, because the
// sketch camera looks along the plane and a view-ring drag cannot measure a turn in that plane. ---
export function beginRevolve(preset?: RevolvePreset) {
  if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
  if (S.gesture) endExtrude();
  if (S.loft) endLoft();
  if (S.sweep) endSweep();
  const sketch = activeSketch(S.editor);
  const frame = drawingFrame();
  if (!sketch || !frame || S.editor.phase !== "editing") return;
  const regions = (preset ? regionsForEdit(sketch, S.editOutlines) : editedRegions(sketch)) ?? chooseRegions(sketch, S.editor.selection.entities, S.editor.cursor);
  if (regions.length === 0) {
    S.host.readout("Select a region to revolve.");
    return;
  }
  const axis = preset?.axis ?? axisUnderPointer(sketch, frame) ?? defaultAxis();
  S.revolveNote = "";
  S.revolve = {
    angle: preset?.angleDeg ?? 360,
    axis,
    follow: !preset,
    choice: preset?.choice ?? (featureEdit() === "root" ? "new" : "auto"),
    regions,
    dragging: false,
    crossing: regions.some((region) => regionCrossesAxis(region, axis)),
    down: null,
  };
  publish("open");
  armRevolveProbe();
}

export function endRevolve() {
  if (!S.revolve) return;
  S.revolve = null;
  S.revolveNote = "";
  window.clearTimeout(S.probeTimer);
  S.host.view.setHandles([]);
  S.host.view.setGhost(null);
  S.host.clearExtrudePreview();
  publish("open");
}

export function takeRevolveAngle(value: number) {
  if (!S.revolve) return;
  const typed = typedAngle(value);
  if ("error" in typed) {
    S.revolveNote = typed.error;
    return;
  }
  S.revolveNote = "";
  S.revolve = { ...S.revolve, angle: typed.angle, follow: false };
}

export function resolvedRevolveMode() {
  const sketch = activeSketch(S.editor);
  const frame = drawingFrame();
  const touches = !!sketch && !!frame && !!S.revolve && sketchTouchesSolid(frame, S.revolve.regions, S.host.bounds(), sketch.on?.kind === "face");
  return resolveExtrudeMode({
    choice: S.revolve?.choice ?? "auto",
    hasSolid: S.host.solid() != null,
    touches,
    distance: 1,
    lockNew: featureEdit() === "root",
    stepEdit: featureEdit() === "step",
  });
}

function currentRevolveOp(): ModelOp | null {
  const sketch = activeSketch(S.editor);
  if (!sketch || !S.revolve || S.revolve.regions.length === 0 || S.revolve.crossing) return null;
  const built = buildSketchRevolve({
    sketch: withSketchName(sketch, S.editor.active),
    regions: S.revolve.regions,
    axis: S.revolve.axis,
    angleDeg: S.revolve.angle,
    mode: resolvedRevolveMode(),
  });
  return "op" in built ? built.op : null;
}

export async function commitRevolve() {
  const why = featureBlocked();
  if (why) {
    S.host.readout(why);
    return;
  }
  const sketch = activeSketch(S.editor);
  if (!sketch || !S.revolve || (S.applying || S.holding)) return;
  const built = buildSketchRevolve({
    sketch: withSketchName(sketch, S.editor.active),
    regions: S.revolve.regions,
    axis: S.revolve.axis,
    angleDeg: S.revolve.angle,
    mode: resolvedRevolveMode(),
  });
  if ("error" in built) {
    S.revolveNote = built.error;
    publish("skip");
    S.host.readout(built.error);
    return;
  }
  const op = withExprs(built.op, S.revolve.angleText ? { angle: S.revolve.angleText } : undefined);
  const mode = resolvedRevolveMode();
  if (S.demo) {
    demoMade(op);
    return;
  }
  const error = await committed(S.host.commitExtrude(op, mode === "new" ? "new" : "on-solid"));
  if (error === undefined) return;
  if (error) {
    S.revolveNote = error;
    publish("skip");
    S.host.readout(error);
    return;
  }
  afterFeature();
}

export function armRevolveProbe() {
  window.clearTimeout(S.probeTimer);
  if (!S.revolve || S.revolve.dragging || S.revolve.crossing) {
    if (S.revolve?.dragging || S.revolve?.crossing) S.host.clearExtrudePreview();
    return;
  }
  if (resolvedRevolveMode() === "new" || !S.host.solid()) {
    S.host.clearExtrudePreview();
    return;
  }
  S.probeTimer = window.setTimeout(() => {
    const op = currentRevolveOp();
    if (op) S.host.probeExtrude(op);
  }, GHOST_PROBE_WAIT_MS);
}

export function revolveReadout(): string {
  if (!S.revolve) return "";
  if (S.revolve.crossing) return REASON.crossAxis;
  const mode = modeLabel(resolvedRevolveMode());
  return featureTitle("revolve", `${S.revolve.angle}° · ${mode}`);
}

function axisUnderPointer(sketch: SketchData, frame: NonNullable<ReturnType<typeof drawingFrame>>): RevolveAxis | null {
  const ray = S.host.view.pointerRay(S.lastClient.x, S.lastClient.y);
  const hit = rayOnPlane(frame, ray.origin, ray.direction);
  if (!hit) return null;
  const tol = Math.max(S.host.view.sketchView().mmPerPx, 1e-4) * 8;
  return pickAxis([...sketchAxes(sketch), ...edgeAxes(S.editor.refs.segments), ...planeAxes()], hit.uv, tol);
}

export function revolvePointer(ev: { phase: "down" | "move" | "up"; x: number; y: number; shift: boolean; ctrl: boolean }, frame: ReturnType<typeof drawingFrame>) {
  if (!S.revolve || !frame) return;
  if (ev.phase === "down") {
    S.revolve = { ...S.revolve, down: { x: ev.x, y: ev.y, angle: S.revolve.angle }, dragging: false };
    return;
  }
  if (ev.phase === "move" && S.revolve.down) {
    const moved = Math.hypot(ev.x - S.revolve.down.x, ev.y - S.revolve.down.y);
    if (moved < 3 && !S.revolve.dragging) return;
    const delta: [number, number] = [ev.x - S.revolve.down.x, ev.y - S.revolve.down.y];
    const snap = ev.ctrl ? "step" : ev.shift ? "fine" : "none";
    const angle = dragAngle(S.revolve.down.angle, perpOf(frame, S.revolve.axis, delta), snap);
    S.revolve = { ...S.revolve, dragging: true, follow: false, angle };
    S.host.clearExtrudePreview();
    publish("values");
    return;
  }
  if (ev.phase === "move") {
    if (S.revolve.follow) {
      const sketch = activeSketch(S.editor);
      const picked = sketch ? axisUnderPointer(sketch, frame) : null;
      const axis = picked ?? S.revolve.axis;
      let regions = S.revolve.regions;
      if (sketch && S.editor.selection.entities.length === 0) {
        const ray = S.host.view.pointerRay(ev.x, ev.y);
        const hit = rayOnPlane(frame, ray.origin, ray.direction);
        const chosen = chooseRegions(sketch, [], hit?.uv ?? null);
        if (chosen.length > 0) regions = chosen;
      }
      S.revolve = { ...S.revolve, axis, regions, crossing: regions.some((region) => regionCrossesAxis(region, axis)) };
    }
    publish("skip");
    return;
  }
  if (ev.phase === "up" && S.revolve.down) {
    const moved = Math.hypot(ev.x - S.revolve.down.x, ev.y - S.revolve.down.y);
    const wasFollow = S.revolve.follow;
    S.revolve = { ...S.revolve, down: null, dragging: false };
    if (moved < 4) {
      // The first click locks the axis. A later one picks the region under it; Enter or Apply keeps the revolve.
      if (wasFollow) S.revolve = { ...S.revolve, follow: false };
      else {
        const regions = clickedRegions(ev, frame, S.revolve.regions);
        if (regions) S.revolve = { ...S.revolve, regions, picked: true, crossing: regions.some((region) => regionCrossesAxis(region, S.revolve!.axis)) };
      }
    }
    publish("open");
    armRevolveProbe();
  }
}

function perpOf(frame: NonNullable<ReturnType<typeof drawingFrame>>, axis: RevolveAxis, delta: [number, number]): number {
  const origin = toWorld(frame, axis.origin);
  const world = axisWorld(frame, axis);
  const tip: Vec3 = [origin[0] + world[0], origin[1] + world[1], origin[2] + world[2]];
  const start = S.host.view.projectPoint(origin);
  const end = S.host.view.projectPoint(tip);
  const screen: [number, number] = start && end ? [end.x - start.x, end.y - start.y] : [0, -1];
  return perpPixels(screen, delta);
}

export function revolveStrokes(frame: NonNullable<ReturnType<typeof drawingFrame>>): SketchStroke[] {
  if (!S.revolve) return [];
  const view = S.host.view.sketchView();
  const bounds = planeWindow(frame, {
    position: view.position,
    target: view.target,
    up: view.up,
    fovDeg: view.fov,
    aspect: view.height > 0 ? view.width / view.height : 1,
  });
  const mm = Math.max(view.mmPerPx, 1e-4);
  const dash = Math.max(mm * 8, 0.4);
  const out: SketchStroke[] = [];
  for (const axis of planeAxes()) {
    const clipped = clipAxis(axis, bounds);
    if (!clipped) continue;
    for (const [a, b] of dashSegment(clipped[0], clipped[1], dash, dash * 0.65)) {
      out.push({ xyz: [...toWorld(frame, a), ...toWorld(frame, b)], role: "axis" });
    }
  }
  const hot = clipAxis(S.revolve.axis, bounds);
  if (hot) out.push({ xyz: [...toWorld(frame, hot[0]), ...toWorld(frame, hot[1])], role: "hint" });
  if (S.revolve.crossing) {
    for (const region of S.revolve.regions) {
      if (!regionCrossesAxis(region, S.revolve.axis)) continue;
      for (const loop of toLoops(region)) {
        const samples = sampleLoop(loop);
        if (samples.length < 2) continue;
        const closed = [...samples, samples[0]!];
        const xyz: number[] = [];
        for (const point of closed) xyz.push(...toWorld(frame, point));
        out.push({ xyz, role: "refuse" });
      }
    }
  }
  return out;
}

export function paintRevolve() {
  if (!S.revolve || S.editor.phase !== "editing") return;
  const frame = drawingFrame();
  const sketch = activeSketch(S.editor);
  if (!frame || !sketch || S.revolve.regions.length === 0) {
    S.host.view.setHandles([]);
    S.host.view.setGhost(null);
    return;
  }
  const centre = toWorld(frame, regionsCentroid(S.revolve.regions));
  S.host.view.setHandles([revolveRing(centre, axisWorld(frame, S.revolve.axis), S.revolve.angle)]);
  if (S.revolve.crossing) {
    S.host.view.setGhost(null);
    return;
  }
  const solid = solidFrameOf(sketch);
  const parts: number[] = [];
  for (const region of S.revolve.regions) {
    const outer = toLoops(region)[0];
    if (!outer) continue;
    const soup = revolveGhost({
      plane: { origin: solid.origin, u: solid.u, v: solid.v },
      axisOrigin: S.revolve.axis.origin,
      axisDir: S.revolve.axis.dir,
      outline: sampleLoop(outer),
      angleDeg: S.revolve.angle,
    });
    parts.push(...soup);
  }
  S.host.view.setGhost(parts.length > 0 ? { kind: "soup", positions: new Float32Array(parts) } : null);
}
