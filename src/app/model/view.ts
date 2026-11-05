/** Presenting a solid: the readout, the context, the view frame, and the open part's pose. */
import { boundsOf, type Bounds } from "../../mesh-place";
import {
  IDENTITY_POSE,
  applyPose,
  boxUnder,
  inversePose,
  isIdentity,
  posedBounds,
  thenPose,
  viewFrameOf,
  type Affine,
} from "../../model-space";
import { unionBox } from "../../measure";
import { type ParsedSolid } from "../../model-reply";
import { contextParts } from "../../model-context";
import { extentAlong } from "../../model-plane";
import { type Vec3 } from "../../model-tree";
import {
  joinPick,
  refreshJoinChoices,
  openModelTool,
  refreshModelCheck,
  refreshModelGhost,
  setModelEditable,
  setModelLocked,
  syncModelChrome,
  syncModelSolid,
  syncPlaceFields,
  syncWorkplaneFields,
} from "../../ui/model-chrome";
import { explodeLook, showExplode } from "../../ui/model-look";
import { canExplode, explodeContext, heldParts } from "../model-explode";
import { meshSeat, meshTokenOf, modelPoseOf, setMeshSeat, type PlateObject } from "../../plate";
import type { ContextPart } from "../../model-context";
import { livePlate } from "../files";
import { fx } from "../fx";
import { paintModelInspect, setInspectVolume } from "../../ui/model-inspect";
import { state } from "../state";
import { assemblyOfObject } from "../assemblies.ts";
import { chooseStudyMesh } from "../../sim/study-mesh.ts";
import { closeSplitPrint } from "../../ui/split-print.ts";
import { closeTransitionCard } from "../../ui/transition-card.ts";
import { S } from "./shared";
import { hideEmpty } from "./create";
import { treeOf } from "./edges";
import { mm } from "./engine";
import { readout } from "./pick";
import type { Lens } from "./shared";
import { runQueuedReaim } from "./transition";
import { showEdits, syncUndo } from "./undo";
import { openObject } from "./workplane";

/** Each solid's, and each plate mesh's, box in its own frame. */
const ownBoxes = new WeakMap<Float32Array, Bounds>();

let refreshingContext = false;

/** What the tools say while a tool's step is looked at in History. */
const PEEK_LOCK = "This is a step of a tool this part was joined with. Edit step changes it; pick a step of this part to work on it.";

/**
 * Show `parsed` as the open tree's current node, or with `view` a tool's step in its place. The camera frames it when
 * another object opened, and stays put otherwise. A tool's step looked at outside an edit is read-only: the tools wait.
 */
export function present(parsed: ParsedSolid, message: string, view: Lens | null = null) {
  // Split to print's card, and a print transition's, were worked out on the solid that was on screen.
  closeSplitPrint();
  closeTransitionCard();
  S.lens = view;
  S.picks = [];
  hideEmpty();
  if (!view) learnSeat(parsed);
  setModelLocked(view && !S.editing ? PEEK_LOCK : null);
  fx.model?.setSolid(parsed, openPose());
  setInspectVolume(parsed.editable ? `${mm(parsed.volumeMm3)} mm³` : "—");
  if (S.open && S.framedFor !== S.open.objectId) {
    S.framedFor = S.open.objectId;
    frameModel(false);
  }
  syncPlaceFields();
  syncWorkplaneFields();
  refreshModelContext();
  fx.model?.highlight([]);
  setModelEditable(parsed.editable);
  syncModelSolid();
  syncModelChrome([]);
  fx.model?.resize();
  showEdits(true);
  refreshModelGhost();
  syncUndo();
  readout(message);
  // P2. The solid or the tool changed: the edge knob follows.
  S.edgeDrag?.sync();
  // --- S2 sketch ---
  S.sketchUi?.sync();
  // --- A7 model check --- a queued Check opens after the solid is on screen; one already open measures this solid.
  if (S.checkQueued) openQueuedCheck();
  else if (openModelTool() === "check") refreshModelCheck();
  // --- Print transitions: Prepare's Re-aim runs once that object's solid is on screen.
  if (S.reaimQueued) runQueuedReaim();
}

export function requestModelCheck(objectId: string) {
  if (!state.plate.objects.some((obj) => obj.id === objectId)) return;
  S.checkQueued = objectId;
  const changed = state.plate.selectedId !== objectId;
  if (changed) fx.selectPlateObject(objectId);
  if (state.stage !== "model") {
    document.querySelector<HTMLButtonElement>("#tabModel")?.click();
    return;
  }
  if (!changed) openQueuedCheck();
}

export function openQueuedCheck() {
  // --- D40. Another object on screen first keeps the request for the one Prepare named.
  if (!S.checkQueued || (S.open?.objectId ?? state.plate.selectedId) !== S.checkQueued) return;
  S.checkQueued = null;
  if (openModelTool() === "check") refreshModelCheck();
  else document.querySelector<HTMLButtonElement>("#modelToolCheck")?.click();
}

/** The other plate objects, grey, where they sit in model space, but for a join's tool, which is the ghost. */
export function refreshModelContext() {
  if (refreshingContext) return;
  // The plate changed: a join's list follows it, and loses a tool that left. The refresh that loss asks for is this one.
  refreshingContext = true;
  try {
    refreshJoinChoices();
  } finally {
    refreshingContext = false;
  }
  S.ghosted = ghostId();
  const parts = contextParts(livePlate(), S.open?.objectId ?? null).filter((part) => part.id !== S.ghosted);
  if (S.lens && S.open) {
    // A tool's step on screen: the part its join cut is grey behind it, as it was on screen, and the tool's own plate
    // object, if Keep left it there, would only stand in its way.
    const tool = S.lens.joins.at(-1)?.op.tool.object;
    fx.model?.setContext([...partsInView(parts.filter((part) => part.id !== tool)), { id: S.open.objectId, self: true, positions: S.open.solid.positions, matrix: shownPose() }]);
    showExplode(false);
    fx.model?.setTags([]);
  } else {
    fx.model?.setContext(partsInView(paintExplode(parts)));
  }
  const canvas = document.querySelector<HTMLElement>("#model");
  const obj = S.open ? state.plate.objects.find((item) => item.id === S.open!.objectId) : undefined;
  // The open object's plate mesh, so a test can tell a model-space move left it alone.
  if (canvas && obj) canvas.dataset.plateMesh = meshTokenOf(obj.bytes);
  // --- E3. Inspect lists the plate; it repaints only when the plate or the open object changed.
  paintModelInspect();
}

/** The plate object drawn as the ghost rather than grey: Boolean's picked tool, or the tool of a join being edited. */
export function ghostId(): string | null {
  const op = S.editing?.panel ? S.editing.op : null;
  return joinPick() ?? (op?.kind === "join" ? op.tool.object : null);
}

/**
 * --- Split to print, Explode (D12). The context with the open part's pieces spread when Explode is on, each number
 * tagged; `data-explode` on `#model` is the gap and `data-explode-parts` each part's shift. A view only: nothing moves
 * on the plate or in a saved file.
 */
function paintExplode(parts: ContextPart[]): ContextPart[] {
  const canvas = document.querySelector<HTMLElement>("#model");
  showExplode(!!S.open && canExplode(S.open.key, parts));
  const look = explodeLook();
  const exploded = S.open && look.on ? explodeContext(S.open.objectId, S.open.key, boundsOf(S.open.solid.positions), objectPose(), parts, look.gapMm) : null;
  fx.model?.setTags((exploded?.tags ?? []).map((tag) => ({ ...tag, at: applyPose(viewFrame(), tag.at) })));
  if (canvas) {
    if (exploded) {
      canvas.dataset.explode = String(look.gapMm);
      canvas.dataset.explodeParts = exploded.shifts;
    } else {
      delete canvas.dataset.explode;
      delete canvas.dataset.explodeParts;
    }
  }
  return exploded?.parts ?? [...parts, ...(S.open ? heldParts(S.open.key) : [])];
}

/** The open object's pose into model space. */
export function objectPose(): Affine {
  const obj = S.open ? state.plate.objects.find((item) => item.id === S.open!.objectId) : undefined;
  return obj ? modelPoseOf(obj) : IDENTITY_POSE;
}

let viewKept: { obj: PlateObject; inAssembly: boolean; frame: Affine } | null = null;

/**
 * --- Assemblies M10. Model space into the view (assemblies D12): the inverse of the open part's pose for a part-frame
 * member of an assembly, so the part stands as it was modelled and every number Model reads or types is in its own
 * frame. Else none.
 */
export function viewFrame(): Affine {
  const obj = openObject();
  if (!obj) return IDENTITY_POSE;
  const inAssembly = obj.frame === "part" && !!assemblyOfObject(obj.id);
  if (viewKept?.obj !== obj || viewKept.inAssembly !== inAssembly) viewKept = { obj, inAssembly, frame: viewFrameOf(obj, inAssembly) };
  return viewKept.frame;
}

/** A pose into model space, on into the view. */
export function inView(pose: Affine): Affine {
  const frame = viewFrame();
  return isIdentity(frame) ? pose : thenPose(pose, frame);
}

/** Grey parts placed in model space, drawn in the view. */
export function partsInView(parts: ContextPart[]): ContextPart[] {
  const frame = viewFrame();
  return isIdentity(frame) ? parts : parts.map((part) => ({ ...part, matrix: thenPose(part.matrix, frame) }));
}

/** A direction in the view, as a direction in model space. */
export function modelDirection(d: Vec3): Vec3 {
  const frame = viewFrame();
  return isIdentity(frame) ? d : applyPose({ m: inversePose(frame).m, t: [0, 0, 0] }, d);
}

/** The pose of the solid on screen, in the view: a tool's step where its joins put it, else the open object's. */
export function openPose(): Affine {
  return S.lens ? inView(S.lens.pose) : shownPose();
}

/** The open object's pose in the view. In its own frame that is exactly the identity, so a typed number is stored exactly as typed. */
export function shownPose(): Affine {
  return isIdentity(viewFrame()) ? objectPose() : IDENTITY_POSE;
}

/** --- S2 --- xyz in the solid's frame, posed into model space. */
export function posePoints(points: ArrayLike<number>, pose: Affine): number[] {
  if (isIdentity(pose)) return Array.from(points);
  const out: number[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) out.push(...applyPose(pose, [points[i]!, points[i + 1]!, points[i + 2]!]));
  return out;
}

/** The solid on screen: a tool's step, else the open solid's shown step. Every tool, pick and handle reads this one. */
export function viewed(): ParsedSolid | null {
  return S.lens?.solid ?? S.open?.solid ?? null;
}

/**
 * The tessellation a stress study slices. Faces and the STL share it, scaled
 * the same way. A missing solid is refused while the scale is not 1 or the
 * step on screen is not the one on the plate.
 */
export function stressMesh() {
  const solid = viewed();
  const tree = treeOf(S.open);
  const plate = state.sourcePos && state.sourcePos.length >= 9 ? state.sourcePos : null;
  return chooseStudyMesh({
    picked: solid && solid.positions.length >= 9 ? solid.positions : null,
    pickedTriangles: solid?.triangles ?? null,
    plate,
    scale: state.partScale,
    committed: !tree || tree.current === tree.committed,
  });
}

/** The box of the solid on screen, in model space. */
export function openBox(): Bounds | null {
  const solid = viewed();
  return solid ? posedBounds(solid.positions, openPose()) : null;
}

/** The box of a mesh's vertices, read once per array: a solid's own box, which Place turns about and the kernel cuts against, or a plate mesh's. */
export function boxOf(positions: Float32Array): Bounds {
  let box = ownBoxes.get(positions);
  if (!box) ownBoxes.set(positions, (box = boundsOf(positions)));
  return box;
}

export function pivotOf(solid: ParsedSolid): Vec3 {
  const own = boxOf(solid.positions);
  return [(own.min[0] + own.max[0]) / 2, (own.min[1] + own.max[1]) / 2, (own.min[2] + own.max[2]) / 2];
}

/**
 * The plate mesh of a step the engine just described sits under that step's solid by the solid's lowest
 * point. When an engine from before `seatMm` read a STEP without saying how far it lowered it, Model learns it here.
 */
function learnSeat(solid: ParsedSolid) {
  const mesh = treeOf(S.open)?.nodes.get(solid.id)?.mesh;
  if (!mesh || meshSeat(mesh.bytes) !== undefined) return;
  const z = extentAlong(solid.positions, [0, 0, 1]);
  if (z) setMeshSeat(mesh.bytes, z.min);
}

/**
 * Frame the open object, or with `all` every object, from the direction Model opens with. The Reset view
 * button, Home, the Objects list's Frame, and the first look at an object all come here.
 */
export function frameModel(all: boolean) {
  const box = openBox();
  // With no solid open, the view frames whatever model space holds.
  const others = all || !box ? partsInView(contextParts(livePlate(), S.open?.objectId ?? null)).map((part) => boxUnder(boxOf(part.positions), part.matrix)) : [];
  const union = unionBox(box ? [box, ...others] : others);
  if (union) fx.model?.frame(union);
}

/** The Objects list's Frame in Model: that object, opened if it is not the open one. */
export function frameInModel(id: string) {
  if (S.open?.objectId === id) frameModel(false);
  else S.framedFor = null;
}
