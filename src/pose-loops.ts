/**
 * Closed loops in Pose (docs/plan-pose-loops.md, L2). After the assembly tree is solved, each pin or line is brought
 * to its place by damped least squares on the joints the loop leaves free. This module is loaded with Pose, not with
 * the first chunk: it registers itself on the assembly reader and on reach.
 */
import { jointAt, setClosureSettle, solveAssembly, withClosures, type Assembly, type Closure, type Joint, type PoseOf } from "./assembly.ts";
import { applyPose, turnDir, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";
import { setReachSettle, turnBall, turnInAssembly } from "./pose.ts";

const CLOSE_MM = 1e-4;
const FAIL_MM = 0.01;
const MAX_STEP = 12;
const BRANCH = 40;
const STEP_EPS = 1e-2;
const PIECE = 5;

export interface LoopDriver {
  poseOf?: PoseOf;
  names?: (id: string) => string;
  centreOf?: (id: string) => Vec3 | undefined;
  separate?: ReadonlySet<string>;
  followLoops?: boolean;
  /** Joints this move already set: the one the user turns, a keyed joint, a coupling it carries. */
  driven?: ReadonlySet<string>;
}

export interface LoopTurned {
  assembly: Assembly;
  angles: ({ object: string; angle: number } | { object: string; travel: number })[];
  clamped: boolean;
  slipped?: string[];
  stopped?: string;
}

interface Dof { id: string; kind: "hinge" | "slide" | "ball"; axis?: Vec3 }
interface Cause { closure?: Closure; limited?: string; gap: number }

type TurnRunner = (assembly: Assembly, object: string, delta: number, options: LoopDriver) => LoopTurned | { reason: string };
type TrainMover = (assembly: Assembly, id: string, delta: number) => Assembly | { reason: string };
let turnRunner: TurnRunner | null = null;
let trainMover: TrainMover | null = null;

/** A gear train's turn, used to walk a driver in small steps and to move a free loop joint's train. */
export function setLoopTurn(runner: TurnRunner | null, mover: TrainMover | null): void {
  turnRunner = runner;
  trainMover = mover;
}

const hypot = (v: readonly number[]): number => Math.hypot(...v);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 | null => {
  const n = Math.hypot(...v);
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null;
};
const dofKey = (dof: Dof): string => dof.kind === "ball" ? `${dof.id}:${dof.axis?.join(",")}` : dof.id;
const memberOf = (assembly: Assembly, id: string) => assembly.members.find((row) => row.object === id);
const replace = (assembly: Assembly, member: Assembly["members"][number]): Assembly => ({ ...assembly, members: assembly.members.map((row) => row.object === member.object ? member : row) });

function chainUp(assembly: Assembly, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = memberOf(assembly, cur)?.parent ?? null;
  }
  return out;
}

/** Joints on the two paths up to the common ancestor: turning one of them moves only one side of the loop. */
export function loopJointIds(assembly: Assembly, closure: Closure): string[] {
  const upA = chainUp(assembly, closure.a.member);
  const upB = chainUp(assembly, closure.b.member);
  const common = upA.find((id) => upB.includes(id));
  const ids: string[] = [];
  for (const id of [...upA, ...upB]) {
    if (id === common || ids.includes(id)) continue;
    const joint = memberOf(assembly, id)?.joint;
    if (joint?.kind === "hinge" || joint?.kind === "slide" || joint?.kind === "ball") ids.push(id);
  }
  return ids;
}

function depth(assembly: Assembly, id: string): number {
  return chainUp(assembly, id).length;
}

function ancestor(assembly: Assembly, id: string, of: string): boolean {
  return chainUp(assembly, of).slice(1).includes(id);
}

/** The joints a coupling carries with `seeds`, so a driven gear is not also a free unknown. */
function blocked(assembly: Assembly, seeds: ReadonlySet<string>): Set<string> {
  const out = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of assembly.couplings ?? []) {
      if (row.kind === "clutch") continue;
      const ends = [row.driver, row.driven, ...(row.carrier ? [row.carrier.body] : []), ...(row.click ? [row.click.object] : [])];
      if (!ends.some((id) => out.has(id))) continue;
      for (const id of ends) if (!out.has(id)) { out.add(id); grew = true; }
    }
  }
  return out;
}

function coupled(assembly: Assembly, id: string): boolean {
  return (assembly.couplings ?? []).some((row) => row.kind !== "clutch" && (row.driver === id || row.driven === id || row.carrier?.body === id));
}

/** Loop joints the caller is not driving, one per gear train (its lead moves the rest). */
function freeJoints(assembly: Assembly, driven: ReadonlySet<string>): string[] {
  const held = blocked(assembly, driven);
  const all: string[] = [];
  for (const closure of assembly.closures ?? []) for (const id of loopJointIds(assembly, closure)) if (!all.includes(id)) all.push(id);
  const free = all.filter((id) => !held.has(id) && memberOf(assembly, id)?.joint).sort((a, b) => depth(assembly, a) - depth(assembly, b));
  const skip = new Set<string>();
  const out: string[] = [];
  for (const id of free) {
    if (skip.has(id)) continue;
    out.push(id);
    for (const row of assembly.couplings ?? []) {
      if (row.kind === "clutch") continue;
      const ends = [row.driver, row.driven, ...(row.carrier ? [row.carrier.body] : [])];
      if (ends.includes(id)) for (const other of ends) if (other !== id) skip.add(other);
    }
  }
  return out;
}

function dofsOf(assembly: Assembly, id: string): Dof[] {
  const joint = memberOf(assembly, id)?.joint;
  if (joint?.kind === "hinge" || joint?.kind === "slide") return [{ id, kind: joint.kind }];
  if (joint?.kind === "ball") return [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((axis) => ({ id, kind: "ball" as const, axis: axis as Vec3 }));
  return [];
}

function closureError(closure: Closure, poses: ReadonlyMap<string, Affine>): number[] {
  const poseA = poses.get(closure.a.member), poseB = poses.get(closure.b.member);
  if (!poseA || !poseB) return closure.kind === "line" ? [1e6, 1e6] : [1e6, 1e6, 1e6];
  const delta = sub(applyPose(poseA, closure.a.at), applyPose(poseB, closure.b.at));
  if (closure.kind !== "line" || !closure.b.along) return [delta[0], delta[1], delta[2]];
  const along = unit(turnDir(poseB, closure.b.along));
  if (!along) return [delta[0], delta[1]];
  const rest = sub(delta, [along[0] * dot(delta, along), along[1] * dot(delta, along), along[2] * dot(delta, along)]);
  const tmp: Vec3 = Math.abs(along[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(along, tmp))!;
  const v = cross(along, u);
  return [dot(rest, u), dot(rest, v)];
}

function errorsOf(assembly: Assembly, poseOf: PoseOf): number[] {
  const poses = solveAssembly(assembly, poseOf).poses;
  return (assembly.closures ?? []).flatMap((closure) => closureError(closure, poses));
}

function distances(assembly: Assembly, poseOf: PoseOf): number[] {
  const poses = solveAssembly(assembly, poseOf).poses;
  return (assembly.closures ?? []).map((closure) => hypot(closureError(closure, poses)));
}

/** The greatest closure error, in mm. A pin is the distance between its points; a line is the distance to the line. */
export function closureGapMm(assembly: Assembly, poseOf: PoseOf): number {
  const rows = distances(assembly, poseOf);
  return rows.length ? Math.max(...rows) : 0;
}

function room(assembly: Assembly, dof: Dof, dir: number): number {
  const joint = memberOf(assembly, dof.id)?.joint;
  if (!joint || joint.kind === "ball" || dof.kind === "ball") return Infinity;
  const at = jointAt(joint);
  const lo = joint.min ?? -Infinity, hi = joint.max ?? Infinity;
  return dir >= 0 ? hi - at : at - lo;
}

function applyDof(assembly: Assembly, dof: Dof, delta: number, centreOf: (id: string) => Vec3 | undefined): Assembly | null {
  if (Math.abs(delta) < 1e-15) return assembly;
  if (dof.kind === "ball" && dof.axis) {
    const member = memberOf(assembly, dof.id);
    if (!member) return null;
    const turned = turnBall(member, dof.axis, delta, centreOf(dof.id) ?? member.joint?.pivot ?? [0, 0, 0]);
    return "reason" in turned ? null : replace(assembly, turned);
  }
  if (coupled(assembly, dof.id) && trainMover) {
    const moved = trainMover(assembly, dof.id, delta);
    return "reason" in moved ? null : moved;
  }
  const turned = turnInAssembly(assembly, dof.id, delta);
  return "reason" in turned ? null : turned;
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col += 1) {
    let best = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r]![col]!) > Math.abs(M[best]![col]!)) best = r;
    const lead = M[best]![col]!;
    if (Math.abs(lead) < 1e-14) return null;
    [M[col], M[best]] = [M[best]!, M[col]!];
    for (let c = col; c <= n; c += 1) M[col]![c]! /= lead;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c += 1) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row) => row[n]!);
}

function rankOf(columns: number[][]): number {
  if (!columns.length || !columns[0]?.length) return 0;
  const rows = columns[0].map((_, i) => columns.map((col) => col[i]!));
  const m = rows.length, n = columns.length;
  let rank = 0;
  for (let col = 0; col < n && rank < m; col += 1) {
    let best = rank;
    for (let r = rank + 1; r < m; r += 1) if (Math.abs(rows[r]![col]!) > Math.abs(rows[best]![col]!)) best = r;
    if (Math.abs(rows[best]![col]!) < 1e-4) continue;
    [rows[rank], rows[best]] = [rows[best]!, rows[rank]!];
    const lead = rows[rank]![col]!;
    for (let c = col; c < n; c += 1) rows[rank]![c]! /= lead;
    for (let r = 0; r < m; r += 1) {
      if (r === rank) continue;
      const f = rows[r]![col]!;
      if (f !== 0) for (let c = col; c < n; c += 1) rows[r]![c]! -= f * rows[rank]![c]!;
    }
    rank += 1;
  }
  return rank;
}

function jacobian(assembly: Assembly, dofs: Dof[], poseOf: PoseOf, centreOf: (id: string) => Vec3 | undefined): number[][] {
  const base = errorsOf(assembly, poseOf);
  return dofs.map((dof) => {
    const nudged = applyDof(assembly, dof, STEP_EPS, centreOf);
    if (!nudged) return base.map(() => 0);
    const next = errorsOf(nudged, poseOf);
    return next.map((value, i) => (value - (base[i] ?? 0)) / STEP_EPS);
  });
}

function atLimit(joint: Joint | undefined): boolean {
  if (!joint || (joint.kind !== "hinge" && joint.kind !== "slide")) return false;
  const at = jointAt(joint);
  return (joint.min !== undefined && at <= joint.min + 1e-4) || (joint.max !== undefined && at >= joint.max - 1e-4);
}

function drifted(assembly: Assembly, starts: ReadonlyMap<string, number>): boolean {
  for (const [id, was] of starts) if (Math.abs(jointAt(memberOf(assembly, id)?.joint) - was) > BRANCH) return true;
  return false;
}

export interface LoopSolve { assembly: Assembly; closed: boolean; gap: number; cause: Cause }

/**
 * Move the free joints so every closure is within 1e-4 mm, starting from the pose the assembly already has.
 * A joint that a step clamps to its limit is left out of the next step. A step that would throw a joint onto the
 * other branch of a toggle is refused, so the warm pose keeps its branch.
 */
export function solveLoops(assembly: Assembly, options: LoopDriver = {}): LoopSolve {
  const poseOf = options.poseOf ?? (() => undefined);
  const centreOf = options.centreOf ?? (() => undefined);
  const driven = options.driven ?? new Set<string>();
  if (!assembly.closures?.length) return { assembly, closed: true, gap: 0, cause: { gap: 0 } };
  const free = freeJoints(assembly, driven);
  const starts = new Map(free.map((id) => [id, jointAt(memberOf(assembly, id)?.joint)]));
  let current = assembly;
  let lambda = 1e-3;
  let skip = new Set<string>();
  let gap = closureGapMm(current, poseOf);
  for (let iter = 0; iter < 48 && gap > CLOSE_MM; iter += 1) {
    let dofs = free.flatMap((id) => dofsOf(current, id)).filter((dof) => !skip.has(dofKey(dof)));
    if (!dofs.length) { skip = new Set(); dofs = free.flatMap((id) => dofsOf(current, id)); }
    if (!dofs.length) break;
    const base = errorsOf(current, poseOf);
    const cols = jacobian(current, dofs, poseOf, centreOf);
    const n = dofs.length;
    const A = Array.from({ length: n }, () => Array<number>(n).fill(0));
    const rhs = Array<number>(n).fill(0);
    for (let j = 0; j < n; j += 1) for (let k = 0; k < n; k += 1) {
      let sum = j === k ? lambda : 0;
      for (let i = 0; i < base.length; i += 1) sum += (cols[j]![i] ?? 0) * (cols[k]![i] ?? 0);
      A[j]![k] = sum;
    }
    for (let j = 0; j < n; j += 1) {
      let sum = 0;
      for (let i = 0; i < base.length; i += 1) sum += (cols[j]![i] ?? 0) * (base[i] ?? 0);
      rhs[j] = -sum;
    }
    const dx = solveLinear(A, rhs);
    if (!dx) { lambda = Math.min(lambda * 10, 1e12); continue; }
    const clamped = new Set<string>();
    let trial = current;
    let moved = false;
    for (let j = 0; j < n; j += 1) {
      let step = dx[j] ?? 0;
      if (!Number.isFinite(step)) continue;
      const allowed = Math.min(MAX_STEP, Math.max(0, room(trial, dofs[j]!, step)));
      if (Math.abs(step) > allowed + 1e-9) {
        step = Math.sign(step) * allowed;
        if (allowed < MAX_STEP - 1e-6) clamped.add(dofKey(dofs[j]!));
      }
      if (Math.abs(step) < 1e-12) continue;
      const next = applyDof(trial, dofs[j]!, step, centreOf);
      if (!next) { clamped.add(dofKey(dofs[j]!)); continue; }
      trial = next;
      moved = true;
    }
    const nextGap = closureGapMm(trial, poseOf);
    if (moved && nextGap < gap - 1e-15 && !drifted(trial, starts)) {
      current = trial;
      gap = nextGap;
      lambda = Math.max(lambda * 0.3, 1e-8);
      skip = clamped;
    } else {
      lambda = Math.min(lambda * 8, 1e12);
      skip = clamped.size ? clamped : skip;
      if (lambda >= 1e12) break;
    }
  }
  const worst = worstClosure(current, poseOf);
  const limited = free.find((id) => id && atLimit(memberOf(current, id)?.joint));
  return { assembly: current, closed: gap <= CLOSE_MM, gap, cause: { closure: worst, ...(limited ? { limited } : {}), gap } };
}

function worstClosure(assembly: Assembly, poseOf: PoseOf): Closure | undefined {
  const poses = solveAssembly(assembly, poseOf).poses;
  let worst: Closure | undefined, gap = -1;
  for (const closure of assembly.closures ?? []) {
    const distance = hypot(closureError(closure, poses));
    if (distance > gap) { gap = distance; worst = closure; }
  }
  return worst;
}

function shown(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** The sentence a move that cannot close carries, naming the loop and the joint or the dead point. */
export function loopSentence(assembly: Assembly, driver: string, names: (id: string) => string, cause: Cause, failed?: Assembly): string {
  const closure = cause.closure ?? assembly.closures?.[0];
  const a = names(closure?.a.member ?? "");
  const b = names(closure?.b.member ?? "");
  const joint = memberOf(assembly, driver)?.joint;
  const value = jointAt(joint);
  const unitText = joint?.kind === "slide" ? " mm" : "°";
  const who = cause.limited ?? (failed ? freeJoints(failed, new Set([driver])).find((id) => atLimit(memberOf(failed, id)?.joint)) : undefined);
  const why = who ? `${names(who)} is at its limit.` : "the links are at their dead point.";
  return `The loop between ${a} and ${b} cannot close past ${shown(value)}${unitText}: ${why}`;
}

function anglesBetween(before: Assembly, after: Assembly, first: string): LoopTurned["angles"] {
  const angles: LoopTurned["angles"] = [];
  const order = [first, ...after.members.map((row) => row.object).filter((id) => id !== first)];
  for (const id of order) {
    const was = memberOf(before, id)?.joint, now = memberOf(after, id)?.joint;
    if (!now || (now.kind !== "hinge" && now.kind !== "slide")) continue;
    if (id !== first && jointAt(now) === jointAt(was)) continue;
    angles.push(now.kind === "slide" ? { object: id, travel: jointAt(now) } : { object: id, angle: jointAt(now) });
  }
  return angles;
}

/**
 * The turn `trainTurn` already took, then the loops. A loop that cannot close to 0.01 mm clamps the driver back to
 * the last value that did, by bisection, and says why.
 */
export function followTurn(base: Assembly, turned: LoopTurned, object: string, delta: number, options: LoopDriver): LoopTurned {
  const names = options.names ?? ((id: string) => id);
  const poseOf = options.poseOf ?? (() => undefined);
  const driven = blocked(base, new Set([object, ...turned.angles.map((row) => row.object)]));
  const opts: LoopDriver = { ...options, poseOf, names, driven };
  const run = (from: Assembly, step: number): LoopSolve | { reason: string } => {
    if (!turnRunner) return solveLoops(from, opts);
    const trial = turnRunner(from, object, step, options);
    if ("reason" in trial) return trial;
    return solveLoops(trial.assembly, opts);
  };
  const accept = (solved: LoopSolve): boolean => solved.closed || solved.gap <= CLOSE_MM;
  if (Math.abs(delta) <= 1e-12) {
    const solved = solveLoops(base, opts);
    return accept(solved) ? { ...turned, assembly: solved.assembly } : { ...turned, stopped: loopSentence(base, object, names, solved.cause, solved.assembly), clamped: true };
  }
  let asm = base;
  let walked = 0;
  let cause: Cause = { gap: Infinity };
  let failed: Assembly | undefined;
  const sign = Math.sign(delta);
  let refused: string | undefined;
  while (Math.abs(delta - walked) > 1e-9) {
    const remain = delta - walked;
    const piece = Math.abs(remain) > PIECE ? PIECE * sign : remain;
    const one = run(asm, piece);
    if ("reason" in one) { refused = one.reason; break; }
    if (accept(one)) { asm = one.assembly; walked += piece; continue; }
    let lo = 0, hi = piece;
    let best = asm;
    cause = one.cause;
    failed = one.assembly;
    for (let i = 0; i < 28 && Math.abs(hi - lo) > 1e-4; i += 1) {
      const mid = lo + (hi - lo) / 2;
      const trial = run(asm, mid);
      if ("reason" in trial || !accept(trial)) {
        hi = mid;
        if (!("reason" in trial)) { cause = trial.cause; failed = trial.assembly; }
      } else { lo = mid; best = trial.assembly; }
    }
    asm = best;
    walked += lo;
    break;
  }
  const finished = !refused && Math.abs((delta - walked)) <= 1e-3 && closureGapMm(asm, poseOf) <= FAIL_MM;
  if (finished && closureGapMm(asm, poseOf) <= CLOSE_MM) {
    return { assembly: asm, angles: anglesBetween(base, asm, object), clamped: turned.clamped && Math.abs(walked - delta) <= 1e-3, ...(turned.slipped ? { slipped: turned.slipped } : {}), ...(turned.stopped ? { stopped: turned.stopped } : {}) };
  }
  const sentence = refused ?? loopSentence(asm, object, names, cause.gap < Infinity ? cause : { gap: closureGapMm(failed ?? asm, poseOf), closure: worstClosure(failed ?? asm, poseOf), limited: cause.limited }, failed);
  return { assembly: asm, angles: anglesBetween(base, asm, object), clamped: true, ...(turned.slipped && Math.abs(walked) > 1e-6 ? { slipped: turned.slipped } : {}), stopped: sentence };
}

function freshId(assembly: Assembly): string {
  const used = new Set((assembly.closures ?? []).map((row) => row.id));
  let n = (assembly.closures?.length ?? 0) + 1;
  while (used.has(`loop_${n}`)) n += 1;
  return `loop_${n}`;
}

export interface LoopEnds { member: string; at: Vec3; to: string; toAt: Vec3; along?: Vec3 }

/** Add a pin, or a line when `along` is set. A part and its own parent are a joint, and are refused. */
export function closeLoop(assembly: Assembly, ends: LoopEnds, names: (id: string) => string = (id) => id, poseOf: PoseOf = () => undefined): { assembly: Assembly; closure: Closure } | { reason: string } {
  if (!memberOf(assembly, ends.member) || !memberOf(assembly, ends.to)) return { reason: "Both parts of a loop are in one assembly." };
  if (ends.member === ends.to) return { reason: "A loop joins two parts." };
  if (![...ends.at, ...ends.toAt, ...(ends.along ?? [])].every((n) => Number.isFinite(n))) return { reason: "A loop needs finite points." };
  if (ancestor(assembly, ends.member, ends.to)) return { reason: `${names(ends.member)} is already ${names(ends.to)}'s parent: that is a joint, not a loop` };
  if (ancestor(assembly, ends.to, ends.member)) return { reason: `${names(ends.to)} is already ${names(ends.member)}'s parent: that is a joint, not a loop` };
  if (ends.along && Math.hypot(...ends.along) < 1e-12) return { reason: "A line needs a direction." };
  const closure: Closure = {
    id: freshId(assembly),
    kind: ends.along ? "line" : "pin",
    a: { member: ends.member, at: [...ends.at] },
    b: { member: ends.to, at: [...ends.toAt], ...(ends.along ? { along: [...ends.along] } : {}) },
  };
  const next = withClosures(assembly, [...(assembly.closures ?? []), closure]);
  const solved = solveLoops(next, { poseOf, driven: new Set(), names });
  if (solved.gap > FAIL_MM) return { reason: loopSentence(assembly, ends.member, names, solved.cause, solved.assembly) };
  return { assembly: solved.assembly, closure: solved.assembly.closures?.find((row) => row.id === closure.id) ?? closure };
}

/** Drop the loop with this id, or the loop that names this member. */
export function removeLoop(assembly: Assembly, which: string, other?: string): { assembly: Assembly } | { reason: string } {
  const rows = assembly.closures ?? [];
  const hit = rows.find((row) => row.id === which || (other !== undefined && ((row.a.member === which && row.b.member === other) || (row.b.member === which && row.a.member === other))) || (other === undefined && (row.a.member === which || row.b.member === which)));
  if (!hit) return { reason: "There is no loop there." };
  return { assembly: withClosures(assembly, rows.filter((row) => row !== hit)) };
}

/** A pin is three error rows; a line with a direction is two. Matches `closureError`. */
function errorWidth(closure: Closure): number {
  return closure.kind === "line" && closure.b.along ? 2 : 3;
}

/**
 * How many of this loop's joints can be keyed. The rank uses only this closure's rows: the other loops'
 * equations are carried by joints that are not in this set, and counting them makes a second pin look locked.
 */
function mobility(assembly: Assembly, closure: Closure, poseOf: PoseOf): number {
  const dofs = loopJointIds(assembly, closure).flatMap((id) => dofsOf(assembly, id));
  if (!dofs.length) return 0;
  let start = 0;
  for (const row of assembly.closures ?? []) {
    if (row === closure) break;
    start += errorWidth(row);
  }
  const width = errorWidth(closure);
  const columns = jacobian(assembly, dofs, poseOf, () => undefined).map((column) => column.slice(start, start + width));
  return Math.max(0, dofs.length - rankOf(columns));
}

/**
 * Keying a joint the loop already sets. The shallowest keyed joints, up to the loop's mobility, drive; the rest follow.
 * Two drivers that the loop can accept are not refused here: a frame that cannot close is.
 */
export function loopKeyRefusals(assembly: Assembly, keyed: ReadonlySet<string>, names: (id: string) => string, poseOf: PoseOf = () => undefined): string[] {
  const issues: string[] = [];
  for (const closure of assembly.closures ?? []) {
    const joints = loopJointIds(assembly, closure);
    const slots = mobility(assembly, closure, poseOf);
    const keyedHere = joints.filter((id) => keyed.has(id)).sort((a, b) => depth(assembly, a) - depth(assembly, b));
    let used = 0;
    const kept: string[] = [];
    for (const id of keyedHere) {
      const count = Math.max(1, dofsOf(assembly, id).length);
      if (used + count <= slots) { used += count; kept.push(id); continue; }
      const through = id === closure.a.member ? closure.b.member : closure.a.member;
      const driver = kept[0] ?? joints.find((other) => other !== id) ?? id;
      issues.push(`${names(id)} follows the loop through ${names(through)}: key ${names(driver)}.`);
    }
  }
  return issues;
}

/** Joints a rest key should leave alone: the loop sets them from the joints it keeps. */
export function loopFollowerIds(assembly: Assembly, poseOf: PoseOf = () => undefined): Set<string> {
  const out = new Set<string>();
  for (const closure of assembly.closures ?? []) {
    const joints = loopJointIds(assembly, closure);
    const slots = mobility(assembly, closure, poseOf);
    const kept = [...joints].sort((a, b) => depth(assembly, a) - depth(assembly, b)).slice(0, slots);
    for (const id of joints) if (!kept.includes(id)) out.add(id);
  }
  return out;
}

function settleOnRead(assembly: Assembly, poseOf: PoseOf): Assembly {
  if (closureGapMm(assembly, poseOf) <= CLOSE_MM) return assembly;
  const solved = solveLoops(assembly, { poseOf, driven: new Set() });
  return solved.closed ? solved.assembly : assembly;
}

setClosureSettle(settleOnRead);
setReachSettle((assembly, poseOf, driven, centreOf) => {
  const solved = solveLoops(assembly, { poseOf, driven: new Set(driven), centreOf });
  if (solved.closed || solved.gap <= FAIL_MM) return solved.assembly;
  const names = (id: string) => id;
  return { reason: loopSentence(assembly, [...driven][0] ?? assembly.closures?.[0]?.a.member ?? "", names, solved.cause, solved.assembly) };
});
