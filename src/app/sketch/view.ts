/** Entering the sketch, its frame, and drawing and publishing it to the view. */
import { S } from "./state";
import { paintCards } from "./cards";
import { paintBox, paintDataset } from "./dataset";
import { leaveDemo } from "./demo";
import { focusDimensionLabel, paintGlyphs, paintInference, paintLabels } from "./dimensions";
import { extrudeNote, extrudeReadout, paintExtrude } from "./extrude";
import { DEMO_EXTENT_MM, FACE_FOR_HOLES, framesMatch } from "./helpers";
import { askOpen } from "./holes";
import { featureNote, syncHud } from "./hud";
import { loftReadout, paintLoft } from "./loft";
import { paintRevolve, revolveReadout, revolveStrokes } from "./revolve";
import { paintSweep, pinnedStrokes, sweepReadout } from "./sweep";
import { gridSpacing } from "../../interact/snap";
import { applyPose } from "../../model-space";
import { type SketchOn, type Vec3, type SketchData } from "../../sketch/model";
import { DRILL_ALL_QUESTION } from "../../sketch/holes.ts";
import { isEditDemo, DEMO_DONE, DEMOS } from "../../sketch/demos";
import { type OriginPlane, sketchMesh } from "../../sketch/draw";
import { frameFromWorkplane, originFrame, planeOf, type SketchFrame, rayOnQuad, tiltedAtFrame, lookAtFrame, SKETCH_ANIM_MS, toWorld, planeWindow } from "../../sketch/frame";
import { gridLines } from "../../sketch/grid";
import { projectReferences } from "../../sketch/refs";
import { beginChoose, enterSketch, activeSketch, sketchBusy, canUndoSketch, canRedoSketch, sketchReadout, withRefs } from "../../sketch/session";
import { fitStatus } from "../../sketch/hints";
import { sharpCorners, axisCrossings, openEnds } from "../../sketch/reasons";
import { workplaneOwn, workplaneOnFace, workplaneIn } from "../../workplane";
import { sampleLoop } from "../../sketch/extrude";
import { toLoops } from "../../sketch/regions";
import { regionCrossesAxis } from "../../sketch/revolve";

export const sync = () => {
  if (S.editor.phase === "off") return;
  S.refsKey = "";
  publish("open");
};

export function enterNamed(name: "XY" | "XZ" | "YZ" | "workplane") {
  const frame = name === "workplane" ? frameFromWorkplane(S.host.workplane()) : offsetFrame(originFrame(name, S.host.origin()));
  const own = workplaneOwn({ source: "global", origin: frame.origin, turn: planeOf(frame).turn }, S.host.pose());
  const on: SketchOn = name === "workplane" ? { kind: "workplane" } : { kind: "plane", name };
  startDrawing(own.origin, own.turn, on);
}

export function enterFace(face: number) {
  const info = S.host.faceInfo(face);
  if (!info) {
    S.host.readout("Pick a flat face. This one is curved.");
    return;
  }
  const own = workplaneOwn(workplaneOnFace(info.plane), S.host.pose());
  startDrawing(own.origin, own.turn, { kind: "face", face: info.ref });
}

function startDrawing(origin: Vec3, turn: Vec3, on: SketchOn) {
  S.chooseOffset = 0;
  const base = S.editor.phase === "choosing" ? S.editor : beginChoose(S.editor);
  S.editor = enterSketch(base, { origin, turn }, on);
  S.aimKey = "";
  S.refsKey = "";
  publish("open");
}

export function drawingFrame(): SketchFrame | null {
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.phase !== "editing") return null;
  return frameFromWorkplane(workplaneIn({ source: "global", origin: sketch.plane.origin, turn: sketch.plane.turn }, S.host.pose()));
}

/** An origin plane moved by the card's Offset along its normal, so a sketch can start above the bed with no solid. */
function offsetFrame(frame: SketchFrame): SketchFrame {
  if (S.chooseOffset === 0) return frame;
  return { ...frame, origin: [0, 1, 2].map((i) => frame.origin[i]! + frame.w[i]! * S.chooseOffset) as Vec3 };
}

function chooserPlanes(): OriginPlane[] {
  const origin = S.host.origin();
  const half = Math.max(S.host.extent(), 20) * 0.75;
  const planes: OriginPlane[] = (["XY", "XZ", "YZ"] as const).map((name) => ({ name, frame: offsetFrame(originFrame(name, origin)), half }));
  const work = frameFromWorkplane(S.host.workplane());
  const same = planes.some((plane) => framesMatch(plane.frame, work));
  if (!same) planes.push({ name: "workplane", frame: work, half });
  return planes;
}

export function chooseAt(x: number, y: number): { kind: "face"; face: number } | { kind: "plane"; name: OriginPlane["name"] } | null {
  const ray = S.host.view.pointerRay(x, y);
  let best: { name: OriginPlane["name"]; t: number } | null = null;
  for (const plane of S.shownPlanes) {
    const hit = rayOnQuad(plane.frame, ray.origin, ray.direction, plane.half);
    if (!hit) continue;
    if (!best || hit.t < best.t) best = { name: plane.name, t: hit.t };
  }
  const face = S.host.view.pickSolid(x, y);
  if (face && (!best || face.t <= best.t)) return { kind: "face", face: face.face };
  return best ? { kind: "plane", name: best.name } : null;
}

export function publish(hudMode: "open" | "values" | "skip") {
  // P2: anything that ends the demo's sketch (Finish, Discard, Esc twice, another tool) ends the demo, and puts the
  // person's sketch back in its place.
  if (S.demo && S.editor.phase !== "editing") {
    leaveDemo();
    return;
  }
  if (S.editor.phase !== "choosing") S.faceForHoles = false;
  if (S.editor.phase !== "editing") {
    S.makeHowOpen = false;
    S.editHowOpen = false;
  }
  // Milestone 6: in an Edit tool's demo, the tool's first edit of the drawing is what the demo made.
  if (S.demo && !S.demo.made && isEditDemo(S.demo.kind) && S.editor.tool === S.demo.kind && S.editor.undo.length > S.demo.undoBase) {
    S.demo = { ...S.demo, made: true };
    S.host.canvas.dataset.sketchDemoMade = S.demo.kind;
    S.cardFocus = ["[data-sketch-demo-leave]"];
  }
  const frame = drawingFrame();
  if (frame) ensureRefs(frame);
  S.shownPlanes = S.editor.phase === "choosing" ? chooserPlanes() : [];
  if (S.editor.phase === "editing") aim(frame);
  else if (S.aimKey) {
    S.aimKey = "";
    S.host.view.setSketchCamera(null);
  }
  S.host.view.setSketchCapture(sketchBusy(S.editor) && !S.editor.lookAround && !S.host.sketchHolesArmed());
  S.host.view.setSketchDim(sketchBusy(S.editor));
  if (S.editor.phase === "editing" && S.aimKey) S.host.view.setSketchLock(!S.editor.lookAround && !featureTilt());
  draw();
  paintCards();
  paintBox();
  paintDataset();
  paintLabels();
  paintGlyphs();
  paintInference();
  paintReadout();
  syncHud(hudMode);
  S.hud.setNote(featureNote());
  focusDimensionLabel();
  if (S.button) {
    const busy = sketchBusy(S.editor);
    S.button.setAttribute("aria-pressed", busy ? "true" : "false");
    if (S.button.getAttribute("aria-disabled") !== "true") {
      S.button.dataset.tipIdle ??= S.button.dataset.tip ?? "";
      S.button.dataset.tip = busy ? "Finish the sketch on the card, or press Esc." : S.button.dataset.tipIdle;
    }
  }
  S.host.syncPull();
  S.host.syncEdge();
  paintExtrude();
  paintRevolve();
  paintLoft();
  paintSweep();
  // --- F1. The empty-plate card sits on the plane. Hide it while drawing so a click reaches the sketch. ---
  const empty = document.querySelector<HTMLElement>("#modelEmpty");
  if (empty) empty.hidden = sketchBusy(S.editor) || S.host.solid() != null;
  const history = S.editor.phase === "editing" ? `${canUndoSketch(S.editor)}:${canRedoSketch(S.editor)}` : S.editor.phase;
  if (history !== S.historyKey) {
    S.historyKey = history;
    S.host.onHistory();
  }
}

/**
 * The readout is the sketch's while it is open. An Apply's sentences, working and done, and the Hole panel's stay.
 * Once the sketch closes it hands the readout back once ("Sketch kept…" after Finish), and then leaves the solid's
 * own sentences alone, so a later sync does not write over "Edit undone." or a volume.
 */
function paintReadout() {
  if (S.keepReadout || (S.applying || S.holding) || S.host.sketchHolesArmed()) {
    S.saidLast = false;
    return;
  }
  if (!sketchBusy(S.editor)) {
    if (S.saidLast) S.host.readout(S.editor.phase === "pinned" ? sketchReadout(S.editor) : S.host.idleReadout());
    S.saidLast = false;
    return;
  }
  S.saidLast = true;
  // P2: a demo's status line says the next click, then that it is done; a refusal still comes first.
  const featureNote = S.sweep ? S.sweep.note : S.loft ? S.loft.note : S.revolve ? S.revolveNote : S.gesture ? extrudeNote() : S.demo && isEditDemo(S.demo.kind) ? S.editor.draw.note ?? "" : "";
  if (S.demo && S.editor.phase === "editing" && !featureNote) S.host.readout(fitStatus(S.demo.made ? DEMO_DONE : DEMOS[S.demo.kind].tryIt));
  else if (S.sweep && S.editor.phase === "editing") S.host.readout(fitStatus(S.sweep.note || sweepReadout()));
  else if (S.loft && S.editor.phase === "editing") S.host.readout(fitStatus(S.loft.note || loftReadout()));
  else if (S.revolve && S.editor.phase === "editing") S.host.readout(fitStatus(S.revolveNote || revolveReadout()));
  else if (S.gesture && S.editor.phase === "editing") S.host.readout(fitStatus(extrudeReadout()));
  else if (askOpen()) S.host.readout(DRILL_ALL_QUESTION);
  else if (S.faceForHoles) S.host.readout(FACE_FOR_HOLES);
  else S.host.readout(fitStatus(sketchReadout(S.editor)));
}

function aim(frame: SketchFrame | null) {
  if (!frame) return;
  const tilt = featureTilt();
  const key = `${S.editor.active}:${frame.origin.map((value) => value.toFixed(3)).join()}:${frame.w.map((value) => value.toFixed(3)).join()}:${tilt ? "tilt" : "plan"}`;
  if (key === S.aimKey) return;
  S.aimKey = key;
  const view = S.host.view.sketchView();
  // --- B15. An extrude or a revolve tilts the view so its depth shows; back in the sketch the view is the plan again.
  // P2: a demo is framed on itself, whatever the size of the part.
  const pose = (tilt ? tiltedAtFrame : lookAtFrame)(frame, S.demo ? S.demo.focus : S.host.focus(), S.demo ? DEMO_EXTENT_MM : S.host.extent(), view.fov);
  S.host.view.setSketchCamera({ ...pose, animateMs: SKETCH_ANIM_MS, lock: !S.editor.lookAround && !tilt });
}

/** An extrude or a revolve is being aimed. */
export function featureTilt(): boolean {
  // P2: in a demo, a loft or a sweep tilts too, so the shape it makes can be seen.
  return !!(S.gesture || S.revolve) || (S.demo != null && !!(S.loft || S.sweep));
}

function ensureRefs(frame: SketchFrame) {
  // Milestone 6: Copy edge's demo reads its stand-in face, not the part's edges.
  if (S.demo?.refs) {
    if (S.refsKey !== "demo") {
      S.refsKey = "demo";
      S.editor = withRefs(S.editor, S.demo.refs);
    }
    return;
  }
  const on = activeSketch(S.editor)?.on;
  const face = on?.kind === "face" ? on.face.index : null;
  const key = `${S.editor.active}:${face ?? "x"}:${frame.origin.map((value) => value.toFixed(2)).join()}${S.profile ? ":profile" : ""}`;
  if (key === S.refsKey) return;
  S.refsKey = key;
  // A profile is drawn against the part cut across its plane, not the solid's edges.
  S.editor = withRefs(S.editor, S.profile ? projectReferences(frame, S.profile.refs, null) : projectReferences(frame, S.host.edges(), S.host.outline(face)));
}

export function draw() {
  if (S.editor.phase === "off" || S.editor.phase === "pinned") {
    S.host.view.setSketchDraw(null);
    return;
  }
  const frame = drawingFrame();
  const grid = frame ? gridFor(frame) : [];
  const mesh = sketchMesh(S.editor, frame, grid, S.shownPlanes, S.host.view.sketchView().mmPerPx);
  S.host.canvas.dataset.sketchTrimPieces = String(mesh.shown?.trimPieces ?? 0);
  S.host.canvas.dataset.sketchTrimHot = mesh.shown?.trimHot ?? "";
  S.host.canvas.dataset.sketchRefHot = String(mesh.shown?.refHot ?? 0);
  if (S.gesture?.guide) mesh.strokes.push({ xyz: [...S.gesture.guide[0], ...S.gesture.guide[1]], role: "hint" });
  if (S.revolve && frame) mesh.strokes.push(...revolveStrokes(frame));
  if ((S.loft || S.sweep) && frame) mesh.strokes.push(...pinnedStrokes());
  const red = frame ? redDots(frame) : { kind: "", at: [] };
  for (const at of red.at) mesh.dots.push({ at, role: "refuse" });
  S.redShown = { kind: red.kind, count: red.at.length };
  S.host.view.setSketchDraw(mesh);
}

function drawingKey(sketch: SketchData): string {
  return JSON.stringify([sketch.points, sketch.entities]);
}

/** R2: mark open ends after a reason named them; a refused crossing of the revolve axis; a sweep's sharp corners. */
export function showMarks(kind: "open") {
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.phase !== "editing") return;
  const drawing = drawingKey(sketch);
  if (S.redMarks?.kind === kind && S.redMarks.drawing === drawing) return;
  S.redMarks = { kind, drawing };
  publish("skip");
}

function redDots(frame: SketchFrame): { kind: string; at: Vec3[] } {
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.phase !== "editing") {
    S.redMarks = null;
    return { kind: "", at: [] };
  }
  if (S.sweep && S.sweep.path.length >= 3) {
    const corners = sharpCorners(S.sweep.path, S.sweep.check);
    if (corners.length > 0) return { kind: "sharp", at: corners.map((point) => applyPose(S.host.pose(), point)) };
  }
  if (S.revolve?.crossing) {
    const at: Vec3[] = [];
    for (const region of S.revolve.regions) {
      if (!regionCrossesAxis(region, S.revolve.axis)) continue;
      for (const loop of toLoops(region)) for (const point of axisCrossings(sampleLoop(loop), S.revolve.axis)) at.push(toWorld(frame, point));
    }
    if (at.length > 0) return { kind: "cross", at };
  }
  if (S.redMarks && S.redMarks.drawing !== drawingKey(sketch)) S.redMarks = null;
  if (S.redMarks?.kind === "open" && !(S.gesture || S.revolve || S.loft || S.sweep)) {
    return { kind: "open", at: openEnds(sketch).map((point) => toWorld(frame, point)) };
  }
  return { kind: "", at: [] };
}

function gridFor(frame: SketchFrame) {
  const view = S.host.view.sketchView();
  const window = planeWindow(frame, {
    position: view.position,
    target: view.target,
    up: view.up,
    fovDeg: view.fov,
    aspect: view.height > 0 ? view.width / view.height : 1,
  });
  return gridLines(window.minU, window.maxU, window.minV, window.maxV, gridSpacing(view.mmPerPx));
}
