/** Close the gap, and Add a shape above. */
import { S } from "./state";
import { textButton } from "./cards";
import { formatHeight } from "./helpers";
import { beginLoft, endLoft, takeLoftSketch } from "./loft";
import { markBlocked } from "./starts";
import { publish, showMarks } from "./view";
import { pushToast } from "../../ui/toasts";
import { type SketchData } from "../../sketch/model";
import { activeSketch, editActiveSketch, enterSketchData, finishSketch, reopenSketch, discardSketch, moveActivePlane } from "../../sketch/session";
import { noShapeReason, REASON, namesOpenEnds, ASSIST_PURPOSE } from "../../sketch/reasons";
import { type ClosedGap, closeGap } from "../../sketch/close-gap";
import { shapeAbove, settleAbove, planeAbove } from "../../sketch/loft-above";
import { sketchRegions } from "../../sketch/regions";

/** --- E1. What Close the gap would make of each drawing, worked out once per drawing. --- */
const gapOf = new WeakMap<SketchData, ClosedGap | null>();

// --- E1. Close the gap. ---
/** What Close the gap makes of the open drawing, or null when nothing it could do closes a shape. */
export function gapToClose(): ClosedGap | null {
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.phase !== "editing" || sketchRegions(sketch).length > 0) return null;
  if (!gapOf.has(sketch)) gapOf.set(sketch, closeGap(sketch));
  return gapOf.get(sketch) ?? null;
}

/** Why the drawing makes no shape. Open ends that Close the gap can join say so. */
export function shapeWhy(sketch: SketchData): string {
  const why = noShapeReason(sketch);
  return why === REASON.openEnds && gapToClose() ? REASON.openEndsClose : why;
}

export function closeTheGap() {
  const closed = gapToClose();
  if (!closed) return;
  S.editor = editActiveSketch(S.editor, closed.sketch);
  S.redMarks = null;
  S.cardFocus = ["[data-sketch-extrude]"];
  publish("open");
  const lines = closed.joins.filter((join) => join.kind === "line").length;
  const said = lines === 0 ? "The ends now meet." : lines === 1 ? "A line now joins the ends." : `${lines} lines now join the ends.`;
  S.host.readout(`${said} Press E to extrude it, or Ctrl+Z to undo.`);
}

// --- L1. Add a shape above. ---
/** The loft has its first section from the open sketch, and that sketch has one shape to copy up. */
export function canAddAbove(): boolean {
  if (!S.loft || S.loft.picks.length !== 1 || S.editor.phase !== "editing" || S.editSession || S.profile) return false;
  const sketch = activeSketch(S.editor);
  return !!sketch && S.loft.picks[0]!.sketchId === S.editor.active && sketchRegions(sketch).length === 1;
}

/** The shape above is open, with its loft waiting. */
export function aboveOpen(): boolean {
  return S.above != null && S.editor.phase === "editing" && S.editor.active === S.above.secondId && !(S.gesture || S.revolve || S.loft || S.sweep);
}

export function addShapeAbove() {
  if (!S.loft || !canAddAbove()) return;
  const first = activeSketch(S.editor)!;
  const firstId = S.editor.active!;
  const copy = shapeAbove(first, S.aboveHeight);
  if ("error" in copy) {
    S.host.readout(copy.error);
    pushToast(copy.error, "info");
    return;
  }
  const kept = { ruled: S.loft.ruled, choice: S.loft.choice };
  endLoft();
  // The first sketch is kept as a card; the copy opens on the plane above it, ready to edit.
  S.editor = enterSketchData(S.editor, copy);
  if (S.editor.active == null) return;
  S.above = { firstId, secondId: S.editor.active, copy, basePlane: first.plane, height: S.aboveHeight, ...kept };
  S.aimKey = "";
  S.refsKey = "";
  S.cardFocus = ["[data-sketch-above-done]"];
  publish("open");
  S.host.readout(aboveSentence());
}

function aboveSentence(): string {
  const first = S.editor.pinned.find((item) => item.id === S.above?.firstId)?.name ?? "the first sketch";
  return `A copy of ${first}, ${formatHeight(S.above?.height ?? S.aboveHeight)} mm above it. Change it, or delete it and draw another shape, then click Back to loft.`;
}

/** Why Back to loft can't go back yet, or "". The copy left as it came, beside a new shape, is not a reason. */
export function aboveBlocked(sketch: SketchData): string {
  const regions = sketchRegions(sketch).length;
  if (regions === 0) return shapeWhy(sketch);
  if (regions > 1) return REASON.manyRegionsAbove;
  return "";
}

/** Back to the loft: the shape above becomes a card, the first sketch opens again, and both are picked. */
export function backToLoft() {
  const pending = S.above;
  if (!pending || !aboveOpen()) return;
  const now = activeSketch(S.editor)!;
  const settled = settleAbove(pending.copy, now);
  const why = aboveBlocked(settled.sketch);
  if (why) {
    if (namesOpenEnds(why)) showMarks("open");
    S.host.readout(why);
    pushToast(why, "info");
    return;
  }
  if (settled.helpers) S.editor = editActiveSketch(S.editor, settled.sketch);
  S.above = null;
  S.editor = finishSketch(S.editor);
  S.editor = reopenSketch(S.editor, pending.firstId);
  S.aimKey = "";
  S.refsKey = "";
  beginLoft();
  if (!S.loft) return;
  S.loft = { ...S.loft, ruled: pending.ruled, choice: pending.choice };
  takeLoftSketch(pending.secondId);
  S.cardFocus = ["[data-sketch-apply]"];
  publish("skip");
  S.host.readout(settled.helpers ? "The copy stays as a helper outline, and your new shape is the top. Press Enter to apply the loft." : "Both shapes are picked. Press Enter to apply the loft.");
}

/** Cancel on the shape above: it goes, and the loft is back as it was, with its one section. */
export function cancelAbove() {
  const pending = S.above;
  if (!pending || !aboveOpen()) return;
  S.above = null;
  S.editor = discardSketch(S.editor, pending.secondId);
  S.editor = reopenSketch(S.editor, pending.firstId);
  S.aimKey = "";
  S.refsKey = "";
  beginLoft();
  if (S.loft) S.loft = { ...S.loft, ruled: pending.ruled, choice: pending.choice };
  publish("open");
}

/** The height of the shape above: typed, or dragged sideways on its label. On the shape above it moves the plane. */
function setAboveHeight(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    S.host.readout("Type a height other than 0, such as 20 or -20.");
    return;
  }
  S.aboveHeight = value;
  if (S.above && aboveOpen()) {
    S.above = { ...S.above, height: value };
    S.editor = moveActivePlane(S.editor, planeAbove(S.above.basePlane, value));
    S.aimKey = "";
    S.refsKey = "";
    publish("skip");
    S.host.readout(aboveSentence());
  }
}

export function heightField(): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "sketch-value sketch-height";
  const name = document.createElement("span");
  name.className = "sketch-scrub";
  name.textContent = "Height";
  name.title = "Drag sideways to change the height, or type it.";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.value = formatHeight(S.above && aboveOpen() ? S.above.height : S.aboveHeight);
  input.dataset.sketchAboveHeight = "";
  input.setAttribute("aria-label", "Height of the shape above, mm");
  const unit = document.createElement("span");
  unit.textContent = "mm";
  input.addEventListener("change", () => setAboveHeight(Number(input.value.trim().replace(",", "."))));
  input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    ev.stopPropagation();
    setAboveHeight(Number(input.value.trim().replace(",", ".")));
  });
  // A drag on the word: 1 mm for every 4 px, whole millimetres, never through 0.
  name.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const start = Number(input.value.trim().replace(",", ".")) || S.aboveHeight;
    name.setPointerCapture(ev.pointerId);
    const move = (moved: PointerEvent) => {
      let value = Math.round(start + (moved.clientX - startX) / 4);
      if (value === 0) value = start > 0 ? 1 : -1;
      input.value = formatHeight(value);
    };
    const up = () => {
      name.removeEventListener("pointermove", move);
      name.removeEventListener("pointerup", up);
      name.removeEventListener("pointercancel", up);
      setAboveHeight(Number(input.value));
      if (!aboveOpen()) publish("skip");
    };
    name.addEventListener("pointermove", move);
    name.addEventListener("pointerup", up);
    name.addEventListener("pointercancel", up);
  });
  label.append(name, input, unit);
  return label;
}

/** In place of Make on the shape above: what it is, its height, Back to loft and Cancel. */
export function aboveStrip(): HTMLElement {
  const strip = document.createElement("section");
  strip.className = "sketch-section sketch-feature sketch-above";
  strip.dataset.sketchSection = "above";
  const head = document.createElement("div");
  head.className = "sketch-feature-row";
  const name = document.createElement("p");
  name.className = "sketch-feature-name";
  name.textContent = "Shape above";
  head.append(name, heightField());
  const note = document.createElement("p");
  note.className = "sketch-above-note model-note";
  note.setAttribute("role", "status");
  note.textContent = "Edit the copy for the loft's top: drag it, set its sizes, or delete it and draw another shape.";
  const done = textButton("Back to loft", { sketchAboveDone: "" });
  done.classList.add("primary");
  done.dataset.tipIdle = ASSIST_PURPOSE.backToLoft;
  const sketch = activeSketch(S.editor);
  markBlocked(done, sketch && S.above ? aboveBlocked(settleAbove(S.above.copy, sketch).sketch) : "");
  const actions = document.createElement("div");
  actions.className = "sketch-feature-actions";
  actions.append(done, textButton("Cancel", { sketchAboveCancel: "" }));
  strip.append(note, head, actions);
  return strip;
}
