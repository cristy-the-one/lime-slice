/**
 * A chain links plate objects parent to child through their pivots. A child's pivot stays at a fixed offset in its
 * parent's pivot frame, and its turn stays fixed in that frame, so moving, turning or scaling the parent carries the
 * children. Inverse kinematics turns those joints so the end object's pivot reaches a point. Nothing here is a slice
 * input: the bed pose of each object is still its own orient, scale and offset.
 */
import { matMul, orientEuler, eulerOrient, rotAbout, type Mat3, type MeshShift } from "./mesh-place.ts";
import {
  add3,
  cross3,
  dot3,
  hypot3,
  matVec,
  offsetKeepingPoint,
  pivotOrCentre,
  scale3,
  sourceToBedPoint,
  sub3,
  transpose,
  centreOf,
  type Vec3,
} from "./pivot.ts";

/** Degrees from the joint's rest orientation. An axis left out is free. */
export interface JointLimits {
  x?: [number, number];
  y?: [number, number];
  z?: [number, number];
}

/** The child pivot in the parent's pivot frame, and the child's turn in that frame. */
export interface ChainLink {
  parent: string;
  offset: Vec3;
  turn: Mat3;
}

export interface ChainObject {
  id: string;
  name: string;
  sourcePos: Float32Array;
  orient: Mat3;
  partScale: number;
  centered: boolean;
  offset: MeshShift;
  pivot?: Vec3;
  chain?: ChainLink;
  jointLimits?: JointLimits;
}

export interface BedSize {
  x: number;
  y: number;
}

export function copyLink(link: ChainLink): ChainLink {
  return { parent: link.parent, offset: [...link.offset] as Vec3, turn: [...link.turn] as Mat3 };
}

export function copyLimits(limits: JointLimits): JointLimits {
  return {
    ...(limits.x ? { x: [...limits.x] as [number, number] } : {}),
    ...(limits.y ? { y: [...limits.y] as [number, number] } : {}),
    ...(limits.z ? { z: [...limits.z] as [number, number] } : {}),
  };
}

export function pivotOfObject(obj: ChainObject): Vec3 {
  return pivotOrCentre(obj.pivot, centreOf(obj.sourcePos));
}

export function pivotBed(obj: ChainObject, bed: BedSize): Vec3 {
  return sourceToBedPoint(obj.sourcePos, pivotOfObject(obj), obj.orient, obj.partScale, obj.centered, obj.offset, bed.x, bed.y);
}

function byId<T extends ChainObject>(objects: readonly T[], id: string): T | undefined {
  return objects.find((obj) => obj.id === id);
}

export function parentId(obj: ChainObject): string | null {
  return obj.chain?.parent ?? null;
}

/** Parents from the root down to `id`, or just `id` when it is free. A loop stops the walk. */
export function chainUp<T extends ChainObject>(objects: readonly T[], id: string): string[] {
  const ids = [id];
  let guard = 0;
  while (guard < objects.length) {
    guard += 1;
    const row = byId(objects, ids[0]!);
    const parent = row ? parentId(row) : null;
    if (!parent || ids.includes(parent) || !byId(objects, parent)) break;
    ids.unshift(parent);
  }
  return ids;
}

export function childrenOf<T extends ChainObject>(objects: readonly T[], id: string): string[] {
  return objects.filter((obj) => obj.chain?.parent === id).map((obj) => obj.id);
}

/** `id` and every object that sits on it, parents before children. */
export function descendants<T extends ChainObject>(objects: readonly T[], id: string): string[] {
  const out: string[] = [];
  const queue = childrenOf(objects, id);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (out.includes(next) || next === id) continue;
    out.push(next);
    queue.push(...childrenOf(objects, next));
  }
  return out;
}

/** Every object in the same chain as `id`, root first. */
export function componentIds<T extends ChainObject>(objects: readonly T[], id: string): string[] {
  const root = chainUp(objects, id)[0] ?? id;
  return [root, ...descendants(objects, root)];
}

export function isChainLeaf<T extends ChainObject>(objects: readonly T[], id: string): boolean {
  const row = byId(objects, id);
  return !!row?.chain && childrenOf(objects, id).length === 0;
}

/** Why `child` cannot sit on `parent`, or null when the link is legal. */
export function linkRefusal<T extends ChainObject>(objects: readonly T[], childId: string, parentId: string): string | null {
  if (childId === parentId) return "A part cannot link to itself.";
  if (!byId(objects, childId) || !byId(objects, parentId)) return "That part is not on the plate.";
  if (chainUp(objects, parentId).includes(childId)) return "That link would make a loop.";
  return null;
}

export function linkBetween<T extends ChainObject>(parent: T, child: T, bed: BedSize): ChainLink {
  const delta = sub3(pivotBed(child, bed), pivotBed(parent, bed));
  return {
    parent: parent.id,
    offset: matVec(transpose(parent.orient), delta),
    turn: matMul(transpose(parent.orient), child.orient),
  };
}

function placeAt<T extends ChainObject>(obj: T, orient: Mat3, partScale: number, world: Vec3, bed: BedSize): T {
  return {
    ...obj,
    orient,
    partScale,
    centered: false,
    offset: offsetKeepingPoint(obj.sourcePos, pivotOfObject(obj), orient, partScale, bed.x, bed.y, world),
  };
}

/** Write each linked child's pose from its parent. Objects that are not children are left as they are. */
export function solveDescendants<T extends ChainObject>(objects: readonly T[], movedId: string, bed: BedSize): T[] {
  const order = descendants(objects, movedId);
  if (order.length === 0) return objects as T[];
  const next = objects.map((obj) => obj);
  const index = new Map(next.map((obj, at) => [obj.id, at]));
  for (const id of order) {
    const child = next[index.get(id)!]!;
    const parent = child.chain ? next[index.get(child.chain.parent)!] : undefined;
    if (!child.chain || !parent) continue;
    const world = add3(pivotBed(parent, bed), matVec(parent.orient, child.chain.offset));
    const orient = matMul(parent.orient, child.chain.turn);
    next[index.get(id)!] = placeAt(child, orient, child.partScale, world, bed);
  }
  return next;
}

/** Record this object's link from where it stands. Descendants are left for `solveDescendants`. */
export function refreshOwnLink<T extends ChainObject>(objects: readonly T[], id: string, bed: BedSize): T[] {
  const obj = byId(objects, id);
  if (!obj?.chain) return objects as T[];
  const parent = byId(objects, obj.chain.parent);
  if (!parent) return objects as T[];
  const link = linkBetween(parent, obj, bed);
  return objects.map((row) => (row.id === id ? { ...row, chain: link } : row));
}

/** Record each child's link from where it stands, so a later parent move carries it from here. */
export function refreshLinks<T extends ChainObject>(objects: readonly T[], bed: BedSize): T[] {
  let changed = false;
  const next = objects.map((obj) => {
    if (!obj.chain) return obj;
    const parent = byId(objects, obj.chain.parent);
    if (!parent) return obj;
    const link = linkBetween(parent, obj, bed);
    changed = true;
    return { ...obj, chain: link };
  });
  return changed ? next : (objects as T[]);
}

/**
 * Drop a link whose parent is missing or that closes a loop. The object keeps the pose it has. Returns the same
 * array when every link is sound.
 */
export function saneChains<T extends ChainObject>(objects: readonly T[]): T[] {
  const ids = new Set(objects.map((obj) => obj.id));
  let changed = false;
  const next = objects.map((obj) => {
    if (!obj.chain) return obj;
    const seen = new Set<string>([obj.id]);
    let at: ChainObject | undefined = obj;
    let bad = false;
    while (at?.chain) {
      if (!ids.has(at.chain.parent) || seen.has(at.chain.parent)) {
        bad = true;
        break;
      }
      seen.add(at.chain.parent);
      at = byId(objects, at.chain.parent);
    }
    if (!bad) return obj;
    changed = true;
    const { chain: _drop, ...rest } = obj;
    return rest as T;
  });
  return changed ? next : (objects as T[]);
}

export function linkedTo<T extends ChainObject>(objects: readonly T[], childId: string, parentId: string, bed: BedSize): { objects: T[]; reason?: string } {
  const reason = linkRefusal(objects, childId, parentId);
  if (reason) return { objects: objects as T[], reason };
  const parent = byId(objects, parentId)!;
  const child = byId(objects, childId)!;
  const link = linkBetween(parent, child, bed);
  return {
    objects: objects.map((obj) => (obj.id === childId ? { ...obj, chain: link } : obj)),
  };
}

export function unlinked<T extends ChainObject>(objects: readonly T[], id: string): T[] {
  return objects.map((obj) => {
    if (obj.id !== id || !obj.chain) return obj;
    const { chain: _drop, ...rest } = obj;
    return rest as T;
  });
}

/** Scale the distances and the part scale of everything that sits on `id`. `id` itself is already scaled. */
export function scaledDescendants<T extends ChainObject>(objects: readonly T[], id: string, ratio: number): T[] {
  if (!(ratio > 0) || ratio === 1) return objects as T[];
  const kids = new Set(descendants(objects, id));
  if (kids.size === 0) return objects as T[];
  return objects.map((obj) => {
    if (!kids.has(obj.id)) return obj;
    const partScale = Math.min(4, Math.max(0.1, obj.partScale * ratio));
    const chain = obj.chain ? { ...obj.chain, offset: scale3(obj.chain.offset, ratio) } : undefined;
    return { ...obj, partScale, ...(chain ? { chain } : {}) };
  });
}

function limitsOf(value: unknown): JointLimits | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const axis = (key: string): [number, number] | undefined => {
    const pair = row[key];
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [min, max] = pair;
    if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max)) return undefined;
    if (min < -360 || max > 360 || min > max) return undefined;
    return [min, max];
  };
  const limits: JointLimits = {};
  const x = axis("x");
  const y = axis("y");
  const z = axis("z");
  if (x) limits.x = x;
  if (y) limits.y = y;
  if (z) limits.z = z;
  return limits.x || limits.y || limits.z ? limits : undefined;
}

/** A chain row from a project file, or null when the row is missing or damaged. A damaged row is left off, not fatal. */
export function readChain(value: unknown): ChainLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.parent !== "string" || !row.parent) return null;
  const offset = row.offset;
  const turn = row.turn;
  if (!Array.isArray(offset) || offset.length !== 3 || offset.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  if (!Array.isArray(turn) || turn.length !== 9 || turn.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  return { parent: row.parent, offset: [offset[0] as number, offset[1] as number, offset[2] as number], turn: [...turn] as Mat3 };
}

export function readJointLimits(value: unknown): JointLimits | undefined {
  return limitsOf(value);
}

export function readPivot(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) return undefined;
  return [value[0] as number, value[1] as number, value[2] as number];
}

function clampEuler(orient: Mat3, limits: JointLimits | undefined): Mat3 {
  if (!limits) return orient;
  const euler = orientEuler(orient);
  const clamp = (value: number, span: [number, number] | undefined) => (span ? Math.min(span[1], Math.max(span[0], value)) : value);
  const rx = clamp(euler.rx, limits.x);
  const ry = clamp(euler.ry, limits.y);
  const rz = clamp(euler.rz, limits.z);
  if (rx === euler.rx && ry === euler.ry && rz === euler.rz) return orient;
  return eulerOrient(rx, ry, rz);
}

function applyWorldRotation<T extends ChainObject>(objects: T[], jointId: string, delta: Mat3, bed: BedSize): void {
  const joint = byId(objects, jointId);
  if (!joint) return;
  const world = pivotBed(joint, bed);
  const before = joint.orient;
  const nextOrient = clampEuler(matMul(delta, before), joint.jointLimits);
  const actual = matMul(nextOrient, transpose(before));
  const index = new Map(objects.map((obj, at) => [obj.id, at]));
  objects[index.get(jointId)!] = placeAt(joint, nextOrient, joint.partScale, world, bed);
  for (const id of descendants(objects, jointId)) {
    const row = objects[index.get(id)!]!;
    const at = pivotBed(row, bed);
    const moved = add3(world, matVec(actual, sub3(at, world)));
    objects[index.get(id)!] = placeAt(row, matMul(actual, row.orient), row.partScale, moved, bed);
  }
}

function rotateJointToward<T extends ChainObject>(objects: T[], jointId: string, leafId: string, target: Vec3, bed: BedSize): void {
  const joint = byId(objects, jointId);
  const leaf = byId(objects, leafId);
  if (!joint || !leaf) return;
  const origin = pivotBed(joint, bed);
  const end = pivotBed(leaf, bed);
  const toEnd = sub3(end, origin);
  const toTarget = sub3(target, origin);
  const endLen = hypot3(toEnd);
  const targetLen = hypot3(toTarget);
  if (endLen < 1e-6 || targetLen < 1e-6) return;
  const a = scale3(toEnd, 1 / endLen);
  const b = scale3(toTarget, 1 / targetLen);
  let axis = cross3(a, b);
  let axisLen = hypot3(axis);
  const dot = Math.max(-1, Math.min(1, dot3(a, b)));
  let angle = Math.acos(dot);
  if (axisLen < 1e-8) {
    if (dot > 0) return;
    const helper: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    axis = cross3(a, helper);
    axisLen = hypot3(axis) || 1;
    angle = Math.PI;
  }
  // One step stays under a right angle so a limit clamp and the next joint can still share the reach.
  if (angle > Math.PI / 2) angle = Math.PI / 2;
  applyWorldRotation(objects, jointId, rotAbout(axis, angle), bed);
}

/**
 * Cyclic coordinate descent: turn each joint from the one before the end back to the root so the end pivot
 * moves toward `target`. Bone lengths stay. Per-joint Euler limits clamp the turn. Null when `leafId` is not
 * the end of a chain. The result's links match the pose it solved.
 */
export function solveIk<T extends ChainObject>(objects: readonly T[], leafId: string, target: Vec3, bed: BedSize, iterations = 32): T[] | null {
  if (!isChainLeaf(objects, leafId)) return null;
  const chain = chainUp(objects, leafId);
  const joints = chain.slice(0, -1);
  if (joints.length === 0) return null;
  const rows = objects.map((obj) => ({
    ...obj,
    orient: [...obj.orient] as Mat3,
    offset: { ...obj.offset },
    ...(obj.pivot ? { pivot: [...obj.pivot] as Vec3 } : {}),
    ...(obj.chain ? { chain: copyLink(obj.chain) } : {}),
    ...(obj.jointLimits ? { jointLimits: copyLimits(obj.jointLimits) } : {}),
  })) as T[];
  for (let iter = 0; iter < iterations; iter += 1) {
    const leaf = byId(rows, leafId);
    if (!leaf) break;
    if (hypot3(sub3(pivotBed(leaf, bed), target)) < 0.05) break;
    for (let i = joints.length - 1; i >= 0; i -= 1) rotateJointToward(rows, joints[i]!, leafId, target, bed);
  }
  return refreshLinks(rows, bed);
}

/** Take one member out. Its children sit on its parent, where they already stand. */
export function removedMember<T extends ChainObject>(objects: readonly T[], id: string, bed: BedSize): T[] {
  const dying = byId(objects, id);
  if (!dying) return objects as T[];
  const parent = dying.chain ? byId(objects, dying.chain.parent) : undefined;
  const kept = objects
    .filter((obj) => obj.id !== id)
    .map((obj) => {
      if (obj.chain?.parent !== id) return obj;
      if (!parent) {
        const { chain: _drop, ...rest } = obj;
        return rest as T;
      }
      return { ...obj, chain: linkBetween(parent, obj, bed) };
    });
  return kept;
}

/**
 * Take the whole chain out. Null when that would empty the plate: the plate always keeps one object, as Remove does.
 */
export function removedChain<T extends ChainObject>(objects: readonly T[], id: string): T[] | null {
  const drop = new Set(componentIds(objects, id));
  if (drop.size === 0 || drop.size >= objects.length) return null;
  return objects.filter((obj) => !drop.has(obj.id));
}

export interface DuplicateChain<T extends ChainObject> {
  objects: T[];
  selectedId: string;
}

/**
 * A copy of the whole chain, shifted clear on X, with the links rewritten onto the copies. Null when `id` is not
 * on the plate. `newId` and `nameOf` belong to the caller so this module does not mint plate ids.
 */
export function duplicateChain<T extends ChainObject>(
  objects: readonly T[],
  id: string,
  bed: BedSize,
  newId: () => string,
  nameOf: (name: string, taken: readonly string[]) => string,
): DuplicateChain<T> | null {
  const members = componentIds(objects, id);
  if (!members.includes(id)) return null;
  let maxX = -Infinity;
  let minX = Infinity;
  for (const memberId of members) {
    const obj = byId(objects, memberId);
    if (!obj) continue;
    const at = pivotBed(obj, bed);
    if (at[0] > maxX) maxX = at[0];
    if (at[0] < minX) minX = at[0];
  }
  const shift = (Number.isFinite(maxX) ? maxX - minX : 0) + 8;
  const map = new Map<string, string>();
  const taken = objects.map((obj) => obj.name);
  const copies: T[] = [];
  for (const memberId of members) {
    const obj = byId(objects, memberId);
    if (!obj) continue;
    const idNext = newId();
    map.set(obj.id, idNext);
    const name = nameOf(obj.name, taken);
    taken.push(name);
    const world = add3(pivotBed(obj, bed), [shift, 0, 0]);
    const { chain: _old, ...rest } = obj;
    copies.push({
      ...rest,
      id: idNext,
      name,
      orient: [...obj.orient] as Mat3,
      offset: offsetKeepingPoint(obj.sourcePos, pivotOfObject(obj), obj.orient, obj.partScale, bed.x, bed.y, world),
      centered: false,
      ...(obj.pivot ? { pivot: [...obj.pivot] as Vec3 } : {}),
      ...(obj.jointLimits ? { jointLimits: copyLimits(obj.jointLimits) } : {}),
    } as T);
  }
  const linked = copies.map((obj) => {
    const source = objects.find((row) => map.get(row.id) === obj.id);
    const parent = source?.chain ? map.get(source.chain.parent) : undefined;
    if (!parent) return obj;
    return { ...obj, chain: { parent, offset: [...source!.chain!.offset] as Vec3, turn: [...source!.chain!.turn] as Mat3 } };
  });
  return { objects: [...objects, ...linked], selectedId: map.get(id) ?? linked[0]!.id };
}

/** A free copy name: "hook copy", then "hook copy 2". */
export function copyName(name: string, taken: readonly string[]): string {
  const base = `${name} copy`;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}
