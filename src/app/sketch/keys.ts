/** Sketch keyboard shortcuts. */
import { S } from "./state";
import { beginExtrude, endExtrude, takeValues } from "./extrude";
import { endEditSession, featureEdit } from "./feature";
import { closeHow } from "./feature-strip";
import { typingTarget } from "./helpers";
import { askOpen, beginHoles, drillEvery, dropAsk } from "./holes";
import { beginLoft, commitLoft, endLoft } from "./loft";
import { endProfile } from "./profile";
import { beginRevolve, endRevolve } from "./revolve";
import { blockedStart } from "./starts";
import { beginSweep, endSweep } from "./sweep";
import { publish } from "./view";
import { sketchKey, cancelDimensionEdit, sketchDimensions, discardSketch, finishSketch, type SketchEditor, activeSketch } from "../../sketch/session";
import { state } from "../state";
import { cycleMode } from "../../sketch/extrude";

/** One handler per sketch command. The window listeners that used to match `ev.key` are gone. */
export function onSketchKey(id: string, ev: KeyboardEvent): boolean {
  if (state.stage !== "model" || (S.editor.phase !== "editing" && S.editor.phase !== "choosing")) return false;
  if (S.applying || S.holding) {
    const outside = typingTarget(ev.target);
    if (outside && !outside.closest(".interact-hud, #sketchCards, .sketch-dims")) return false;
    return true;
  }
  // A digit with no size box is swallowed, so 2 cannot switch to Preview. The box itself writes the character.
  if (id === "sketch-size") return !S.hud.shown;
  if (S.editor.phase === "choosing") {
    if (id !== "sketch-escape") return true;
    const next = sketchKey(S.editor, "Escape", { ctrl: false, meta: false, shift: false });
    if (next) leaveEditing(next);
    return true;
  }
  if (id === "sketch-escape") return onSketchEscape(ev);
  // A profile sketch makes no feature of its own: the split's card cuts along it.
  if (S.profile && (id === "sketch-loft" || id === "sketch-sweep" || id === "sketch-holes" || id === "sketch-extrude" || id === "sketch-revolve")) return true;
  if (id === "sketch-loft" || id === "sketch-sweep" || id === "sketch-holes" || id === "sketch-extrude" || id === "sketch-revolve") return startSketchFeature(id);
  if (id === "sketch-mode") return cycleSketchMode();
  if (id === "sketch-smooth") return toggleSketchSmooth();
  if (id === "sketch-tab") return tabSketchExtrude(ev);
  if (id === "sketch-enter" && S.loft) {
    void commitLoft();
    return true;
  }
  if (id === "sketch-enter" && askOpen()) {
    drillEvery();
    return true;
  }
  const spec = sketchEditorKey(id, ev);
  if (!spec) return false;
  return applyEditorKey(spec.key, { ctrl: spec.ctrl, meta: spec.meta, shift: spec.shift });
}

function onSketchEscape(ev: KeyboardEvent): boolean {
  const field = typingTarget(ev.target);
  // Parameters keeps the key and folds. Count the press, so the next Escape leaves the sketch.
  if (field && !field.closest(".interact-hud, #sketchCards, .sketch-dims")) {
    if (!S.menuOpen && !S.howOpen && !S.loft && !S.sweep && !S.revolve && !S.gesture && !S.host.sketchHolesArmed()) {
      applyEditorKey("Escape", { ctrl: false, meta: false, shift: false });
    }
    return false;
  }
  const howHost = S.cards?.querySelector(".sketch-how");
  if (S.howOpen && ev.target instanceof Node && howHost?.contains(ev.target)) {
    closeHow(true);
    return true;
  }
  // P2: Esc shuts the Make row's How first, as it shuts a menu.
  if (S.makeHowOpen) {
    S.makeHowOpen = false;
    S.cardFocus = ["[data-sketch-make-how]"];
    publish("skip");
    return true;
  }
  if (S.menuOpen) {
    S.cardFocus = [`[data-sketch-menu="${S.menuOpen}"]`];
    S.menuOpen = null;
    publish("skip");
    return true;
  }
  if (ev.target instanceof HTMLElement && ev.target.dataset.sketchDimInput != null) {
    S.editor = cancelDimensionEdit(S.editor);
    publish("open");
    return true;
  }
  if (S.host.sketchHolesArmed()) {
    S.host.endSketchHoles();
    publish("open");
    return true;
  }
  if (askOpen()) {
    dropAsk();
    return true;
  }
  if (S.loft) {
    escapeFeature(endLoft);
    return true;
  }
  if (S.sweep) {
    escapeFeature(endSweep);
    return true;
  }
  if (S.revolve) {
    escapeFeature(endRevolve);
    return true;
  }
  if (S.gesture) {
    escapeFeature(endExtrude);
    return true;
  }
  return applyEditorKey("Escape", { ctrl: false, meta: false, shift: false });
}

function startSketchFeature(id: string): boolean {
  const drawing = sketchDimensions(S.editor) != null;
  if (drawing) return true;
  if (id === "sketch-loft") {
    if (!S.loft && blockedStart("loft")) return true;
    if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
    if (S.gesture) endExtrude();
    if (S.revolve) endRevolve();
    if (S.sweep) endSweep();
    if (!S.loft) beginLoft();
    return true;
  }
  if (id === "sketch-sweep") {
    if (!S.sweep && blockedStart("sweep")) return true;
    if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
    if (S.gesture) endExtrude();
    if (S.revolve) endRevolve();
    if (S.loft) endLoft();
    if (!S.sweep) beginSweep();
    return true;
  }
  if (id === "sketch-holes") {
    if (S.gesture || S.host.sketchHolesArmed()) return true;
    if (blockedStart("holes")) return true;
    if (S.revolve) endRevolve();
    if (S.loft) endLoft();
    if (S.sweep) endSweep();
    beginHoles();
    return true;
  }
  if (id === "sketch-extrude") {
    if (!S.gesture && blockedStart("extrude")) return true;
    if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
    if (S.revolve) endRevolve();
    if (S.loft) endLoft();
    if (S.sweep) endSweep();
    if (!S.gesture) beginExtrude();
    return true;
  }
  if (!S.revolve && blockedStart("revolve")) return true;
  if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
  if (S.gesture) endExtrude();
  if (S.loft) endLoft();
  if (S.sweep) endSweep();
  if (!S.revolve) beginRevolve();
  return true;
}

function cycleSketchMode(): boolean {
  const lock = featureEdit();
  if (S.loft) S.loft = { ...S.loft, choice: cycleMode(S.loft.choice, lock), note: "" };
  else if (S.sweep) S.sweep = { ...S.sweep, choice: cycleMode(S.sweep.choice, lock), note: "" };
  else if (S.revolve) S.revolve = { ...S.revolve, choice: cycleMode(S.revolve.choice, lock) };
  else if (S.gesture) S.gesture = { ...S.gesture, choice: cycleMode(S.gesture.choice, lock) };
  else return false;
  publish("open");
  return true;
}

function toggleSketchSmooth(): boolean {
  if (!S.loft) return false;
  S.loft = { ...S.loft, ruled: !S.loft.ruled, note: "" };
  publish("open");
  return true;
}

export function tabSketchExtrude(ev: KeyboardEvent): boolean {
  if (!S.gesture || ev.shiftKey || S.gesture.slots >= 3) return false;
  const inputs = [...document.querySelectorAll<HTMLInputElement>(".interact-hud input")];
  const last = inputs.length > 0 && document.activeElement === inputs[inputs.length - 1];
  if (!last) return false;
  const typed = inputs.map((input) => Number(input.value));
  if (typed.every((value) => Number.isFinite(value))) takeValues(typed);
  S.gesture = { ...S.gesture, slots: (S.gesture.slots + 1) as 2 | 3 };
  if (S.gesture.slots === 2 && !(S.gesture.depth2 != null && S.gesture.depth2 > 0)) S.gesture = { ...S.gesture, depth2: Math.abs(S.gesture.distance) };
  if (S.gesture.slots === 3 && S.gesture.draft == null) S.gesture = { ...S.gesture, draft: 0 };
  publish("open");
  const next = document.querySelectorAll<HTMLInputElement>(".interact-hud input");
  next[next.length - 1]?.focus();
  return true;
}

function sketchEditorKey(id: string, ev: KeyboardEvent): { key: string; ctrl: boolean; meta: boolean; shift: boolean } | null {
  const ctrl = ev.ctrlKey || ev.metaKey;
  const keys: Record<string, { key: string; ctrl?: boolean; shift?: boolean }> = {
    "sketch-line": { key: "l" },
    "sketch-rect": { key: "r" },
    "sketch-circle": { key: "c" },
    "sketch-arc": { key: "a" },
    "sketch-tangent": { key: "a", shift: true },
    "sketch-polygon": { key: "n" },
    "sketch-slot": { key: "s", shift: true },
    "sketch-spline": { key: "b" },
    "sketch-trim": { key: "t" },
    "sketch-offset": { key: "f" },
    "sketch-fillet": { key: "g" },
    "sketch-use": { key: "u" },
    "sketch-construction": { key: "x" },
    "sketch-helper-line": { key: "x", shift: true },
    "sketch-look": { key: "o" },
    "sketch-delete": { key: "Delete" },
    "sketch-undo": { key: "z", ctrl: true },
    "sketch-redo": { key: ev.shiftKey ? "z" : "y", ctrl: true, shift: ev.shiftKey },
    "sketch-enter": { key: "Enter" },
  };
  const spec = keys[id];
  if (!spec) return null;
  return { key: spec.key, ctrl: spec.ctrl ?? false, meta: ctrl && !ev.ctrlKey, shift: spec.shift ?? false };
}

function applyEditorKey(key: string, mods: { ctrl: boolean; meta: boolean; shift: boolean }): boolean {
  const next = sketchKey(S.editor, key, mods);
  if (!next || next === S.editor) return true;
  if ((S.revolve || S.loft || S.sweep) && S.editor.phase === "editing" && next.phase === "editing" && next.tool !== S.editor.tool) {
    S.revolve = null;
    S.loft = null;
    S.sweep = null;
    window.clearTimeout(S.probeTimer);
    S.host.view.setHandles([]);
    S.host.view.setGhost(null);
    S.host.clearExtrudePreview();
  }
  leaveEditing(next);
  return true;
}

/** Esc in a feature gesture: back to the sketch, or in a History Edit, out of the edit at once. */
export function escapeFeature(end: () => void) {
  if (!S.editSession) {
    end();
    // P2: in a demo the next Esc leaves it, so Esc twice from the tool goes back to the person's sketch.
    if (S.demo) S.editor = { ...S.editor, esc: 1 };
    return;
  }
  leaveEditing(S.editor.active != null ? discardSketch(S.editor, S.editor.active) : finishSketch(S.editor));
}

export function leaveEditing(after: SketchEditor) {
  // Finish, or Esc out of the profile sketch, uses the chain as it stands.
  if (S.profile && S.editor.phase === "editing" && after.phase !== "editing") {
    endProfile(activeSketch(S.editor));
    return;
  }
  let next = after;
  const left = S.editor.phase === "editing" && next.phase !== "editing";
  const session = S.editSession;
  if (left) {
    S.above = null;
    next = endEditSession(next);
    if (S.host.sketchHolesArmed()) S.host.endSketchHoles();
    S.gesture = null;
    S.revolve = null;
    S.loft = null;
    S.sweep = null;
    window.clearTimeout(S.probeTimer);
    S.host.view.setHandles([]);
    S.host.view.setGhost(null);
    S.host.clearExtrudePreview();
  }
  S.editor = next;
  publish("open");
  if (left && session) S.host.cancelFeatureEdit();
}
