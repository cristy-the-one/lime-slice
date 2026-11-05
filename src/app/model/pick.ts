/** Picking: the click on the solid, the plugin's face pick, the context bar, and the readout. */
import { IDENTITY_POSE, applyPose, isIdentity } from "../../model-space";
import type { ModelPick } from "../../model-view";
import { type ParsedSolid } from "../../model-reply";
import { nextModelPicks, selectionCountLabel } from "../../model-select";
import { faceCentre, formatMm } from "../../model-plane";
import { pathTo, type Vec3 } from "../../model-tree";
import { averagePoint, contextKind, polylineMid } from "../../context-bar";
import { hideContextBar, showContextBar } from "../../context-bar-ui";
import { openModelTool, syncModelChrome } from "../../ui/model-chrome";
import { axisWord, curvedValueOf, faceValueOf, sketchOutline, type PickedFaceValue } from "../../recipe/picks";
import { faceRows as geometryFaceRows } from "../../modeling/solid-geometry";
import type { SketchChoice } from "../../ui/pick-field";
import { sectionFacePicked } from "../../ui/model-look";
import { fx } from "../fx";
import { plainModelError } from "../model-error";
import { sketchTakesPick } from "../sketch";
import { modelTrees } from "../model-trees";
import { state } from "../state";
import { stressPickFace, stressPicking } from "../../ui/stress.ts";
import { splitPrintOpen, splitPrintPicked } from "../../ui/split-print.ts";
import { transitionCardOpen, transitionChainClick, transitionPicked } from "../../ui/transition-card.ts";
import { S } from "./shared";
import { paintBlendHighlight, treeOf } from "./edges";
import { mm, text, treeCall } from "./engine";
import { curvedKind, paintTextAnchor } from "./features";
import { flatFace } from "./geometry";
import { frameLocated } from "./probe";
import { noteRepeatPick } from "./repeat";
import { VIEW_ONLY } from "./shared";
import { pickTransitionChain } from "./transition";
import { setMode } from "./tree";
import { openPose, viewed } from "./view";
import { openObject } from "./workplane";

/** --- P3 context bar --- The click that made the current selection. `empty` is a click on nothing. */
let contextClick: { x: number; y: number; empty: boolean } | null = null;

let contextFromPick = false;

// --- Recipe API 1.2. A plugin's face or outline value waits for the next face click on the open part.
let pluginFacePick: ((picked: { object: string; face: PickedFaceValue } | null) => void) | null = null;

/** Arm a face pick for a plugin's form; the sentence that says why it cannot start, or null. */
export function startPluginFacePick(done: (picked: { object: string; face: PickedFaceValue } | null) => void): string | null {
  if (state.stage !== "model" || !S.open || !viewed()) return "No part is open to pick a face on. Select a part in the objects list, then open it in Model.";
  if (S.lens) return "History shows an earlier step. Click the last step in History, then pick the face.";
  cancelPluginFacePick(true);
  pluginFacePick = done;
  document.addEventListener("keydown", escPluginFacePick, true);
  setMode("face");
  readout(`Click a flat face of ${openObject()?.name ?? "the part"}. Esc cancels.`);
  return null;
}

/** Stop waiting for a face click; `tell` hands the form a cancel, so it stops showing the wait. */
export function cancelPluginFacePick(tell: boolean) {
  const done = pluginFacePick;
  pluginFacePick = null;
  document.removeEventListener("keydown", escPluginFacePick, true);
  if (tell) done?.(null);
}

/** Esc while a plugin's form waits for a face: the wait ends, and nothing else takes the key. */
function escPluginFacePick(ev: KeyboardEvent) {
  if (ev.key !== "Escape" || !pluginFacePick) return;
  ev.preventDefault();
  ev.stopPropagation();
  cancelPluginFacePick(true);
  readout("No face was picked.");
}

/** The face click a plugin's form waits for: a flat face of the open part, kept as {normal, nearPoint, areaMm2}. */
function takePluginFacePick(pick: ModelPick | null): boolean {
  if (!pluginFacePick || pick?.kind !== "face" || !S.open) return false;
  const solid = viewed();
  const set = solid ? { faces: geometryFaceRows(solid.positions, solid.triangles, solid.faces), positions: solid.positions, triangles: solid.triangles } : null;
  // --- Recipe API 1.3: a curved face is kept by its surface and a point; a plugin whose parameter takes only flat faces says so when it runs.
  const face: PickedFaceValue | null = set ? faceValueOf(set, pick.index) ?? curvedValueOf(set, pick.index) : null;
  if (!face) {
    readout("That face is not on the part. Click a face, or press Esc.");
    return true;
  }
  const done = pluginFacePick;
  cancelPluginFacePick(false);
  S.picks = [{ kind: "face", index: pick.index }];
  fx.model?.highlight(S.picks);
  syncModelChrome(S.picks);
  done({ object: S.open.objectId, face });
  readout("normal" in face ? `Picked the face facing ${axisWord(face.normal)}, ${formatMm(face.areaMm2 ?? 0)} mm².` : `Picked a ${face.surface === "other" ? "curved" : face.surface} face, ${formatMm(face.areaMm2 ?? 0)} mm².`);
  return true;
}

/** The sketches a plugin's outline may use: each extrude's or revolve's step with an outline, on the shown path of each part. */
export function plateSketches(): SketchChoice[] {
  const out: SketchChoice[] = [];
  for (const obj of state.plate.objects) {
    const tree = obj.modelTree ? modelTrees.get(obj.modelTree) : undefined;
    if (!tree) continue;
    for (const id of pathTo(tree, tree.current)) {
      const node = tree.nodes.get(id);
      if (!node?.op || (node.op.kind !== "extrude" && node.op.kind !== "revolve")) continue;
      if ("reason" in sketchOutline(tree, id, IDENTITY_POSE)) continue;
      out.push({ object: obj.id, step: id, label: `${obj.name} · ${node.name ?? node.label}` });
    }
  }
  return out;
}

export async function onPick(pick: ModelPick | null, shift: boolean, pointer: { x: number; y: number }) {
  // --- B13. A loft or sweep in Look around takes the click as a section or a profile. ---
  if (sketchTakesPick(pointer.x, pointer.y)) return;
  if (takePluginFacePick(pick)) return;
  // A Stress pick mode takes face clicks as holds or loads; the selection stays as it was.
  if (stressPicking()) {
    if (pick?.kind === "face") stressPickFace(pick.index);
    return;
  }
  const at = S.open;
  const tree = treeOf(at);
  const solid = viewed();
  // A tool's step looked at is read-only; while one is edited, picks are on it.
  if (!at || !tree || !solid || (S.lens && !S.editing)) return;
  // --- A4. A path point, an axis, or a mirror face, before the selection changes. ---
  noteRepeatPick(pick);
  contextClick = { x: pointer.x, y: pointer.y, empty: pick == null };
  contextFromPick = true;
  // --- Print transitions (step 6): with the card open, a plain click on an edge takes its tangent chain, and a second
  // click on one edge of that chain takes it alone.
  const chainAsk = !shift && pick?.kind === "edge" ? transitionChainClick(pick.index) : null;
  S.picks = nextModelPicks(S.picks, pick, shift);
  // --- Text on a cylinder or a cone: the click is where the text goes. Another face takes the anchor away.
  if (openModelTool() === "text") {
    const clicked = pick?.kind === "face" && pick.at && curvedKind(pick.index) !== null ? pick : null;
    if (clicked?.at) S.textAnchor = { face: clicked.index, point: [clicked.at[0], clicked.at[1], clicked.at[2]] };
    else if (S.picks.length !== 1 || S.picks[0]!.kind !== "face" || S.textAnchor?.face !== S.picks[0]!.index) S.textAnchor = null;
    S.featureMemo = null;
    paintTextAnchor();
  }
  paintBlendHighlight();
  // --- A10. Right after the section axis became Face, the pick is that plane too, kept in the solid's frame. A curved face is refused in the menu.
  if (pick?.kind === "face") {
    const own = flatFace(solid, pick.index);
    sectionFacePicked(own ? { origin: own.point, normal: own.normal } : "curved");
  }
  syncModelChrome(S.picks);
  if (splitPrintOpen()) splitPrintPicked();
  if (transitionCardOpen()) transitionPicked();
  if (chainAsk === "chain" && pick?.kind === "edge") void pickTransitionChain(S.lens ? S.lens.key : at.key, S.lens ? S.lens.node : tree.current, pick.index);
  const seq = ++S.measureSeq;
  if (S.picks.length === 0) {
    readout(`${about(solid)} Pick a face or an edge.`);
    S.edgeDrag?.picksChanged();
    return;
  }
  if (S.picks.length === 1) {
    readout(`${describe(solid, S.picks[0]!)} ${about(solid)}`);
    S.edgeDrag?.picksChanged();
    return;
  }
  if (S.picks.length !== 2) {
    readout(`${selectionCountLabel(S.picks)}. ${about(solid)}`);
    S.edgeDrag?.picksChanged();
    return;
  }
  readout("Measuring distance…");
  const generation = S.ticket;
  const [key, node] = S.lens ? [S.lens.key, S.lens.node] : [at.key, tree.current];
  const body = await treeCall(key, node, {
    call: "distance",
    key,
    node,
    aKind: S.picks[0]!.kind,
    aIndex: S.picks[0]!.index,
    bKind: S.picks[1]!.kind,
    bIndex: S.picks[1]!.index,
  });
  if (seq !== S.measureSeq || generation !== S.ticket || state.stage !== "model") return;
  const distance = typeof body.distanceMm === "number" ? body.distanceMm : null;
  if (distance == null) {
    readout(text(body.error) || "Could not measure that distance.");
    S.edgeDrag?.picksChanged();
    return;
  }
  readout(`${describe(solid, S.picks[0]!)} ${describe(solid, S.picks[1]!)} Distance ${mm(distance)} mm.`);
  S.edgeDrag?.picksChanged();
}

/** --- P3 context bar --- A click chooses the bar. Clearing the selection, or switching pick mode, takes it away. */
export function paintContextBar() {
  const fromPick = contextFromPick;
  contextFromPick = false;
  const solid = viewed();
  if (!solid || (S.lens && !S.editing)) {
    hideContextBar();
    return;
  }
  if (!fromPick) {
    if (S.picks.length === 0) hideContextBar();
    else if (document.querySelector("#modelBar")?.getAttribute("data-tool")) {
      const restored = contextKind(
        S.picks,
        solid.faces.map((face) => ({ index: face.id, ...(face.surface ? { surface: face.surface } : {}) })),
      );
      const box = document.querySelector("#model")?.getBoundingClientRect();
      if (restored) showContextBar({
        kind: restored,
        picks: S.picks,
        pointer: box ? { x: box.left + box.width / 2, y: box.top + 28 } : { x: 28, y: 28 },
        anchor: contextAnchor(solid),
      });
    }
    return;
  }
  const pointer = contextClick;
  if (S.picks.length === 0) {
    if (pointer?.empty) showContextBar({ kind: "empty", picks: S.picks, pointer, anchor: null });
    else hideContextBar();
    return;
  }
  const kind = contextKind(
    S.picks,
    solid.faces.map((face) => ({ index: face.id, ...(face.surface ? { surface: face.surface } : {}) })),
  );
  if (!kind || !pointer) {
    hideContextBar();
    return;
  }
  showContextBar({ kind, picks: S.picks, pointer, anchor: contextAnchor(solid) });
}

function contextAnchor(solid: ParsedSolid): Vec3 | null {
  const pose = openPose();
  const place = (point: Vec3): Vec3 => (isIdentity(pose) ? point : applyPose(pose, point));
  const points: Vec3[] = [];
  for (const pick of S.picks) {
    if (pick.kind === "face") {
      const centre = faceCentre(solid.positions, solid.triangles, pick.index);
      if (centre) points.push(place(centre));
    } else {
      const edge = solid.edges.find((item) => item.id === pick.index);
      const mid = polylineMid(edge?.points);
      if (mid) points.push(place(mid));
    }
  }
  return averagePoint(points);
}

function describe(current: ParsedSolid, pick: ModelPick) {
  if (pick.kind === "face") {
    const area = current.faces.find((face) => face.id === pick.index)?.areaMm2;
    return `Face ${pick.index + 1} · ${mm(area ?? Number.NaN)} mm².`;
  }
  const length = current.edges.find((edge) => edge.id === pick.index)?.lengthMm;
  return `Edge ${pick.index + 1} · ${mm(length ?? Number.NaN)} mm.`;
}

/** The solid's volume, or why there is none. */
export function about(solid: ParsedSolid) {
  return solid.editable ? `Volume ${mm(solid.volumeMm3)} mm³.` : VIEW_ONLY;
}

export function modelTool(): string | undefined {
  return document.querySelector<HTMLElement>("#modelBar")?.dataset.tool;
}

export function readout(message: string) {
  S.readoutText = plainModelError(message, modelTool());
  paintReadout();
}

/** The sentence, then Show where while a refusal has boxes. Setting textContent would drop the button. */
export function paintReadout() {
  const node = document.querySelector<HTMLElement>("#modelReadout");
  if (!node) return;
  // E3. One line in the status line: the sentence ellipsizes, and its tip says it whole.
  const sentence = document.createElement("span");
  sentence.className = "model-readout-text";
  sentence.textContent = S.readoutText;
  node.replaceChildren(sentence);
  if (S.readoutText) node.dataset.tip = S.readoutText;
  else delete node.dataset.tip;
  if (!S.locatedNow) return;
  const button = document.createElement("button");
  button.id = "modelShowWhere";
  button.type = "button";
  button.className = "btn model-show-where";
  button.textContent = "Show where";
  button.addEventListener("click", () => frameLocated());
  node.append(button);
}
