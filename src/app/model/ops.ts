/** The op a panel, an edit, or a tool field stands for. */
import { toSolidOp } from "../../model-space";
import { rootSpec } from "../../model-primitive";
import { selectedEdges, selectedFaces } from "../../model-blend";
import { isFeatureTool } from "../../model-features";
import { isRepeatTool } from "../../model-repeat";
import { type ModelOp, type Vec3 } from "../../model-tree";
import { moveFacesOp, shellOp, stepEdges } from "../../model-request";
import {
  fieldPrimitive,
  holeBoxes,
  chamferChoice,
  joinOpen,
  panelExprs,
  openModelTool,
  edgeFilterChoice,
  edgeMode,
  edgeStepId,
  edgeStepKnown,
  shellClosed,
  toolFrame,
} from "../../ui/model-chrome";
import { holesInModel, type HoleSizes } from "../../sketch/holes.ts";
import { transitionCardOp } from "../../ui/transition-card.ts";
import { planePoint, planePrimitive } from "../../workplane";
import { S } from "./shared";
import { featureNow } from "./features";
import { drillAxis, num, splitState } from "./geometry";
import { panelJoin } from "./join";
import { withPanelExprs } from "./parameters";
import { repeatNow } from "./repeat";
import type { Editing } from "./shared";
import { openPose } from "./view";

/** What the open panel would build: an edited step's op while one is edited, else the open tool's. */
export function panelOp(): ModelOp | null {
  return S.editing ? editOp(S.editing) : toolOp(openModelTool());
}

/** An edited step's op as its panel says it: a join keeps its tool and placement, a new solid's root stands as `rootSpec` puts it. */
export function editOp(run: Editing): ModelOp | null {
  // --- F1/E1. The sketch extrude's Apply is the op it built, not a panel. ---
  if (run.featureOp) return run.featureOp;
  // P2. The edge drag's edit is the fillet or chamfer it holds, not whatever panel is open.
  if (run.edgeOp) return run.edgeOp;
  // --- Print transitions: the card is the editor.
  if (run.op.kind === "transition") return transitionCardOp();
  const tool = openModelTool();
  if (run.op.kind === "root") {
    if (tool !== "create") return null;
    const spec = rootSpec(fieldPrimitive());
    const exprs = panelExprs();
    return exprs ? { kind: "root", ...spec, exprs } : { kind: "root", ...spec };
  }
  if (run.op.kind === "join") {
    const keepTool = document.querySelector<HTMLInputElement>("#modelKeepTool")?.checked ?? false;
    return tool === "boolean" ? { ...run.op, op: boolOp(), keepTool } : null;
  }
  return toolOp(tool);
}

/** The open tool's edit in the solid's own frame, from its model-space fields. Null when it cannot run yet. */
export function toolOp(tool: string | null | undefined): ModelOp | null {
  const op = fieldOp(tool);
  const posed = op && toSolidOp(op, openPose());
  return posed ? withPanelExprs(posed) : null;
}

/** --- F4. Radius, depth, Through all, and the counterbore, shared by every point. --- */
export function holeSizesNow(): HoleSizes {
  const { through, counterbore } = holeBoxes();
  return {
    radius: num("#modelHoleR"),
    depth: num("#modelHoleD"),
    through,
    counterboreRadius: counterbore ? num("#modelBoreR") : null,
    counterboreDepth: counterbore ? num("#modelBoreD") : null,
  };
}

/** Gaps 13. A chamfer's second size or angle, and its flip, as the panel says them. Nothing for equal sides or a fillet. */
function chamferSides(tool: "fillet" | "chamfer"): { size2?: number; angleDeg?: number; flip?: true } {
  if (tool !== "chamfer") return {};
  const { form, flip } = chamferChoice();
  if (form === "equal") return {};
  const second = form === "two" ? { size2: num("#modelChamfer2") } : { angleDeg: num("#modelChamferAngle") };
  return { ...second, ...(flip ? { flip: true as const } : {}) };
}

/** The open tool's edit as its fields say it, in model space. */
function fieldOp(tool: string | null | undefined): ModelOp | null {
  // --- A3 composite features: the group is expanded in model space, then toolOp stores it in the solid's frame. ---
  if (isFeatureTool(tool)) return featureNow(tool).group;
  // --- end A3 ---
  // --- A4 pattern and mirror: one group, the source steps each moved by the same motions. ---
  if (isRepeatTool(tool)) return repeatNow(tool).group;
  // --- end A4 ---
  const origin: Vec3 = [num("#modelX"), num("#modelY"), num("#modelZ")];
  switch (tool) {
    case "fillet":
    case "chamfer": {
      // --- A5. One step's edges, or the edges picked on the solid. ---
      if (edgeMode() === "step") {
        const id = edgeStepId();
        if (id == null || !edgeStepKnown()) return null;
        return { kind: tool, edges: [stepEdges(id, edgeFilterChoice())], size: num("#modelBlend"), ...chamferSides(tool) };
      }
      const edges = selectedEdges(S.picks);
      return edges.length === 0 ? null : { kind: tool, edges, size: num("#modelBlend"), ...chamferSides(tool) };
    }
    case "hole": {
      // --- F4. One group, one hole per point snapped when the panel opened. ---
      if (S.sketchHoleDraft) {
        const built = holesInModel({ sketch: S.sketchHoleDraft.sketch, points: S.sketchHoleDraft.points, pose: openPose(), sizes: holeSizesNow() });
        return "op" in built ? built.op : null;
      }
      const { through, counterbore } = holeBoxes();
      return {
        kind: "hole",
        origin: planePoint(toolFrame(), origin),
        axis: drillAxis(),
        radius: num("#modelHoleR"),
        depth: num("#modelHoleD"),
        ...(through ? { through: true as const } : {}),
        ...(counterbore ? { counterboreRadius: num("#modelBoreR"), counterboreDepth: num("#modelBoreD") } : {}),
      };
    }
    // --- A2 shell ---
    case "shell":
      return shellOp(num("#modelShell"), shellClosed() ? [] : selectedFaces(S.picks));
    case "boolean":
      return joinOpen() ? panelJoin() : { kind: "boolean", op: boolOp(), ...planePrimitive(fieldPrimitive(), toolFrame()), merge: true };
    case "split": {
      const split = splitState();
      return "plan" in split ? { kind: "split", origin: split.plan.origin, normal: split.plan.normal } : null;
    }
    case "scale":
      return { kind: "scale", factor: num("#modelFactor") };
    // --- P1: the panel always moves the selected faces. Alt is the drag, not this field. ---
    case "pushpull": {
      const faces = S.picks.filter((pick) => pick.kind === "face");
      const distance = num("#modelPull");
      if (faces.length === 0 || !Number.isFinite(distance) || distance === 0) return null;
      // An edit of a prism (Alt on one face) stays a prism, with its draft and its stop face.
      const prism = S.editing?.op.kind === "faceExtrude" ? S.editing.op : null;
      if (prism && faces.length === 1) return { ...prism, face: faces[0]!.index, distance };
      return moveFacesOp(faces.map((pick) => ({ face: pick.index, distance })));
    }
    default:
      return null;
  }
}

export function boolOp(): "fuse" | "cut" | "common" {
  if (document.querySelector("#modelCut")?.getAttribute("aria-pressed") === "true") return "cut";
  if (document.querySelector("#modelCommon")?.getAttribute("aria-pressed") === "true") return "common";
  return "fuse";
}
