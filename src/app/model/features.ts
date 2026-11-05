/** A3 composite features: the feature panel's expansion and the text anchor. */
import {
  emptyFeature,
  expandFeature,
  featureSource,
  keptFeatureFields,
  panelChoices,
  posedContext,
  rangeNote,
  readFeatureSpec,
  type FeatureTool,
} from "../../model-features";
import { S } from "./shared";
import { num } from "./geometry";
import { openPose, viewed } from "./view";

/** The one picked face, or null when the selection is not exactly one face. */
export function oneFeatureFace(): number | null {
  const faces = S.picks.filter((pick) => pick.kind === "face");
  return faces.length === 1 ? faces[0]!.index : null;
}

/**
 * What the face is for lettering besides a flat one (text milestones 2 and 3): `round` for a cylinder or a cone (Around or Along),
 * `skin` for a sphere, a torus or a freeform face (U or V, Wrap or Project), null for a flat face or none. Kept for the next call
 * with the same solid, pose and face.
 */
let curvedMemo: { solid: unknown; pose: string; face: number; kind: "round" | "skin" | null } | null = null;

export function curvedKind(face: number | null): "round" | "skin" | null {
  const solid = viewed();
  if (face == null || !solid) return null;
  const pose = openPose();
  const key = JSON.stringify(pose);
  if (curvedMemo?.solid === solid && curvedMemo.face === face && curvedMemo.pose === key) return curvedMemo.kind;
  const found = posedContext(solid, pose).round?.(face);
  const kind = found && !("reason" in found) ? (found.surface === "cylinder" || found.surface === "cone" ? "round" : "skin") : null;
  curvedMemo = { solid, pose: key, face, kind };
  return kind;
}

export function paintTextAnchor() {
  const note = document.querySelector<HTMLElement>("#modelTextAnchorText");
  if (note) note.textContent = S.textAnchor ? "Placed where you clicked. Click the face to move it." : "In the middle of the face. Click the face to place the text.";
}

/** The open feature, expanded on the solid on screen. Memoized across the ghost, the note, and Apply. */
export function featureNow(tool: FeatureTool) {
  const solid = viewed();
  const face = oneFeatureFace();
  const typed = readFeatureSpec(tool, (id) => num(`#${id}`), panelChoices(tool), face ?? 0);
  // --- Text on a curved face: the direction, the flip, wrap or project, and the point the text is centred on.
  const curved = tool === "text" ? curvedKind(face) : null;
  if (curved) {
    const choices = panelChoices("text");
    if (curved === "round" && choices.way === "axis") typed.along = "axis";
    if (curved === "skin" && choices.dir === "v") typed.along = "v";
    if (curved === "skin" && choices.project) typed.wrap = "project";
    if (choices.flip) typed.flip = true;
    if (S.textAnchor && S.textAnchor.face === face) typed.point = S.textAnchor.point;
  }
  // --- D28. An edit keeps the region its step was typed with, which the panel has no field for.
  const spec = { ...typed, ...keptFeatureFields(S.editing ? featureSource(S.editing.op) : null, tool) };
  const pose = openPose();
  const key = JSON.stringify({ spec, face, id: solid?.id ?? null, pose });
  if (S.featureMemo?.key === key) return S.featureMemo.value;
  const range = rangeNote(tool, (id) => num(`#${id}`));
  const value = range ? emptyFeature(range) : expandFeature(spec, solid, pose, face);
  S.featureMemo = { key, value };
  return value;
}

// --- end A3 ---
