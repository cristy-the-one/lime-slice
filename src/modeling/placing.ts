/**
 * Where a part stands, as a recipe's model_place and object_place set it (docs/plan-recipe-plugins.md D16): its own
 * pose in model space, and its place on the plate. The MCP session and the app's recipe calls both run these, so a
 * plugin that moves the part it made moves it the same way in either.
 */
import { hullOf, layFlatMatrix, restPose } from "../bed-rest.ts";
import { align, centeringShift, eulerOrient, matMul, orientEuler, placeMesh, rotX, rotY, rotZ, type Bounds, type Mat3 } from "../mesh-place.ts";
import { posedBounds, type Affine, type ObjectFrame } from "../model-space.ts";
import { alignDelta, bedBox, isAlignRelation } from "../place-snap.ts";
import { evaluate } from "./expr.ts";
import { isPlainNumber } from "./params.ts";

/** The sentence for an object id that is not on the plate. */
export const UNKNOWN_OBJECT = "That object is not on the plate. Call plate_list for the current handles.";

/** The sentence a reply ends on: which frame later typed numbers are read in. */
export function frameNote(frame: ObjectFrame): string {
  return frame === "part"
    ? "Numbers in later model_probe, model_apply and model_edit calls are still read in the part's own frame, where model_describe, faces_find, edges_find and surface_at answer."
    : "Numbers in later model_probe, model_apply and model_edit calls are read in model space, so they move with the pose, and model_describe, faces_find, edges_find and surface_at answer there too; frame:\"part\" keeps both in the part's own frame.";
}

/**
 * What a refusal of a part away from model space's origin adds: the frame its numbers were read in, which is also the
 * frame every read answers in, and the pose that moved it. Empty for a part with no pose. It no longer says "sits at":
 * reads and cuts share one frame, so there is no offset for a caller to add.
 */
export function frameWhere(modelPose: Affine | undefined, frame: ObjectFrame | undefined): string {
  if (!modelPose || (modelPose.t.every((v) => v === 0) && modelPose.m.every((v, i) => v === (i % 4 === 0 ? 1 : 0)))) return "";
  const mm = (v: number) => Math.round(v * 100) / 100 + 0;
  const turn = orientEuler(modelPose.m as Mat3);
  const moved = modelPose.t.some((v) => v !== 0) ? `moved by (${modelPose.t.map(mm).join(", ")})` : "";
  const turned = [turn.rx, turn.ry, turn.rz].some((deg) => Math.abs(deg) > 1e-6) ? `turned (${[turn.rx, turn.ry, turn.rz].map(mm).join("°, ")}°)` : "";
  const pose = [moved, turned].filter(Boolean).join(" and ");
  return frame === "part"
    ? ` Numbers are read in the part's own frame, where model_describe, faces_find and surface_at answer too; in the assembly the part is ${pose}.`
    : ` Numbers are read in model space, where model_describe, faces_find and surface_at answer too; model_place has the part ${pose} there. model_place {frame:"part"} reads them in the part's own frame.`;
}

/** Three numbers as typed, each a number or an expression; absent ones keep `values`, and `texts` their expressions. */
export type PlaceTexts = [string | null, string | null, string | null];

/**
 * Three of model_place's numbers, each a number or an expression over the project's parameters. An absent one keeps
 * `values` and its text in `texts`; a number drops the text. `texts` is undefined when no number has one.
 */
export function placeNumbers(input: Record<string, unknown>, keys: [string, string, string], values: [number, number, number], params: Record<string, number>, texts?: PlaceTexts): { values: [number, number, number]; texts?: PlaceTexts } | { reason: string } {
  const out: [number, number, number] = [...values];
  const kept: PlaceTexts = texts ? [...texts] : [null, null, null];
  for (let axis = 0; axis < 3; axis += 1) {
    const raw = input[keys[axis]!];
    if (raw === undefined) continue;
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return { reason: `${keys[axis]} is a number or an expression.` };
      out[axis] = raw;
      kept[axis] = null;
      continue;
    }
    if (typeof raw !== "string" || !raw.trim()) return { reason: `${keys[axis]} is a number or an expression.` };
    try {
      out[axis] = evaluate(raw, params);
    } catch (err) {
      return { reason: `${keys[axis]}: ${err instanceof Error ? err.message : String(err)}` };
    }
    kept[axis] = isPlainNumber(raw) ? null : raw.trim();
  }
  return { values: out, ...(kept.some((text) => text !== null) ? { texts: kept } : {}) };
}

/** A part's own pose and the frame its numbers are typed in. */
export interface FreePose {
  modelPose: Affine;
  frame?: ObjectFrame;
}

/**
 * model_place for a part outside every assembly: its pose in model space from x, y, z and turnX, turnY, turnZ, over the
 * pose it has. Returns the new pose and frame, and what the reply says of them (without an assembly's fields).
 */
export function placeFree(part: FreePose, input: Record<string, unknown>, params: Record<string, number>): { pose: FreePose; texts: boolean; reply: Record<string, unknown> } | { reason: string } {
  const current = orientEuler(part.modelPose.m as Mat3);
  const where = placeNumbers(input, ["x", "y", "z"], [...part.modelPose.t] as [number, number, number], params);
  if ("reason" in where) return where;
  const turned = placeNumbers(input, ["turnX", "turnY", "turnZ"], [current.rx, current.ry, current.rz], params);
  if ("reason" in turned) return turned;
  const frame: ObjectFrame = input.frame === "part" || input.frame === "model" ? input.frame : part.frame ?? "model";
  const modelPose: Affine = { m: eulerOrient(turned.values[0], turned.values[1], turned.values[2]), t: where.values };
  const turn = orientEuler(modelPose.m as Mat3);
  return {
    pose: { modelPose, ...(frame === "part" ? { frame } : {}) },
    texts: !!(where.texts || turned.texts),
    reply: { ok: true, pose: "assembled", x: modelPose.t[0], y: modelPose.t[1], z: modelPose.t[2], turnX: turn.rx, turnY: turn.ry, turnZ: turn.rz, frame },
  };
}

/** The part's box in model space: its solid under its pose, to 0.01 mm. */
export function assembledBox(positions: Float32Array | null | undefined, pose: Affine): { min: number[]; max: number[] } | null {
  const box = positions && positions.length >= 9 ? posedBounds(positions, pose) : null;
  if (!box) return null;
  const mm = (value: number) => Math.round(value * 100) / 100 + 0;
  return { min: box.min.map(mm), max: box.max.map(mm) };
}

/** A part's place on the plate: the mesh it is placed from, its turn and scale, and where it stands. */
export interface PlatePlace {
  source: Float32Array;
  orient: Mat3;
  scale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
}

/** What object_place reads besides the part: the bed, the part's flat faces, and another part's placed box. */
export interface PlateEnv {
  bedMm: [number, number, number];
  faces?: readonly { normal?: readonly number[] | null }[];
  /** Another object's placed box, or null when there is none. */
  boundsOf(id: string): Bounds | null;
}

/** The part's placed mesh box. */
export function placedBounds(place: PlatePlace, bedMm: [number, number, number]): Bounds {
  return placeMesh(place.source, place.orient, place.scale, bedMm[0], bedMm[1], place.centered, place.offset).bounds;
}

/**
 * object_place: the part's turn, scale and place on the plate, changed in `place` as the call asks. The reply, or a
 * sentence (the place may then be part-changed, as the session's was).
 */
export function placeOnPlate(place: PlatePlace, input: Record<string, unknown>, env: PlateEnv): Record<string, unknown> {
  const [bedX, bedY, bedZ] = env.bedMm;
  let reslice = false;
  if (typeof input.scalePercent === "number") {
    place.scale = input.scalePercent / 100;
    reslice = true;
  }
  if (input.layFlat === true) {
    place.orient = layFlatMatrix(place.source, place.orient, place.scale);
    reslice = true;
  }
  const turn = input.turn as { axis?: string; degrees?: number } | undefined;
  if (turn && typeof turn.degrees === "number") {
    const rot = turn.axis === "x" ? rotX(turn.degrees) : turn.axis === "y" ? rotY(turn.degrees) : rotZ(turn.degrees);
    place.orient = matMul(rot, place.orient);
    reslice = true;
  }
  if (input.centreOnBed === true) {
    place.centered = true;
    place.offset = { x: 0, y: 0, z: 0 };
  }
  if (typeof input.rotX === "number" || typeof input.rotY === "number" || typeof input.rotZ === "number") {
    const current = orientEuler(place.orient);
    place.orient = eulerOrient(typeof input.rotX === "number" ? input.rotX : current.rx, typeof input.rotY === "number" ? input.rotY : current.ry, typeof input.rotZ === "number" ? input.rotZ : current.rz);
    reslice = true;
  }
  if (typeof input.faceDown === "number") {
    const face = env.faces?.[input.faceDown];
    if (!face?.normal) return { ok: false, reason: "That face is not a flat face on this solid." };
    place.orient = align(face.normal as [number, number, number], [0, 0, -1]);
    reslice = true;
  }
  let rest: Record<string, unknown> = {};
  if (input.settle === true) {
    const hull = hullOf(place.source);
    if (hull) {
      const found = restPose(hull, place.orient, place.scale);
      place.orient = found.orient;
      rest = { settled: found.snapped, contactMm2: Math.round(found.areaMm2 * 10) / 10 };
    } else {
      rest = { settled: false, contactMm2: 0 };
    }
    const turned = orientEuler(place.orient);
    rest.rotationDeg = { x: Math.round(turned.rx * 100) / 100, y: Math.round(turned.ry * 100) / 100, z: Math.round(turned.rz * 100) / 100 };
    reslice = true;
  }
  const uncentre = () => {
    if (!place.centered) return;
    place.offset = centeringShift(place.source, place.orient, place.scale, bedX, bedY);
    place.centered = false;
  };
  if (typeof input.z === "number") {
    uncentre();
    place.offset = { ...place.offset, z: input.z };
  }
  if (typeof input.centreX === "number" || typeof input.centreY === "number") {
    const current = placedBounds(place, env.bedMm);
    const cx = (current.min[0] + current.max[0]) / 2;
    const cy = (current.min[1] + current.max[1]) / 2;
    uncentre();
    const dx = typeof input.centreX === "number" ? input.centreX - cx : 0;
    const dy = typeof input.centreY === "number" ? input.centreY - cy : 0;
    place.offset = { x: place.offset.x + dx, y: place.offset.y + dy, z: place.offset.z };
  }
  const alignSpec = input.align as { to?: unknown; how?: unknown } | undefined;
  if (alignSpec) {
    if (!isAlignRelation(alignSpec.how)) return { ok: false, reason: "align.how is not a relation." };
    const toBed = alignSpec.to === "bed";
    const other = toBed ? null : env.boundsOf(String(alignSpec.to));
    if (!toBed && !other) return { ok: false, reason: UNKNOWN_OBJECT };
    const box = other ?? bedBox(bedX, bedY, bedZ);
    const delta = alignDelta(placedBounds(place, env.bedMm), box, alignSpec.how, toBed);
    if (!delta) return { ok: false, reason: "The bed has no side to touch or stack on. Use flush or centre." };
    uncentre();
    place.offset = { x: place.offset.x + delta[0], y: place.offset.y + delta[1], z: place.offset.z + delta[2] };
  }
  const placed = placedBounds(place, env.bedMm);
  return {
    ok: true,
    centreMm: [(placed.min[0] + placed.max[0]) / 2, (placed.min[1] + placed.max[1]) / 2, (placed.min[2] + placed.max[2]) / 2],
    scalePercent: place.scale * 100,
    orient: [...place.orient],
    ...rest,
    reslice,
    label: "Place",
  };
}
