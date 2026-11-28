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
import { decodeSurfaceInspect, exactFrom, shownVolumeMm3, type ParsedSolid } from "../../model-reply";
import { cachedSurface, keepSurface, surfaceKey } from "./surface-cache";
import { viewRequest } from "../../model-mesh-quality";
import { isOpenSheet } from "../../model-sheet";
import { contextParts } from "../../model-context";
import { isHidden, isolate, pruneHidden, setHidden, showAll, visibleParts } from "../../model-hidden";
import { extentAlong } from "../../model-plane";
import { type Vec3 } from "../../model-tree";
import {
  joinPick,
  refreshJoinChoices,
  openModelTool,
  refreshModelCheck,
  refreshModelGhost,
  setModelEditable,
  setSheetMode,
  setModelLocked,
  syncModelChrome,
  syncModelSolid,
  syncPlaceFields,
  syncWorkplaneFields,
} from "../../ui/model-chrome";
import { explodeLook, lookState, mountModelLook, onExplode, onSurfaceNeed, showExplode } from "../../ui/model-look";
import { canExplode, explodeContext, heldParts } from "../model-explode";
import { meshSeat, meshTokenOf, modelPoseOf, setMeshSeat, type PlateObject } from "../../plate";
import { centreOf, usingCustomPivot } from "../../pivot.ts";
import type { ContextPart } from "../../model-context";
import { livePlate, syncPlateView } from "../files";
import { fx } from "../fx";
import { paintModelInspect, setInspectVolume } from "../../ui/model-inspect";
import { state } from "../state";
import { assemblyOfObject } from "../assemblies.ts";
import { chooseStudyMesh } from "../../sim/study-mesh.ts";
import { closeSplitPrint } from "../../ui/split-print.ts";
import { closeTransitionCard } from "../../ui/transition-card.ts";
import { S, takeKeepView } from "./shared";
import { warmMesh } from "./commit";
import { hideEmpty, plateBoxes } from "./create";
import { treeOf } from "./edges";
import { mm, treeCall } from "./engine";
import { readout } from "./pick";
import type { Lens } from "./shared";
import { runQueuedReaim } from "./transition";
import { showEdits, syncUndo } from "./undo";
import { openObject } from "./workplane";
import { mountModelInspect } from "../../ui/model-inspect";
import { plateObjectSizes } from "../settings";
import { posedFace } from "./workplane";

/** Each solid's, and each plate mesh's, box in its own frame. */
const ownBoxes = new WeakMap<Float32Array, Bounds>();

let surfaceInspectTicket = 0;

async function ensureSurfaceInspect(need: { curvature: boolean; isoparms: boolean }) {
  if (!need.curvature && !need.isoparms) return;
  const open = S.open;
  const tree = treeOf(open);
  if (!open || !tree) return;
  const key = S.lens?.key ?? open.key;
  const node = S.lens?.node ?? tree.current;
  const chord = state.stepTolerance;
  const cacheKey = surfaceKey(key, node, chord);
  const cached = cachedSurface(cacheKey);
  const hasCurv = !need.curvature || !!cached?.minRadiusMm;
  const hasIso = !need.isoparms || cached?.isoPoints !== undefined;
  if (cached && hasCurv && hasIso) {
    fx.model?.setSurfaceInspect({
      ...(cached.minRadiusMm ? { minRadiusMm: cached.minRadiusMm } : {}),
      ...(cached.gaussian ? { gaussian: cached.gaussian } : {}),
      ...(cached.mean ? { mean: cached.mean } : {}),
      ...(cached.isoPoints ? { isoPoints: cached.isoPoints } : {}),
    });
    return;
  }
  const mine = ++surfaceInspectTicket;
  const wantCurv = need.curvature || !!cached?.minRadiusMm;
  const wantIso = need.isoparms || cached?.isoPoints !== undefined;
  // Per-vertex curvature describes the display mesh when the view draws one: the same field as the view's own requests.
  const body = await treeCall(key, node, viewRequest({
    call: "surfaceInspect",
    key,
    node,
    chordMm: chord,
    curvature: wantCurv,
    isoparms: wantIso,
    isoCount: 6,
  }));
  if (mine !== surfaceInspectTicket) return;
  const decoded = decodeSurfaceInspect(body);
  if (typeof decoded === "string") return;
  keepSurface(cacheKey, decoded);
  // A late reply is kept for its node but shown only while that node is still on screen: isoparm lines carry no
  // vertex count to check against (the curvature buffers are length-checked), so they would draw on another solid.
  const nowTree = treeOf(S.open);
  const nowKey = S.lens?.key ?? S.open?.key;
  const nowNode = S.lens?.node ?? nowTree?.current;
  if (nowKey !== key || nowNode !== node || state.stepTolerance !== chord) return;
  fx.model?.setSurfaceInspect({
    ...(decoded.minRadiusMm ? { minRadiusMm: decoded.minRadiusMm } : {}),
    ...(decoded.gaussian ? { gaussian: decoded.gaussian } : {}),
    ...(decoded.mean ? { mean: decoded.mean } : {}),
    ...(decoded.isoPoints ? { isoPoints: decoded.isoPoints } : {}),
  });
}

let refreshingContext = false;
let exactTicket = 0;

/** The exact volume already read for a node's solid. A second showing of that card does not ask again. */
const exactRead = new Map<string, number | null>();

/** One node's solid, so a rebuild (a new fingerprint) is read again and a repaint is not. */
function exactReadKey(key: string, node: number, parsed: ParsedSolid): string {
  const fp = parsed.fingerprint;
  return `${key}:${node}:${fp?.volumeMm3 ?? parsed.volumeMm3}:${fp?.faces ?? -1}:${fp?.edges ?? -1}`;
}

function paintExact(parsed: ParsedSolid, exact: number, quick: string) {
  const phrase = `${mm(shownVolumeMm3({ volumeMm3: parsed.volumeMm3, exactVolumeMm3: exact }))} mm³`;
  setInspectVolume(phrase);
  parsed.exactVolumeMm3 = exact;
  if (phrase !== quick && S.readoutText.includes(quick)) readout(S.readoutText.replace(quick, phrase));
}

/** The Part card's volume is the exact measure. The open itself stays on the quick reply. A ghost, a hover and a repaint do not come here. */
async function showExactVolume(parsed: ParsedSolid) {
  const open = S.open;
  const tree = treeOf(open);
  if (!open || !tree) return;
  const key = S.lens?.key ?? open.key;
  const node = S.lens?.node ?? parsed.id;
  const id = exactReadKey(key, node, parsed);
  const known = exactRead.get(id);
  const quick = `${mm(shownVolumeMm3(parsed))} mm³`;
  if (known !== undefined) {
    if (known !== null) paintExact(parsed, known, quick);
    return;
  }
  exactRead.set(id, null);
  const mine = ++exactTicket;
  let body: Record<string, unknown>;
  try {
    body = await treeCall(key, node, { call: "exactVolume", key, node });
  } catch {
    exactRead.delete(id);
    return;
  }
  const exact = exactFrom(body);
  exactRead.set(id, exact ?? null);
  if (mine !== exactTicket || S.open !== open || exact === undefined) return;
  paintExact(parsed, exact, quick);
}

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
  // One rule for the banner, the sheet tools, the viewport's sheet look and the plate mark (src/model-sheet.ts): a
  // surfaces-only STEP is no sheet unless its plate object is marked one.
  const marked = state.plate.objects.find((obj) => obj.id === S.open?.objectId)?.sheet === true;
  const isSheet = !view && isOpenSheet(parsed, treeOf(S.open)?.root, parsed.id, marked);
  fx.model?.setSolid(parsed, openPose(), isSheet);
  setInspectVolume(parsed.editable ? `${mm(shownVolumeMm3(parsed))} mm³` : "—");
  // The first look at an object frames it, but for one a Ctrl-click selected (the camera stays) and one just added (the
  // camera moves only as far as it takes to show it, and what was in view stays in view).
  const keepView = takeKeepView(S.open?.objectId);
  if (S.open && S.framedFor !== S.open.objectId) {
    const added = S.addedIds.delete(S.open.objectId);
    S.framedFor = S.open.objectId;
    if (keepView) {
      // Where it is, and nothing else.
    } else if (added) {
      const box = openBox();
      if (box) fx.model?.reveal(box);
    } else frameModel(false);
  }
  syncPlaceFields();
  syncWorkplaneFields();
  refreshModelContext();
  fx.model?.highlight([]);
  setSheetMode(isSheet);
  setModelEditable(parsed.editable);
  // --- Organic surfaces S4 (U6): show open-sheet banner with one-click Thicken & Cap & Sew when open.
  const sheetBar = document.querySelector<HTMLElement>("#modelSheetBar");
  if (sheetBar) {
    sheetBar.hidden = !isSheet;
    if (isSheet) {
      const n = parsed.nakedEdges?.length ?? 0;
      const label = document.querySelector<HTMLElement>("#modelSheetText");
      if (label) {
        label.textContent = n > 0
          ? `Open sheet · ${n} open border${n === 1 ? "" : "s"} — thicken or cap & sew to make a printable solid.`
          : "Open sheet — thicken or cap & sew to make a printable solid.";
      }
    }
  }
  syncModelSolid();
  syncModelChrome([]);
  fx.model?.resize();
  showEdits(true);
  refreshModelGhost();
  syncUndo();
  readout(message);
  if (parsed.editable) void showExactVolume(parsed);
  // P2. The solid or the tool changed: the edge knob follows.
  S.edgeDrag?.sync();
  // --- S2 sketch ---
  S.sketchUi?.sync();
  // --- A7 model check --- a queued Check opens after the solid is on screen; one already open measures this solid.
  if (S.checkQueued) openQueuedCheck();
  else if (openModelTool() === "check") refreshModelCheck();
  // --- Print transitions: Prepare's Re-aim runs once that object's solid is on screen.
  if (S.reaimQueued) runQueuedReaim();
  // The plate takes this solid's mesh when Model is left: its cracks are closed meanwhile, off the UI's path.
  if (!view) warmMesh(parsed);
  // --- Organic surfaces S1: if Curvature or Surface grid (Isoparms) is active, fetch buffers lazily for this solid.
  const look = lookState();
  if (look.shading === "curvature" || look.isoparms) {
    void ensureSurfaceInspect({ curvature: look.shading === "curvature", isoparms: look.isoparms });
  }
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
  noteAdded();
  // Hidden objects are never built into the view, so nothing can draw, hover, pick, measure or snap to them. The open one is always shown.
  pruneHidden(livePlate().map((obj) => obj.id), S.open?.objectId ?? null);
  const parts = visibleParts(contextParts(livePlate(), S.open?.objectId ?? null)).filter((part) => part.id !== S.ghosted);
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

/**
 * An object that was not on the plate when Model last listed it is new: the camera shows it, moving as little as it
 * takes, and not at all when it is already in view. The first object, and a plate that was just opened, are not additions.
 */
function noteAdded() {
  const plate = livePlate();
  const before = S.seenIds;
  S.seenIds = new Set(plate.map((obj) => obj.id));
  if (!before || before.size === 0 || state.stage !== "model") return;
  const fresh = plate.filter((obj) => !before.has(obj.id));
  if (fresh.length === 0) return;
  const boxes = plateBoxes();
  const shown: Bounds[] = [];
  plate.forEach((obj, i) => {
    if (!before.has(obj.id)) {
      S.addedIds.add(obj.id);
      if (!isHidden(obj.id) && boxes[i]) shown.push(boxes[i]!);
    }
  });
  const union = unionBox(shown);
  if (union) fx.model?.reveal(union);
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
  const centre: Vec3 = [(own.min[0] + own.max[0]) / 2, (own.min[1] + own.max[1]) / 2, (own.min[2] + own.max[2]) / 2];
  const obj = S.open ? state.plate.objects.find((row) => row.id === S.open!.objectId) : undefined;
  if (!obj?.pivot || !usingCustomPivot(obj.pivot, centreOf(obj.sourcePos))) return centre;
  return [obj.pivot[0], obj.pivot[1], obj.pivot[2] + (meshSeat(obj.bytes) ?? 0)];
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
  const others = all || !box ? partsInView(visibleParts(contextParts(livePlate(), S.open?.objectId ?? null))).map((part) => boxUnder(boxOf(part.positions), part.matrix)) : [];
  const union = unionBox(box ? [box, ...others] : others);
  if (union) fx.model?.frame(union);
}

/** The Objects list's Frame in Model: that object, opened if it is not the open one. */
export function frameInModel(id: string) {
  if (S.open?.objectId === id) frameModel(false);
  else S.framedFor = null;
}

export function bindInspect() {
  // --- E3. Inspect, the right dock in Model. ---
  mountModelInspect({
    objects: () => plateObjectSizes().map((row) => ({ ...row, hidden: isHidden(row.id) })),
    openId: () => S.open?.objectId ?? state.plate.selectedId,
  });
}

/** Inspect's eye: hide or show one plate object in the view (`only`: show just this one, or all again). Nothing on the plate changes. */
export function toggleObjectHidden(id: string, only: boolean) {
  const openId = S.open?.objectId ?? state.plate.selectedId;
  // The open object is always shown, so it is neither hidden nor counted among the ones isolating hides.
  const ids = state.plate.objects.map((obj) => obj.id).filter((other) => other !== openId);
  if (!ids.includes(id)) return;
  if (only) isolate(id, ids);
  else setHidden(id, !isHidden(id));
  refreshModelContext();
  syncPlateView();
}

export function showAllObjects() {
  showAll();
  refreshModelContext();
  syncPlateView();
}

export function bindLook() {
  // --- A10. Section view and colour by step, from the View menu in the model foot.
  if (fx.model) {
    mountModelLook({
      setLook: (state) => fx.model?.setLook(state),
      onSectionDrag: (cb) => fx.model?.onSectionDrag(cb),
      posed(plane) {
        const at = posedFace({ point: plane.origin, normal: plane.normal })!;
        return { origin: at.point, normal: at.normal };
      },
    });
    onExplode(() => refreshModelContext());
    onSurfaceNeed((need) => void ensureSurfaceInspect(need));
  }
}
