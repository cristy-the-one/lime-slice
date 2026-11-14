/** Shared, side-effect-free sampling of named assembly poses. Times and angles are seconds and degrees. */
import { memberPose, readJoint, rotationQuaternion, solveAssembly, type Assembly, type Member, type PoseOf } from "./assembly.ts";
import { boundsOf, type Bounds } from "./mesh-place.ts";
import { applyPose, boxUnder, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";
import { alignedHinge, poseChain, solvePose, turnBall, turnHinge } from "./pose.ts";
import { interference } from "./interference.ts";
import { trainOf, trainTurn } from "./gear-train.ts";

export type Quaternion = [number, number, number, number];
export type Aim = number | "rest" | "aligned" | "min" | "max" | { fraction: number } | { rotation: Quaternion } | { reach: { at: Vec3; to: Vec3 } };
export interface PoseKey { t: number; line?: number; ease?: "linear" | "inOut"; hold?: number; set?: Record<string, Aim>; rest?: boolean; colors?: Record<string, string> }
export interface PoseAnimation { fps: number; keys: PoseKey[]; colors?: Record<string, string>; background?: string }
/** A background as a script, a tool call or the save dialog gives it. */
export const BACKGROUND_REFUSAL = "A background is a colour written #rrggbb, such as #e07040.";
export const isBackground = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
/** `positions` and `centre` are in the part frame, before its model pose. */
export interface AnimationPart { object: string; name: string; positions?: Float32Array; centre?: Vec3 }
export interface RigMember { object: string; name: string; parent: string | null; joint: Member["joint"]; aligned?: number }
export interface AnimationIssue { line?: number; reason: string }
export interface AnimationFrame { time: number; assembly: Assembly; poses: Map<string, Affine>; colors: Map<string, string> }
export interface AnimationResult { frames: AnimationFrame[]; fps: number; durationS: number; bounds: Bounds | null; keys: { t: number; line?: number; reached?: boolean; distanceMm?: number; clamped?: string[] }[]; warnings: AnimationIssue[]; interferenceChecked: boolean }
type Value = { kind: "angle"; value: number } | { kind: "rotation"; value: Quaternion } | { kind: "reach"; at: Vec3; to: Vec3; blend?: number; segment?: number };
type Point = { time: number; until: number; ease: "linear" | "inOut"; value: Value; key: number };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finiteVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const pointLerp = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const normalize = (q: Quaternion): Quaternion => { const n = Math.hypot(...q); return q.map((v) => v / n) as Quaternion; };
const multiply = (a: Quaternion, b: Quaternion): Quaternion => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];

/** Spherical interpolation chooses the short arc and accepts either sign of a quaternion. */
export function slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  const q = normalize(a); let r = normalize(b);
  let cosine = q.reduce((sum, v, i) => sum + v * r[i]!, 0);
  if (cosine < 0) { r = r.map((v) => -v) as Quaternion; cosine = -cosine; }
  if (cosine > 0.9995) return normalize(q.map((v, i) => lerp(v, r[i]!, t)) as Quaternion);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine))), sin = Math.sin(angle);
  return q.map((v, i) => (v * Math.sin((1 - t) * angle) + r[i]! * Math.sin(t * angle)) / sin) as Quaternion;
}

/** Names are stable, unique and matched as displayed; a duplicate receives -2, -3, … . */
export function animationRig(assembly: Assembly, parts: readonly AnimationPart[]): RigMember[] {
  const partById = new Map(parts.map((part) => [part.object, part]));
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const member of assembly.members) {
    const base = partById.get(member.object)?.name.trim() || "Part";
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name); names.set(member.object, name);
  }
  return assembly.members.map((member) => {
    const aligned = alignedHinge(member);
    return { object: member.object, name: names.get(member.object)!, parent: member.parent ? names.get(member.parent) ?? null : null, joint: member.joint ? structuredClone(member.joint) : undefined, ...(aligned === null ? {} : { aligned }) };
  });
}

/** A glob union; names with no matching member are not silently ignored. */
export function rigGroup(rig: readonly RigMember[], pattern: string): RigMember[] {
  const matchers = pattern.split("|").map((part) => new RegExp(`^${part.trim().split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
  return rig.filter((row) => matchers.some((matcher) => matcher.test(row.name)));
}

function resolveAim(member: Member, aim: Aim): Value | string {
  const joint = readJoint(member.joint);
  // A root moves only on a hinge of its own, on the plate (docs/plan-gear-kinds.md).
  if (!joint || (member.parent === null && joint.kind !== "hinge")) return "This part has no movable joint.";
  // A rack's slide moves with its pinion (docs/plan-gear-kinds.md, stage 3): key the pinion.
  if (joint.kind === "slide") return "A slide moves with its pinion: key the pinion's angle.";
  if (typeof aim === "object" && aim !== null && "reach" in aim) {
    if (member.parent === null) return "A root turns on the plate; it has no chain to reach with.";
    return finiteVec(aim.reach?.at) && finiteVec(aim.reach?.to) ? { kind: "reach", at: aim.reach.at, to: aim.reach.to } : "Reach needs two finite three-number points.";
  }
  if (joint.kind === "ball") {
    if (aim === "rest") return { kind: "rotation", value: joint.rest ?? rotationQuaternion(memberPose(member).m) };
    if (aim === "aligned") return { kind: "rotation", value: [0, 0, 0, 1] };
    if (typeof aim === "object" && aim !== null && "rotation" in aim && Array.isArray(aim.rotation) && aim.rotation.length === 4 && aim.rotation.every(Number.isFinite) && Math.hypot(...aim.rotation) > 1e-10) return { kind: "rotation", value: normalize(aim.rotation) };
    return "A ball needs a rotation, rest, aligned or reach.";
  }
  let value: number | null = null;
  if (typeof aim === "number") value = aim;
  else if (aim === "rest") value = 0;
  else if (aim === "aligned") value = alignedHinge(member);
  else if (aim === "min") value = joint.min ?? null;
  else if (aim === "max") value = joint.max ?? null;
  else if (typeof aim === "object" && aim !== null && "fraction" in aim && typeof aim.fraction === "number" && Number.isFinite(aim.fraction) && Math.abs(aim.fraction) <= 1) {
    const limit = aim.fraction < 0 ? joint.min : joint.max;
    if (limit !== undefined) value = Math.abs(aim.fraction) * limit;
  }
  if (value === null || !Number.isFinite(value)) return "This aim needs a finite angle, an unambiguous alignment, or the named limit.";
  if ((joint.min !== undefined && value < joint.min - 1e-9) || (joint.max !== undefined && value > joint.max + 1e-9)) return `Angle ${value} is outside this hinge's limits (${joint.min ?? "free"} to ${joint.max ?? "free"}).`;
  return { kind: "angle", value };
}

function atTime(points: Point[], time: number, activeTime: (time: number) => number): Value {
  let before = points[0]!;
  for (let i = 1; i < points.length; i++) {
    const after = points[i]!;
    if (time < after.time) {
      const from = activeTime(before.until), to = activeTime(after.time);
      if (time <= before.until || to <= from) return before.value;
      let f = Math.max(0, Math.min(1, (activeTime(time) - from) / (to - from)));
      if (after.ease === "inOut") f = f * f * (3 - 2 * f);
      if (after.value.kind === "reach" && before.value.kind !== "reach") return { ...after.value, blend: f, segment: after.key };
      if (before.value.kind === "angle" && after.value.kind === "angle") return { kind: "angle", value: lerp(before.value.value, after.value.value, f) };
      if (before.value.kind === "rotation" && after.value.kind === "rotation") return { kind: "rotation", value: slerp(before.value.value, after.value.value, f) };
      if (before.value.kind === "reach" && after.value.kind === "reach") return { kind: "reach", at: pointLerp(before.value.at, after.value.at, f), to: pointLerp(before.value.to, after.value.to, f) };
      return before.value;
    }
    before = after;
  }
  return before.value;
}

/** Turn a ball toward a parent-frame quaternion through the same cone-limited operation as Pose. */
function rotateBall(member: Member, target: Quaternion, centre: Vec3): Member | { reason: string } {
  const q = rotationQuaternion(memberPose(member).m), inverse: Quaternion = [-q[0], -q[1], -q[2], q[3]];
  let delta = normalize(multiply(inverse, target));
  if (delta[3] < 0) delta = delta.map((v) => -v) as Quaternion;
  const sin = Math.hypot(delta[0], delta[1], delta[2]);
  if (sin < 1e-10) return member;
  return turnBall(member, [delta[0] / sin, delta[1] / sin, delta[2] / sin], 2 * Math.atan2(sin, delta[3]) * 180 / Math.PI, centre);
}

/** Validate all keys before returning any frame; never mutate the given assembly or poses. */
/**
 * `options.interference: false` leaves the parts' crossing check out: a second sampling of a script that was already
 * checked (an export at another frame rate) only needs the poses.
 */
export function sampleAnimation(animation: PoseAnimation, original: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], options: { interference?: boolean } = {}): AnimationResult | { issues: AnimationIssue[] } {
  if (!record(animation)) return { issues: [{ reason: "An animation must be an object." }] };
  const issues: AnimationIssue[] = [], warnings: AnimationIssue[] = [];
  const rig = animationRig(original, parts), partById = new Map(parts.map((part) => [part.object, part]));
  const members = new Map(original.members.map((member) => [member.object, member]));
  const tracks = new Map<string, Point[]>();
  const colorEvents: { time: number; id: string; color: string }[] = [];
  const colorKeys = new Set<string>();
  const addColors = (raw: Record<string, string>, time: number, line?: number) => {
    for (const [pattern, color] of Object.entries(raw)) {
      const match = rigGroup(rig, pattern);
      if (!match.length) { issues.push({ ...(line !== undefined ? { line } : {}), reason: `No member matches ${pattern}.` }); continue; }
      if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) { issues.push({ ...(line !== undefined ? { line } : {}), reason: `${pattern}: a colour needs six hex digits, such as #e07040.` }); continue; }
      for (const row of match) {
        const id = `${time}:${row.object}`;
        if (colorKeys.has(id)) warnings.push({ ...(line !== undefined ? { line } : {}), reason: `${row.name} has two colours at ${time}; the later key wins.` });
        colorKeys.add(id);
        colorEvents.push({ time, id: row.object, color: color.toLowerCase() });
      }
    }
  };
  if (animation.colors !== undefined) {
    if (record(animation.colors)) addColors(animation.colors as Record<string, string>, -1);
    else issues.push({ reason: "The palette must map member names to colours." });
  }
  if (animation.background !== undefined && !isBackground(animation.background)) issues.push({ reason: BACKGROUND_REFUSAL });
  if (!Number.isInteger(animation.fps) || animation.fps < 4 || animation.fps > 30) issues.push({ reason: "Frames per second must be a whole number from 4 to 30." });
  if (!Array.isArray(animation.keys) || animation.keys.length === 0) return { issues: [...issues, { reason: "Add at least one key." }] };
  const root = original.members.filter((member) => member.parent === null);
  if (root.length !== 1 || !poseOf(root[0]!.object)) issues.push({ reason: "The assembly needs one fixed root with a model pose." });
  if (original.members.some((member) => !partById.get(member.object)?.name.trim())) issues.push({ reason: "Every assembly member needs a part name." });
  const partCentre = (id: string): Vec3 | undefined => {
    const part = partById.get(id);
    if (part?.centre && finiteVec(part.centre)) return part.centre;
    if (!part?.positions?.length) return undefined;
    const box = boundsOf(part.positions);
    return box.min.map((v, i) => (v + box.max[i]!) / 2) as Vec3;
  };
  let end = 0;
  const holds: { start: number; end: number; line?: number }[] = [];
  // Each gear train has one lead, the body a key names, else the first in rig order; the rest of the train follows it.
  const named = new Set(animation.keys.flatMap((key) => record(key) && record(key.set) ? Object.keys(key.set).flatMap((pattern) => rigGroup(rig, pattern).map((row) => row.object)) : []));
  const followers = new Set<string>();
  for (const row of rig) {
    const train = trainOf(original, row.object);
    if (!train.has(row.object) || followers.has(row.object)) continue;
    const lead = rig.find((other) => train.has(other.object) && named.has(other.object)) ?? row;
    for (const id of train) if (id !== lead.object) followers.add(id);
  }
  const keys = animation.keys.map((key) => ({ t: record(key) && typeof key.t === "number" ? key.t : 0, ...(record(key) && typeof key.line === "number" ? { line: key.line } : {}) } as AnimationResult["keys"][number]));
  animation.keys.forEach((key, index) => {
    if (!record(key)) { issues.push({ reason: "Each key must be an object." }); return; }
    const issue = (reason: string) => issues.push({ ...(key.line !== undefined ? { line: key.line } : {}), reason });
    if (!Number.isFinite(key.t) || key.t < 0 || !Number.isFinite(key.hold ?? 0) || (key.hold ?? 0) < 0 || (key.ease !== undefined && key.ease !== "linear" && key.ease !== "inOut")) { issue("A key needs a finite nonnegative time and hold, and a supported easing."); return; }
    end = Math.max(end, key.t + (key.hold ?? 0));
    if (key.hold) holds.push({ start: key.t, end: key.t + key.hold, ...(key.line !== undefined ? { line: key.line } : {}) });
    if (key.colors !== undefined) {
      if (record(key.colors)) addColors(key.colors as Record<string, string>, key.t, key.line);
      else issue("Key colours must map member names to colours.");
    }
    if (key.set !== undefined && !record(key.set)) { issue("A key's poses must map member names to aims."); return; }
    const explicit = Object.entries(key.set ?? {});
    const assigned = new Set(explicit.flatMap(([pattern]) => rigGroup(rig, pattern).map((row) => row.object)));
    const items: [string, Aim][] = [];
    // A gear train rests through its lead alone: the others follow it (docs/plan-gear-coupling.md).
    if (key.rest) for (const row of rig) if (row.joint && row.joint.kind !== "slide" && !assigned.has(row.object) && !followers.has(row.object)) items.push([row.name, "rest"]);
    items.push(...explicit);
    for (const [pattern, aim] of items) {
      const matched = rigGroup(rig, pattern);
      if (!matched.length) { issue(`No member matches ${pattern}.`); continue; }
      for (const row of matched) {
        const member = members.get(row.object)!;
        const value = resolveAim(member, aim);
        if (typeof value === "string") { issue(`${row.name}: ${value}`); continue; }
        if (value.kind === "reach" && !poseChain([original], row.object).size) { issue(`${row.name}: no jointed chain can reach.`); continue; }
        if (member.joint?.kind === "ball" && member.joint.cone !== undefined) {
          const centre = partCentre(row.object);
          if (!centre) { issue(`${row.name}: a cone-limited ball needs its part centre.`); continue; }
          if (value.kind === "rotation") {
            const turned = rotateBall(member, value.value, centre);
            if ("reason" in turned) { issue(`${row.name}: ${turned.reason}`); continue; }
            const actual = rotationQuaternion(memberPose(turned).m);
            const agreement = Math.abs(actual.reduce((sum, component, i) => sum + component * value.value[i]!, 0));
            if (agreement < 1 - 1e-8) { issue(`${row.name}: the requested rotation exceeds the ball's cone limit.`); continue; }
          }
        }
        const track = tracks.get(row.object) ?? [];
        const duplicate = track.findIndex((point) => point.time === key.t);
        if (duplicate >= 0) { warnings.push({ ...(key.line !== undefined ? { line: key.line } : {}), reason: `${row.name} is set twice at ${key.t}; the later key wins.` }); track.splice(duplicate, 1); }
        track.push({ time: key.t, until: key.t + (key.hold ?? 0), ease: key.ease ?? "linear", value, key: index });
        tracks.set(row.object, track);
      }
    }
  });
  if (end * animation.fps > 18000) issues.push({ reason: "An animation may have at most 18000 frames." });
  holds.sort((a, b) => a.start - b.start);
  for (const hold of holds) {
    if (animation.keys.some((key) => record(key) && typeof key.t === "number" && key.t > hold.start && key.t < hold.end)) issues.push({ ...(hold.line !== undefined ? { line: hold.line } : {}), reason: "A key falls inside a hold." });
  }
  const mergedHolds: { start: number; end: number }[] = [];
  for (const hold of holds) {
    const last = mergedHolds.at(-1);
    if (last && hold.start <= last.end) last.end = Math.max(last.end, hold.end);
    else mergedHolds.push({ start: hold.start, end: hold.end });
  }
  const activeTime = (time: number) => time - mergedHolds.reduce((sum, hold) => sum + Math.max(0, Math.min(time, hold.end) - hold.start), 0);
  const initialPoses = solveAssembly(original, poseOf).poses;
  for (const [id, points] of tracks) {
    points.sort((a, b) => a.time - b.time);
    const member = members.get(id)!;
    for (let i = 1; i < points.length; i++) if (points[i - 1]!.until > points[i]!.time) issues.push({ ...(keys[points[i - 1]!.key]?.line !== undefined ? { line: keys[points[i - 1]!.key]!.line } : {}), reason: `${rig.find((row) => row.object === id)!.name}: a hold extends past the next key.` });
    if (points[0]!.time > 0) {
      const first = points[0]!.value;
      const initial: Value = first.kind === "reach" ? { kind: "reach", at: first.at, to: applyPose(initialPoses.get(id) ?? memberPose(member), first.at) } : member.joint?.kind === "hinge" ? { kind: "angle", value: member.joint.angle ?? 0 } : { kind: "rotation", value: rotationQuaternion(memberPose(member).m) };
      points.unshift({ time: 0, until: 0, ease: "linear", value: initial, key: -1 });
    }
  }
  const tracked = [...tracks.keys()];
  for (let i = 0; i < tracked.length; i++) {
    const train = trainOf(original, tracked[i]!);
    const other = tracked.slice(i + 1).find((id) => train.has(id));
    if (other) {
      const name = (id: string) => rig.find((row) => row.object === id)!.name;
      issues.push({ reason: `${name(tracked[i]!)} and ${name(other)} are one gear train; key only one of them.` });
    }
  }
  if (issues.length) return { issues };
  const count = Math.max(1, Math.round(end * animation.fps));
  let assembly = structuredClone(original), bounds: Bounds | null = null;
  const reachStarts = new Map<string, Vec3>();
  const frames: AnimationFrame[] = [];
  colorEvents.sort((a, b) => a.time - b.time);
  const colors = new Map<string, string>();
  let colorIndex = 0;
  const usable = original.members.flatMap((member) => { const part = partById.get(member.object); return part?.positions && part.positions.length >= 9 ? [{ id: member.object, positions: part.positions, box: boundsOf(part.positions) }] : []; });
  const centre = partCentre;
  const checkPairs = options.interference !== false;
  const pairSeen = new Map<number, { pa: Affine; pb: Affine; hit: boolean }>();
  const samePose = (p: Affine, q: Affine) => p === q || (p.m.every((v, k) => v === q.m[k]) && p.t.every((v, k) => v === q.t[k]));
  // Solve at key times too: a key between exported frames must report its own target, not a later sample.
  const frameTimes = Array.from({ length: count }, (_, frame) => count === 1 ? 0 : end * frame / (count - 1));
  const frameNumbers = new Map(frameTimes.map((time, frame) => [time, frame]));
  const times = [...new Set([...frameTimes, ...keys.map((key) => key.t)])].sort((a, b) => a - b);
  for (const time of times) {
    while (colorIndex < colorEvents.length && colorEvents[colorIndex]!.time <= time) {
      const event = colorEvents[colorIndex++]!; colors.set(event.id, event.color);
    }
    const reaches: { id: string; value: Extract<Value, { kind: "reach" }> }[] = [];
    for (const [id, points] of tracks) {
      const value = atTime(points, time, activeTime), member = assembly.members.find((row) => row.object === id)!;
      if (value.kind === "reach") { reaches.push({ id, value }); continue; }
      if (value.kind === "angle" && (trainOf(assembly, id).has(id) || member.parent === null)) {
        // A coupled hinge turns its whole gear train, and a hinged root keeps the parts hinged on it on their pins; a
        // locked train refuses the animation.
        const turned = trainTurn(assembly, id, value.value - (member.joint?.kind === "hinge" ? member.joint.angle ?? 0 : 0));
        if ("reason" in turned) return { issues: [{ reason: `${rig.find((row) => row.object === id)!.name}: ${turned.reason}` }] };
        assembly = turned.assembly;
        continue;
      }
      const result = value.kind === "angle" ? turnHinge(member, value.value - (member.joint?.kind === "hinge" ? member.joint.angle ?? 0 : 0)) : rotateBall(member, value.value, centre(id) ?? member.joint!.pivot);
      if ("reason" in result) return { issues: [{ reason: `${rig.find((row) => row.object === id)!.name}: ${result.reason}` }] };
      assembly = { ...assembly, members: assembly.members.map((row) => row.object === id ? result : row) };
    }
    for (const { id, value } of reaches) {
      let target = value.to;
      if (value.blend !== undefined) {
        const segment = `${id}:${value.segment}`;
        let start = reachStarts.get(segment);
        if (!start) {
          const pose = solveAssembly(assembly, poseOf).poses.get(id);
          if (!pose) return { issues: [{ reason: `The pose of ${id} is unavailable.` }] };
          start = applyPose(pose, value.at); reachStarts.set(segment, start);
        }
        target = pointLerp(start, value.to, value.blend);
      }
      const solved = solvePose(assembly, poseOf, id, value.at, target, centre);
      if ("reason" in solved) return { issues: [{ reason: solved.reason }] };
      assembly = solved.assembly;
    }
    const poses = solveAssembly(assembly, poseOf).poses;
    for (const [id, points] of tracks) for (const point of points) {
      if (point.key < 0 || point.value.kind !== "reach" || point.time !== time) continue;
      const pose = poses.get(id); if (!pose) continue;
      const actual = applyPose(pose, point.value.at), target = point.value.to;
      const distance = Math.hypot(...actual.map((value, i) => value - target[i]!));
      const key = keys[point.key]!;
      key.reached = (key.reached ?? true) && distance <= 0.05;
      key.distanceMm = Math.max(key.distanceMm ?? 0, distance);
      if (distance > 0.05) {
        const clamped = [...poseChain([assembly], id)].flatMap((jointId) => {
          const joint = assembly.members.find((row) => row.object === jointId)?.joint;
          if (joint?.kind !== "hinge") return [];
          const angle = joint.angle ?? 0;
          return ((joint.min !== undefined && Math.abs(angle - joint.min) < 1e-7) || (joint.max !== undefined && Math.abs(angle - joint.max) < 1e-7)) ? [rig.find((row) => row.object === jointId)!.name] : [];
        });
        if (clamped.length) key.clamped = [...new Set([...(key.clamped ?? []), ...clamped])];
      }
    }
    const frame = frameNumbers.get(time);
    if (frame === undefined) continue;
    for (const part of usable) {
      const pose = poses.get(part.id); if (!pose) continue;
      const one = boxUnder(part.box, pose);
      bounds = bounds ? { min: bounds.min.map((v, i) => Math.min(v, one.min[i]!)) as Vec3, max: bounds.max.map((v, i) => Math.max(v, one.max[i]!)) as Vec3 } : one;
    }
    const frameBoxes = checkPairs ? usable.map((part) => { const pose = poses.get(part.id); return pose ? boxUnder(part.box, pose) : null; }) : [];
    for (let i = 0; checkPairs && i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]!, b = usable[j]!, pa = poses.get(a.id), pb = poses.get(b.id), ba = frameBoxes[i], bb = frameBoxes[j];
      if (!pa || !pb || !ba || !bb || ba.min.some((v, axis) => v > bb.max[axis]! || bb.min[axis]! > ba.max[axis]!)) continue;
      // Two parts that stand as they stood the last time they were tested cross as they did: most pairs of a
      // mechanism do not move in most frames. The poses must be the same numbers, so the answer is the test's own.
      const slot = i * usable.length + j, last = pairSeen.get(slot);
      let hit: boolean;
      if (last && samePose(last.pa, pa) && samePose(last.pb, pb)) hit = last.hit;
      else {
        const result = interference({ positions: a.positions, pose: pa }, { positions: b.positions, pose: pb });
        hit = result.verdict === "crossing" || !!result.nested;
        pairSeen.set(slot, { pa, pb, hit });
      }
      if (hit) warnings.push({ reason: `Frame ${frame + 1}: ${rig.find((r) => r.object === a.id)!.name} intersects ${rig.find((r) => r.object === b.id)!.name}.` });
    }
    // The assembly is replaced, never written to, from one time to the next, so a frame can hold it as it is.
    frames.push({ time, assembly, poses: new Map(poses), colors: new Map(colors) });
  }
  return { frames, fps: animation.fps, durationS: end, bounds, keys, warnings, interferenceChecked: checkPairs && usable.length === original.members.length };
}
