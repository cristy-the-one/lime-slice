/** Geometry helpers: split state, the drill axis, the shell seat, and face rows. */
import { applyPose, inversePose, isIdentity, turnDir, type Affine } from "../../model-space";
import { type ParsedSolid } from "../../model-reply";
import { holeAxis, lastFace, outwardFromMesh, selectedFaces } from "../../model-blend";
import {
  boxExtentAlong,
  extentMemo,
  faceCentre,
  facePlane,
  planeFor,
  splitBase,
  type AxisExtent,
  type FacePlane,
  type SplitState,
} from "../../model-plane";
import { type Vec3 } from "../../model-tree";
import { fieldNumber, splitMode, toolFrame } from "../../ui/model-chrome";
import { axesOf, drillDown, isIdentityFrame } from "../../workplane";
import { S } from "./shared";
import { boxOf, openBox, openPose, viewed } from "./view";
import { posedFace } from "./workplane";

const extentOf = extentMemo();

/** Each solid's flat faces, by face index; null for a curved one. */
const flatFaces = new WeakMap<ParsedSolid, Map<number, FacePlane | null>>();

/** The last split worked out, for the solid, pose, and panel state it was worked out from: one input asks several times. */
let splitKept: { solid: ParsedSolid; pose: Affine; key: string; state: SplitState } | null = null;

/**
 * The open solid's extent along a model-space normal: its own extent along that normal turned back into the
 * solid's frame, moved by the pose. Exact, since the pose is rigid.
 */
export function modelExtent(solid: ParsedSolid, pose: Affine, normal: Vec3): AxisExtent | null {
  const own = extentOf(solid.positions, isIdentity(pose) ? normal : turnDir(inversePose(pose), normal));
  const shift = normal[0] * pose.t[0] + normal[1] * pose.t[1] + normal[2] * pose.t[2];
  return own && { min: own.min + shift, max: own.max + shift };
}

/**
 * The box the kernel measures a cut against, the solid's own, as `planeFor` takes it: the box itself on an
 * identity pose, else its corners' extent along a model-space normal turned back into the solid's frame.
 */
export function kernelBox(solid: ParsedSolid, pose: Affine): { min: Vec3; max: Vec3 } | ((normal: Vec3) => AxisExtent) {
  const own = boxOf(solid.positions);
  if (isIdentity(pose)) return own;
  const back = inversePose(pose);
  return (normal) => {
    const extent = boxExtentAlong(own, turnDir(back, normal));
    const shift = normal[0] * pose.t[0] + normal[1] * pose.t[1] + normal[2] * pose.t[2];
    return { min: extent.min + shift, max: extent.max + shift };
  };
}

/**
 * The split plane from the panel, in model space: the one place a split request is built, and `toolOp` takes
 * it into the solid's frame. X, Y, and Z cut square to that axis of the view, which is model space; Face cuts
 * parallel to the last picked flat face.
 */
export function splitState(): SplitState {
  const at = viewed();
  const pose = openPose();
  const box = openBox();
  if (!at || !box) return { why: "Open a STEP file to measure a solid.", wait: true };
  const mode = splitMode();
  const frame = toolFrame();
  const picked = mode === "face" ? lastFace(S.picks) : null;
  const facePicking = document.querySelector("#modelPickFace")?.getAttribute("aria-pressed") === "true";
  const value = num("#modelPlane");
  const tilt: [number, number] = [num("#modelTiltA"), num("#modelTiltB")];
  // An edited split whose normal points down its axis keeps that side: its base is the axis turned around.
  const edited = S.editing?.panel?.plane;
  const flip = !!edited?.flip && edited.mode === mode;
  const key = `${mode}|${picked}|${facePicking}|${value}|${tilt}|${flip}|${frame.source}|${frame.origin}|${frame.turn}`;
  if (splitKept?.solid === at && splitKept.pose === pose && splitKept.key === key) return splitKept.state;
  let state: SplitState;
  if (mode === "face" && picked == null) {
    state = { why: facePicking ? "Pick a flat face to cut from." : "Switch to Face picking, then pick a flat face to cut from.", wait: true };
  } else {
    const own = picked == null ? null : flatFace(at, picked);
    const face = posedFace(own);
    const center: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    let base = splitBase(mode, center, face);
    // X, Y, and Z stay those axes on the global frame. Any other frame reads them as U, V, and W from its origin.
    if (base && mode !== "face" && !isIdentityFrame(frame)) {
      const [u, v, w] = axesOf(frame);
      const axis = mode === "x" ? u : mode === "y" ? v : w;
      base = { mode, normal: axis, base: [frame.origin[0], frame.origin[1], frame.origin[2]], dir: axis };
    }
    if (base && flip) base = { ...base, normal: [-base.normal[0], -base.normal[1], -base.normal[2]] as Vec3 };
    state = base
      ? { plan: planeFor(base, value, tilt, (normal) => modelExtent(at, pose, normal), kernelBox(at, pose)) }
      : { why: "Pick a flat face. This one is curved.", wait: false };
  }
  splitKept = { solid: at, pose, key, state };
  return state;
}

/** A split is on offer when the solid can be cut square to at least one model axis. */
export function splitLegal(): boolean {
  const at = viewed();
  const pose = openPose();
  const box = openBox();
  if (!at || !box) return false;
  const kernel = kernelBox(at, pose);
  return (["x", "y", "z"] as const).some((mode) => planeFor(splitBase(mode, [0, 0, 0], null)!, 0, [0, 0], (normal) => modelExtent(at, pose, normal), kernel).range != null);
}

export function flatFace(solid: ParsedSolid, face: number): FacePlane | null {
  let known = flatFaces.get(solid);
  if (!known) flatFaces.set(solid, (known = new Map()));
  if (!known.has(face)) {
    const normal = solid.faces.find((item) => item.id === face)?.normal ?? outwardFromMesh(solid.positions, solid.triangles, face);
    known.set(face, normal ? facePlane(solid.positions, solid.triangles, face, normal as Vec3) : null);
  }
  return known.get(face)!;
}

/** Into the last picked face, or with no face picked, the way an edited hole drilled, else along the workplane's −W. */
export function drillAxis(): Vec3 {
  const face = lastFace(S.picks);
  const solid = viewed();
  if (!solid || face == null) return S.editing?.panel?.axis ?? drillDown(toolFrame());
  const stored = solid.faces.find((item) => item.id === face)?.normal;
  const axis = holeAxis(stored ?? outwardFromMesh(solid.positions, solid.triangles, face));
  const pose = openPose();
  return isIdentity(pose) ? axis : turnDir(pose, axis);
}

// --- A2 shell ---
let seatMemo: { solid: ParsedSolid; face: number; outward: Vec3 | null; centre: Vec3 | null } | null = null;

/** The first picked face's middle and inward normal, in model space. The thickness knob sits there. */
export function shellSeat(): { point: Vec3; inward: Vec3 } | null {
  const face = selectedFaces(S.picks)[0];
  const solid = viewed();
  if (face == null || !solid) return null;
  // --- D36. The face's middle and normal walk the whole mesh, so they are read once per solid and face, not per drag move.
  let seat = seatMemo?.solid === solid && seatMemo.face === face ? seatMemo : null;
  if (!seat) {
    const stored = solid.faces.find((item) => item.id === face)?.normal;
    seat = { solid, face, outward: stored ?? outwardFromMesh(solid.positions, solid.triangles, face), centre: faceCentre(solid.positions, solid.triangles, face) };
    seatMemo = seat;
  }
  const { outward, centre } = seat;
  if (!outward || !centre) return null;
  const inward = holeAxis(outward);
  const pose = openPose();
  return isIdentity(pose) ? { point: centre, inward } : { point: applyPose(pose, centre), inward: turnDir(pose, inward) };
}

/** Each shown face as the shell matcher wants it: its reply area, and the mesh's area-weighted middle. */
export function faceRows(solid: ParsedSolid): { id: number; areaMm2: number; mid: Vec3 }[] {
  return solid.faces.map((face) => ({
    id: face.id,
    areaMm2: face.areaMm2,
    mid: faceCentre(solid.positions, solid.triangles, face.id) ?? [Number.NaN, Number.NaN, Number.NaN],
  }));
}

export function num(id: string) {
  return fieldNumber(id.slice(1));
}

export function stlName(name: string) {
  const stem = name.replace(/\.(step|stp|stl|3mf)$/i, "");
  return `${stem || "solid"}.stl`;
}
