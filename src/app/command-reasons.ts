/**
 * Why a palette command cannot run. The row stays listed, with this sentence in its tip (R5).
 * Null when it can run, and null for a command this module does not know.
 */
import { state } from "./state.ts";

export interface AnimationFacts {
  /** An animation plugin is in this project or the library. */
  plugins: boolean;
  /** An assembly is selected and an animation is chosen. */
  assembly: boolean;
  /** A frame animation is on screen, so Stop, Keep, Save and Keep in library can run. */
  ready: boolean;
  preparing: boolean;
  /** The playing animation's file is already in the plugin library. */
  inLibrary: boolean;
}

const EMPTY_ANIMATION: AnimationFacts = {
  plugins: false,
  assembly: false,
  ready: false,
  preparing: false,
  inLibrary: false,
};

let animationFacts: AnimationFacts = { ...EMPTY_ANIMATION };

/** Why Close loop cannot run, published by the Joint tool. `jointTool` is false until that tool is open. */
export interface LoopFacts {
  jointTool: boolean;
  reason: string | null;
}

const EMPTY_LOOP: LoopFacts = { jointTool: false, reason: null };
let loopFacts: LoopFacts = { ...EMPTY_LOOP };

/** Pose publishes this whenever the Joint tool's panel is rebuilt. */
export function setLoopFacts(next: LoopFacts): void {
  loopFacts = next;
}

/** Pose publishes this whenever the animation panel is rebuilt, including before that panel is on screen. */
export function setAnimationFacts(next: AnimationFacts): void {
  animationFacts = next;
}

/** Model binds the same "a solid is open" read the Print transition card uses. Until then, none is. */
let printTransitionSolid = (): boolean => false;

export function bindPrintTransitionSolid(read: () => boolean): void {
  printTransitionSolid = read;
}

function settingsLevel(): "simple" | "advanced" | "expert" {
  if (typeof document === "undefined") return "simple";
  const level = document.documentElement.dataset.settingsLevel;
  if (level === "advanced" || level === "expert") return level;
  return "simple";
}

/** The settings dock, where height ranges, modifiers and object settings are drawn. */
function settingsOnScreen(): boolean {
  return state.stage === "prepare" || state.stage === "preview" || state.stage === "gcode";
}

function hasPart(): boolean {
  return state.plate.objects.length > 0 || state.placed !== null;
}

/** Feature-menu tools. The label is the sentence's subject. */
const MODEL_TOOLS: Record<string, string> = {
  "model-boss": "Boss",
  "model-texture": "Texture",
  "model-array": "Array",
  "model-ribs": "Ribs",
  "model-text": "Text",
  "model-patch": "Patch",
  "model-blend": "Blend",
  "model-nurbs": "NURBS",
};

function plateModifierReason(offStage: string, simple: string): string | null {
  if (!settingsOnScreen()) return offStage;
  if (settingsLevel() === "simple") return simple;
  if (!hasPart()) return "Add a part to the plate first.";
  return null;
}

/** Model registers this. Until then a build is not a reason, and the modeler stays out of the first chunk. */
let modelBuildingReason: (id: string) => string | null = () => null;

export function bindModelActionReason(read: (id: string) => string | null): void {
  modelBuildingReason = read;
}

/** The sentence for `id`, or null when this command can run (or is not one of these). */
export function actionReason(id: string): string | null {
  const building = modelBuildingReason(id);
  if (building) return building;
  const modelTool = MODEL_TOOLS[id];
  if (modelTool) return state.stage === "model" ? null : `${modelTool} is in Model.`;
  switch (id) {
    case "pose-move":
      return state.stage === "pose" ? null : "Move is in Pose.";
    case "model-transition":
      if (state.stage !== "model") return "Print transition is in Model.";
      if (!printTransitionSolid()) return "Open a solid to add a print transition.";
      return null;
    case "model-view":
      return state.stage === "model" ? null : "View is in Model.";
    case "calibrate":
      return state.stage === "prepare" ? null : "Calibrate is in Prepare.";
    case "measure-points":
      return state.stage === "prepare" ? null : "Measure between points is in Prepare.";
    case "pose-close-loop":
      if (state.stage !== "pose") return "Close loop is in Pose.";
      if (!loopFacts.jointTool) return "Close loop is in the Joint tool.";
      return loopFacts.reason;
    case "pose-animation-play":
      if (state.stage !== "pose") return "Play is in Pose.";
      if (animationFacts.preparing) return "An animation is already being prepared.";
      if (!animationFacts.plugins) return "No animation plugins in this project or library.";
      if (!animationFacts.assembly) return "Select an assembly and an animation.";
      return null;
    case "pose-animation-stop":
      if (state.stage !== "pose") return "Stop is in Pose.";
      if (!animationFacts.ready) return "Play an animation first.";
      return null;
    case "pose-animation-keep":
      if (state.stage !== "pose") return "Keep this frame is in Pose.";
      if (!animationFacts.ready) return "Play an animation first.";
      return null;
    case "pose-animation-save":
      if (state.stage !== "pose") return "Save animation is in Pose.";
      if (!animationFacts.ready) return "Play an animation first.";
      return null;
    case "pose-animation-library":
      if (state.stage !== "pose") return "Keep in library is in Pose.";
      if (!animationFacts.ready) return "Play an animation first.";
      if (animationFacts.inLibrary) return "This animation is already in your plugin library.";
      return null;
    case "add-height-range":
      return plateModifierReason("Height ranges are in Prepare, Preview and G-code.", "Height ranges show at Advanced.");
    case "add-modifier-box":
    case "add-modifier-cylinder":
    case "add-modifier-sphere":
      return plateModifierReason("Modifiers are in Prepare, Preview and G-code.", "Modifiers show at Advanced.");
    case "object-settings":
      if (!settingsOnScreen()) return "Object settings are in Prepare, Preview and G-code.";
      if (settingsLevel() === "simple") return "Object settings show at Advanced.";
      if (!state.plate.selectedId) return "Select a part.";
      return null;
    case "preview-color-by":
      return state.stage === "preview" ? null : "Color by is in Preview.";
    case "preview-features":
      if (state.stage !== "preview") return "Features shown are in Preview.";
      if (!state.result) return "Slice to choose the features shown.";
      return null;
    case "preview-bed":
      return state.stage === "prepare" || state.stage === "preview" ? null : "Bed opacity is in Prepare and Preview.";
    default:
      return null;
  }
}
