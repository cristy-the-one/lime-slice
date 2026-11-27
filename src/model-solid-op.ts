/**
 * A tool op between model space and the open solid's own frame (`toSolidOp`, `fromSolidOp`), and where a primitive
 * turns. Apart from src/model-space.ts so the first chunk, which needs poses, does not carry the part tables.
 */
import { eulerOrient, matMul, orientEuler, type Mat3 } from "./mesh-place.ts";
import { partCentreZ } from "./model-part.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import { applyPose, inversePose, isIdentity, moveOnly, poseScale, turnDir, type Affine } from "./model-space.ts";
import type { Curve3D, LoftBoundary, ModelOp, SheetSpec, Vec3 } from "./model-tree.ts";
import { framePose, isIdentityFrame, type Workplane } from "./workplane.ts";

/**
 * A tool's op, typed in model space, in the open solid's own frame: what the engine builds and the tree stores.
 * A primitive turns about its centre (`turnCentre`), so that centre goes through the pose and the turn takes the pose's
 * turn. Identity returns `op` itself, so every file without a pose sends exactly the numbers typed.
 * The pose is rigid: only a Separate-shells piece of a scaled part carries a scale, and Model never opens one.
 */
export function toSolidOp(op: ModelOp, pose: Affine): ModelOp {
  if (isIdentity(pose)) return op;
  const back = inversePose(pose);
  const point = (p: Vec3) => applyPose(back, p);
  switch (op.kind) {
    case "boolean": {
      if (op.primitive === "sphere" || moveOnly(back)) return { ...op, origin: point(op.origin) };
      const half = turnCentre(op);
      const centre = point([op.origin[0] + half[0], op.origin[1] + half[1], op.origin[2] + half[2]]);
      const s = poseScale(back);
      const turned = orientEuler(matMul(back.m.map((value) => value / s) as Mat3, eulerOrient(op.turn[0], op.turn[1], op.turn[2])));
      return { ...op, origin: [centre[0] - half[0], centre[1] - half[1], centre[2] - half[2]], turn: [turned.rx, turned.ry, turned.rz] };
    }
    case "hole":
      return { ...op, origin: point(op.origin), axis: turnDir(back, op.axis) };
    case "split":
      return { ...op, origin: point(op.origin), normal: turnDir(back, op.normal) };
    // --- Split to print: each cut's plane as a split's, and its U turned with it. ---
    case "partition":
      return { ...op, cuts: op.cuts.map((cut) => ({ ...cut, origin: point(cut.origin), normal: turnDir(back, cut.normal), ...(cut.u ? { u: turnDir(back, cut.u) } : {}) })) };
    case "extrude":
    case "revolve":
    // --- Text with real fonts: the plane is a frame, as a profile's is.
    case "lettering": {
      // The profile's plane is a frame: its origin goes through the pose and its turn takes the pose's turn.
      if (moveOnly(back)) return { ...op, origin: point(op.origin) };
      const s = poseScale(back);
      const turned = orientEuler(matMul(back.m.map((value) => value / s) as Mat3, eulerOrient(op.turn[0], op.turn[1], op.turn[2])));
      return { ...op, origin: point(op.origin), turn: [turned.rx, turned.ry, turned.rz] };
    }
    case "loft": {
      const s = poseScale(back);
      const turn = back.m.map((value) => value / s) as Mat3;
      const moveOnlyPose = moveOnly(back);
      const moveBoundary = (cond: LoftBoundary | undefined): LoftBoundary | undefined => {
        if (!cond || moveOnlyPose) return cond;
        if (cond.kind === "tangent") return { ...cond, dir: turnDir(back, cond.dir) };
        if (cond.kind === "curvature" && cond.dir) return { ...cond, dir: turnDir(back, cond.dir) };
        return cond;
      };
      const sections = op.sections.map((section) => {
        if (section.apex) {
          const moved = point(section.apex);
          return { ...section, origin: moved, apex: moved };
        }
        if (moveOnlyPose) return { ...section, origin: point(section.origin) };
        const turned = orientEuler(matMul(turn, eulerOrient(section.turn[0], section.turn[1], section.turn[2])));
        return { ...section, origin: point(section.origin), turn: [turned.rx, turned.ry, turned.rz] as Vec3 };
      });
      const guides = op.guides?.map((g) => moveCurve3D(g, point));
      const startCondition = moveBoundary(op.startCondition);
      const endCondition = moveBoundary(op.endCondition);
      return {
        ...op,
        sections,
        ...(guides ? { guides } : {}),
        ...(startCondition ? { startCondition } : {}),
        ...(endCondition ? { endCondition } : {}),
      };
    }
    case "sweep": {
      const s = poseScale(back);
      const turn = back.m.map((value) => value / s) as Mat3;
      const moveOnlyPose = moveOnly(back);
      const sections = op.sections.map((section) => {
        if (moveOnlyPose) return { ...section, origin: point(section.origin) };
        const turned = orientEuler(matMul(turn, eulerOrient(section.turn[0], section.turn[1], section.turn[2])));
        return { ...section, origin: point(section.origin), turn: [turned.rx, turned.ry, turned.rz] as Vec3 };
      });
      const mode = op.mode
        ? op.mode.kind === "fixedBinormal"
          ? { kind: "fixedBinormal" as const, dir: turnDir(back, op.mode.dir) }
          : op.mode.kind === "auxSpine"
            ? { ...op.mode, spine: moveCurve3D(op.mode.spine, point) }
            : op.mode
        : undefined;
      return { ...op, sections, spine: moveCurve3D(op.spine, point), ...(mode ? { mode } : {}) };
    }
    // --- Print transitions: the build direction turns with the pose; edges are picked on the solid.
    case "transition":
      return { ...op, build: turnDir(back, op.build) };
    // --- A1 group: every step goes into the solid's frame, the same way it would alone. ---
    case "group":
      return { ...op, steps: op.steps.map((step) => toSolidOp(step, pose)) };
    case "draft": {
      const pull = turnDir(back, op.pull ?? [0, 0, 1]);
      const neutral = op.neutral;
      const turned = neutral !== undefined && typeof neutral === "object" && "origin" in neutral
        ? { origin: point(neutral.origin), normal: turnDir(back, neutral.normal) }
        : neutral;
      const plusZ = Math.abs(pull[0]) < 1e-9 && Math.abs(pull[1]) < 1e-9 && pull[2] > 0.999;
      return {
        kind: "draft",
        faces: op.faces,
        angleDeg: op.angleDeg,
        ...(plusZ ? {} : { pull }),
        ...(turned !== undefined ? { neutral: turned } : {}),
        ...(op.exprs ? { exprs: op.exprs } : {}),
      };
    }
    case "sheet":
      return { ...op, ...moveSheetSpec(op, back, point) };
    case "trimSplit":
      return { ...op, sheet: moveSheetSpec(op.sheet, back, point) };
    case "replaceFace":
      return { ...op, sheet: moveSheetSpec(op.sheet, back, point) };
    case "splitFace":
      return {
        ...op,
        curve: moveCurve3D(op.curve, point),
        ...(op.direction ? { direction: turnDir(back, op.direction) } : {}),
      };
    case "patch":
      return {
        ...op,
        boundaries: op.boundaries.map((bound) => ({ ...bound, ...(bound.curve ? { curve: moveCurve3D(bound.curve, point) } : {}) })),
        ...(op.guides ? { guides: op.guides.map((curve) => moveCurve3D(curve, point)) } : {}),
        ...(op.points ? { points: op.points.map((p) => point(p)) } : {}),
      };
    case "nurbsSurface":
      return { ...op, poles: op.poles.map((row) => row.map((pole) => point(pole))) };
    // --- S5: a blend's two sides may be typed curves, in model space as a patch's are.
    case "blendSurface":
      return {
        ...op,
        a: { ...op.a, ...(op.a.curve ? { curve: moveCurve3D(op.a.curve, point) } : {}) },
        b: { ...op.b, ...(op.b.curve ? { curve: moveCurve3D(op.b.curve, point) } : {}) },
      };
    default:
      return op;
  }
}

function moveSheetSpec(spec: SheetSpec, back: Affine, point: (p: Vec3) => Vec3): SheetSpec {
  return {
    ...spec,
    curves: spec.curves.map((c) => moveCurve3D(c, point)),
    ...(spec.dir ? { dir: turnDir(back, spec.dir) } : {}),
    ...(spec.axisOrigin ? { axisOrigin: point(spec.axisOrigin) } : {}),
  };
}

function moveCurve3D(curve: Curve3D, point: (p: Vec3) => Vec3): Curve3D {
  if (curve.kind === "polyline") return { ...curve, points: curve.points.map(point) };
  if (curve.kind === "spline") return { ...curve, through: curve.through.map(point) };
  if (curve.kind === "nurbs") return { ...curve, poles: curve.poles.map(point) };
  if (curve.kind === "segments") {
    return {
      kind: "segments",
      start: point(curve.start),
      segments: curve.segments.map((seg) => {
        if (seg.kind === "line") return { kind: "line", to: point(seg.to) };
        if (seg.kind === "arc") return { kind: "arc", through: point(seg.through), to: point(seg.to) };
        if (seg.kind === "nurbs") return { ...seg, ...(seg.poles ? { poles: seg.poles.map(point) } : {}), to: point(seg.to) };
        return { kind: "spline", through: seg.through.map(point), to: point(seg.to) };
      }),
    };
  }
  return curve;
}

/**
 * A stored op, in the solid's own frame, back in model space at the object's pose: what an edited step's panel opens
 * with, so `toSolidOp` of it at the same pose is the op again. Identity returns `op` itself.
 */
export function fromSolidOp(op: ModelOp, pose: Affine): ModelOp {
  return isIdentity(pose) ? op : toSolidOp(op, inversePose(pose));
}

/** Where the primitive turns, from its origin: a box's or a wedge's middle, a torus's, sphere's, or ellipsoid's centre, else halfway up its axis. */
export function turnCentre(spec: PrimitiveSpec): Vec3 {
  if (spec.primitive === "box" || spec.primitive === "wedge") return [spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2];
  if (spec.primitive === "torus" || spec.primitive === "sphere" || spec.primitive === "ellipsoid") return [0, 0, 0];
  if (spec.primitive === "part") return [0, 0, partCentreZ(spec)];
  return [0, 0, spec.height / 2];
}

/**
 * A primitive typed in the frame's U, V, W, in the frame's space. It turns about its own centre (`turnCentre`), so the
 * centre goes through the frame and the turn takes the frame's turn, as `toSolidOp` takes an op into a solid's frame.
 * An identity frame returns `spec` itself.
 */
export function planePrimitive(spec: PrimitiveSpec, plane: Workplane): PrimitiveSpec {
  if (isIdentityFrame(plane)) return spec;
  const placed = fromSolidOp({ kind: "boolean", op: "fuse", ...spec }, framePose(plane)) as Extract<ModelOp, { kind: "boolean" }>;
  return { ...spec, origin: placed.origin, turn: placed.turn };
}
