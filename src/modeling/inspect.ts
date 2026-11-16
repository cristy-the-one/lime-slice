/**
 * Looking at a solid without rendering it: where a ray lands, what a probe would change, and
 * what a print would trip over. All of it reads the tessellated mesh in the part frame, whose
 * chord tolerance is 0.05 mm, so a number here is that close and no closer.
 */
import { shellCount, shellGroups, takeGroups } from "../mesh-shells.ts";
import { eulerOrient } from "../mesh-place.ts";
import { primitiveMesh, turnCentre, type PrimitiveSpec } from "../model-primitive.ts";
import { applyPose, boxUnder, type Affine } from "../model-space.ts";

type Vec = [number, number, number];
export interface Box {
  min: Vec;
  max: Vec;
}

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const roundVec = (v: readonly number[]): Vec => [round(v[0]!), round(v[1]!), round(v[2]!)];

export function boxOf(pos: ArrayLike<number>): Box {
  const min: Vec = [Infinity, Infinity, Infinity];
  const max: Vec = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < pos.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = pos[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

/** The tool shape of a boolean op as a triangle soup in the solid's frame: turned about its centre, then placed. */
export function toolMesh(spec: PrimitiveSpec): Float32Array {
  const local = primitiveMesh(spec);
  const centre = turnCentre(spec);
  const rot = eulerOrient(spec.turn[0], spec.turn[1], spec.turn[2]);
  const out = new Float32Array(local.length);
  for (let i = 0; i + 2 < local.length; i += 3) {
    const dx = local[i]! - centre[0];
    const dy = local[i + 1]! - centre[1];
    const dz = local[i + 2]! - centre[2];
    out[i] = spec.origin[0] + centre[0] + rot[0] * dx + rot[1] * dy + rot[2] * dz;
    out[i + 1] = spec.origin[1] + centre[1] + rot[3] * dx + rot[4] * dy + rot[5] * dz;
    out[i + 2] = spec.origin[2] + centre[2] + rot[6] * dx + rot[7] * dy + rot[8] * dz;
  }
  return out;
}

export interface Hit {
  triangle: number;
  distanceMm: number;
  point: Vec;
  normal: Vec;
  /** The ray starts inside the solid: it met a face from behind. */
  fromInside: boolean;
}

/** The first triangle a ray meets, Möller–Trumbore. `direction` need not be a unit vector. */
export function firstHit(pos: Float32Array, origin: Vec, direction: Vec): Hit | null {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) return null;
  const d: Vec = [direction[0] / length, direction[1] / length, direction[2] / length];
  let best: Hit | null = null;
  for (let tri = 0; tri * 9 + 8 < pos.length; tri += 1) {
    const b = tri * 9;
    const e1: Vec = [pos[b + 3]! - pos[b]!, pos[b + 4]! - pos[b + 1]!, pos[b + 5]! - pos[b + 2]!];
    const e2: Vec = [pos[b + 6]! - pos[b]!, pos[b + 7]! - pos[b + 1]!, pos[b + 8]! - pos[b + 2]!];
    const p: Vec = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const s: Vec = [origin[0] - pos[b]!, origin[1] - pos[b + 1]!, origin[2] - pos[b + 2]!];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q: Vec = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (t < 0 || (best && t >= best.distanceMm)) continue;
    const n: Vec = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (!(nl > 0)) continue;
    const normal: Vec = [n[0] / nl, n[1] / nl, n[2] / nl];
    best = {
      triangle: tri,
      distanceMm: t,
      point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t],
      normal,
      fromInside: normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2] > 0,
    };
  }
  return best;
}

function vec3(value: unknown): Vec | null {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? value as Vec : null;
}

/** surface_at: the first hit of a ray, or of a straight-down ray at x, y. */
export function surfaceAt(
  solid: { positions: Float32Array; triangles: Uint32Array; bounds: Box },
  input: Record<string, unknown>,
): Record<string, unknown> {
  const point = vec3(input.point);
  const direction = input.direction === undefined ? null : vec3(input.direction);
  if (input.direction !== undefined && (!direction || !(Math.hypot(...direction) > 0))) return { ok: false, reason: "The direction needs three numbers that are not all zero." };
  let origin: Vec;
  let aim: Vec;
  if (point) {
    if (!direction) return { ok: false, reason: "A point needs a direction." };
    origin = point;
    aim = direction;
  } else if (typeof input.x === "number" && typeof input.y === "number") {
    // Straight down from just above the part, unless the caller aims it.
    origin = [input.x, input.y, solid.bounds.max[2] + 1];
    aim = direction ?? [0, 0, -1];
  } else {
    return { ok: false, reason: "Give a point and a direction, or x and y." };
  }
  const hit = firstHit(solid.positions, origin, aim);
  if (!hit) return { ok: true, hit: false, reason: "The ray misses the solid." };
  const face = solid.triangles.length * 9 === solid.positions.length ? solid.triangles[hit.triangle] : undefined;
  return {
    ok: true,
    hit: true,
    point: roundVec(hit.point),
    normal: roundVec(hit.normal),
    distanceMm: round(hit.distanceMm),
    ...(face !== undefined ? { faceIndex: face } : {}),
    ...(hit.fromInside ? { fromInside: true } : {}),
  };
}

export interface SolidMetrics {
  volumeMm3: number;
  bbox: Box;
  shellCount: number;
}

export function solidMetrics(solid: { positions: Float32Array; volumeMm3: number }): SolidMetrics {
  return { volumeMm3: solid.volumeMm3, bbox: boxOf(solid.positions), shellCount: shellCount(solid.positions) };
}

const shown = (m: SolidMetrics) => ({
  volumeMm3: round(m.volumeMm3, 2),
  bbox: { min: roundVec(m.bbox.min), max: roundVec(m.bbox.max) },
  shellCount: m.shellCount,
});

/**
 * What a probe tells beside "it fits". `after` is null when the engine sent no mesh for the edit, and then
 * only `before` is real: the result names what is missing instead of guessing it.
 */
export function probeMetrics(before: SolidMetrics, after: SolidMetrics | null): { metrics: Record<string, unknown>; warning?: string } {
  if (!after) {
    return {
      metrics: {
        before: shown(before),
        unavailable: ["volumeAfter", "bboxAfter", "shellCountAfter", "delta"],
        note: "The modeler sent no mesh for this edit, so only the solid before it is measured.",
      },
    };
  }
  const delta = {
    volumeMm3: round(after.volumeMm3 - before.volumeMm3, 2),
    bboxMin: roundVec(after.bbox.min.map((v, i) => v - before.bbox.min[i]!)),
    bboxMax: roundVec(after.bbox.max.map((v, i) => v - before.bbox.max[i]!)),
    shellCount: after.shellCount - before.shellCount,
  };
  const warning = after.shellCount > before.shellCount ? `This leaves ${after.shellCount} separate pieces.` : undefined;
  return { metrics: { before: shown(before), after: shown(after), delta }, ...(warning ? { warning } : {}) };
}

/**
 * A belt printer, as the check reads it. The engine slices a belt along `s = −y·sin α + z·cos α` in the plate frame
 * (`mirror_rotate_x` in crates/lime-slice-core/src/belt.rs, `buildDirection` in src/belt.ts): the belt carries the part
 * toward +Y, its +Y end prints first, and each new layer is laid toward −Y and up. The belt itself is the plate's Z = 0.
 */
export interface CheckBelt {
  angleDeg: number;
  widthMm: number;
  maxLengthMm?: number | null;
}

export interface CheckInput {
  positions: Float32Array;
  overhangDeg: number;
  buildMm: Vec;
  /** A belt printer: overhangs and ceilings are read against its build direction, the fit against its width. */
  belt?: CheckBelt | null;
  /** The B-rep face of each triangle (`solid.triangles`), when the mesh is a solid's: each overhang names its faces. */
  faceOf?: ArrayLike<number> | null;
}

const BED_EPS = 0.02;
/** On a belt a face square to the belt sits at exactly the belt's angle; it is not past a threshold of that angle. */
const BELT_EPS = 1e-6;
/** The most faces an overhang or a ceiling names, the largest first. */
const MAX_FACES = 12;

/** Overhang triangles gathered in one 10 mm grid cell. `at` is the cell's place in the grid. */
interface OverhangCell {
  at: Vec;
  area: number;
  sum: Vec;
  min: Vec;
  max: Vec;
  /** Area by B-rep face, when the mesh names its faces. */
  faces?: Map<number, number>;
}

function addFace(into: Map<number, number>, face: number, area: number) {
  into.set(face, (into.get(face) ?? 0) + area);
}

/** The faces of a region, the largest first, as the Model tools take them (face indexes). */
function faceList(faces: ReadonlyMap<number, number>): number[] {
  return [...faces.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_FACES).map(([face]) => face);
}

/** A belt's build direction as a sentence, in the plate's frame. */
export function beltBuildSentence(angleDeg: number): string {
  const angle = round(angleDeg, 1);
  return `Layers stack at ${angle}° to the belt: the belt carries the part toward the plate's +Y, so the +Y end prints first and each new layer is laid toward −Y and up. Overhangs and down faces are read against that direction, not straight up; contact and floating pieces are read against the belt.`;
}

function touch(a: OverhangCell, b: OverhangCell): boolean {
  return [0, 1, 2].every((axis) => a.min[axis]! <= b.max[axis]! + BED_EPS && b.min[axis]! <= a.max[axis]! + BED_EPS);
}

/**
 * One overhang that spans several grid cells is one region: neighbouring cells whose triangles meet are merged.
 * Each cell is joined only to the 26 around it, so this is linear in the cells.
 */
function mergedCells(cells: ReadonlyMap<string, OverhangCell>): OverhangCell[] {
  const parent = new Map<OverhangCell, OverhangCell>();
  const find = (cell: OverhangCell): OverhangCell => {
    let root = cell;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(cell, root);
    return root;
  };
  for (const cell of cells.values()) parent.set(cell, cell);
  for (const cell of cells.values()) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const other = cells.get(`${cell.at[0] + dx},${cell.at[1] + dy},${cell.at[2] + dz}`);
          if (!other || other === cell || !touch(cell, other)) continue;
          const a = find(cell);
          const b = find(other);
          if (a !== b) parent.set(b, a);
        }
      }
    }
  }
  const merged = new Map<OverhangCell, OverhangCell>();
  for (const cell of cells.values()) {
    const root = find(cell);
    const into = merged.get(root) ?? { at: root.at, area: 0, sum: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], ...(cell.faces ? { faces: new Map<number, number>() } : {}) };
    into.area += cell.area;
    if (cell.faces && into.faces) for (const [face, area] of cell.faces) addFace(into.faces, face, area);
    for (let axis = 0; axis < 3; axis += 1) {
      into.sum[axis]! += cell.sum[axis]!;
      into.min[axis] = Math.min(into.min[axis]!, cell.min[axis]!);
      into.max[axis] = Math.max(into.max[axis]!, cell.max[axis]!);
    }
    merged.set(root, into);
  }
  return [...merged.values()];
}

/**
 * `printCheck` of the part in its print frame (`printFrame`), with each place mapped back into the solid's frame
 * through `toSource`, where the caller aims an edit. A height (`zMm`, `floatsMm`) and the fit stay as printed.
 */
export function checkInSource(checked: Record<string, unknown>, toSource: Affine): Record<string, unknown> {
  const back = (point: readonly number[]) => roundVec(applyPose(toSource, point));
  const backBox = (box: { min: readonly number[]; max: readonly number[] }) => {
    const mapped = boxUnder({ min: [box.min[0]!, box.min[1]!, box.min[2]!], max: [box.max[0]!, box.max[1]!, box.max[2]!] }, toSource);
    return { min: roundVec(mapped.min), max: roundVec(mapped.max) };
  };
  const overhang = checked.overhang as { regions: { centre: Vec; min: Vec; max: Vec }[] };
  const ceilings = checked.ceilings as { centre: Vec }[];
  const islands = checked.islands as { bbox: { min: Vec; max: Vec } }[];
  // A belt's build direction, a direction and not a place: the turn of `toSource` without its move, at unit length.
  const build = checked.build as { direction: Vec } | undefined;
  const turned = build ? (() => {
    const zero = applyPose(toSource, [0, 0, 0]);
    const tip = applyPose(toSource, build.direction);
    const along = [tip[0]! - zero[0]!, tip[1]! - zero[1]!, tip[2]! - zero[2]!];
    const length = Math.hypot(along[0]!, along[1]!, along[2]!) || 1;
    return { ...build, direction: roundVec(along.map((value) => value / length + 0)) };
  })() : undefined;
  return {
    ...checked,
    overhang: { ...overhang, regions: overhang.regions.map((region) => ({ ...region, centre: back(region.centre), ...backBox(region) })) },
    ceilings: ceilings.map((row) => ({ ...row, centre: back(row.centre) })),
    islands: islands.map((island) => ({ ...island, bbox: backBox(island.bbox) })),
    ...(turned ? { build: turned } : {}),
  };
}

/**
 * model_check: the printability of the solid as it stands, lowest point on the bed. On a belt (`input.belt`) the
 * lowest point is on the belt; overhangs and down faces are read against the belt's build direction, and the fit
 * against the belt's width and the printer's height, since a belt does not limit the length along it.
 */
export function printCheck(input: CheckInput): Record<string, unknown> {
  const { positions: pos, overhangDeg, buildMm } = input;
  const belt = input.belt ?? null;
  const faceOf = input.faceOf && input.faceOf.length * 9 === pos.length ? input.faceOf : null;
  const box = boxOf(pos);
  const floor = box.min[2];
  const sine = Math.sin((overhangDeg * Math.PI) / 180);
  // The direction each new layer is laid in: straight up on a bed, (0, −sin α, cos α) on a belt.
  const angle = belt ? (Math.min(80, Math.max(10, belt.angleDeg)) * Math.PI) / 180 : 0;
  const build: Vec = belt ? [0, -Math.sin(angle), Math.cos(angle)] : [0, 0, 1];
  // On a belt, how far along the build direction the first layer is: a down face is named by its distance from it.
  let first = Infinity;
  if (belt) for (let i = 0; i + 2 < pos.length; i += 3) first = Math.min(first, pos[i + 1]! * build[1] + pos[i + 2]! * build[2]);
  const cell = 10;
  const cells = new Map<string, OverhangCell>();
  const levels = new Map<number, { area: number; sum: Vec; faces?: Map<number, number> }>();
  let total = 0;
  let overhang = 0;
  let bed = 0;
  for (let tri = 0; tri * 9 + 8 < pos.length; tri += 1) {
    const b = tri * 9;
    const e1: Vec = [pos[b + 3]! - pos[b]!, pos[b + 4]! - pos[b + 1]!, pos[b + 5]! - pos[b + 2]!];
    const e2: Vec = [pos[b + 6]! - pos[b]!, pos[b + 7]! - pos[b + 1]!, pos[b + 8]! - pos[b + 2]!];
    const n: Vec = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const twice = Math.hypot(n[0], n[1], n[2]);
    if (!(twice > 0)) continue;
    const area = twice / 2;
    const nz = n[2] / twice;
    // The normal along the build direction: nz on a bed, exactly as before.
    const along = belt ? (n[1] * build[1] + n[2] * build[2]) / twice : nz;
    total += area;
    const z0 = pos[b + 2]!;
    const z1 = pos[b + 5]!;
    const z2 = pos[b + 8]!;
    const centre: Vec = [
      (pos[b]! + pos[b + 3]! + pos[b + 6]!) / 3,
      (pos[b + 1]! + pos[b + 4]! + pos[b + 7]!) / 3,
      (z0 + z1 + z2) / 3,
    ];
    const onBed = Math.max(z0, z1, z2) <= floor + BED_EPS;
    if (onBed && nz < -0.9) {
      bed += area;
      continue;
    }
    if (belt ? -along <= sine + BELT_EPS : -along <= sine) continue;
    overhang += area;
    const face = faceOf ? faceOf[tri] : undefined;
    // A face flat to the layers and pointing back against them is a ceiling, listed by where it is below; it is not a
    // slanted overhang too. On a bed that is its height; on a belt its distance from the first layer.
    if (along < -0.99) {
      const level = belt ? round(centre[1] * build[1] + centre[2] * build[2] - first, 1) : round(centre[2], 1);
      const row = levels.get(level) ?? { area: 0, sum: [0, 0, 0], ...(faceOf ? { faces: new Map<number, number>() } : {}) };
      row.area += area;
      row.sum[0]! += centre[0] * area;
      row.sum[1]! += centre[1] * area;
      row.sum[2]! += centre[2] * area;
      if (row.faces && face !== undefined) addFace(row.faces, face, area);
      levels.set(level, row);
      continue;
    }
    const at: Vec = [Math.floor(centre[0] / cell), Math.floor(centre[1] / cell), Math.floor(centre[2] / cell)];
    const key = at.join(",");
    const slot = cells.get(key) ?? { at, area: 0, sum: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], ...(faceOf ? { faces: new Map<number, number>() } : {}) };
    slot.area += area;
    if (slot.faces && face !== undefined) addFace(slot.faces, face, area);
    for (let axis = 0; axis < 3; axis += 1) {
      slot.sum[axis]! += centre[axis]! * area;
      slot.min[axis] = Math.min(slot.min[axis]!, pos[b + axis]!, pos[b + 3 + axis]!, pos[b + 6 + axis]!);
      slot.max[axis] = Math.max(slot.max[axis]!, pos[b + axis]!, pos[b + 3 + axis]!, pos[b + 6 + axis]!);
    }
    cells.set(key, slot);
  }
  const regions = mergedCells(cells)
    .sort((a, b) => b.area - a.area)
    .slice(0, 6)
    .map((slot) => ({
      areaMm2: round(slot.area, 1),
      centre: roundVec([slot.sum[0]! / slot.area, slot.sum[1]! / slot.area, slot.sum[2]! / slot.area]),
      min: roundVec(slot.min),
      max: roundVec(slot.max),
      ...(slot.faces ? { faces: faceList(slot.faces) } : {}),
    }));
  const ceilings = [...levels.entries()]
    .filter(([, row]) => row.area >= 1)
    .sort((a, b) => b[1].area - a[1].area)
    .slice(0, 6)
    .map(([level, row]) => {
      const faces = row.faces ? { faces: faceList(row.faces) } : {};
      if (!belt) return { zMm: level, areaMm2: round(row.area, 1), centre: roundVec([row.sum[0]! / row.area, row.sum[1]! / row.area, level]), ...faces };
      const centre = roundVec([row.sum[0]! / row.area, row.sum[1]! / row.area, row.sum[2]! / row.area]);
      return { zMm: round(centre[2], 1), layerMm: level, areaMm2: round(row.area, 1), centre, ...faces };
    });
  const groups = shellGroups(pos);
  const islands: { bbox: { min: Vec; max: Vec }; floatsMm: number }[] = [];
  if (groups) {
    for (const part of takeGroups(pos, groups.groups)) {
      const shell = boxOf(part);
      if (shell.min[2] > floor + BED_EPS) islands.push({ bbox: { min: roundVec(shell.min), max: roundVec(shell.max) }, floatsMm: round(shell.min[2] - floor) });
    }
  }
  const size: Vec = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const warnings: string[] = [];
  if (belt) {
    // Across the belt and its height; along the belt nothing is limited here.
    const limits: [number, null, number] = [belt.widthMm, null, buildMm[2]];
    const over = (["x", "z"] as const).filter((axis) => size[axis === "x" ? 0 : 2]! > limits[axis === "x" ? 0 : 2]! + 1e-6);
    if (over.includes("x")) warnings.push(`The part is wider than the belt: ${round(size[0], 2)} mm across it (X) against ${round(belt.widthMm, 2)} mm.`);
    if (over.includes("z")) warnings.push(`The part is taller than the printer's build height: ${round(size[2], 2)} mm above the belt (Z) against ${round(buildMm[2], 2)} mm.`);
    if (islands.length > 0) warnings.push(`${islands.length === 1 ? "One piece does" : `${islands.length} pieces do`} not touch the belt and would print in the air.`);
    if (ceilings.length > 0) warnings.push(`Faces flat to the layers point back against the build direction at ${ceilings.map((row) => (row as { layerMm?: number }).layerMm).join(", ")} mm from the first layer; they need support or a bridge.`);
    if (overhang > 0 && total > 0) warnings.push(`${round(overhang, 1)} mm² overhangs more than ${overhangDeg}° from the belt's build direction.`);
    if (!(bed > 0)) warnings.push("Nothing flat rests on the belt.");
    const cap = belt.maxLengthMm ?? null;
    const lengthNote = `On a belt the length along it (Y) has no limit in this check; it checks the width across the belt (X, ${round(belt.widthMm, 2)} mm) and the height above it (Z, the printer's ${round(buildMm[2], 2)} mm).${cap != null ? ` The belt's max length of ${round(cap, 2)} mm is checked when it slices.` : ""}`;
    return {
      ok: true,
      overhang: { thresholdDeg: overhangDeg, areaMm2: round(overhang, 1), share: total > 0 ? round(overhang / total, 3) : 0, regions },
      ceilings,
      bedContact: { areaMm2: round(bed, 1) },
      islands,
      fit: { sizeMm: roundVec(size), buildVolumeMm: limits, fits: over.length === 0, over, note: lengthNote },
      warnings,
      notChecked: ["thin walls"],
      build: { belt: true, angleDeg: round(belt.angleDeg, 1), direction: roundVec(build.map((value) => value + 0)), text: beltBuildSentence(belt.angleDeg) },
    };
  }
  const over = (["x", "y", "z"] as const).filter((_, axis) => size[axis]! > buildMm[axis]! + 1e-6);
  if (over.length > 0) warnings.push(`The part is larger than the build volume along ${over.join(" and ").toUpperCase()}.`);
  if (islands.length > 0) warnings.push(`${islands.length === 1 ? "One piece does" : `${islands.length} pieces do`} not touch the bed and would print in the air.`);
  if (ceilings.length > 0) warnings.push(`Flat faces point down above the bed at Z ${ceilings.map((row) => row.zMm).join(", ")}; they need support or a bridge.`);
  if (overhang > 0 && total > 0) warnings.push(`${round(overhang, 1)} mm² overhangs more than ${overhangDeg}°.`);
  if (!(bed > 0)) warnings.push("Nothing flat rests on the bed.");
  return {
    ok: true,
    overhang: { thresholdDeg: overhangDeg, areaMm2: round(overhang, 1), share: total > 0 ? round(overhang / total, 3) : 0, regions },
    ceilings,
    bedContact: { areaMm2: round(bed, 1) },
    islands,
    fit: { sizeMm: roundVec(size), buildVolumeMm: buildMm, fits: over.length === 0, over },
    warnings,
    notChecked: ["thin walls"],
  };
}
