/** Show me: the demo sketches. */
import { S } from "./state";
import { textButton } from "./cards";
import { beginExtrude } from "./extrude";
import { armProbe } from "./feature";
import { armLoftProbe, beginLoft } from "./loft";
import { armRevolveProbe, beginRevolve } from "./revolve";
import { armSweepProbe, beginSweep } from "./sweep";
import type { DemoSaved } from "./types";
import { drawingFrame, featureTilt, publish } from "./view";
import { type ModelOp } from "../../model-tree";
import { type SketchData } from "../../sketch/model";
import { holeTargets, type HoleTarget, holesInModel } from "../../sketch/holes.ts";
import { type DemoKind, placeDemo, isEditDemo, DEMO_WALL, DEMO_HOLE_SIZES, DEMOS, DEMO_DONE, DEMO_LEAD, DEMO_KINDS } from "../../sketch/demos";
import { toPlane, toWorld, SKETCH_ANIM_MS } from "../../sketch/frame";
import { hitSketch } from "../../sketch/hit";
import { activeSketch, sketchOff, pinSketch, enterSketchData, withTool, type SketchTool } from "../../sketch/session";
import { armOffset } from "../../sketch/tools";

// --- P2. Show me. ---

/**
 * Open `kind`'s demo on the plane of the open sketch, centred where the view looks, with the tool started so its next
 * click is the one the strip names. The person's sketch, feature and camera are kept to put back.
 */
export function openDemo(kind: DemoKind) {
  const sketch = activeSketch(S.editor);
  const frame = drawingFrame();
  if (S.demo || !sketch || !frame || S.editor.phase !== "editing" || S.applying || S.holding || S.profile) return;
  const view = S.host.view.sketchView();
  const saved: DemoSaved = {
    editor: S.editor,
    gesture: S.gesture,
    revolve: S.revolve,
    revolveNote: S.revolveNote,
    loft: S.loft,
    sweep: S.sweep,
    drillAsk: S.drillAsk,
    redMarks: S.redMarks,
    editSession: S.editSession,
    editOutlines: S.editOutlines,
    editCards: S.editCards,
    above: S.above,
    aboveHeight: S.aboveHeight,
    howFeature: S.howFeature,
    howOpen: S.howOpen,
    makeHowOpen: S.makeHowOpen,
    editHowOpen: S.editHowOpen,
    aimKey: S.aimKey,
    holes: S.host.sketchHolesArmed() ? { sketch, targets: holeTargets(sketch, S.editor.selection) } : null,
    camera: { position: [...view.position], target: [...view.target], up: [...view.up] },
  };
  clearFeatureView();
  const centre = toPlane(frame, S.host.focus()).uv;
  const placed = placeDemo(kind, { plane: sketch.plane, ...(sketch.on ? { on: sketch.on } : {}), centre });
  let next = sketchOff();
  for (const item of placed.cards) next = pinSketch(next, item.sketch, item.name);
  next = enterSketchData(next, placed.drawing);
  S.gesture = null;
  S.revolve = null;
  S.revolveNote = "";
  S.loft = null;
  S.sweep = null;
  S.drillAsk = null;
  S.redMarks = null;
  S.editSession = false;
  S.editOutlines = [];
  S.editCards = [];
  S.above = null;
  S.howFeature = null;
  S.howOpen = false;
  S.makeHowOpen = false;
  S.editHowOpen = false;
  S.menuOpen = null;
  S.demo = { kind, saved, made: false, focus: toWorld(frame, centre), undoBase: 0, ...(placed.refs ? { refs: placed.refs } : {}), ...(placed.aim ? { aim: placed.aim } : {}) };
  S.editor = next;
  S.aimKey = "";
  S.refsKey = "";
  S.host.canvas.dataset.sketchDemoMade = "";
  if (isEditDemo(kind)) {
    openEditDemo(kind, placed.drawing, placed.aim ?? centre);
    return;
  }
  if (kind === "extrude") beginExtrude();
  else if (kind === "revolve") beginRevolve();
  else if (kind === "loft") beginLoft();
  else if (kind === "sweep" || kind === "pipe") beginSweep();
  else {
    // Holes waits for H, the click the strip names.
    S.cardFocus = ["[data-sketch-holes]"];
    publish("open");
  }
}

/**
 * Milestone 6: an Edit tool's demo opens with that tool on, ready for the click the strip names. Trim shows its red
 * piece before the pointer moves; Offset has the route picked with Both sides and Close the ends on, and waits for a
 * typed distance.
 */
function openEditDemo(kind: DemoKind, drawing: SketchData, aim: [number, number]) {
  S.editor = withTool(S.editor, kind as SketchTool);
  if (kind === "trim") {
    const hit = hitSketch(drawing, aim, 0.5);
    S.editor = { ...S.editor, pointer: aim, hover: { point: null, entity: hit.entity } };
  }
  if (kind === "offset") {
    const ids = drawing.entities.map((entity) => entity.id);
    S.editor = { ...S.editor, cursor: aim, draw: armOffset(drawing, { ...S.editor.draw, wall: { ...DEMO_WALL } }, ids, aim), selection: { entities: ids, points: [] } };
  }
  S.cardFocus = ["[data-sketch-demo-leave]"];
  publish("open");
}

/** The demo's Apply: the op its tool built, which goes nowhere. The ghost stays, so the person sees what it made. */
export function demoMade(op: ModelOp) {
  if (!S.demo) return;
  S.demo = { ...S.demo, made: true };
  S.host.canvas.dataset.sketchDemoMade = op.kind;
  S.cardFocus = ["[data-sketch-demo-leave]"];
  publish("open");
}

/** The demo's Holes: the group the Hole panel would apply at its opening sizes. The panel itself is the part's. */
export function demoHoles(sketch: SketchData, targets: readonly HoleTarget[]) {
  const built = holesInModel({ sketch, points: targets, pose: S.host.pose(), sizes: DEMO_HOLE_SIZES });
  if ("error" in built) {
    S.host.readout(built.error);
    publish("open");
    return;
  }
  demoMade(built.op);
}

/** Close the demo and put back the sketch, feature, Hole panel and camera exactly as Show me found them. */
export function leaveDemo() {
  if (!S.demo) return;
  const { saved, kind: left } = S.demo;
  S.demo = null;
  clearFeatureView();
  S.editor = saved.editor;
  S.gesture = saved.gesture;
  S.revolve = saved.revolve;
  S.revolveNote = saved.revolveNote;
  S.loft = saved.loft;
  S.sweep = saved.sweep;
  S.drillAsk = saved.drillAsk;
  S.redMarks = saved.redMarks;
  S.editSession = saved.editSession;
  S.editOutlines = saved.editOutlines;
  S.editCards = saved.editCards;
  S.above = saved.above;
  S.aboveHeight = saved.aboveHeight;
  S.howFeature = saved.howFeature;
  S.howOpen = saved.howOpen;
  S.makeHowOpen = saved.makeHowOpen;
  S.editHowOpen = saved.editHowOpen;
  S.menuOpen = null;
  S.aimKey = saved.aimKey;
  S.refsKey = "";
  S.host.canvas.dataset.sketchDemoMade = "";
  // The keyboard goes back to the How the demo was opened from.
  S.cardFocus = [".sketch-how-open", isEditDemo(left) ? "[data-sketch-edit-how]" : "[data-sketch-make-how]"];
  publish("open");
  S.host.view.setSketchCamera({ ...saved.camera, animateMs: SKETCH_ANIM_MS, lock: !S.editor.lookAround && !featureTilt() });
  if (S.gesture) armProbe();
  else if (S.revolve) armRevolveProbe();
  else if (S.loft) armLoftProbe();
  else if (S.sweep) armSweepProbe();
  if (saved.holes) S.host.beginSketchHoles(saved.holes.sketch, saved.holes.targets);
}

/** The demo closes under the card (Model left, a history jump, another tool): the person's state comes back unsaid. */
export function leaveDemoQuietly() {
  if (!S.demo) return;
  const saved = S.demo.saved;
  // The Hole panel isn't reopened under a tool that is taking the dock.
  S.demo = { ...S.demo, saved: { ...saved, holes: null } };
  leaveDemo();
}

/** What a feature shows outside the card: the probe on its way, the handles, the ghost, the preview, the Hole panel. */
function clearFeatureView() {
  window.clearTimeout(S.probeTimer);
  S.host.view.setHandles([]);
  S.host.view.setGhost(null);
  S.host.clearExtrudePreview();
  if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
}

/** Above Draw while a demo is open: which tool, and the next click or what it made. */
export function demoStrip(): HTMLElement {
  const open = S.demo!;
  const spec = DEMOS[open.kind];
  const strip = document.createElement("section");
  strip.className = "sketch-section sketch-feature sketch-demo";
  strip.dataset.sketchSection = "demo";
  strip.dataset.sketchDemoOpen = open.kind;
  const name = document.createElement("p");
  name.className = "sketch-feature-name";
  name.textContent = `Show me: ${spec.label}`;
  const note = document.createElement("p");
  note.className = "sketch-demo-note model-note";
  note.setAttribute("role", "status");
  note.textContent = open.made ? `${spec.made} ${DEMO_DONE}` : spec.tryIt;
  strip.append(name, note);
  return strip;
}

/** P2 on the Make row: a ? after the tools, whose How lists a Show me for each one. */
export function makeHow(): Node[] {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn sketch-make-how";
  button.textContent = "?";
  button.dataset.sketchMakeHow = "";
  button.setAttribute("aria-label", "Make tool demos");
  button.setAttribute("aria-expanded", S.makeHowOpen ? "true" : "false");
  button.setAttribute("aria-controls", "sketchMakeHow");
  button.dataset.tip = "Show me how each one works";
  button.title = button.dataset.tip;
  const pop = document.createElement("div");
  pop.id = "sketchMakeHow";
  pop.className = "sketch-how-pop sketch-make-how-pop";
  pop.setAttribute("role", "group");
  pop.setAttribute("aria-label", "Show me");
  pop.hidden = !S.makeHowOpen;
  const lead = document.createElement("p");
  lead.className = "sketch-how-lead";
  lead.textContent = DEMO_LEAD;
  const row = document.createElement("div");
  row.className = "sketch-how-demos";
  for (const kind of DEMO_KINDS) row.append(showMeButton(kind, DEMOS[kind].label));
  pop.append(lead, row);
  return [button, pop];
}

export function showMeButton(kind: DemoKind, label: string): HTMLButtonElement {
  const show = textButton(label, { sketchDemo: kind });
  show.classList.add("sketch-show-me");
  show.dataset.tip = `Try ${DEMOS[kind].label} on a small ready-made sketch. Your own sketch comes back after.`;
  show.dataset.sketchDemoGroup = isEditDemo(kind) ? "edit" : "make";
  show.title = show.dataset.tip;
  return show;
}
