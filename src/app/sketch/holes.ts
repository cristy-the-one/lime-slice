/** Holes from anywhere: H on a sketch. */
import { S } from "./state";
import { textButton } from "./cards";
import { demoHoles } from "./demo";
import { markBlocked } from "./starts";
import { publish } from "./view";
import { type SketchData } from "../../sketch/model";
import { sketchOnFace, FACE_REFUSAL, holeTargets, POINT_REFUSAL, type HoleTarget, everyHoleSelection, DRILL_ALL_QUESTION } from "../../sketch/holes.ts";
import { activeSketch } from "../../sketch/session";
import { REASON } from "../../sketch/reasons";

export function beginHoles() {
  const sketch = activeSketch(S.editor);
  if (!sketch || !sketchOnFace(sketch)) {
    S.host.readout(S.host.solid() ? REASON.holesFace : FACE_REFUSAL);
    return;
  }
  // H again while the question is up is a Yes.
  if (askOpen()) {
    drillEvery();
    return;
  }
  const targets = holeTargets(sketch, S.editor.selection);
  if (targets.length === 0) {
    const every = everyHole(sketch);
    if (nothingSelected() && every.length > 0) {
      S.drillAsk = { sketch, count: every.length };
      S.cardFocus = ["[data-sketch-drill-yes]"];
      publish("open");
      return;
    }
    S.host.readout(POINT_REFUSAL);
    return;
  }
  if (S.demo) {
    demoHoles(sketch, targets);
    return;
  }
  S.host.beginSketchHoles(sketch, targets);
  publish("open");
}

// --- H1. Holes from anywhere. ---
export function nothingSelected(): boolean {
  return S.editor.selection.entities.length === 0 && S.editor.selection.points.length === 0;
}

export function everyHole(sketch: SketchData): HoleTarget[] {
  return holeTargets(sketch, everyHoleSelection(sketch));
}

/** The question is up: asked about this drawing, nothing else open, and nothing changed since. */
export function askOpen(): boolean {
  return S.drillAsk != null && S.editor.phase === "editing" && activeSketch(S.editor) === S.drillAsk.sketch && !(S.gesture || S.revolve || S.loft || S.sweep || S.profile) && !S.host.sketchHolesArmed();
}

/** Yes: every point and circle centre is selected, and the Hole panel opens on them, as H does on a selection. */
export function drillEvery() {
  const sketch = activeSketch(S.editor);
  S.drillAsk = null;
  if (!sketch) return;
  const selection = everyHoleSelection(sketch);
  S.editor = { ...S.editor, selection };
  if (S.demo) {
    demoHoles(sketch, holeTargets(sketch, selection));
    return;
  }
  S.host.beginSketchHoles(sketch, holeTargets(sketch, selection));
  publish("open");
}

export function dropAsk() {
  S.drillAsk = null;
  S.cardFocus = ["[data-sketch-holes]"];
  publish("open");
  S.host.readout(POINT_REFUSAL);
}

/** In place of Make while H asks: the question, how many holes, Yes and No. */
export function askStrip(): HTMLElement {
  const strip = document.createElement("section");
  strip.className = "sketch-section sketch-feature sketch-drill";
  strip.dataset.sketchSection = "drill";
  const name = document.createElement("p");
  name.className = "sketch-feature-name";
  name.textContent = "Holes";
  const question = document.createElement("p");
  question.className = "sketch-drill-note model-note";
  question.setAttribute("role", "status");
  question.textContent = DRILL_ALL_QUESTION;
  const count = S.drillAsk?.count ?? 0;
  const yes = textButton(count === 1 ? "Yes, drill 1 hole" : `Yes, drill ${count} holes`, { sketchDrillYes: "" });
  yes.classList.add("primary");
  yes.dataset.tipIdle = "Open the hole sizes for every point and circle centre (Enter)";
  markBlocked(yes, "");
  const no = textButton("No, I'll pick", { sketchDrillNo: "" });
  no.dataset.tip = "Select the points or circles yourself, then press H (Esc)";
  no.title = no.dataset.tip;
  const actions = document.createElement("div");
  actions.className = "sketch-feature-actions";
  actions.append(yes, no);
  strip.append(name, question, actions);
  return strip;
}
