/**
 * --- S2 sketch editor ---
 * Enter and leave a sketch, the plane camera, the grid, reference lines, Line and Rectangle.
 * --- F1. Extrude copies the sketch onto the op. A sketch with no feature is still not saved.
 * --- F2. Revolve copies the sketch onto the op the same way. V is taken only while a sketch is open.
 * --- F3. Loft (Shift+L) and sweep (W) are taken only while a sketch is open.
 * Undo here is the sketch's own stack (`docs/plan-gui-cad-modeling.md` §4.3).
 */
// The sketch editor lives in ./sketch/: state.ts (the shared state), types.ts, and one module per concern or tool.
import { S } from "./sketch/state";
import { installCardClicks } from "./sketch/card-click";
import { markFromButton } from "./sketch/cards";
import { installDatasetDefaults } from "./sketch/dataset";
import { leaveDemoQuietly } from "./sketch/demo";
import { installDimensionLayers } from "./sketch/dimensions";
import { installHud } from "./sketch/hud";
import { escapeFeature, leaveEditing, onSketchKey, tabSketchExtrude } from "./sketch/keys";
import { loftPointer } from "./sketch/loft";
import { installOpeners } from "./sketch/openers";
import { installPointer } from "./sketch/pointer";
import { dropProfile } from "./sketch/profile";
import { pickSweepAt } from "./sketch/sweep";
import type { ProfileSketchRequest, SketchHost } from "./sketch/types";
import { enterFace, enterNamed, publish, sync } from "./sketch/view";
import { createElement, Pencil } from "lucide";
import { setSketchKeyHandler } from "./sketch-keys";
import { pushToast } from "../ui/toasts";
import { registerContextAction } from "../context-bar";
import { type ProfileLoop } from "../model-tree";
import { type SketchData } from "../sketch/model";
import { sketchBusy, canUndoSketch, canRedoSketch, undoSketch, redoSketch, beginChoose, finishSketch, sketchOff } from "../sketch/session";
import { setDrivingEvaluator, plainDrivingValue } from "../sketch/constrain";
import { evaluate, ExprError } from "../modeling/expr.ts";
import { appParamMessage } from "../modeling/params.ts";
import { state } from "./state";
import { type ExtrudePreset } from "../sketch/extrude";
import { type RevolvePreset } from "../sketch/revolve";
import { type LoftPreset } from "../sketch/loft";
import { type SweepPreset } from "../sketch/sweep";

export type { ProfileSketchRequest, SketchHost } from "./sketch/types";
export { PROFILE_SKETCH_STEPS } from "./sketch/helpers";

/** Reopen a sketch and its extrude drag, with the regions the extrude was applied to. E1 calls this from History Edit. */
export function openSketchFeature(sketch: SketchData, preset: ExtrudePreset, outlines: readonly ProfileLoop[]) {
  S.openFeatureImpl(sketch, preset, outlines);
}

export function openSketchRevolve(sketch: SketchData, preset: RevolvePreset, outlines: readonly ProfileLoop[]) {
  S.openRevolveImpl(sketch, preset, outlines);
}

export function openSketchLoft(preset: LoftPreset | SweepPreset) {
  S.openLoftImpl(preset);
}

export function openProfileSketch(request: ProfileSketchRequest) {
  S.openProfileImpl(request);
}

/** Leave the sketch without applying. A history jump uses this so the editor does not stay up. */
export function closeSketchSession() {
  S.closeFeatureImpl();
}

/** Model applies a feature of the open sketch (its holes): the sketch waits and leaves the readout to Model. */
export function holdSketchForApply(on: boolean) {
  S.holdImpl(on);
}

/** Another model was loaded: the sketches drawn on the old one go with it, cards included. */
export function forgetSketches() {
  S.forgetImpl();
}

// --- F1. Sketch on a face, and on the bed. Order 35 sits between Hole and Shell, so the face bar's arrow keys stay. ---
registerContextAction({
  id: "sketch-on-face",
  label: "Sketch on face",
  when: ["flat-face"],
  order: 35,
  tip: "Draw on this face",
  command: "model-sketch",
  toolbar: "#modelToolSketch",
  run() {
    const face = S.faceForSketch();
    if (face != null) S.enterFaceAction(face);
  },
});

registerContextAction({
  id: "sketch-on-bed",
  label: "Sketch on bed",
  when: ["empty"],
  order: 18,
  tip: "Draw on the bed",
  command: "model-sketch",
  toolbar: "#modelToolSketch",
  run() {
    S.enterBedAction();
  },
});

/** Choosing or editing. Pinned cards do not take the view, so push/pull and the edge knob stay. */
export function sketchOccupiesView(): boolean {
  return S.api.occupies();
}

export function sketchOwnsHistory(): boolean {
  return S.api.ownsHistory();
}

export function sketchHistoryButtons(): { undo: boolean; redo: boolean } | null {
  return S.api.history();
}

/**
 * A click the view gave the Model picks, at client pixels. While Look around is on during a loft or a sweep the
 * click picks a section or a profile, as it does with the view locked. True when the sketch took it.
 */
export function sketchTakesPick(x: number, y: number): boolean {
  return S.api.takePick(x, y);
}

export function sketchUndo(): void {
  S.api.undo();
}

export function sketchRedo(): void {
  S.api.redo();
}

export function mountSketch(host: SketchHost): { sync(): void } {
  S.host = host;
  const cards = document.querySelector<HTMLElement>("#sketchCards");
  S.cards = cards;
  const button = document.querySelector<HTMLButtonElement>("#modelToolSketch");
  S.button = button;
  const bed = document.querySelector<HTMLButtonElement>("#modelEmptySketch");
  S.bed = bed;
  if (button && !button.querySelector(".ico")) {
    const label = button.textContent?.trim() || "Sketch";
    button.replaceChildren(createElement(Pencil, { width: 14, height: 14, "aria-hidden": "true", class: "ico" }));
    const text = document.createElement("span");
    text.className = "model-tool-label";
    text.textContent = label;
    button.append(text);
    button.classList.add("is-icon");
  }
  setDrivingEvaluator((text) => {
    const plain = plainDrivingValue(text);
    if (plain != null) return plain;
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      const value = evaluate(trimmed, host.parameters());
      if (!Number.isFinite(value)) return { error: `"${trimmed}" is not a finite number. Type a number, or a formula that gives one.` };
      return value;
    } catch (err) {
      const message = err instanceof ExprError || err instanceof Error ? err.message : String(err);
      return { error: appParamMessage(message) };
    }
  });
  // Tab on the extrude's last field adds Other side, then Draft. The size box below also takes Tab in capture, and
  // `mountKeys` registers after this module, so the registry's `sketch-tab` would never see it: this listener has to
  // be added before the box's. The registry entry stays for the shortcut sheet.
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab" || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (state.stage !== "model" || S.editor.phase !== "editing") return;
    if (!tabSketchExtrude(ev)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  installHud();
  installDimensionLayers();
  S.api = {
    occupies: () => sketchBusy(S.editor),
    ownsHistory: () => S.editor.phase === "editing",
    takePick(x, y) {
      if (S.editor.phase !== "editing" || !S.editor.lookAround || (S.applying || S.holding) || !(S.loft || S.sweep)) return false;
      if (S.loft) loftPointer({ phase: "up", x, y });
      else pickSweepAt(x, y);
      return true;
    },
    history: () => (S.editor.phase === "editing" ? { undo: canUndoSketch(S.editor), redo: canRedoSketch(S.editor) } : null),
    undo() {
      S.editor = undoSketch(S.editor);
      publish("open");
    },
    redo() {
      S.editor = redoSketch(S.editor);
      publish("open");
    },
    sync,
  };
  button?.addEventListener("click", () => {
    if (button.getAttribute("aria-disabled") === "true") {
      pushToast(button.title || button.dataset.tip || "Sketch is not available.", "info");
      return;
    }
    if (sketchBusy(S.editor)) {
      button.dataset.tip = "Finish the sketch on the card, or press Esc.";
      return;
    }
    button.dataset.tip = button.dataset.tipIdle ?? button.dataset.tip ?? "";
    host.closeTool();
    S.editor = beginChoose(S.editor);
    publish("open");
  });
  bed?.addEventListener("click", () => {
    host.closeTool();
    S.editor = beginChoose(S.editor);
    enterNamed("XY");
  });
  // A card menu is a keyboard menu: the arrows, Home and End move through its items, and Tab leaves it closed.
  cards?.addEventListener("keydown", (ev) => {
    const menu = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>("[role=menu]") : null;
    if (!menu || !S.menuOpen) return;
    const items = [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")];
    const at = items.indexOf(ev.target as HTMLElement);
    const next =
      ev.key === "ArrowDown" ? (at + 1) % items.length
      : ev.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : ev.key === "Home" ? 0
      : ev.key === "End" ? items.length - 1
      : null;
    if (next != null) {
      ev.preventDefault();
      ev.stopPropagation();
      items[next]?.focus();
      return;
    }
    if (ev.key === "Tab") {
      const which = S.menuOpen;
      S.menuOpen = null;
      if (which) S.cardFocus = [`[data-sketch-menu="${which}"]`];
      publish("skip");
    }
  });
  cards?.addEventListener("mouseover", markFromButton);
  cards?.addEventListener("focusin", markFromButton);
  installCardClicks();
  installPointer();
  installDatasetDefaults();
  installOpeners();
  // Another Model tool opened from the toolbar or a key. The sketch gives way to it, as starting a command ends the
  // sketch in Fusion or Onshape: a new sketch stays as a card, and a History Edit is cancelled. Holes from this
  // sketch are its own tool, and an Apply on its way finishes first.
  const bar = document.querySelector<HTMLElement>("#modelBar");
  S.bar = bar;
  if (bar) {
    new MutationObserver(() => {
      // A profile sketch belongs to the split's card, which closes it when another tool takes the dock.
      if (!bar.dataset.tool || !sketchBusy(S.editor) || host.sketchHolesArmed() || (S.applying || S.holding) || S.profile) return;
      // P2: the demo closes first, so the person's own sketch gives way as it would have.
      leaveDemoQuietly();
      if (S.editor.phase === "choosing") {
        S.editor = finishSketch(S.editor);
        publish("open");
        return;
      }
      if (S.editSession) escapeFeature(() => {});
      else leaveEditing(finishSketch(S.editor));
    }).observe(bar, { attributes: true, attributeFilter: ["data-tool"] });
  }
  S.holdImpl = (on) => {
    S.holding = on && sketchBusy(S.editor);
  };
  S.forgetImpl = () => {
    leaveDemoQuietly();
    dropProfile();
    if (S.editor.phase === "off" && S.editor.pinned.length === 0 && !S.editSession) return;
    if (host.sketchHolesArmed()) host.endSketchHoles();
    S.gesture = null;
    S.revolve = null;
    S.revolveNote = "";
    S.loft = null;
    S.sweep = null;
    S.editSession = false;
    S.editCards = [];
    S.editOutlines = [];
    S.menuOpen = null;
    window.clearTimeout(S.probeTimer);
    host.view.setHandles([]);
    host.view.setGhost(null);
    host.clearExtrudePreview();
    S.editor = sketchOff();
    publish("open");
  };
  S.faceForSketch = () => host.selectedFace();
  S.enterFaceAction = (face) => {
    if (!sketchBusy(S.editor)) {
      host.closeTool();
      S.editor = beginChoose(S.editor);
    }
    enterFace(face);
  };
  S.enterBedAction = () => {
    if (!sketchBusy(S.editor)) {
      host.closeTool();
      S.editor = beginChoose(S.editor);
    }
    enterNamed("XY");
  };
  setSketchKeyHandler(onSketchKey);
  return { sync };
}
