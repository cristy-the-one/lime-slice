/** What Extrude, Revolve, Loft and Sweep share when they apply. */
import { S } from "./state";
import { currentOp, resolvedMode } from "./extrude";
import { publish } from "./view";
import { type HudField } from "../../interact/hud";
import { GHOST_PROBE_WAIT_MS } from "../../interact/ghosts";
import { type SketchData } from "../../sketch/model";
import { finishSketch, type SketchEditor, discardSketch } from "../../sketch/session";
import { isPlainNumber } from "../../modeling/params.ts";

/** A demo is a sketch of its own with nowhere to attach: every feature in it is a new object, as on a root edit. */
export const featureEdit = (): "root" | "step" | null => (S.demo ? "root" : S.host.featureEdit());

/** The op the open extrude would apply, or the sentence it is refused with before anything is sent. */
/** The card's name, so History can say "Sketch 1" instead of a profile count. */
export function withSketchName(sketch: SketchData, id: number | null): SketchData {
  if (sketch.name?.trim()) return sketch;
  const card = id == null ? undefined : S.editor.pinned.find((item) => item.id === id);
  const name = card && card.name !== "Sketch" ? card.name : `Sketch ${card?.id ?? S.editor.nextName}`;
  return { ...sketch, name };
}

/**
 * Await an Apply. Keys, clicks, and pointer picks wait while it runs (`applying`), so an Esc cannot leave the
 * step applied with the sketch still open. Undefined when the sketch closed meanwhile (Model was left, or the
 * history jumped), so the caller does nothing more.
 */
export async function committed(apply: Promise<string | null>): Promise<string | null | undefined> {
  S.applying = true;
  let error: string | null;
  try {
    error = await apply;
  } finally {
    S.applying = false;
  }
  return S.editor.phase === "editing" ? error : undefined;
}

/**
 * The feature was applied. The gesture ends and the sketch closes: a new sketch stays as a card, a History Edit's
 * copy goes. The readout keeps what the apply said about the solid, and the solid is framed, since putting the
 * sketch camera back would hide what was just made.
 */
export function afterFeature() {
  S.gesture = null;
  S.revolve = null;
  S.revolveNote = "";
  S.loft = null;
  S.sweep = null;
  window.clearTimeout(S.probeTimer);
  S.host.view.setHandles([]);
  S.host.view.setGhost(null);
  S.host.clearExtrudePreview();
  S.editor = endEditSession(finishSketch(S.editor));
  S.keepReadout = true;
  try {
    publish("open");
  } finally {
    S.keepReadout = false;
  }
  S.host.frameSolid();
}

/** An edit is over: the cards it opened go with it. A sketch that was not an edit is returned as it is. */
export function endEditSession(next: SketchEditor): SketchEditor {
  let out = next;
  if (S.editSession) for (const id of S.editCards) out = discardSketch(out, id);
  S.editSession = false;
  S.editCards = [];
  S.editOutlines = [];
  return out;
}

export function armProbe() {
  window.clearTimeout(S.probeTimer);
  if (!S.gesture || S.gesture.dragging) return;
  if (resolvedMode() === "new" || !S.host.solid()) {
    S.host.clearExtrudePreview();
    return;
  }
  S.probeTimer = window.setTimeout(() => {
    const op = currentOp();
    if (op) S.host.probeExtrude(op);
  }, GHOST_PROBE_WAIT_MS);
}

export function fieldTexts(fields: readonly HudField[], texts: readonly (string | null)[]): Record<string, string> {
  const out: Record<string, string> = {};
  fields.forEach((field, index) => {
    const text = texts[index];
    if (text && text.trim() && !isPlainNumber(text)) out[field.id] = text.trim();
  });
  return out;
}
