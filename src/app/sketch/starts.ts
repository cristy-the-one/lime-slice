/** Which Start buttons are blocked, and why. */
import { S } from "./state";
import { canAddAbove, shapeWhy } from "./above";
import { editedRegions } from "./extrude";
import { everyHole, nothingSelected } from "./holes";
import { pinnedRegion } from "./loft";
import { pinnedChain } from "./sweep";
import type { StartKind } from "./types";
import { showMarks } from "./view";
import { pushToast } from "../../ui/toasts";
import { sketchOnFace, FACE_REFUSAL, holeTargets, POINT_REFUSAL } from "../../sketch/holes.ts";
import { activeSketch } from "../../sketch/session";
import { REASON, blockedTip, namesOpenEnds } from "../../sketch/reasons";
import { chooseRegions } from "../../sketch/extrude";
import { sketchRegions } from "../../sketch/regions";
import { PIPE_DIAMETER_REFUSAL, openChain } from "../../sketch/sweep";

/**
 * Why Apply cannot keep the open feature for want of a pick, or "" when it can. The same sentence is the button's
 * tooltip. Only picks block: a refusal the builder or the modeler gives is shown on Apply, under the box and in the
 * status line, so it names the real cause and a retry is never blocked by a stale note.
 */
export function featureBlocked(): string {
  if (S.revolve) {
    if (S.revolve.crossing) return REASON.crossAxis;
    if (S.revolve.regions.length === 0) return REASON.pickRevolve;
    return "";
  }
  if (S.loft) {
    if (S.loft.picks.length < 2) return canAddAbove() ? REASON.loftAbove : REASON.loftSecond;
    return "";
  }
  if (S.sweep) {
    if (!S.sweep.profile || !S.sweep.profileSketch) return S.sweep.pipe ? S.sweep.note || PIPE_DIAMETER_REFUSAL : REASON.sweepProfile;
    if (S.sweep.path.length < 2) return REASON.sweepRoute;
    return "";
  }
  if (S.gesture && S.gesture.regions.length === 0) return REASON.pickExtrude;
  return "";
}

/** P1: a greyed button keeps its purpose line, and the reason goes under it. */
export function markBlocked(button: HTMLButtonElement, why: string) {
  button.setAttribute("aria-disabled", why ? "true" : "false");
  button.classList.toggle("is-disabled", why !== "");
  const tip = blockedTip(button.dataset.tipIdle ?? "", why);
  if (tip) {
    button.dataset.tip = tip;
    button.title = tip;
  } else {
    delete button.dataset.tip;
    button.removeAttribute("title");
  }
  if (why) button.dataset.reason = why;
  else delete button.dataset.reason;
}

/** Why Extrude, Revolve, Loft or Sweep cannot start. Empty when a click is the right next step. */
export function startWhy(kind: StartKind, hover = false): string {
  const sketch = activeSketch(S.editor);
  if (!sketch || S.editor.phase !== "editing") return REASON.noSketch;
  const regions = sketchRegions(sketch);
  // A key press also takes the region under the pointer, as beginExtrude and beginRevolve do. The button cannot.
  const chosen = hover
    ? editedRegions(sketch) ?? chooseRegions(sketch, S.editor.selection.entities, S.editor.cursor)
    : chooseRegions(sketch, S.editor.selection.entities, null);
  if (kind === "extrude") {
    if (regions.length === 0) return shapeWhy(sketch);
    if (chosen.length === 0) return REASON.pickExtrude;
    return "";
  }
  if (kind === "revolve") {
    if (regions.length === 0) return shapeWhy(sketch);
    if (chosen.length === 0) return REASON.pickRevolveStart;
    return "";
  }
  if (kind === "loft") {
    const elsewhere = S.editor.pinned.some((item) => item.id !== S.editor.active && sketchRegions(item.sketch).length > 0);
    if (regions.length === 0 && !elsewhere) return shapeWhy(sketch);
    return "";
  }
  if (kind === "holes") {
    if (!sketchOnFace(sketch)) return S.host.solid() ? REASON.holesFace : FACE_REFUSAL;
    // H1: with nothing selected, H asks to drill at every point and circle centre.
    if (holeTargets(sketch, S.editor.selection).length === 0 && !(nothingSelected() && everyHole(sketch).length > 0)) return POINT_REFUSAL;
    return "";
  }
  const path = openChain(sketch) ?? pinnedChain();
  if (chosen.length === 0 && !pinnedRegion() && !path) return sketch.entities.length === 0 ? REASON.sweepNothing : shapeWhy(sketch);
  return "";
}

export function blockedStart(kind: StartKind): boolean {
  const why = startWhy(kind, true);
  if (!why) return false;
  if (namesOpenEnds(why)) showMarks("open");
  S.host.readout(why);
  pushToast(why, "info");
  return true;
}

export function startActive(kind: StartKind): boolean {
  if (kind === "extrude") return S.gesture != null;
  if (kind === "revolve") return S.revolve != null;
  if (kind === "loft") return S.loft != null;
  if (kind === "holes") return S.host.sketchHolesArmed();
  return S.sweep != null;
}

export function paintStarts() {
  const kinds: [StartKind, string][] = [
    ["extrude", "[data-sketch-extrude]"],
    ["revolve", "[data-sketch-revolve]"],
    ["loft", "[data-sketch-loft]"],
    ["sweep", "[data-sketch-sweep]"],
    ["holes", "[data-sketch-holes]"],
  ];
  for (const [kind, selector] of kinds) {
    const button = S.cards?.querySelector<HTMLButtonElement>(selector);
    if (!button) continue;
    markBlocked(button, startActive(kind) ? "" : startWhy(kind));
  }
}

/** The pick the open feature is still waiting for, shown on the card with Cancel. */
export function pickPrompt(): string {
  const why = featureBlocked();
  return S.revolve?.crossing ? "" : why;
}
