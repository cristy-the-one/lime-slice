/** A split to print's profile sketch, and closing a sketch quietly. */
import { S } from "./state";
import { leaveDemoQuietly } from "./demo";
import { endEditSession } from "./feature";
import { leaveEditing } from "./keys";
import { publish } from "./view";
import { type SketchData } from "../../sketch/model";
import { discardSketch, finishSketch, activeSketch } from "../../sketch/session";

const profileNotes = new WeakMap<SketchData, string>();

/** The profile sketch closes under the card (Model left, a history jump): it is dropped, and the card hears null. */
export function dropProfile() {
  const request = S.profile;
  if (!request) return;
  S.profile = null;
  if (S.editor.phase === "editing" && S.editor.active != null) S.editor = discardSketch(S.editor, S.editor.active);
  request.done(null);
}

/** The profile is used (`sketch`) or cancelled (null): the sketch leaves without a card, and the split's card takes over. */
export function endProfile(sketch: SketchData | null) {
  const request = S.profile;
  if (!request) return;
  S.profile = null;
  leaveEditing(S.editor.active != null ? discardSketch(S.editor, S.editor.active) : finishSketch(S.editor));
  request.done(sketch);
}

/** The sentence under the profile sketch's card: why the chain is not a profile yet, or "" when it is. */
export function profileNote(): string {
  const sketch = activeSketch(S.editor);
  if (!S.profile || !sketch) return "";
  let note = profileNotes.get(sketch);
  if (note === undefined) {
    note = S.profile.check(sketch);
    profileNotes.set(sketch, note);
  }
  return note;
}

export function closeQuietly() {
  leaveDemoQuietly();
  dropProfile();
  if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
  if (S.editor.phase !== "editing" && S.editor.phase !== "choosing") {
    S.gesture = null;
    S.revolve = null;
    S.loft = null;
    S.sweep = null;
    if (S.editSession) {
      S.editor = endEditSession(S.editor);
      publish("open");
    }
    return;
  }
  S.gesture = null;
  S.revolve = null;
  S.loft = null;
  S.sweep = null;
  window.clearTimeout(S.probeTimer);
  S.host.view.setHandles([]);
  S.host.view.setGhost(null);
  S.host.clearExtrudePreview();
  S.editor = endEditSession(finishSketch(S.editor));
  publish("open");
}
