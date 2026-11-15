/**
 * Gear trains in an assembly (`docs/plan-gear-coupling.md`): couplings found from the pairs the mesh check calls
 * `meshing`, a turn of one gear carried through the train at the tooth ratios, locked trains refused, and a validator
 * that turns the train and asks the mesh check again. External spur gears on parallel axes only.
 *
 * The code that moves gears never reads the mesh check: `findCouplings` uses it to wire the train, and `trainCheck`
 * uses it to judge sampled frames. A turn is `turnHinge` on each body by its share of one delta.
 */
import { assemblyOf, bodyOf, couplingNames, couplingSeat, declaredOf, drives, frameOf, jointAt, jointUse, memberFields, rootOf, solveAssembly, withCouplings, withRootAt, type Assembly, type Body, type Coupling, type DeclaredKind, type GearRef, type Member, type PoseOf } from "./assembly.ts";
import { gearReach, worldPair, type GearVerdict, type WorldGear } from "./gear-pair.ts";
import { applyPose, inversePose, poseScale, relativePose, turnDir, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";
import { turnInAssembly } from "./pose.ts";
import { clickGeometry, clickLift, clickRefusal, faceMiddle } from "./ratchet-click.ts";

/** A gear's centre may sit this far from its hinge's line, mm. */
const ON_AXIS_MM = 0.05;
/** Hinge and gear axes are parallel within a degree, as the mesh check's planes are. */
const PARALLEL = Math.cos(Math.PI / 180);

export { bodyOf, frameOf, type Body };

export interface NotCoupled {
  names: [string, string];
  verdict?: GearVerdict;
  reason: string;
}

export interface TrainLock {
  /** The gears of the locked train, by label. */
  gears: string[];
  reason: string;
}

export interface Found {
  couplings: Coupling[];
  notCoupled: NotCoupled[];
  locked: TrainLock[];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(...v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
};

function memberOf(assembly: Assembly, object: string): Member | undefined {
  return assembly.members.find((row) => row.object === object);
}

/** A hinge's axis and a point on it, in model space. Null for a body without a hinge. */
function hingeLine(assembly: Assembly, poses: ReadonlyMap<string, Affine>, body: string): { axis: Vec3; point: Vec3 } | null {
  const member = memberOf(assembly, body), pose = poses.get(body);
  if (!member || !pose || member.joint?.kind !== "hinge") return null;
  return { axis: unit(turnDir(pose, member.joint.axis)), point: applyPose(pose, member.joint.pivot) };
}

/** Why a pair that is not `meshing` is not coupled, one sentence. */
export function notCoupledSentence(a: string, b: string, verdict: GearVerdict, distanceMm?: number, workingMm?: number, reason?: string): string {
  const mm = (value: number) => String(Math.round(value * 100) / 100);
  const centres = distanceMm !== undefined && workingMm !== undefined ? ` (centres ${mm(distanceMm)} mm apart, they mesh at ${mm(workingMm)} mm)` : "";
  const why = verdict === "tooClose" ? `they are too close${centres}`
    : verdict === "loose" ? `they are too far apart${centres}`
    : verdict === "toothOnTooth" ? "their teeth cross"
    : verdict === "unbuildable" ? `one cannot be built${reason ? `: ${reason.replace(/\.$/, "")}` : ""}`
    : verdict === "moduleMismatch" ? "their modules differ"
    : verdict === "pressureMismatch" ? "their pressure angles differ"
    : "they do not mesh";
  return `${a} and ${b} are not coupled: ${why}.`;
}

/** A slide's direction in model space. Null for a body without a slide. */
function slideLine(assembly: Assembly, poses: ReadonlyMap<string, Affine>, body: string): Vec3 | null {
  const member = memberOf(assembly, body), pose = poses.get(body);
  if (!member || !pose || member.joint?.kind !== "slide") return null;
  return unit(turnDir(pose, member.joint.axis));
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The sentence for two gears whose axes are not parallel and whose teeth may reach each other (their bounding spheres
 * meet): bevel gears and worms are not covered (docs/plan-gear-kinds.md, stage 4). Null when the axes are parallel or
 * the gears stand clear.
 */
export function crossedSentence(a: WorldGear, b: WorldGear): string | null {
  const cos = Math.abs(dot(a.axis, b.axis));
  if (cos >= PARALLEL) return null;
  const reach = (gear: WorldGear) => Math.hypot(gearReach(gear), gear.thickness / 2);
  if (Math.hypot(...minus(a.centre, b.centre)) > reach(a) + reach(b)) return null;
  const degrees = Math.round((Math.acos(Math.min(1, cos)) * 180) / Math.PI);
  return `${a.label} and ${b.label} are not coupled: their axes cross at ${degrees}°, and bevel gears and worms are not covered.`;
}

/** Each gear of `start`'s that crosses another's axis within reach, one sentence each. */
export function crossedNotes(gears: readonly WorldGear[], start: string): string[] {
  const mine = gears.filter((gear) => gear.objectId === start);
  return mine.flatMap((gear) => gears.filter((other) => other.objectId !== start).flatMap((other) => crossedSentence(gear, other) ?? []));
}

/** Whether `gear`'s centre lies on `line`, the axes parallel. */
function onLine(gear: WorldGear, line: { axis: Vec3; point: Vec3 } | null): boolean {
  if (!line || Math.abs(dot(line.axis, gear.axis)) < PARALLEL) return false;
  const along = minus(gear.centre, line.point);
  const t = dot(along, line.axis);
  return Math.hypot(along[0] - t * line.axis[0], along[1] - t * line.axis[1], along[2] - t * line.axis[2]) <= ON_AXIS_MM;
}

/** `gear` turned `degrees` about its own axis. */
function turnedGear(gear: WorldGear, degrees: number): WorldGear {
  const [x, y, z] = gear.axis;
  const r = (degrees * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), k = 1 - c;
  const [a, b, d] = gear.tooth0;
  const tooth0: Vec3 = [
    (k * x * x + c) * a + (k * x * y - s * z) * b + (k * x * z + s * y) * d,
    (k * x * y + s * z) * a + (k * y * y + c) * b + (k * y * z - s * x) * d,
    (k * x * z - s * y) * a + (k * y * z + s * x) * b + (k * z * z + c) * d,
  ];
  return { ...gear, tooth0 };
}

/**
 * Whether a pinion and a ring that mesh where they stand still mesh as they turn together, by the tooth ratio, the
 * same way: twelve steps through a pitch of the pinion.
 */
function holdsAsItTurns(a: WorldGear, b: WorldGear): boolean {
  const pinion = a.internal ? b : a, ring = a.internal ? a : b;
  const same = Math.sign(dot(pinion.axis, ring.axis)) || 1;
  for (let k = 1; k <= 12; k += 1) {
    const turn = (360 / pinion.spur.teeth) * (k / 12);
    const report = worldPair(turnedGear(pinion, turn), turnedGear(ring, same * turn * (pinion.spur.teeth / ring.spur.teeth)));
    if (report?.verdict !== "meshing") return false;
  }
  return true;
}

function refOf(gear: WorldGear): GearRef {
  return { object: gear.objectId, step: gear.step, name: gear.label };
}

/**
 * The couplings of `assembly`'s gears at `poses`: every pair the mesh check calls `meshing`, on two bodies that turn
 * on one frame about the gears' own axes. `gears` are the members' gears placed at those poses.
 */
export function findCouplings(assembly: Assembly, gears: readonly WorldGear[], poses: ReadonlyMap<string, Affine>, nameOfBody: (body: string) => string = (body) => gears.find((gear) => gear.objectId === body)?.label ?? body): Found {
  const couplings: Coupling[] = [];
  const notCoupled: NotCoupled[] = [];
  const offAxis = (gear: WorldGear, body: string): boolean => {
    const line = hingeLine(assembly, poses, body);
    if (!line) return false;
    const along = minus(gear.centre, line.point);
    const t = dot(along, line.axis);
    const off = Math.hypot(along[0] - t * line.axis[0], along[1] - t * line.axis[1], along[2] - t * line.axis[2]);
    return Math.abs(dot(line.axis, gear.axis)) < PARALLEL || off > ON_AXIS_MM;
  };
  for (let i = 0; i < gears.length; i += 1) {
    for (let j = i + 1; j < gears.length; j += 1) {
      const a = gears[i]!, b = gears[j]!;
      // Two gears of one solid are one body.
      if (a.objectId === b.objectId) continue;
      const bodyA = bodyOf(assembly, a.objectId), bodyB = bodyOf(assembly, b.objectId);
      if (!bodyA || !bodyB) continue;
      if ("body" in bodyA && "body" in bodyB && bodyA.body === bodyB.body) {
        // One body: a shared shaft, which is never a pair. On the fixed body (neither gear has a hinge) a mesh is
        // said, since silence there read as "No pair of these gears meshes."
        if (bodyA.fixed && worldPair(a, b)?.verdict === "meshing") notCoupled.push({ names: [a.label, b.label], reason: `${a.label} and ${b.label} are not coupled: they mesh, but neither has a hinge to turn on.` });
        continue;
      }
      const report = worldPair(a, b);
      // Axes that cross (docs/plan-gear-kinds.md, stage 4): bevel gears and worms are not covered, and say so.
      if (!report) {
        const crossed = crossedSentence(a, b);
        if (crossed) notCoupled.push({ names: [a.label, b.label], reason: crossed });
        continue;
      }
      if (report.verdict === "apart") continue;
      const names: [string, string] = [a.label, b.label];
      if (report.verdict !== "meshing") {
        notCoupled.push({ names, verdict: report.verdict, reason: notCoupledSentence(a.label, b.label, report.verdict, report.distanceMm, report.workingMm, report.reason) });
        continue;
      }
      if ("reason" in bodyA || "reason" in bodyB) {
        const [gear, why] = "reason" in bodyA ? [a.label, bodyA.reason] : [b.label, (bodyB as { reason: string }).reason];
        notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: ${gear} ${why}.` });
        continue;
      }
      if (bodyA.fixed && bodyB.fixed) continue;
      // A rack (docs/plan-gear-kinds.md, stage 3) drives on a slide along its own teeth, against a pinion's hinge.
      if (a.rack || b.rack) {
        const [rack, rackBody, pinion, pinionBody] = a.rack ? [a, bodyA, b, bodyB] : [b, bodyB, a, bodyA];
        const rackJoint = memberOf(assembly, rackBody.body)?.joint;
        if (!rackBody.fixed && rackJoint?.kind !== "slide") {
          notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: ${rack.label} turns on a hinge, and a rack is driven only on a slide.` });
          continue;
        }
        if (!pinionBody.fixed && memberOf(assembly, pinionBody.body)?.joint?.kind !== "hinge") {
          notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: ${pinion.label} slides, and a rack's pinion turns on a hinge.` });
          continue;
        }
        if (frameOf(assembly, rackBody.body) !== frameOf(assembly, pinionBody.body) || frameOf(assembly, rackBody.body) === null) {
          notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: their joints sit on different parts, and a rack rides only on the part its pinion turns on.` });
          continue;
        }
        const slide = rackBody.fixed ? null : slideLine(assembly, poses, rackBody.body);
        if (slide && Math.abs(dot(slide, rack.tooth0)) < PARALLEL) {
          notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: ${rack.label}'s slide does not run along its teeth.` });
          continue;
        }
        if (!pinionBody.fixed && offAxis(pinion, pinionBody.body)) {
          notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: ${pinion.label}'s hinge does not turn about its gear's axis.` });
          continue;
        }
        // Turned + about its own axis, the pinion's pitch point runs along teeth x axis; the rack travels with it.
        const teeth = unit(cross(rack.axis, rack.tooth0));
        const run = unit(cross(teeth, pinion.axis));
        const hinge = hingeLine(assembly, poses, pinionBody.body)?.axis ?? pinion.axis;
        const along = slide ?? rack.tooth0;
        const mmPerDeg = ((Math.PI * pinion.spur.module * pinion.spur.teeth) / 360) * (Math.sign(dot(run, along)) || 1) * (Math.sign(dot(pinion.axis, hinge)) || 1);
        const ratio = a.rack ? 1 / mmPerDeg : mmPerDeg;
        const gearRefs: [GearRef, GearRef] = [refOf(a), refOf(b)];
        const seat = couplingSeat(assembly, gearRefs);
        couplings.push({ driver: bodyA.body, driven: bodyB.body, ratio, gears: gearRefs, rack: a.rack ? "driver" : "driven", ...(seat ? { seat } : {}) });
        continue;
      }
      const frameA = frameOf(assembly, bodyA.body), frameB = frameOf(assembly, bodyB.body);
      // A planet (docs/plan-gear-kinds.md, stage 2): one gear hinges on a turning part K, the carrier, and the other
      // on the part K turns on, coaxial with K's hinge. Either way round.
      const carrierFor = (planetFrame: string | null, otherFrame: string | null, other: WorldGear): string | null => {
        if (planetFrame === null || otherFrame === null) return null;
        const k = memberOf(assembly, planetFrame);
        if (k?.joint?.kind !== "hinge" || frameOf(assembly, planetFrame) !== otherFrame) return null;
        return onLine(other, hingeLine(assembly, poses, planetFrame)) ? planetFrame : null;
      };
      const carrierBody = frameA === frameB ? null : carrierFor(frameA, frameB, b) ?? carrierFor(frameB, frameA, a);
      if (frameA === null || frameB === null || (frameA !== frameB && carrierBody === null)) {
        const why = frameA === null || frameB === null ? "a gear that rides on another turning part is not covered" : "a gear that rides on another turning part is covered only on a carrier whose hinge shares the other gear's axis";
        notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: their hinges sit on different parts, and ${why}.` });
        continue;
      }
      const skew = [[a, bodyA] as const, [b, bodyB] as const].find(([gear, body]) => !body.fixed && offAxis(gear, body.body));
      if (skew) {
        notCoupled.push({ names, reason: `${a.label} and ${b.label} are not coupled: ${skew[0].label}'s hinge does not turn about its gear's axis.` });
        continue;
      }
      // An internal pair is checked through a pitch of its turn as well: a pinion too big for its ring turns into it.
      const internal = !!a.internal !== !!b.internal;
      if (internal && !holdsAsItTurns(a, b)) {
        notCoupled.push({ names, verdict: "toothOnTooth", reason: `${a.label} and ${b.label} are not coupled: their teeth cross as they turn.` });
        continue;
      }
      // A fixed body has no hinge; its gear's axis stands in, as its sign does not matter to a train that cannot turn.
      const axisA = hingeLine(assembly, poses, bodyA.body)?.axis ?? a.axis;
      const axisB = hingeLine(assembly, poses, bodyB.body)?.axis ?? b.axis;
      // Inside a ring both turn the same way; outside, the other way.
      const rho = (internal ? 1 : -1) * (a.spur.teeth / b.spur.teeth);
      const ratio = rho * Math.sign(dot(axisA, axisB));
      const gearRefs: [GearRef, GearRef] = [refOf(a), refOf(b)];
      let carrier: Coupling["carrier"];
      if (carrierBody !== null) {
        // In the carrier's frame the mesh is a fixed-axis one: (b - K) = rho (a - K), each about the carrier's axis u.
        const u = hingeLine(assembly, poses, carrierBody)!.axis;
        const sB = Math.sign(dot(axisB, u)) || 1;
        const aOff = frameA === carrierBody ? 0 : 1, bOff = frameB === carrierBody ? 0 : 1;
        carrier = { body: carrierBody, name: nameOfBody(carrierBody), ratio: sB * (bOff - rho * aOff) };
      }
      const seat = couplingSeat(assembly, gearRefs, carrierBody ?? undefined);
      couplings.push({ driver: bodyA.body, driven: bodyB.body, ratio, gears: gearRefs, ...(carrier ? { carrier } : {}), ...(seat ? { seat } : {}) });
    }
  }
  const oriented = orientOutward(assembly, couplings);
  return { couplings: oriented, notCoupled, locked: trainLocks(assembly, [...declaredOf(assembly), ...oriented]) };
}

/**
 * Each coupling turned to read outward from its train's first body in member order, so a train reads "pinion drives
 * wheel, wheel drives third" from the gear a person would turn. The ratio inverts with it; the motion is the same.
 */
function orientOutward(assembly: Assembly, couplings: Coupling[]): Coupling[] {
  const order = new Map(assembly.members.map((row, i) => [row.object, i]));
  const depth = new Map<string, number>();
  // A body that cannot turn (the fixed root, a held part) never leads: a train reads from a gear a person turns.
  const fixed = (id: string) => !drives(assembly.members.find((row) => row.object === id)?.joint);
  const bodies = [...new Set(couplings.flatMap((row) => [row.driver, row.driven]))].sort((a, b) => Number(fixed(a)) - Number(fixed(b)) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const start of bodies) {
    if (depth.has(start)) continue;
    depth.set(start, 0);
    for (const queue = [start]; queue.length;) {
      const at = queue.shift()!;
      for (const row of couplings) {
        const other = row.driver === at ? row.driven : row.driven === at ? row.driver : null;
        if (other !== null && !depth.has(other)) { depth.set(other, depth.get(at)! + 1); queue.push(other); }
      }
    }
  }
  return couplings.map((row) => {
    if (depth.get(row.driver)! <= depth.get(row.driven)!) return row;
    const gears: [GearRef, GearRef] = [row.gears![1], row.gears![0]];
    const seat = couplingSeat(assembly, gears, row.carrier?.body);
    // driven = r driver + c carrier, so driver = driven / r - (c / r) carrier.
    const carrier = row.carrier ? { ...row.carrier, ratio: -row.carrier.ratio / row.ratio } : undefined;
    const rack = row.rack === "driver" ? "driven" as const : row.rack === "driven" ? "driver" as const : undefined;
    return { driver: row.driven, driven: row.driver, ratio: 1 / row.ratio, gears, ...(carrier ? { carrier } : {}), ...(rack ? { rack } : {}), ...(seat ? { seat } : {}) };
  });
}

export interface TrainOptions {
  /**
   * Bodies driven on their own in this turn, besides the one turned: an animation's keyed bodies. A clutch whose driven
   * side holds one of them slips (docs/plan-coupling-kinds.md, stage 4).
   */
  separate?: ReadonlySet<string>;
}

export interface Scales {
  /** Degrees (or mm) each body of the train moves for one degree (or mm) of the start. */
  scales: Map<string, number>;
  /** The couplings of this train. */
  couplings: Coupling[];
  locked?: TrainLock;
  /** Each clutch that slips in this turn, with its sentence. */
  slipped?: { coupling: Coupling; reason: string }[];
  /**
   * Each body's group: 0 is the start's, and every side a clutch carries is a group of its own, `parents[g]` the group
   * it is carried by. A group stops at its own joint limits, and its clutch slips past them.
   */
  groups?: Map<string, number>;
  parents?: number[];
  /**
   * Ratchets turned against their free way while their click stands off its seat: the click first rides back down the
   * tooth, free for `allow` of the start's units, and only then does the ratchet carry its part.
   */
  backlash?: { coupling: Coupling; allow: number }[];
}

const sameScale = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function gearNames(couplings: readonly Coupling[]): string[] {
  return [...new Set(couplings.flatMap((row) => couplingNames(row)))];
}

function listed(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Whether a coupling ties its two bodies rigidly in this turn: a gear mesh, a ratio, a winch, or an engaged ratchet. */
function rigid(row: Coupling, engaged: ReadonlySet<Coupling>): boolean {
  return row.kind === "clutch" ? false : row.kind === "ratchet" ? engaged.has(row) : true;
}

/** A ratchet's click phase now: degrees the wheel has run free past the notch the click last dropped into. */
export function clickPhase(row: Coupling): number {
  return row.click?.phase ?? 0;
}

/**
 * One rigid component: every body the start reaches through rigid couplings (`rigid`), each at its scale. A body reached
 * at two scales closes a loop whose ratios disagree; a body that cannot move (the fixed root, a held part) in it means
 * the component cannot move. Either is a lock, with its sentence.
 */
function component(assembly: Assembly, all: readonly Coupling[], start: string, engaged: ReadonlySet<Coupling>): { scales: Map<string, number>; used: Coupling[]; lock?: TrainLock } {
  const scales = new Map<string, number>([[start, 1]]);
  const used = new Set<Coupling>();
  const queue = [start];
  let loop: Coupling | undefined;
  while (queue.length) {
    const at = queue.shift()!;
    const scale = scales.get(at)!;
    for (const row of all) {
      if ((row.driver !== at && row.driven !== at) || !rigid(row, engaged)) continue;
      used.add(row);
      const [other, next] = row.driver === at ? [row.driven, scale * row.ratio] : [row.driver, scale / row.ratio];
      const seen = scales.get(other);
      if (seen === undefined) {
        scales.set(other, next);
        queue.push(other);
      } else if (!sameScale(seen, next)) loop ??= row;
    }
  }
  const couplings = all.filter((row) => used.has(row));
  // A body without a hinge or slide cannot move: the fixed root, or a held part. A root with a hinge turns on the plate.
  const fixed = [...scales.keys()].filter((body) => memberOf(assembly, body) !== undefined && !drives(memberOf(assembly, body)!.joint));
  const names = gearNames(couplings);
  const gearsOnly = couplings.every((row) => row.kind === undefined);
  if (loop) return { scales, used: couplings, lock: { gears: names, reason: `${listed(names)} are locked: they close a loop whose ${gearsOnly ? "tooth ratios" : "ratios"} do not agree, so none of them can turn.` } };
  if (fixed.length && couplings.length) {
    // A ratchet that holds against a part that stays says so in its own words.
    const holding = couplings.find((row) => row.kind === "ratchet" && fixed.includes(row.driven));
    if (holding) {
      const [wheel, part] = couplingNames(holding);
      return { scales, used: couplings, lock: { gears: names, reason: `${wheel} turns only ${holding.free === 1 ? "forward" : "back"}: its click on ${part} holds it the other way.` } };
    }
    const held = couplings.filter((row) => fixed.includes(row.driver) || fixed.includes(row.driven)).map((row) => (fixed.includes(row.driver) ? couplingNames(row)[0] : couplingNames(row)[1]));
    const tail = gearsOnly ? "the train meshes with it" : "the train is coupled to it";
    return { scales, used: couplings, lock: { gears: names, reason: `${listed(names)} are locked: ${listed([...new Set(held)])} cannot turn, and ${tail}.` } };
  }
  return { scales, used: couplings };
}

/**
 * The start's rigid component, then each side a clutch carries (docs/plan-coupling-kinds.md, stage 4): a clutch carries
 * its driven side from its driver at its ratio, unless that side cannot move (it holds a fixed or held part, or locks)
 * or holds a body driven on its own (`separate`); a turn that starts on the driven side never passes back. Then it slips.
 */
function solveTrain(assembly: Assembly, all: readonly Coupling[], start: string, engaged: ReadonlySet<Coupling>, options: TrainOptions): Scales {
  const first = component(assembly, all, start, engaged);
  if (first.lock) return { scales: first.scales, couplings: first.used, locked: first.lock };
  const scales = new Map(first.scales);
  const groups = new Map([...scales.keys()].map((id) => [id, 0]));
  const parents = [-1];
  const used = [...first.used];
  const slipped: { coupling: Coupling; reason: string }[] = [];
  const handled = new Set<Coupling>();
  for (let grew = true; grew;) {
    grew = false;
    for (const row of all) {
      if (row.kind !== "clutch" || handled.has(row)) continue;
      const driverIn = scales.has(row.driver), drivenIn = scales.has(row.driven);
      if (!driverIn && !drivenIn) continue;
      handled.add(row);
      const [driverName, drivenName] = couplingNames(row);
      if (drivenIn) {
        // Both ends already move with the turn, or the turn started on the driven side: nothing passes, it slips.
        if (!driverIn || !sameScale(scales.get(row.driven)!, scales.get(row.driver)! * row.ratio)) slipped.push({ coupling: row, reason: driverIn ? `The clutch between ${driverName} and ${drivenName} slips: both are turned.` : `${driverName} stays: the clutch slips when ${drivenName} is turned on its own.` });
        continue;
      }
      const side = component(assembly, all, row.driven, engaged);
      const bodies = [...side.scales.keys()];
      if (side.lock || bodies.some((id) => scales.has(id))) { slipped.push({ coupling: row, reason: `${drivenName} stays: the clutch from ${driverName} slips, as ${drivenName} cannot move.` }); continue; }
      if (options.separate && bodies.some((id) => options.separate!.has(id))) { slipped.push({ coupling: row, reason: `${drivenName} is driven on its own: the clutch from ${driverName} slips.` }); continue; }
      const group = parents.length;
      parents.push(groups.get(row.driver)!);
      const at = scales.get(row.driver)! * row.ratio;
      for (const [id, scale] of side.scales) { scales.set(id, at * scale); groups.set(id, group); }
      used.push(row, ...side.used);
      grew = true;
    }
  }
  return { scales, couplings: used, ...(slipped.length ? { slipped } : {}), groups, parents };
}

/**
 * Every body the train of `start` reaches, with its scale, for a turn of sign `sign` (+1, -1, or 0 when the way is not
 * known: a listing). A body reached at two scales closes a loop whose ratios disagree; a fixed body in the train cannot
 * turn. Either locks the train. A ratchet ties its two bodies only when the turn goes against its free way (with 0 it
 * runs free); a clutch carries its driven side unless that side is held or driven on its own.
 */
export function trainScales(assembly: Assembly, start: string, sign = 0, options: TrainOptions = {}): Scales {
  const all = assembly.couplings ?? [];
  // A train with a carrier in it is a set of linear equations (docs/plan-gear-kinds.md, stage 2).
  const reached = new Set([start]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of all) {
      const ends = [row.driver, row.driven, ...(row.carrier ? [row.carrier.body] : [])];
      if (ends.some((id) => reached.has(id)) && ends.some((id) => !reached.has(id))) { for (const id of ends) reached.add(id); grew = true; }
    }
  }
  const train = all.filter((row) => reached.has(row.driver));
  if (train.some((row) => row.carrier)) {
    const odd = train.find((row) => row.kind === "ratchet" || row.kind === "clutch");
    if (odd) return { scales: new Map([[start, 1]]), couplings: train, locked: { gears: gearNames(train), reason: `${listed(couplingNames(odd))} are not covered: a ratchet or a clutch in a train with a planet carrier.` } };
    return planetaryScales(assembly, start, [...reached], train);
  }
  const ratchets = all.filter((row) => row.kind === "ratchet");
  const engaged = new Set<Coupling>();
  for (;;) {
    const solved = solveTrain(assembly, all, start, engaged, options);
    if (solved.locked || !sign) return solved;
    // A ratchet turned against its free way carries its part: tie it and solve again. Ties only grow, so this ends.
    const backlash: { coupling: Coupling; allow: number }[] = [];
    let grew = false;
    for (const row of ratchets) {
      if (engaged.has(row)) continue;
      const a = solved.scales.get(row.driver) ?? 0, b = solved.scales.get(row.driven) ?? 0;
      const rel = sign * (a - b / row.ratio);
      if (Math.abs(rel) < 1e-12 || rel * (row.free ?? 1) > 0) continue;
      const phase = clickPhase(row);
      if (phase > 1e-9) { backlash.push({ coupling: row, allow: phase / Math.abs(rel) }); continue; }
      engaged.add(row);
      grew = true;
    }
    if (!grew) return backlash.length ? { ...solved, backlash } : solved;
  }
}

/**
 * A train with a carrier: every coupling is `driven - ratio driver - carrier.ratio carrier = 0`, a body without a hinge
 * (a fixed root, a held part) stands at 0, and `start` turns 1. Solved by elimination: no solution is a lock, more than
 * one means sun, ring and carrier all turn freely, and one of them must be held.
 */
function planetaryScales(assembly: Assembly, start: string, bodies: string[], couplings: Coupling[]): Scales {
  const index = new Map(bodies.map((id, i) => [id, i]));
  const n = bodies.length;
  const rows: number[][] = [];
  for (const row of couplings) {
    const eq = new Array<number>(n + 1).fill(0);
    eq[index.get(row.driven)!]! += 1;
    eq[index.get(row.driver)!]! -= row.ratio;
    if (row.carrier) eq[index.get(row.carrier.body)!]! -= row.carrier.ratio;
    rows.push(eq);
  }
  const fixed = bodies.filter((id) => !drives(memberOf(assembly, id)?.joint));
  for (const id of fixed) { const eq = new Array<number>(n + 1).fill(0); eq[index.get(id)!] = 1; rows.push(eq); }
  { const eq = new Array<number>(n + 1).fill(0); eq[index.get(start)!] = 1; eq[n] = 1; rows.push(eq); }
  // Gauss-Jordan with partial pivoting.
  let rank = 0;
  const pivots: number[] = [];
  for (let col = 0; col < n && rank < rows.length; col += 1) {
    let best = rank;
    for (let r = rank + 1; r < rows.length; r += 1) if (Math.abs(rows[r]![col]!) > Math.abs(rows[best]![col]!)) best = r;
    if (Math.abs(rows[best]![col]!) < 1e-9) continue;
    [rows[rank], rows[best]] = [rows[best]!, rows[rank]!];
    const lead = rows[rank]![col]!;
    for (let c = col; c <= n; c += 1) rows[rank]![c]! /= lead;
    for (let r = 0; r < rows.length; r += 1) {
      if (r === rank) continue;
      const f = rows[r]![col]!;
      if (f !== 0) for (let c = col; c <= n; c += 1) rows[r]![c]! -= f * rows[rank]![c]!;
    }
    pivots.push(col);
    rank += 1;
  }
  const inconsistent = rows.slice(rank).some((row) => Math.abs(row[n]!) > 1e-7);
  // A locked train still names every body that turns in it, so it is said once.
  const all = () => { for (const id of bodies) if (!fixed.includes(id)) scales.set(id, id === start ? 1 : 0); };
  const names = [...gearNames(couplings), ...new Set(couplings.flatMap((row) => (row.carrier ? [row.carrier.name] : [])))];
  const scales = new Map<string, number>();
  if (inconsistent || rank < n) all();
  if (inconsistent) {
    const held = fixed.flatMap((id) => couplings.flatMap((row) => (row.driver === id ? [couplingNames(row)[0]] : row.driven === id ? [couplingNames(row)[1]] : row.carrier?.body === id ? [row.carrier.name] : [])));
    return { scales, couplings, locked: { gears: names, reason: held.length ? `${listed(names)} are locked: ${listed([...new Set(held)])} cannot turn, and the train meshes with it.` : `${listed(names)} are locked: they close a loop whose tooth ratios do not agree, so none of them can turn.` } };
  }
  if (rank < n) {
    return { scales, couplings, locked: { gears: names, reason: `${listed(names)} turn more than one way: hold the sun, the ring or the carrier (Joint: Held), and the others follow.` } };
  }
  // A held body stands still: it is in the equations, not in the turn.
  pivots.forEach((col, r) => { if (!fixed.includes(bodies[col]!)) scales.set(bodies[col]!, rows[r]![n]!); });
  // The start first, as the walk gives it.
  return { scales: new Map([[start, 1], ...[...scales].filter(([id]) => id !== start)]), couplings };
}

/** Each locked train of `couplings`, once. */
function trainLocks(assembly: Assembly, couplings: Coupling[]): TrainLock[] {
  const coupled = withCouplings(assembly, couplings);
  const seen = new Set<string>();
  const locks: TrainLock[] = [];
  for (const row of couplings) {
    for (const body of [row.driver, row.driven]) {
      // A held body is not where a turn starts: in a planetary stage it holds the train, it does not lock it.
      if (seen.has(body) || !drives(coupled.members.find((one) => one.object === body)?.joint)) continue;
      const train = trainScales(coupled, body);
      for (const id of train.scales.keys()) seen.add(id);
      if (train.locked) locks.push(train.locked);
    }
  }
  return locks;
}

export interface Turned {
  assembly: Assembly;
  /** Every hinge the turn moved, with its new angle, and every slide with its new travel; the turned one first. */
  angles: ({ object: string; angle: number } | { object: string; travel: number })[];
  /** True when a joint limit, or a ratchet after its click's free play, held the train short of the asked turn. */
  clamped: boolean;
  /** Each clutch that slipped, in a sentence. */
  slipped?: string[];
  /** Why the train stopped short after it had moved: a ratchet that holds once its click is back on its seat. */
  stopped?: string;
}

/** A body's group step: `step` clamped to the group's own joint limits, in the start's units. */
function groupRange(assembly: Assembly, scales: ReadonlyMap<string, number>, groups: ReadonlyMap<string, number> | undefined, group: number): [number, number] {
  let low = -Infinity, high = Infinity;
  for (const [body, scale] of scales) {
    if ((groups?.get(body) ?? 0) !== group) continue;
    const joint = memberOf(assembly, body)?.joint;
    // A hinge's limits are degrees, a slide's millimetres: each is its own body's share of the step.
    if (!drives(joint)) continue;
    const angle = jointAt(joint);
    const lo = joint.min === undefined ? -Infinity : (joint.min - angle) / scale;
    const hi = joint.max === undefined ? Infinity : (joint.max - angle) / scale;
    low = Math.max(low, Math.min(lo, hi));
    high = Math.min(high, Math.max(lo, hi));
  }
  return [low, high];
}

const clampTo = (value: number, [low, high]: [number, number]) => (low > high ? 0 : Math.max(low, Math.min(high, value)));

/** The click's hinge angle for a phase: its seat plus the least lift that clears the teeth (`src/ratchet-click.ts`). */
export function clickAngle(click: NonNullable<Coupling["click"]>, phase: number): number {
  return click.zero + click.sense * clickLift({ teeth: click.teeth, tip: click.tip, root: click.root, arm: click.arm }, phase);
}

/**
 * Each ratchet's click put where the wheel's turn from `before` to `after` leaves it: the wheel's phase past its notch
 * grows as it runs free (the nose rides up the tooth's back and drops into the next notch each pitch) and shrinks as it
 * turns the other way (the nose rides back down to its seat). Engaged, the wheel and the click's part turn together and
 * the click stays where it is on its part. The phase is kept on the coupling.
 */
function moveClicks(before: Assembly, after: Assembly): Assembly | { reason: string } {
  let next = after;
  const rows = after.couplings ?? [];
  for (const [index, row] of rows.entries()) {
    if (row.kind !== "ratchet" || !row.click) continue;
    const at = (assembly: Assembly, id: string) => jointAt(memberOf(assembly, id)?.joint);
    const rel = (at(after, row.driver) - at(before, row.driver)) - (at(after, row.driven) - at(before, row.driven)) / row.ratio;
    if (Math.abs(rel) < 1e-12) continue;
    const pitch = 360 / row.click.teeth;
    const was = clickPhase(row);
    let phase = rel * (row.free ?? 1) > 0 ? was + Math.abs(rel) : Math.max(0, was - Math.abs(rel));
    phase %= pitch;
    if (pitch - phase < 1e-9 || phase < 1e-9) phase = 0;
    const click = memberOf(next, row.click.object);
    if (click?.joint?.kind !== "hinge") continue;
    const turned = turnInAssembly(next, row.click.object, clickAngle(row.click, phase) - (click.joint.angle ?? 0));
    if ("reason" in turned) return turned;
    const couplings = [...(turned.couplings ?? [])];
    couplings[index] = { ...row, click: { ...row.click, phase } };
    next = { ...turned, couplings };
  }
  return next;
}

/**
 * Turn `object`'s joint by `delta` (degrees, or mm for a slide) and every body coupled to it by its share. The train stops
 * together at the first joint limit; a side a clutch carries stops at its own and slips. A ratchet turned against its
 * free way first lets its click ride back down the tooth, then carries its part (or, on a part that stays, stops the
 * turn there). A locked train is refused, with its sentence, and nothing moves.
 */
export function trainTurn(assembly: Assembly, object: string, delta: number, options: TrainOptions = {}): Turned | { reason: string; locked?: string[] } {
  const member = memberOf(assembly, object);
  if (!member) return { reason: "This part is not in the assembly." };
  const clicked = (assembly.couplings ?? []).find((row) => row.click?.object === object);
  if (clicked) return { reason: `${clicked.click!.name} moves with its ratchet: turn ${couplingNames(clicked)[0]}.` };
  if (!Number.isFinite(delta)) return { reason: "A hinge needs a finite turn and a nonzero axis." };
  let next = assembly;
  let remaining = delta;
  let clamped = false;
  let stopped: string | undefined;
  const slipped = new Set<string>();
  for (let piece = 0; piece < 64 && Math.abs(remaining) > 1e-12; piece += 1) {
    const sign = Math.sign(remaining);
    const train = trainScales(next, object, sign, options);
    if (train.locked) {
      if (piece === 0) return { reason: train.locked.reason, locked: train.locked.gears };
      stopped = train.locked.reason;
      clamped = true;
      break;
    }
    for (const row of train.slipped ?? []) slipped.add(row.reason);
    const limited = clampTo(remaining, groupRange(next, train.scales, train.groups, 0));
    const short = Math.abs(limited - remaining) > 1e-9;
    let step = limited;
    let seating = false;
    // A click off its seat rides back down first: this piece ends where it is seated again.
    for (const row of train.backlash ?? []) if (row.allow < Math.abs(step)) { step = sign * row.allow; seating = true; }
    const steps = [step];
    for (let g = 1; g < (train.parents?.length ?? 1); g += 1) steps.push(clampTo(steps[train.parents![g]!]!, groupRange(next, train.scales, train.groups, g)));
    const before = next;
    for (const [body, scale] of train.scales) {
      const share = scale * steps[train.groups?.get(body) ?? 0]!;
      if (share === 0) continue;
      // A hinged root keeps the parts hinged on it on their pins (turnInAssembly).
      const placed = turnInAssembly(next, body, share);
      if ("reason" in placed) return { reason: placed.reason };
      next = placed;
    }
    const clicks = moveClicks(before, next);
    if ("reason" in clicks) return { reason: clicks.reason };
    next = clicks;
    remaining -= step;
    if (step === 0 || (short && !seating)) { clamped = true; break; }
  }
  // Every joint that moved, the turned one first.
  const angles: Turned["angles"] = [];
  const order = [object, ...next.members.map((row) => row.object).filter((id) => id !== object)];
  for (const id of order) {
    const was = memberOf(assembly, id), now = memberOf(next, id);
    if (!now || !drives(now.joint)) continue;
    if (id !== object && jointAt(now.joint) === jointAt(was?.joint)) continue;
    angles.push(now.joint.kind === "slide" ? { object: id, travel: jointAt(now.joint) } : { object: id, angle: jointAt(now.joint) });
  }
  return { assembly: next, angles, clamped: clamped || Math.abs(remaining) > 1e-9, ...(slipped.size ? { slipped: [...slipped] } : {}), ...(stopped ? { stopped } : {}) };
}

/**
 * The bodies in `object`'s train, `object`'s own body included, and the clicks its ratchets set: what one key drives.
 * A clutch parts two trains: its driven side may be keyed on its own (it slips). Empty when it is in no coupling.
 */
export function trainOf(assembly: Assembly, object: string): Set<string> {
  const body = bodyOf(assembly, object);
  const all = assembly.couplings ?? [];
  if (!body || "reason" in body || !all.some((row) => row.driver === body.body || row.driven === body.body)) return new Set();
  const reached = new Set([body.body]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of all) {
      if (row.kind === "clutch") continue;
      const ends = [row.driver, row.driven, ...(row.carrier ? [row.carrier.body] : [])];
      if (ends.some((id) => reached.has(id)) && ends.some((id) => !reached.has(id))) { for (const id of ends) reached.add(id); grew = true; }
    }
  }
  // A part that stays (the root, a held part) does not move with a key.
  for (const id of [...reached]) if (id !== body.body && !drives(memberOf(assembly, id)?.joint)) reached.delete(id);
  for (const row of all) if (row.click && (reached.has(row.driver) || reached.has(row.driven))) reached.add(row.click.object);
  return reached;
}

export interface TrainCheck {
  frames: number;
  pairs: number;
  /** Every sampled frame where a coupled pair was not `meshing`. Empty is the proof. */
  bad: { angle: number; names: [string, string]; verdict: GearVerdict | "missing" }[];
}

/**
 * The validator: turn the train of `object` to each of `angles` (degrees from its present pose), solve, place the gears
 * again with `gearsAt`, and ask the mesh check about every coupled pair. A declared coupling has no gears to ask.
 */
export function trainCheck(assembly: Assembly, poseOf: PoseOf, gearsAt: (poses: ReadonlyMap<string, Affine>) => WorldGear[], object: string, angles: readonly number[]): TrainCheck | { reason: string } {
  const train = trainScales(assembly, object);
  if (train.locked) return { reason: train.locked.reason };
  const meshes = train.couplings.filter((row): row is Coupling & { gears: [GearRef, GearRef] } => !!row.gears);
  const bad: TrainCheck["bad"] = [];
  for (const angle of angles) {
    const turned = trainTurn(assembly, object, angle);
    if ("reason" in turned) return { reason: turned.reason };
    const gears = gearsAt(solveAssembly(turned.assembly, poseOf).poses);
    const find = (ref: GearRef) => gears.find((gear) => gear.objectId === ref.object && gear.step === ref.step);
    for (const row of meshes) {
      const a = find(row.gears[0]), b = find(row.gears[1]);
      const report = a && b ? worldPair(a, b) : null;
      const verdict = report ? report.verdict : "missing";
      if (verdict !== "meshing") bad.push({ angle, names: [row.gears[0].name, row.gears[1].name], verdict });
    }
  }
  return { frames: angles.length, pairs: meshes.length, bad };
}

const shown = (value: number, places = 3) => {
  const r = Math.round(value * 10 ** places) / 10 ** places;
  return `${r < 0 ? "−" : ""}${Math.abs(r)}`;
};

/** One line a reply or the panel shows for a coupling. */
export function couplingLine(row: Coupling): string {
  const [a, b] = couplingNames(row);
  if (row.kind === "winch") return `${a} winds ${b} ${row.wind === "out" ? "out" : "in"} turning forward, on a ${shown(row.radius ?? 0, 2)} mm drum: ×${shown(row.ratio)} mm a degree`;
  if (row.kind === "ratchet") {
    const forward = row.free === 1;
    const click = row.click ? ` under ${row.click.name} (${row.click.teeth} teeth, lift ${shown(Math.abs(row.click.lift), 2)}°)` : "";
    if (row.on?.[1] === "fixed") return `${a} turns ${forward ? "forward" : "back"} only${click}: its click on ${b} holds it the other way`;
    return `${a} drives ${b} turning ${forward ? "back" : "forward"}; turning ${forward ? "forward" : "back"} it runs free${click}`;
  }
  const unit = row.kind !== undefined ? declaredUnit(row) : row.rack === "driven" ? " mm a degree" : row.rack === "driver" ? " degrees a mm" : "";
  if (row.kind === "clutch") return `${a} drives ${b} through a clutch, ×${shown(row.ratio)}${unit}; it slips when ${b} is held or turned on its own (no torque is computed)`;
  const on = row.carrier ? ` on ${row.carrier.name}` : "";
  return `${a} drives ${b}${on}, ×${shown(row.ratio)}${unit}`;
}

/** The unit of a declared ratio: what the driven joint moves for one of the driver's. */
function declaredUnit(row: Coupling): string {
  const [from, to] = row.on ?? ["hinge", "hinge"];
  if (from === "hinge" && to === "slide") return " mm a degree";
  if (from === "slide" && to === "hinge") return " degrees a mm";
  if (from === "slide" && to === "slide") return " mm a mm";
  return "";
}

/** What a person or a call asks for when declaring a coupling (docs/plan-coupling-kinds.md). Objects are parts. */
export interface DeclareSpec {
  driver: string;
  driven: string;
  kind: DeclaredKind;
  /** ratio: required. clutch: default one to one, the hinges' axes' sense taken in. */
  ratio?: number;
  /** winch: the drum's radius, mm, and which way turning the drum forward moves the cord. Default in. */
  radius?: number;
  wind?: "in" | "out";
  /** ratchet: the wheel's free way against its click's part. Default 1 (forward). */
  free?: 1 | -1;
  /** ratchet: the click part, and the wheel's teeth, tip radius and root radius (horology's `Ratchet`). */
  click?: string;
  teeth?: number;
  tip?: number;
  root?: number;
  /** ratchet: the click part's centre in model space, to tell that the click reaches toward its notch the free way. */
  clickCentre?: Vec3;
}

/**
 * `assembly` with a declared coupling between `spec.driver`'s and `spec.driven`'s bodies, replacing any declared one
 * between the same two, or a sentence why not. `poses` are every member's model pose (a solve of the assembly).
 */
export function declareCoupling(assembly: Assembly, poses: ReadonlyMap<string, Affine>, spec: DeclareSpec, nameOf: (id: string) => string): Assembly | { reason: string } {
  const bodyFor = (id: string): { body: string; fixed: boolean } | { reason: string } => {
    const found = bodyOf(assembly, id);
    if (!found) return { reason: `${nameOf(id)} is not in this assembly.` };
    if ("reason" in found) return { reason: `${nameOf(id)} ${found.reason}.` };
    return found;
  };
  const a = bodyFor(spec.driver), b = bodyFor(spec.driven);
  if ("reason" in a) return a;
  if ("reason" in b) return b;
  const [nameA, nameB] = [nameOf(a.body), nameOf(b.body)];
  if (a.body === b.body) return { reason: `${nameA} and ${nameB} are one part: they already move together.` };
  const useA = jointUse(assembly, a.body), useB = jointUse(assembly, b.body);
  if (!useA || !useB) return { reason: "A ball joint drives nothing: couple hinges and slides." };
  const all = assembly.couplings ?? [];
  const between = (row: Coupling) => (row.driver === a.body && row.driven === b.body) || (row.driver === b.body && row.driven === a.body);
  if (all.some((row) => row.kind === undefined && between(row))) return { reason: `${nameA} and ${nameB} are already coupled by their gears.` };
  const line = (body: string) => hingeLine(assembly, poses, body);
  let row: Coupling;
  const finiteNonzero = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value !== 0;
  if (spec.kind === "ratio") {
    if (useA === "fixed" || useB === "fixed") return { reason: `${useA === "fixed" ? nameA : nameB} has no hinge or slide: couple two parts that turn or slide.` };
    if (!finiteNonzero(spec.ratio)) return { reason: "A ratio is a finite number other than 0: degrees (or mm) the driven part moves for one of the driver's." };
    row = { driver: a.body, driven: b.body, ratio: spec.ratio, kind: "ratio", names: [nameA, nameB], on: [useA, useB] };
  } else if (spec.kind === "winch") {
    if (useA !== "hinge" || useB !== "slide") return { reason: `A winch turns a drum on a hinge (${nameA}) and pulls a load on a slide (${nameB}).` };
    if (typeof spec.radius !== "number" || !Number.isFinite(spec.radius) || spec.radius <= 0 || spec.radius > 10000) return { reason: "A winch needs the drum's radius, a positive number of mm." };
    const wind = spec.wind ?? "in";
    const drum = line(a.body), load = memberOf(assembly, b.body), pose = poses.get(b.body);
    if (!drum || !pose || load?.joint?.kind !== "slide") return { reason: `${nameA} or ${nameB} has no pose.` };
    const along = unit(turnDir(pose, load.joint.axis));
    const gap = minus(drum.point, applyPose(pose, load.joint.pivot));
    const off = gap.map((v, i) => v - dot(gap, drum.axis) * drum.axis[i]!) as Vec3;
    const toward = dot(off, along);
    if (Math.abs(toward) < 1e-6 * Math.max(1, Math.hypot(...off))) return { reason: `${nameB}'s slide does not run toward ${nameA} or away from it, so a cord from the drum cannot pull it.` };
    const mmPerDeg = (2 * Math.PI * spec.radius) / 360;
    row = { driver: a.body, driven: b.body, ratio: (wind === "in" ? 1 : -1) * Math.sign(toward) * mmPerDeg, kind: "winch", names: [nameA, nameB], on: ["hinge", "slide"], radius: spec.radius, wind };
  } else if (spec.kind === "ratchet") {
    if (useA !== "hinge") return { reason: `A ratchet wheel turns on a hinge: give ${nameA} one.` };
    if (useB === "slide") return { reason: `A ratchet's click rides on a part that turns about the wheel's axis, or on one that stays: ${nameB} slides.` };
    const free = spec.free ?? 1;
    if (free !== 1 && free !== -1) return { reason: "free is 1 (the wheel runs free turning forward) or -1 (turning back)." };
    const wheel = line(a.body);
    if (!wheel) return { reason: `${nameA} has no pose.` };
    let ratio = 1;
    if (useB === "hinge") {
      const carrier = line(b.body);
      if (!carrier || Math.abs(dot(wheel.axis, carrier.axis)) < PARALLEL) return { reason: `${nameB} does not turn about ${nameA}'s axis: a ratchet's click rides on a part coaxial with the wheel, or on one that stays.` };
      const along = minus(wheel.point, carrier.point);
      const t = dot(along, carrier.axis);
      if (Math.hypot(along[0] - t * carrier.axis[0], along[1] - t * carrier.axis[1], along[2] - t * carrier.axis[2]) > ON_AXIS_MM) return { reason: `${nameB} does not turn about ${nameA}'s axis: a ratchet's click rides on a part coaxial with the wheel, or on one that stays.` };
      ratio = Math.sign(dot(wheel.axis, carrier.axis)) || 1;
    }
    row = { driver: a.body, driven: b.body, ratio, kind: "ratchet", names: [nameA, nameB], on: ["hinge", useB], free };
    if (spec.click !== undefined) {
      const click = memberOf(assembly, spec.click);
      const clickName = nameOf(spec.click);
      if (!click) return { reason: `${clickName} is not in this assembly.` };
      if (click.joint?.kind !== "hinge" || click.parent === null) return { reason: `${clickName} needs a hinge of its own to lift on.` };
      const carried = bodyOf(assembly, click.parent);
      if (!carried || "reason" in carried || carried.body !== b.body) return { reason: `${clickName} must sit on ${nameB}, the part its click is mounted on.` };
      if (spec.click === a.body || all.some((other) => other.click?.object === spec.click && !between(other)) || all.some((other) => other.driver === spec.click || other.driven === spec.click)) return { reason: `${clickName} is coupled already: a click moves only with its ratchet.` };
      if (typeof spec.teeth !== "number" || typeof spec.tip !== "number" || typeof spec.root !== "number") return { reason: "A ratchet's click needs the wheel's teeth, tip radius and root radius (horology's Ratchet)." };
      const hinge = line(spec.click);
      if (!hinge || Math.abs(dot(hinge.axis, wheel.axis)) < PARALLEL) return { reason: `${clickName}'s hinge does not lie along ${nameA}'s axis: a click lifts in the wheel's plane.` };
      // The click's arm from where its hinge stands: horology puts the pivot on the tangent through the face's middle.
      const out = minus(hinge.point, wheel.point);
      const axial = dot(out, wheel.axis);
      const radial = out.map((v, i) => v - axial * wheel.axis[i]!) as Vec3;
      const reach = Math.hypot(...radial), middle = faceMiddle(spec.tip, spec.root);
      if (reach <= middle) return { reason: `${clickName}'s hinge stands inside ${nameA}'s teeth: a click pivots outside the tips.` };
      const shape = { teeth: spec.teeth, tip: spec.tip, root: spec.root, arm: Math.sqrt(reach * reach - middle * middle) };
      const refusal = clickRefusal(shape);
      if (refusal) return { reason: refusal };
      // The wheel's plane, seen so the wheel runs free clockwise (horology's): its normal is against the free turn.
      const normal = wheel.axis.map((v) => -free * v) as Vec3;
      const geometry = clickGeometry(shape);
      if (spec.clickCentre) {
        // Horology's nose sits at the root, turned back from the pivot's direction by the pivot's angle off the face.
        const along = Math.atan2(shape.arm, middle);
        const toward = radial.map((v) => v / reach) as Vec3;
        const side = cross(normal, toward);
        const noseDir = toward.map((v, i) => v * Math.cos(along) - side[i]! * Math.sin(along)) as Vec3;
        const nose = wheel.point.map((v, i) => v + axial * wheel.axis[i]! + geometry.nose[0] * noseDir[i]!) as Vec3;
        // The click lies on the nose's side of the line from the wheel's axis through its pivot, or it is the other hand.
        if (dot(minus(spec.clickCentre, hinge.point), side) * dot(minus(nose, hinge.point), side) <= 0) return { reason: `${clickName} does not reach back toward its notch the way ${nameA} runs free: check free, or which hand the click is.` };
      }
      const sense: 1 | -1 = dot(hinge.axis, normal) > 0 ? 1 : -1;
      const angle = click.joint.angle ?? 0;
      row = { ...row, click: { object: spec.click, name: clickName, teeth: spec.teeth, tip: spec.tip, root: spec.root, arm: shape.arm, sense, zero: angle, phase: 0, lift: sense * geometry.liftDeg } };
    }
  } else {
    if (useA === "fixed" || useB === "fixed" || useA !== useB) return { reason: "A clutch couples two hinges or two slides." };
    let ratio = spec.ratio;
    if (ratio === undefined) {
      const lineA = line(a.body), lineB = line(b.body);
      ratio = lineA && lineB ? Math.sign(dot(lineA.axis, lineB.axis)) || 1 : 1;
    }
    if (!finiteNonzero(ratio)) return { reason: "A clutch's ratio is a finite number other than 0." };
    row = { driver: a.body, driven: b.body, ratio, kind: "clutch", names: [nameA, nameB], on: [useA, useB] };
  }
  const kept = all.filter((other) => !(other.kind !== undefined && between(other)));
  const next = withCouplings(assembly, [...kept, row]);
  if (row.kind === "ratio" || row.kind === "winch") {
    const train = trainScales(next, a.body);
    if (train.locked) return { reason: `That would lock the train: ${train.locked.reason}` };
  }
  return next;
}

/** `assembly` without the declared coupling between `a`'s and `b`'s bodies; unchanged when there is none. */
export function removeDeclared(assembly: Assembly, a: string, b: string): Assembly {
  const one = bodyOf(assembly, a), two = bodyOf(assembly, b);
  const ids = [one && "body" in one ? one.body : a, two && "body" in two ? two.body : b];
  return withCouplings(assembly, (assembly.couplings ?? []).filter((row) => !(row.kind !== undefined && ids.includes(row.driver) && ids.includes(row.driven))));
}

/** A plate object that holds gears, at its pose in model space now. */
export interface GearPart {
  id: string;
  name: string;
  pose: Affine;
  /** Its gears placed at `pose`. */
  gears: WorldGear[];
}

export interface Prepared {
  /** Every assembly after the step; `assembly` among them. */
  assemblies: Assembly[];
  /** The assembly Couple gears then couples: with the hinges given and the gears taken in. Null when nothing meshes. */
  assembly: Assembly | null;
  /** The objects given a hinge, in plate order. */
  hinged: string[];
  /** The racks given a slide along their teeth, in plate order. */
  slid: string[];
  /** The objects that joined an assembly, the new root included. */
  joined: string[];
  /** True when the gears stood in no assembly and one was made. */
  made: boolean;
  /** Gears that could not be given a hinge, one sentence each. */
  refused: string[];
}

const IDENTITY: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/**
 * Whether `gear` is on one shaft with one of `others`: its centre on that gear's axis line, the axes parallel, and the
 * two in planes of their own. A sun inside its ring shares the ring's axis in the ring's plane: two gears, not a shaft.
 */
function coaxial(gear: WorldGear, others: readonly WorldGear[]): boolean {
  return others.some((other) => {
    if (Math.abs(dot(gear.axis, other.axis)) < PARALLEL) return false;
    const along = minus(gear.centre, other.centre);
    const t = dot(along, other.axis);
    const onAxis = Math.hypot(along[0] - t * other.axis[0], along[1] - t * other.axis[1], along[2] - t * other.axis[2]) <= ON_AXIS_MM;
    return onAxis && Math.abs(t) >= (gear.thickness + other.thickness) / 2 - 1e-6;
  });
}

/** A name for a new gear train that no assembly has. */
function trainName(assemblies: readonly Assembly[]): string {
  const taken = new Set(assemblies.map((row) => row.name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? "Gear train" : `Gear train ${n}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Couple gears' first step (`docs/plan-gear-kinds.md`, stage 1): the gears that mesh with `start`'s, and a hinge for each
 * that needs one, so a train turns without hinges made by hand or a frame part.
 *
 * - `start` in an assembly, or free and meshing with an assembly's gear: that assembly's gears, and the free gears that
 *   mesh with them (taken in, seated on its root).
 * - `start` free: the free gears in its meshing group become a new assembly, the first in plate order its root.
 * - A gear needs a hinge when it meshes with a gear of another part, has no joint and is not held, and does not turn: it
 *   is the root, or seated without a joint on a root that holds no gear, or seated on a gear whose axis it does not
 *   share (then it is seated on the root instead, where it stands). A gear on another gear's axis is one shaft with it.
 *
 * `parts` are every plate object that holds gears, in plate order; `poseOf` gives every object's model pose. Nothing
 * here reads or writes the window: the app and the MCP session both call it, then `findCouplings` on `assembly`.
 */
export function prepareTrain(assemblies: readonly Assembly[], parts: readonly GearPart[], start: string, poseOf: PoseOf, newId: string): Prepared {
  // A free gear that meshes with an assembly's gear is taken into that assembly, as if Couple gears ran there.
  const own = parts.find((part) => part.id === start);
  const mine = assemblyOf(assemblies, start) ?? assemblies.find((assembly) => own && parts.some((part) =>
    part.id !== start && assembly.members.some((row) => row.object === part.id) && part.gears.some((gear) => own.gears.some((mate) => worldPair(mate, gear)?.verdict === "meshing"))));
  const inScope = (id: string) => (mine ? mine.members.some((row) => row.object === id) : false) || !assemblyOf(assemblies, id);
  const scope = parts.filter((part) => inScope(part.id));
  const byId = new Map(scope.map((part) => [part.id, part]));
  // Which gear of each part meshes with a gear of another part, and the parts each part meshes with.
  const meshes = new Map<string, Set<string>>();
  const meshingGear = new Map<string, WorldGear>();
  for (let i = 0; i < scope.length; i += 1) {
    for (let j = i + 1; j < scope.length; j += 1) {
      const a = scope[i]!, b = scope[j]!;
      for (const ga of a.gears) {
        for (const gb of b.gears) {
          if (worldPair(ga, gb)?.verdict !== "meshing") continue;
          if (!meshes.has(a.id)) meshes.set(a.id, new Set());
          if (!meshes.has(b.id)) meshes.set(b.id, new Set());
          meshes.get(a.id)!.add(b.id);
          meshes.get(b.id)!.add(a.id);
          if (!meshingGear.has(a.id)) meshingGear.set(a.id, ga);
          if (!meshingGear.has(b.id)) meshingGear.set(b.id, gb);
        }
      }
    }
  }
  // The meshing group: from the assembly's members, or from the free gear alone.
  const seeds = mine ? mine.members.map((row) => row.object).filter((id) => meshes.has(id)) : meshes.has(start) ? [start] : [];
  const group = new Set(seeds);
  for (const queue = [...seeds]; queue.length;) {
    for (const next of meshes.get(queue.shift()!) ?? []) {
      if (!group.has(next)) { group.add(next); queue.push(next); }
    }
  }
  if (!mine && group.size < 2) return { assemblies: [...assemblies], assembly: null, hinged: [], slid: [], joined: [], made: false, refused: [] };
  const free = scope.filter((part) => group.has(part.id) && !assemblyOf(assemblies, part.id)).map((part) => part.id);
  const joined: string[] = [];
  let assembly: Assembly;
  if (mine) assembly = mine;
  else {
    // A rack slides; the root turns on the plate or stands. So the first gear that is not a rack is the root.
    const first = free.find((id) => !byId.get(id)?.gears.some((gear) => gear.rack)) ?? free[0]!;
    free.splice(free.indexOf(first), 1);
    free.unshift(first);
    assembly = { id: newId, name: trainName(assemblies), members: [{ object: first, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] }] };
    joined.push(first);
  }
  const root = rootOf(assembly)!;
  const rootPose = () => poseOf(root.object) ?? IDENTITY;
  for (const id of free) {
    if (id === root.object) continue;
    assembly = { ...assembly, members: [...assembly.members, { object: id, parent: root.object, ...memberFields(relativePose(rootPose(), poseOf(id) ?? IDENTITY)) }] };
    joined.push(id);
  }
  // The hinges, in plate order.
  const hinged: string[] = [];
  const slid: string[] = [];
  const refused: string[] = [];
  const member = (id: string) => assembly.members.find((row) => row.object === id);
  // A carrier (docs/plan-gear-kinds.md, stage 2): a part that holds no gear, has no joint and is not the root, with
  // gears seated on it that mesh with a ring seated elsewhere. It turns about the ring's axis.
  const carriers = new Map<string, WorldGear>();
  for (const row of assembly.members) {
    if (row.parent === null || row.joint || row.held || byId.get(row.object)?.gears.length) continue;
    const planets = assembly.members.filter((one) => one.parent === row.object && group.has(one.object));
    const outside = scope.filter((part) => group.has(part.id) && part.id !== row.object && !planets.some((one) => one.object === part.id));
    for (const planet of planets) {
      const own = byId.get(planet.object)?.gears ?? [];
      // Only a ring makes a part a carrier: a bracket that holds a gear by a sun alone is a fixed axle there. A carrier
      // without a ring takes its hinge by hand (Joint: Hinge), and its gears then hinge on it.
      const sun = outside.flatMap((part) => part.gears).find((gear) => gear.internal && own.some((mine) => worldPair(mine, gear)?.verdict === "meshing"));
      if (sun) { carriers.set(row.object, sun); break; }
    }
  }
  for (const [carrier, sun] of carriers) {
    const pose = poseOf(carrier) ?? IDENTITY;
    const inverse = inversePose(pose);
    const axis = turnDir(inverse, sun.axis);
    const length = Math.hypot(...axis);
    const joint = { kind: "hinge" as const, pivot: applyPose(inverse, sun.centre), axis: axis.map((v) => v / length) as Vec3, angle: 0 };
    assembly = { ...assembly, members: assembly.members.map((one) => (one.object === carrier ? { ...one, joint } : one)) };
    hinged.push(carrier);
  }
  // A ring that is the root of a planetary stage stays fixed: it is the housing, so sun and carrier turn by it.
  const housing = carriers.size > 0 && !!byId.get(root.object)?.gears.some((gear) => gear.internal);
  for (const part of scope) {
    const gear = meshingGear.get(part.id);
    const row = member(part.id);
    if (!gear || !row || !group.has(part.id) || row.joint || row.held) continue;
    if (row.parent === null && housing) continue;
    let needs = row.parent === null;
    let reseat = false;
    for (let at = row.parent === null ? undefined : member(row.parent), seen = new Set<string>(); at && !seen.has(at.object); at = at.parent === null ? undefined : member(at.parent)) {
      seen.add(at.object);
      const shaft = byId.get(at.object);
      if (shaft?.gears.length) {
        // Seated on a gear: one shaft with it when they share an axis, otherwise a gear of its own, off that gear.
        if (!coaxial(gear, shaft.gears)) { needs = true; reseat = at.parent !== null; }
        break;
      }
      if (at.joint?.kind === "hinge") {
        // Seated on a part that turns: on its shaft when the gear is on its hinge's line, otherwise a planet on it.
        const pose = poseOf(at.object) ?? IDENTITY;
        if (!onLine(gear, { axis: turnDir(pose, at.joint.axis), point: applyPose(pose, at.joint.pivot) })) needs = true;
        break;
      }
      if (at.joint) break;
      if (at.parent === null) { needs = true; break; }
    }
    if (!needs) continue;
    const pose = poseOf(part.id) ?? IDENTITY;
    if (gear.rack) {
      // A rack slides along its own teeth (docs/plan-gear-kinds.md, stage 3). A rack that is the root stays fixed.
      if (row.parent === null) { refused.push(`${part.name} is the assembly's root, and a root does not slide: make a gear the root.`); continue; }
      const inverse = inversePose(pose);
      const along = turnDir(inverse, gear.tooth0);
      const length = Math.hypot(...along);
      const joint = { kind: "slide" as const, pivot: applyPose(inverse, gear.centre), axis: along.map((v) => v / length) as Vec3, travel: 0 };
      const seated: Member = reseat ? { object: row.object, parent: root.object, ...memberFields(relativePose(rootPose(), pose)), joint } : { ...row, joint };
      assembly = { ...assembly, members: assembly.members.map((one) => (one === row ? seated : one)) };
      slid.push(part.id);
      continue;
    }
    if (row.parent === null && Math.abs(poseScale(pose) - 1) > 1e-9) {
      refused.push(`${part.name} is scaled in model space, so it cannot turn on the plate.`);
      continue;
    }
    const inverse = inversePose(pose);
    const axis = turnDir(inverse, gear.axis);
    const length = Math.hypot(...axis);
    const joint = { kind: "hinge" as const, pivot: applyPose(inverse, gear.centre), axis: axis.map((v) => v / length) as Vec3, angle: 0 };
    const seated: Member = reseat
      ? { object: row.object, parent: root.object, ...memberFields(relativePose(rootPose(), pose)), joint }
      : { ...row, joint };
    assembly = { ...assembly, members: assembly.members.map((one) => (one === row ? seated : one)) };
    if (row.parent === null) assembly = withRootAt(assembly, pose);
    hinged.push(part.id);
  }
  const next = mine ? assemblies.map((one) => (one.id === mine.id ? assembly : one)) : [...assemblies, assembly];
  return { assemblies: next, assembly, hinged, slid, joined, made: !mine, refused };
}

/** What Couple gears made, in sentences: the hinges given, and the new assembly. `nameOf` names an object. */
export function preparedLines(prepared: Prepared, nameOf: (id: string) => string): string[] {
  const lines: string[] = [];
  if (prepared.hinged.length) {
    const names = prepared.hinged.map(nameOf);
    lines.push(`Gave ${listed(names)} a hinge about ${names.length === 1 ? "its axis" : "their axes"}.`);
  }
  if (prepared.slid.length) {
    const names = prepared.slid.map(nameOf);
    lines.push(`Gave ${listed(names)} a slide along ${names.length === 1 ? "its teeth" : "their teeth"}.`);
  }
  if (prepared.made && prepared.assembly) {
    const root = rootOf(prepared.assembly);
    const turns = root?.joint?.kind === "hinge" ? ` ${nameOf(root.object)} turns on the plate.` : "";
    lines.push(`They stand in a new assembly, ${prepared.assembly.name}.${turns}`);
  }
  return [...lines, ...prepared.refused];
}
