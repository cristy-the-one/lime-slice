/** Shared, side-effect-free sampling of named assembly poses. Times and angles are seconds and degrees. */
import { memberPose, readJoint, rotationQuaternion, solveAssembly, type Assembly, type Member, type PoseOf } from "./assembly.ts";
import { boundsOf, type Bounds } from "./mesh-place.ts";
import { applyPose, boxUnder, inversePose, thenPose, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";
import { alignedHinge, poseChain, solvePose, turnBall, turnHinge } from "./pose.ts";
import { interference, MESH_TOLERANCE_MM } from "./interference.ts";
import { trainOf, trainTurn } from "./gear-train.ts";
import { memberNamesOf, nameMatcher } from "./anim-members.ts";

export type Quaternion = [number, number, number, number];
export type Aim = number | "rest" | "aligned" | "min" | "max" | { fraction: number } | { rotation: Quaternion } | { reach: { at: Vec3; to: Vec3 } };
export interface PoseKey { t: number; line?: number; ease?: "linear" | "inOut"; hold?: number; set?: Record<string, Aim>; rest?: boolean; colors?: Record<string, string> }
export interface PoseAnimation { fps: number; keys: PoseKey[]; colors?: Record<string, string>; background?: string }
/** A background as a script, a tool call or the save dialog gives it. */
export const BACKGROUND_REFUSAL = "A background is a colour written #rrggbb, such as #e07040.";
export const isBackground = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
/** `positions` and `centre` are in the part frame, before its model pose. */
/** `chordMm`: a solid's kernel mesh carries the chord it was made at, for contact reads (src/contact.ts `ContactPart`). */
export interface AnimationPart { object: string; name: string; positions?: Float32Array; centre?: Vec3; chordMm?: number }
export interface RigMember { object: string; name: string; parent: string | null; joint: Member["joint"]; aligned?: number }
export interface AnimationIssue { line?: number; reason: string }
/**
 * A warning. One about two parts that cross names them (`pair`), says on how many frames (`frames`), the first of them
 * (1-based) and its time, or that they already overlap at rest and the animation keeps them so (`atRest`).
 */
export interface AnimationWarning extends AnimationIssue { pair?: [string, string]; frames?: number; firstFrame?: number; timeS?: number; atRest?: boolean }
export interface AnimationFrame { time: number; assembly: Assembly; poses: Map<string, Affine>; colors: Map<string, string> }
/**
 * `ignored`: the pairs the caller left out of the crossing check (`SampleOptions.ignore`), by member name, and a sentence
 * that says so. Present only when the check ran and a pair was named.
 */
export interface AnimationResult { frames: AnimationFrame[]; fps: number; durationS: number; bounds: Bounds | null; keys: { t: number; line?: number; reached?: boolean; distanceMm?: number; clamped?: string[] }[]; warnings: AnimationWarning[]; interferenceChecked: boolean; ignored?: { pairs: [string, string][]; reason: string } }
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
  const names = memberNamesOf(assembly.members, (object) => partById.get(object)?.name);
  return assembly.members.map((member) => {
    const aligned = alignedHinge(member);
    return { object: member.object, name: names.get(member.object)!, parent: member.parent ? names.get(member.parent) ?? null : null, joint: member.joint ? structuredClone(member.joint) : undefined, ...(aligned === null ? {} : { aligned }) };
  });
}

/** A glob union; names with no matching member are not silently ignored. */
export function rigGroup(rig: readonly RigMember[], pattern: string): RigMember[] {
  const match = nameMatcher(pattern);
  return rig.filter((row) => match(row.name));
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

/** The most frames one animation may have. */
export const MAX_FRAMES = 18000;
/** How far past a grid time an end may fall, in frames, and still end on that frame: rounding, not a later pose. */
const GRID_SLACK = 1e-6;
/**
 * Where an animation's frames fall (6.8.0, docs/plan-pose-animation.md): frame `k` at exactly `k / fps`, for
 * `k = 0 … n`, where `n` is the first whole frame at or after `end` (`ceil(end × fps)`, an end within a millionth of a
 * frame past a grid time ending on it). An end on the grid is the last frame; an end between two grid times is shown by
 * the next one, which holds the final pose, since nothing moves after the last key. So every frame is `1/fps` apart, a
 * player that shows one every `1/fps` shows each at its own time, and the duration is `n / fps`. `end = 0` is one frame.
 * The recipe crate's `anim::frame_times` is the same rule, number for number.
 */
export function frameTimes(fps: number, end: number): number[] {
  return Array.from({ length: frameCount(fps, end) }, (_, k) => k / fps);
}
/** How many frames `frameTimes(fps, end)` gives: `ceil(end × fps) + 1`. */
export function frameCount(fps: number, end: number): number {
  return Math.max(0, Math.ceil(end * fps - GRID_SLACK)) + 1;
}

/**
 * A sentence when keys fall between frames, else null. Frames are at whole multiples of `1/fps`, so a key there is on a
 * frame; a key elsewhere has frames on either side interpolated toward it, and a pose checked at that key is not one a
 * frame shows. The keys at the last key time are never between: the frame at or after them shows the final pose.
 */
export function frameTiming(sampled: { frames: { time: number }[]; keys: { t: number }[]; fps: number }): string | null {
  const times = sampled.frames.map((frame) => frame.time);
  const last = Math.max(...sampled.keys.map((key) => key.t));
  const between = sampled.keys.filter((key) => key.t < last && !times.some((time) => Math.abs(time - key.t) <= 1e-9)).length;
  if (between === 0) return null;
  return `${between} of ${sampled.keys.length} keys fall between frames: frames are at whole multiples of 1/${sampled.fps} s, and a frame between two keys is interpolated between them, so a pose checked at such a key is not one a frame shows. Key at k/${sampled.fps} s (anim::frame_times) to put each key on a frame. A warning gives its frame and time.`;
}

/**
 * Whether the last frame shows what the first does: the same parts, every pose within 1e-9 (rotation) and 1e-6 mm, and
 * the same colours. A GIF loops, so such a last frame is left out of it: a gear train keyed through whole turns would
 * otherwise hold its start pose for two frames at every pass, a visible stutter. A one-frame animation never ends where
 * it starts in this sense.
 */
export function endsWhereItStarts(frames: readonly Pick<AnimationFrame, "poses" | "colors">[]): boolean {
  if (frames.length < 2) return false;
  const first = frames[0]!, last = frames[frames.length - 1]!;
  if (first.poses.size !== last.poses.size || first.colors.size !== last.colors.size) return false;
  for (const [id, a] of first.poses) {
    const b = last.poses.get(id);
    if (!b || !a.m.every((v, k) => Math.abs(v - b.m[k]!) <= 1e-9) || !a.t.every((v, k) => Math.abs(v - b.t[k]!) <= 1e-6)) return false;
  }
  for (const [id, color] of first.colors) if (last.colors.get(id) !== color) return false;
  return true;
}

/** How far sampling has come: `frame` frames of `count` are ready. */
export interface SampleStep { frame: number; count: number }
export type SampleOutcome = AnimationResult | { issues: AnimationIssue[] };
/**
 * `interference: false` leaves the parts' crossing check out: a second sampling of a script that was already checked
 * (an export at another frame rate) only needs the poses. `onProgress` hears each frame as it is ready (frame of count),
 * the parts' crossing check of that frame included. `toleranceMm` is the crossing check's (default `MESH_TOLERANCE_MM`).
 * `ignore` names pairs of members (by name, as the rig gives it, or by handle) the crossing check leaves out: a friction
 * fit whose parts move against each other (a collet slipping on its pin) overlaps on every frame by design. A name that
 * is not a member refuses the animation (`readIgnore`).
 */
export interface SampleOptions { interference?: boolean; toleranceMm?: number; ignore?: [string, string][]; onProgress?: (frame: number, count: number) => void }

/**
 * A caller's `ignore` read against the rig: each pair as two member handles, and as the two names the rig gives them; or
 * why it is refused (the field named). Both hosts read it the same way: the MCP server before it builds a script, and
 * `sampleAnimationSteps` itself, so the window's worker refuses what the server refuses.
 */
export function readIgnore(rig: readonly RigMember[], raw: unknown): { pairs: [string, string][]; names: [string, string][] } | { reason: string } {
  if (raw === undefined) return { pairs: [], names: [] };
  const shape = 'ignore is a list of pairs of member names, such as [["Collet", "Pin"]].';
  if (!Array.isArray(raw)) return { reason: shape };
  const pairs: [string, string][] = [], names: [string, string][] = [], seen = new Set<string>();
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every((name) => typeof name === "string")) return { reason: shape };
    const rows = (entry as string[]).map((name) => rig.find((row) => row.name === name) ?? rig.find((row) => row.object === name));
    const missing = (entry as string[]).find((_, at) => !rows[at]);
    if (missing !== undefined) return { reason: `ignore: "${missing}" is not a member of this assembly. Its members: ${rig.slice(0, 20).map((row) => row.name).join(", ")}${rig.length > 20 ? ", …" : ""}.` };
    const [a, b] = rows as [RigMember, RigMember];
    if (a.object === b.object) return { reason: `ignore: ["${entry[0]}", "${entry[1]}"] names ${a.name} twice; a pair is two members.` };
    const key = [a.object, b.object].sort().join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([a.object, b.object]);
    names.push([a.name, b.name]);
  }
  return { pairs, names };
}

/** The sentence a reply gives for the pairs a caller left out of the crossing check. */
export function ignoredSentence(names: readonly [string, string][]): string {
  const list = names.map(([a, b]) => `${a} and ${b}`).join("; ");
  return `Left out of the crossing check because the call named ${names.length === 1 ? "this pair" : "these pairs"} in ignore: ${list}. Their overlap on any frame is not reported.`;
}

/** The sampler's options as the window passes them (src/pose-anim-sample.ts) and its worker reads them: the crossing check off, or the pairs it leaves out. */
export const sampleOptions = (options: { interference?: boolean; ignore?: [string, string][] }): SampleOptions => ({ ...(options.interference === false ? { interference: false } : {}), ...(options.ignore ? { ignore: options.ignore } : {}) });

/** Validate all keys before returning any frame; never mutate the given assembly or poses. */
export function sampleAnimation(animation: PoseAnimation, original: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], options: SampleOptions = {}): SampleOutcome {
  const steps = sampleAnimationSteps(animation, original, poseOf, parts, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    options.onProgress?.(step.value.frame, step.value.count);
  }
}

/**
 * `sampleAnimation` one frame at a time: it yields how many frames are ready of how many (0 of N first, once the keys
 * are read), and returns what `sampleAnimation` returns. A caller that must not hold the thread (the window, when no
 * worker can be made) runs it in slices; `sampleAnimation` runs it to the end. One body, so both answer the same.
 */
export function* sampleAnimationSteps(animation: PoseAnimation, original: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], options: SampleOptions = {}): Generator<SampleStep, SampleOutcome, void> {
  if (!record(animation)) return { issues: [{ reason: "An animation must be an object." }] };
  const issues: AnimationIssue[] = [], warnings: AnimationWarning[] = [];
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
  const ignore = readIgnore(rig, options.ignore);
  if ("reason" in ignore) issues.push({ reason: ignore.reason });
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
        // A ratchet's click is set by its wheel (docs/plan-coupling-kinds.md, stage 3): key the wheel.
        const clicked = (original.couplings ?? []).find((one) => one.click?.object === row.object);
        if (clicked) { issue(`${row.name}: a click moves with its ratchet: key the ratchet.`); continue; }
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
  if (frameCount(animation.fps, end) > MAX_FRAMES) issues.push({ reason: `An animation may have at most ${MAX_FRAMES} frames.` });
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
  // Frame k at k / fps, through the first grid time at or after the end (`frameTimes`).
  const frameTimesNow = frameTimes(animation.fps, end), count = frameTimesNow.length;
  // Every keyed body is driven on its own: a clutch whose driven side holds one slips (docs/plan-coupling-kinds.md).
  const separate = new Set(tracked);
  let assembly = structuredClone(original), bounds: Bounds | null = null;
  const reachStarts = new Map<string, Vec3>();
  const frames: AnimationFrame[] = [];
  colorEvents.sort((a, b) => a.time - b.time);
  const colors = new Map<string, string>();
  let colorIndex = 0;
  const usable = original.members.flatMap((member) => { const part = partById.get(member.object); return part?.positions && part.positions.length >= 9 ? [{ id: member.object, positions: part.positions, box: boundsOf(part.positions) }] : []; });
  const centre = partCentre;
  const checkPairs = options.interference !== false;
  const skipped = "pairs" in ignore ? ignore : { pairs: [], names: [] };
  const crossings = checkPairs ? crossingCheck(original, poseOf, parts, options.toleranceMm ?? MESH_TOLERANCE_MM, skipped.pairs) : null;
  // Solve at key times too: a key between exported frames must report its own target, not a later sample.
  const frameNumbers = new Map(frameTimesNow.map((time, frame) => [time, frame]));
  const times = [...new Set([...frameTimesNow, ...keys.map((key) => key.t)])].sort((a, b) => a - b);
  yield { frame: 0, count };
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
        const turned = trainTurn(assembly, id, value.value - (member.joint?.kind === "hinge" ? member.joint.angle ?? 0 : 0), { separate });
        if ("reason" in turned) return { issues: [{ reason: `${rig.find((row) => row.object === id)!.name}: ${turned.reason}` }] };
        // A ratchet that held the turn short once its click was seated: the frames show it held, and the warning says so.
        const held = turned.stopped ? `${rig.find((row) => row.object === id)!.name}: ${turned.stopped}` : null;
        if (held && !warnings.some((row) => row.reason === held)) warnings.push({ reason: held });
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
    crossings?.frame(frame, time, poses);
    // The assembly is replaced, never written to, from one time to the next, so a frame can hold it as it is.
    frames.push({ time, assembly, poses: new Map(poses), colors: new Map(colors) });
    yield { frame: frames.length, count };
  }
  if (crossings) warnings.push(...crossings.warnings(frames.length));
  // The time of the last frame: what a player that shows a frame every 1/fps reaches, the end rounded up to the grid.
  return { frames, fps: animation.fps, durationS: frameTimesNow[count - 1]!, bounds, keys, warnings, interferenceChecked: checkPairs && usable.length === original.members.length, ...(checkPairs && skipped.names.length ? { ignored: { pairs: skipped.names, reason: ignoredSentence(skipped.names) } } : {}) };
}

/**
 * The parts' crossing check, fed one frame at a time by `sampleAnimationSteps` (so the window's worker, its sliced
 * fallback and the MCP server, which gives the event loop a turn between steps, all run the same check), and read once
 * at the end: one warning a pair.
 *
 * It is the mesh pass (`interference`) at `toleranceMm`, by default `MESH_TOLERANCE_MM`: the kernel meshes each face to
 * within that of its surface, so two meshes that overlap less than that deep may be faces that only touch (an arbor
 * turning in a hole of its own size). Overlap deeper than that is a crossing; `model_check {interference, exact}`
 * measures a pose's common volume. Two parts that already overlap at rest (as the plate holds them, before any key),
 * and stand on a frame as they stood at rest to each other, are one warning with `atRest`: the same overlap, not one a
 * frame. Frames where they have moved and still cross are counted as crossings. The pairs in `ignore` (member handles)
 * are never tested: the caller named them as fits that overlap by design.
 */
function crossingCheck(original: Assembly, poseOf: PoseOf, parts: readonly AnimationPart[], tolerance: number, ignore: readonly [string, string][] = []) {
  const skip = new Set(ignore.map((pair) => [...pair].sort().join("\u0000")));
  const rig = animationRig(original, parts), partById = new Map(parts.map((part) => [part.object, part]));
  const usable = original.members.flatMap((member) => { const part = partById.get(member.object); return part?.positions && part.positions.length >= 9 ? [{ id: member.object, positions: part.positions, box: boundsOf(part.positions) }] : []; });
  const nameOf = (id: string) => rig.find((row) => row.object === id)!.name;
  const pairSeen = new Map<number, { pa: Affine; pb: Affine; hit: boolean }>();
  const samePose = (p: Affine, q: Affine) => p === q || (p.m.every((v, k) => v === q.m[k]) && p.t.every((v, k) => v === q.t[k]));
  // Two relative poses within these are the same: a pair that turns together keeps its rest pose to rounding.
  const sameRelative = (p: Affine, q: Affine) => p.m.every((v, k) => Math.abs(v - q.m[k]!) <= 1e-9) && p.t.every((v, k) => Math.abs(v - q.t[k]!) <= 1e-6);
  const crosses = (a: (typeof usable)[number], b: (typeof usable)[number], pa: Affine, pb: Affine) => {
    const result = interference({ positions: a.positions, pose: pa }, { positions: b.positions, pose: pb }, { toleranceMm: tolerance });
    return result.verdict === "crossing" || !!result.nested;
  };
  let rest: Map<string, Affine> | undefined;
  // Per pair: whether it overlaps at rest (tested the first time the pair crosses on a frame), and its relative pose then.
  const atRest = new Map<number, { hit: boolean; relative?: Affine }>();
  const counts = new Map<number, { a: string; b: string; rest: number; moving: number; first?: number; time?: number }>();
  return {
    /** Frame `frame` (0-based) at `time`, its parts at `poses`. */
    frame(frame: number, time: number, poses: ReadonlyMap<string, Affine>): void {
      const frameBoxes = usable.map((part) => { const pose = poses.get(part.id); return pose ? boxUnder(part.box, pose) : null; });
      for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
        const a = usable[i]!, b = usable[j]!, pa = poses.get(a.id), pb = poses.get(b.id), ba = frameBoxes[i], bb = frameBoxes[j];
        if (!pa || !pb || !ba || !bb || ba.min.some((v, axis) => v > bb.max[axis]! || bb.min[axis]! > ba.max[axis]!)) continue;
        if (skip.size && skip.has([a.id, b.id].sort().join("\u0000"))) continue;
        // Two parts that stand as they stood the last time they were tested cross as they did: most pairs of a
        // mechanism do not move in most frames. The poses must be the same numbers, so the answer is the test's own.
        const slot = i * usable.length + j, last = pairSeen.get(slot);
        let hit: boolean;
        if (last && samePose(last.pa, pa) && samePose(last.pb, pb)) hit = last.hit;
        else {
          hit = crosses(a, b, pa, pb);
          pairSeen.set(slot, { pa, pb, hit });
        }
        if (!hit) continue;
        let start = atRest.get(slot);
        if (!start) {
          rest ??= solveAssembly(original, poseOf).poses;
          const ra = rest.get(a.id), rb = rest.get(b.id);
          start = ra && rb && crosses(a, b, ra, rb) ? { hit: true, relative: thenPose(rb, inversePose(ra)) } : { hit: false };
          atRest.set(slot, start);
        }
        const row = counts.get(slot) ?? { a: nameOf(a.id), b: nameOf(b.id), rest: 0, moving: 0 };
        if (start.hit && sameRelative(thenPose(pb, inversePose(pa)), start.relative!)) row.rest += 1;
        else {
          row.moving += 1;
          if (row.first === undefined) { row.first = frame; row.time = time; }
        }
        counts.set(slot, row);
      }
    },
    /** One warning a pair, over `total` frames: overlaps at rest first, then crossings by their first frame. */
    warnings(total: number): AnimationWarning[] {
      const check = `mesh pass: the meshes overlap deeper than ${tolerance} mm`;
      const out: AnimationWarning[] = [];
      for (const row of counts.values()) if (row.rest > 0) {
        const kept = row.rest === total ? "every frame keeps them so" : `${row.rest} of ${total} frames keep them so`;
        out.push({ reason: `${row.a} overlaps ${row.b} at rest, and ${kept} (${check}). Said once: the overlap is the plate's own, not the animation's.`, pair: [row.a, row.b], frames: row.rest, atRest: true });
      }
      const moving = [...counts.values()].filter((row) => row.moving > 0).sort((x, y) => x.first! - y.first!);
      for (const row of moving) {
        const time = Math.round(row.time! * 1000) / 1000;
        out.push({ reason: `${row.a} intersects ${row.b} on ${row.moving} of ${total} frame${total === 1 ? "" : "s"}, first frame ${row.first! + 1} at ${time} s (${check}).`, pair: [row.a, row.b], frames: row.moving, firstFrame: row.first! + 1, timeS: time });
      }
      return out;
    },
  };
}

/** One member as an animation saw it, or as it stands now: its name, its model pose (absent is where it was made) and its points. */
export interface StalePart { name: string; pose: Affine | undefined; points: ArrayLike<number> }

/**
 * What an animation was built from, against what stands now: null when nothing it used has changed, else a clause that
 * names what did ("Wheel moved", "The assembly's joints changed"). The frames hold poses and meshes from the start of
 * the build, so they are stale only when a member's pose, its shape, or the assembly itself is different.
 *
 * A part that was only stored again is the same part: a mirror from an MCP session, or a mesh the view finished
 * preparing, makes a new record with the same pose and the same points. The window used to ask for the same record,
 * and for the selection to still be on the assembly, so in such a session every Play answered "The assembly changed
 * while the animation was building." however often it was pressed.
 */
export function animationStale(snapshot: Assembly, current: Assembly | undefined, was: ReadonlyMap<string, StalePart | undefined>, now: ReadonlyMap<string, StalePart | undefined>): string | null {
  if (!current) return "The assembly was removed";
  if (current.members.length !== snapshot.members.length || current.members.some((row, at) => row.object !== snapshot.members[at]!.object)) return "The assembly's parts changed";
  const close = (a: Affine | undefined, b: Affine | undefined) => {
    const flat = (pose: Affine | undefined) => (pose ? [...pose.m, ...pose.t] : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const left = flat(a), right = flat(b);
    return left.every((value, at) => Math.abs(value - right[at]!) <= 1e-9);
  };
  for (const [id, before] of was) {
    const after = now.get(id);
    if (!before && !after) continue;
    if (!before || !after) return `${(after ?? before)!.name} was ${after ? "added" : "removed"}`;
    if (!close(before.pose, after.pose)) return `${after.name} moved`;
    const a = before.points, b = after.points;
    if (a !== b) {
      if (a.length !== b.length) return `${after.name}'s shape changed`;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return `${after.name}'s shape changed`;
    }
  }
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) return "The assembly's joints changed";
  return null;
}
