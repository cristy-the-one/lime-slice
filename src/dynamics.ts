/**
 * Hinge dynamics (docs/plan-hinge-dynamics.md): an assembly's jointed bodies run in time under gravity, a drive and
 * friction. Shared by the window's worker and the MCP server: no DOM.
 *
 * - Every body is a member on a hinge or a slide on the fixed root, with what is seated on it (`movingBody`); its mass
 *   and inertia are `src/mass.ts`'s, at a density. Gravity is G_MM_S2 along −Z of model space.
 * - Rigid couplings (gear meshes, ratios, winches) reduce a train to one generalized coordinate `q` (its lead body's
 *   joint, radians or mm, 0 where it stands): each body moves `scale · q`, the train's inertia is the reflected one.
 * - Ratchets, joint limits and contacts (the escapement, src/escapement.ts) are unilateral constraints; pivot friction
 *   and clutches are Coulomb friction. All are velocity impulses solved at each step.
 * - The step is Moreau's midpoint (Moreau–Jean): half a step of positions, the forces and the impulses at the midpoint,
 *   half a step of positions. Free motion is then the position Verlet scheme: symplectic, second order.
 *
 * Units inside: mm, g, s, radians. A torque is g·mm²/s² (1 N·mm = 1e6), an energy the same (1 µJ = 1e3).
 */
import { bodyOf as assemblyBody, couplingNames, frameOf, rootOf, type Assembly, type Coupling } from "./assembly.ts";
import { trainScales } from "./gear-train.ts";
import { aboutAxis, bodyOf as massBodyOf, G_MM_S2, movingBody, partIntegrals, type BodyPart } from "./mass.ts";
import { applyPose, turnDir, type Affine } from "./model-space.ts";

export type Vec3 = [number, number, number];
export const N_MM = 1e6;
export const MICROJOULE = 1e3;
const DEG = Math.PI / 180;

/** A member's triangles in its own frame and its pose into model space, as `model_mass` weighs it. */
export interface DynPart { object: string; name: string; positions: ArrayLike<number>; pose: Affine }

export interface Drive {
  /** The part the drive acts on: its body's joint takes the torque, or carries the weight. */
  member: string;
  /** A constant torque on the hinge, N·mm, in the hinge's own sense. */
  torqueNmm?: number;
  /** A hanging weight, g: on the winch the member's drum (or slide) is coupled by, or on a cord round `radiusMm`. */
  weightG?: number;
  /** A cord on this hinge's drum, mm: the weight hangs from it with no part of its own. */
  radiusMm?: number;
  /** Which way the cord unwinds as the weight falls: the hinge's + (1) or − (−1). */
  dir?: 1 | -1;
}

export interface DynamicsInputs {
  densityGCm3: number;
  /** Coulomb coefficient at every pin. */
  friction: number;
  pinRadiusMm: number;
  restitution: number;
  /** Viscous drag at each hinge, N·mm·s per radian. */
  viscous?: number;
  /** A clutch's slip torque, N·mm. */
  clutchNmm?: number;
  drive?: Drive;
}

export interface Body {
  object: string;
  name: string;
  kind: "hinge" | "slide";
  coord: number;
  /** The body's joint move (radians or mm) for one unit of its coordinate. */
  scale: number;
  /** Degrees (hinge) or mm (slide) of its joint where the run starts. */
  start: number;
  min?: number;
  max?: number;
  massG: number;
  /** About its hinge line, g·mm² (0 for a slide). */
  inertiaGmm2: number;
  /** Its hinge line (a point and a unit axis), or its slide's unit direction, in model space. */
  point: Vec3;
  axis: Vec3;
  /** Its centre of gravity where the run starts. */
  centre: Vec3;
  /** Its pin's Coulomb torque bound, g·mm²/s², and the load it is worked out from, g. */
  pinFriction: number;
  pinLoadG: number;
  /** A weight on a cord round this hinge: its mass, the drum radius and the way it unwinds. */
  cord?: { massG: number; radiusMm: number; dir: 1 | -1 };
  /** Its potential energy is the drive's (a hanging weight). */
  drives: boolean;
  /** The parts that move with it. */
  parts: string[];
}

export interface Coord {
  lead: string;
  name: string;
  unit: "rad" | "mm";
  inertia: number;
  /** Coulomb bound of the pins' friction reflected onto this coordinate. */
  friction: number;
  viscous: number;
  /** A constant generalized force: the drive's torque reflected. */
  torque: number;
  lo: number;
  hi: number;
  bodies: number[];
}

/** One row of the impulse problem at a step. */
export interface Row {
  j: Float64Array;
  kind: "normal" | "friction" | "bound";
  /** Bounds of a `bound` row's impulse. */
  lo: number;
  hi: number;
  /** A friction row's coefficient and its normal row. */
  mu?: number;
  normal?: number;
  /**
   * A normal row's gap at the midpoint, mm or radians (0 or less: touching). A row offered while still apart is
   * speculative: its velocity may close the gap by the step's end, and no more; at an impact it rebounds by the
   * restitution instead.
   */
  gap?: number;
  /** Where its work goes in the ledger. */
  ledger: string;
}

/** A constraint or a friction coupling that adds rows at a step. */
export interface Element {
  kind: string;
  rows(q: Float64Array, v: Float64Array, h: number, out: Row[]): void;
  /** After a step: a click's seat moves on, a counter. */
  after?(q: Float64Array): void;
  /**
   * Which contacts are made at `q`, within a band far wider than a resting contact's stray: a step whose start and
   * predicted end differ makes or breaks a contact, and is refined.
   */
  signature?(q: ArrayLike<number>): string;
}

export interface System {
  coords: Coord[];
  bodies: Body[];
  elements: Element[];
  restitution: number;
  /** What the model left out or assumed, in sentences, said with every answer made from it. */
  notes: string[];
}

export type Refusal = { reason: string };

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** `u` turned by `a` radians about the unit axis `n` (Rodrigues). */
export function turnVec(u: Vec3, n: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a), k = dot(n, u) * (1 - c), x = cross(n, u);
  return [u[0] * c + x[0] * s + n[0] * k, u[1] * c + x[1] * s + n[1] * k, u[2] * c + x[2] * s + n[2] * k];
}

/** A body's centre of gravity with its joint moved `delta` (radians or mm) from the start. */
export function centreAt(body: Body, delta: number): Vec3 {
  if (body.kind === "slide") return [body.centre[0] + body.axis[0] * delta, body.centre[1] + body.axis[1] * delta, body.centre[2] + body.axis[2] * delta];
  const r = turnVec(sub(body.centre, body.point), body.axis, delta);
  return [body.point[0] + r[0], body.point[1] + r[1], body.point[2] + r[2]];
}

/** Gravity's generalized force on the body's own joint (torque, or force along the slide) with it moved `delta`. */
function gravityOn(body: Body, delta: number, g: number): number {
  if (body.kind === "slide") return -body.massG * g * body.axis[2];
  let tau = 0;
  if (body.massG > 0) {
    const r = turnVec(sub(body.centre, body.point), body.axis, delta);
    // τ = n · (r × m g down), down = (0, 0, −1): −m g (n × r)_z.
    tau = -body.massG * g * cross(body.axis, r)[2];
  }
  if (body.cord) tau += body.cord.massG * g * body.cord.radiusMm * body.cord.dir;
  return tau;
}

/** The body's potential energy with its joint moved `delta`. */
function potentialOf(body: Body, delta: number, g: number): number {
  let v = body.massG * g * centreAt(body, delta)[2];
  if (body.cord) v -= body.cord.massG * g * body.cord.radiusMm * body.cord.dir * delta;
  return v;
}

/** Degrees (or mm) of a body's joint for one unit of its coordinate. */
export function jointRate(body: Body): number {
  return body.kind === "hinge" ? body.scale / DEG : body.scale;
}

// --- Building the system from an assembly.

function name(nameOf: (id: string) => string, id: string): string {
  return nameOf(id) || id;
}

/**
 * The system of an assembly as it stands: its bodies, their coordinates, the drive, pivot friction, joint limits,
 * ratchets and clutches. Elements that need more than the assembly says (an escapement) are added by the caller.
 * Refused, with a sentence, for what the model does not cover (docs/plan-hinge-dynamics.md, section 5).
 */
export function buildSystem(assembly: Assembly, parts: readonly DynPart[], inputs: DynamicsInputs, nameOf: (id: string) => string, g = G_MM_S2): System | Refusal {
  const root = rootOf(assembly);
  if (!root) return { reason: "The assembly has no root." };
  if (root.joint) return { reason: "The root turns on a hinge of its own: a run needs a fixed frame." };
  const partOf = new Map(parts.map((part) => [part.object, part]));
  const memberOf = (id: string) => assembly.members.find((row) => row.object === id);
  const clicks = new Set((assembly.couplings ?? []).flatMap((row) => (row.click ? [row.click.object] : [])));
  for (const row of assembly.couplings ?? []) if (row.carrier) return { reason: `${row.carrier.name} carries a planet: a train with a planet carrier is not covered.` };
  // Bodies: jointed members whose joint sits on the root. A click rides with the part it sits on.
  const bodyIds: string[] = [];
  const riders = new Map<string, string[]>();
  for (const member of assembly.members) {
    if (!member.joint) continue;
    if (member.joint.kind === "ball") return { reason: `${name(nameOf, member.object)} turns on a ball joint: only hinges and slides are covered.` };
    const frame = frameOf(assembly, member.object);
    if (frame === root.object) { bodyIds.push(member.object); continue; }
    if (clicks.has(member.object) && member.parent) {
      const carrier = assemblyBody(assembly, member.parent);
      if (carrier && !("reason" in carrier)) { riders.set(carrier.body, [...(riders.get(carrier.body) ?? []), member.object]); continue; }
    }
    const on = member.parent ? assemblyBody(assembly, member.parent) : null;
    const onName = on && !("reason" in on) ? name(nameOf, on.body) : "a moving part";
    return { reason: `${name(nameOf, member.object)} is hinged on ${onName}, which moves: only parts whose joint sits on the frame are covered.` };
  }
  if (!bodyIds.length) return { reason: "Nothing in the assembly moves: give a part a hinge or a slide on the frame." };

  const bodies: Body[] = [];
  let firstHinge: { id: string; axis: Vec3 } | null = null;
  for (const id of bodyIds) {
    const member = memberOf(id)!;
    const joint = member.joint as Extract<NonNullable<typeof member.joint>, { kind: "hinge" | "slide" }>;
    const own = movingBody(assembly, id)?.parts ?? [id];
    const ids = [...own];
    for (const rider of riders.get(id) ?? []) for (const part of movingBody(assembly, rider)?.parts ?? [rider]) if (!ids.includes(part)) ids.push(part);
    const rows: BodyPart[] = [];
    for (const part of ids) {
      const mesh = partOf.get(part);
      if (!mesh) return { reason: `${name(nameOf, part)} has no mesh to weigh.` };
      const integrals = partIntegrals(mesh.positions, name(nameOf, part));
      if ("reason" in integrals) return integrals;
      rows.push({ integrals, pose: mesh.pose, densityGCm3: inputs.densityGCm3 });
    }
    const mass = massBodyOf(rows);
    const pose = partOf.get(id)!.pose;
    const axis = turnDir(pose, joint.axis);
    const point = applyPose(pose, joint.pivot);
    if (!(Math.hypot(...axis) > 0.5)) return { reason: `${name(nameOf, id)}'s joint has no direction.` };
    let inertia = 0;
    if (joint.kind === "hinge") {
      if (firstHinge && Math.abs(Math.abs(dot(firstHinge.axis, axis)) - 1) > 1e-6) return { reason: `${name(nameOf, id)}'s hinge is not parallel to ${name(nameOf, firstHinge.id)}'s: only mechanisms on parallel axes are covered.` };
      firstHinge ??= { id, axis };
      const about = aboutAxis(mass, point, axis);
      if ("reason" in about) return about;
      inertia = about.inertiaGmm2;
    }
    bodies.push({
      object: id, name: name(nameOf, id), kind: joint.kind, coord: -1, scale: 0,
      start: joint.kind === "hinge" ? joint.angle ?? 0 : joint.travel ?? 0,
      ...(joint.min !== undefined ? { min: joint.min } : {}), ...(joint.max !== undefined ? { max: joint.max } : {}),
      massG: mass.massG, inertiaGmm2: inertia, point, axis, centre: mass.centreMm, pinFriction: 0, pinLoadG: 0, drives: false, parts: ids,
    });
  }
  const bodyIndex = new Map(bodies.map((body, i) => [body.object, i]));
  const notes: string[] = [];

  // The drive: which body it acts on, before coordinates are made (its body leads its train).
  const drive = inputs.drive;
  let driveBody: Body | undefined;
  if (drive) {
    const at = assemblyBody(assembly, drive.member);
    if (!at || "reason" in at) return { reason: `${name(nameOf, drive.member)} is not a part of this assembly that moves.` };
    driveBody = bodies[bodyIndex.get(at.body) ?? -1];
    if (!driveBody) return { reason: `${name(nameOf, drive.member)} does not move: it has no joint, or it is held.` };
    const given = [drive.torqueNmm, drive.weightG].filter((x) => x !== undefined).length;
    if (given !== 1) return { reason: "A drive is a torque or a weight: give one of them." };
  }

  // Coordinates: each rigid train once, its lead the drive's body or its first body.
  const order = driveBody ? [driveBody.object, ...bodyIds.filter((id) => id !== driveBody!.object)] : bodyIds;
  const coords: Coord[] = [];
  for (const id of order) {
    const lead = bodies[bodyIndex.get(id)!]!;
    if (lead.coord >= 0) continue;
    const train = trainScales(assembly, id, 0);
    if (train.locked) return { reason: train.locked.reason };
    const c = coords.length;
    const coord: Coord = { lead: id, name: lead.name, unit: lead.kind === "hinge" ? "rad" : "mm", inertia: 0, friction: 0, viscous: 0, torque: 0, lo: -Infinity, hi: Infinity, bodies: [] };
    for (const [other, s] of train.scales) {
      if ((train.groups?.get(other) ?? 0) !== 0) continue;
      const k = bodyIndex.get(other);
      if (k === undefined) continue;
      const body = bodies[k]!;
      // trainScales gives degrees and mm; a coordinate is in radians or mm.
      const fromDeg = (kind: Body["kind"]) => (kind === "hinge" ? DEG : 1);
      body.coord = c;
      body.scale = (s * fromDeg(body.kind)) / fromDeg(lead.kind);
      coord.bodies.push(k);
    }
    coords.push(coord);
  }

  // The drive's load: a weight on a winch or on a cord, or a torque.
  if (drive && driveBody) {
    if (drive.torqueNmm !== undefined) {
      if (driveBody.kind !== "hinge") return { reason: `${driveBody.name} slides: a torque drives a hinge. Give a weight, or drive its drum.` };
      coords[driveBody.coord]!.torque += driveBody.scale * drive.torqueNmm * N_MM;
    } else if (drive.radiusMm !== undefined) {
      if (driveBody.kind !== "hinge") return { reason: `${driveBody.name} slides: a cord round a radius needs a hinge.` };
      driveBody.cord = { massG: drive.weightG!, radiusMm: drive.radiusMm, dir: drive.dir ?? 1 };
      driveBody.drives = true;
      notes.push(`The weight, ${drive.weightG} g, hangs on a cord round a ${drive.radiusMm} mm drum on ${driveBody.name}: a point mass on an inextensible cord, with no part of its own.`);
    } else {
      // A winch the body is coupled by: the weight is its slide body.
      const winch = (assembly.couplings ?? []).find((row) => row.kind === "winch" && (row.driver === driveBody!.object || row.driven === driveBody!.object));
      const weight = winch ? bodies[bodyIndex.get(winch.driven) ?? -1] : driveBody.kind === "slide" ? driveBody : undefined;
      if (!weight || weight.kind !== "slide") return { reason: "A weight hangs on a cord: couple a drum to the weight's slide (Couplings: Winch), or give the drum's radius." };
      notes.push(`The weight is ${weight.name}, taken as ${drive.weightG} g in place of its solid's ${round(weight.massG, 1)} g, on an inextensible, massless cord; it does not swing.`);
      weight.massG = drive.weightG!;
      weight.drives = true;
    }
  }

  // Pins: Coulomb torque μ r N, N the static load. A drum's pin also carries its weight's pull.
  for (const body of bodies) {
    if (body.kind !== "hinge") continue;
    let load = body.massG + (body.cord?.massG ?? 0);
    for (const row of assembly.couplings ?? []) {
      if (row.kind === "winch" && row.driver === body.object) {
        const weight = bodies[bodyIndex.get(row.driven) ?? -1];
        if (weight) load += weight.massG;
      }
    }
    body.pinLoadG = load;
    body.pinFriction = inputs.friction * inputs.pinRadiusMm * load * g;
  }
  for (const [c, coord] of coords.entries()) {
    for (const k of coord.bodies) {
      const body = bodies[k]!;
      const s = body.scale;
      coord.inertia += s * s * (body.kind === "hinge" ? body.inertiaGmm2 + (body.cord ? body.cord.massG * body.cord.radiusMm ** 2 : 0) : body.massG);
      coord.friction += Math.abs(s) * body.pinFriction;
      if (body.kind === "hinge") coord.viscous += s * s * (inputs.viscous ?? 0) * N_MM;
      // Joint limits in coordinate units.
      const rate = jointRate(body);
      for (const limit of [body.min, body.max]) {
        if (limit === undefined || rate === 0) continue;
        const at = (limit - body.start) / rate;
        if (limit === body.min ? rate > 0 : rate < 0) coord.lo = Math.max(coord.lo, at);
        else coord.hi = Math.min(coord.hi, at);
      }
    }
    if (!(coord.inertia > 0)) return { reason: `${coord.name} has no mass to move: its parts weigh nothing at this density.` };
    void c;
  }

  const elements: Element[] = [];
  for (const [c, coord] of coords.entries()) if (Number.isFinite(coord.lo) || Number.isFinite(coord.hi)) elements.push(limitElement(c, coord, coords.length));
  for (const row of assembly.couplings ?? []) {
    if (row.kind === "ratchet") {
      const element = ratchetElement(row, bodies, bodyIndex, coords.length, nameOf);
      if ("reason" in element) return element;
      elements.push(element);
    }
    if (row.kind === "clutch") {
      const capacity = (inputs.clutchNmm ?? 5) * N_MM;
      elements.push(clutchElement(row, bodies, bodyIndex, coords.length, capacity));
      notes.push(`The clutch between ${couplingNames(row).join(" and ")} slips above ${inputs.clutchNmm ?? 5} N·mm${inputs.clutchNmm === undefined ? " (a guess for a printed friction fit: give clutch)" : ""}.`);
    }
  }
  if (assembly.couplings?.some((row) => row.click)) notes.push("A click counts with the part it sits on; its own swing, its spring and its drop into each notch are left out.");
  return { coords, bodies, elements, restitution: inputs.restitution, notes };
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A coordinate's joint limits as stops. */
function limitElement(c: number, coord: Coord, n: number): Element {
  return {
    kind: "limit",
    signature: (q) => (q[c]! - coord.lo <= BAND ? "lo" : coord.hi - q[c]! <= BAND ? "hi" : ""),
    rows(q, v, h, out) {
      // Speculative, as a contact: offered once the rest of the step would reach the stop.
      const below = q[c]! - coord.lo, above = coord.hi - q[c]!;
      if (below <= 0.5 * h * Math.max(0, -v[c]!)) { const j = new Float64Array(n); j[c] = 1; out.push({ j, kind: "normal", lo: 0, hi: Infinity, ledger: "stops", gap: below }); }
      if (above <= 0.5 * h * Math.max(0, v[c]!)) { const j = new Float64Array(n); j[c] = -1; out.push({ j, kind: "normal", lo: 0, hi: Infinity, ledger: "stops", gap: above }); }
    },
  };
}

/**
 * A ratchet as a one-way stop between its wheel and the part its click sits on (or the frame): the wheel's turn
 * against its free way, relative to that part, cannot pass the click's seat. Running free, the seat moves on a pitch
 * each time the wheel passes one (the click drops into the next notch). Without a click, every point is a seat.
 */
function ratchetElement(row: Coupling, bodies: Body[], index: Map<string, number>, n: number, nameOf: (id: string) => string): Element | Refusal {
  const wheel = bodies[index.get(row.driver) ?? -1];
  if (!wheel) return { reason: `${name(nameOf, row.driver)}, a ratchet wheel, does not move.` };
  const part = bodies[index.get(row.driven) ?? -1];
  const free = row.free ?? 1;
  const ratio = row.ratio || 1;
  const pitch = row.click ? 360 / row.click.teeth : 0;
  // Relative turn, degrees: the wheel's against the part's.
  const rel = (q: ArrayLike<number>) => jointRate(wheel) * q[wheel.coord]! - (part ? (jointRate(part) * q[part.coord]!) / ratio : 0);
  let seat = -free * (row.click?.phase ?? 0);
  const element: Element & { clicks: number } = {
    kind: "ratchet",
    clicks: 0,
    signature: (q) => (free * (rel(q) - seat) * DEG <= BAND ? "held" : ""),
    rows(q, _v, _h, out) {
      if (free * (rel(q) - seat) > 0) return;
      const j = new Float64Array(n);
      j[wheel.coord] = (j[wheel.coord] ?? 0) + free * wheel.scale;
      if (part) j[part.coord] = (j[part.coord] ?? 0) - (free * part.scale) / ratio;
      out.push({ j, kind: "normal", lo: 0, hi: Infinity, ledger: "ratchet" });
    },
    after(q) {
      const r = rel(q);
      if (!pitch) { if (free * (r - seat) > 0) seat = r; return; }
      while (free * (r - seat) >= pitch) { seat += free * pitch; element.clicks += 1; }
    },
  };
  return element;
}

/** A clutch: Coulomb friction between its two sides, up to `capacity` at the driven joint. */
function clutchElement(row: Coupling, bodies: Body[], index: Map<string, number>, n: number, capacity: number): Element {
  const driver = bodies[index.get(row.driver) ?? -1];
  const driven = bodies[index.get(row.driven) ?? -1];
  return {
    kind: "clutch",
    rows(_q, _v, h, out) {
      if (driver && driven && driver.coord === driven.coord) return;
      const j = new Float64Array(n);
      if (driven) j[driven.coord] = (j[driven.coord] ?? 0) + driven.scale;
      if (driver) j[driver.coord] = (j[driver.coord] ?? 0) - row.ratio * driver.scale;
      out.push({ j, kind: "bound", lo: -h * capacity, hi: h * capacity, ledger: "clutch" });
    },
  };
}

// --- The step.

export interface Ledger {
  /** The drive's work so far: its weight's fall and its torque. */
  driveIn: number;
  /** Energy taken out, by where it went: `pivot:<coordinate>`, `pallets`, `impacts`, `stops`, `ratchet`, `clutch`, `viscous`. */
  out: Record<string, number>;
}

/** Moreau's midpoint stepping of a system, from a start (coordinates from where the assembly stands, velocities). */
export class Stepper {
  readonly n: number;
  q: Float64Array;
  v: Float64Array;
  t = 0;
  steps = 0;
  readonly ledger: Ledger = { driveIn: 0, out: {} };
  /** Rows of the last step with their impulses, for a caller that asks what held what. */
  lastRows: { row: Row; p: number }[] = [];
  private readonly inv: Float64Array;
  private readonly energy0: number;

  readonly system: System;
  readonly h: number;
  readonly g: number;

  constructor(system: System, h: number, q0?: ArrayLike<number>, v0?: ArrayLike<number>, g = G_MM_S2) {
    this.system = system;
    this.h = h;
    this.g = g;
    this.n = system.coords.length;
    this.q = new Float64Array(this.n);
    this.v = new Float64Array(this.n);
    if (q0) this.q.set(q0);
    if (v0) this.v.set(v0);
    this.inv = Float64Array.from(system.coords, (c) => 1 / c.inertia);
    this.f = new Float64Array(this.n);
    // The pins' friction: one bound row a coordinate, the same every step.
    this.pivotRows = [];
    for (let c = 0; c < this.n; c += 1) {
      const F = system.coords[c]!.friction;
      if (!(F > 0)) continue;
      const j = new Float64Array(this.n); j[c] = 1;
      this.pivotRows.push({ j, kind: "bound", lo: -h * F, hi: h * F, ledger: `pivot:${c}` });
    }
    this.energy0 = this.kinetic() + this.potential(false);
    this.driveStart = this.potential(true);
  }

  /** Each body's joint move from where the assembly stands, radians or mm. */
  delta(body: Body, q: ArrayLike<number> = this.q): number {
    return body.scale * q[body.coord]!;
  }

  kinetic(v: ArrayLike<number> = this.v): number {
    let sum = 0;
    for (let c = 0; c < this.n; c += 1) sum += 0.5 * this.system.coords[c]!.inertia * v[c]! * v[c]!;
    return sum;
  }

  /** Potential energy: the drive's weights only, or every body but them. */
  potential(drive: boolean, q: ArrayLike<number> = this.q): number {
    let sum = 0;
    for (const body of this.system.bodies) if (body.drives === drive) sum += potentialOf(body, this.delta(body, q), this.g);
    return sum;
  }

  /** Generalized forces at `q`: gravity, the weights, the drive's torque. */
  forces(q: ArrayLike<number>, out: Float64Array): void {
    for (let c = 0; c < this.n; c += 1) out[c] = this.system.coords[c]!.torque;
    for (const body of this.system.bodies) out[body.coord] = out[body.coord]! + body.scale * gravityOn(body, this.delta(body, q), this.g);
  }

  /** What is left of the energy balance: kinetic and potential change, less the drive's work, plus what was taken out. */
  residual(): number {
    let out = 0;
    for (const value of Object.values(this.ledger.out)) out += value;
    return this.kinetic() + this.potential(false) - this.energy0 - this.ledger.driveIn + out;
  }

  private readonly f: Float64Array;
  private readonly pivotRows: Row[];
  private readonly driveStart: number;
  private torqueWork = 0;

  /** One step of `h`, refined where a contact starts, closes or ends (docs/plan-hinge-dynamics.md, section 3). */
  step(): void {
    this.advance(this.h, 0);
    this.steps += 1;
    this.ledger.driveIn = this.driveStart - this.potential(true) + this.torqueWork;
  }

  /** Steps refined into sub-steps, for a caller that reports the cost. */
  refined = 0;
  refinedClosing = 0;

  private pivotFor(h: number): Row[] {
    if (h === this.h) return this.pivotRows;
    return this.pivotRows.map((row) => ({ ...row, lo: (row.lo * h) / this.h, hi: (row.hi * h) / this.h }));
  }

  private advance(h: number, depth: number): void {
    const { n, system } = this;
    const q0 = this.q, v0 = this.v;
    const qm = new Float64Array(n);
    for (let c = 0; c < n; c += 1) qm[c] = q0[c]! + 0.5 * h * v0[c]!;
    const f = this.f;
    this.forces(qm, f);
    const v = new Float64Array(n);
    for (let c = 0; c < n; c += 1) {
      const coord = system.coords[c]!;
      const free = v0[c]! + h * f[c]! * this.inv[c]!;
      // Viscous drag, implicit: never turns the motion round.
      const damped = coord.viscous > 0 ? free / (1 + h * coord.viscous * this.inv[c]!) : free;
      if (coord.viscous > 0) this.add("viscous", 0.5 * coord.inertia * (free * free - damped * damped));
      v[c] = damped;
    }
    // The impulse problem: pins' friction, then the elements' rows at the midpoint.
    const rows: Row[] = this.pivotFor(h).slice();
    for (const element of system.elements) element.rows(qm, v0, h, rows);
    // An event in this step: a contact closing (a speculative row) or a contact made or broken between the step's start
    // and its predicted end. Its timing is first order in the step, so the step is made again as REFINE sub-steps,
    // twice over at most: h/64 at an event.
    if (depth < 2) {
      let closing = false;
      for (const row of rows) if (row.kind === "normal" && row.gap !== undefined && row.gap > CLOSING) closing = true;
      let changes = closing;
      if (!changes) {
        const end = new Float64Array(n);
        for (let c = 0; c < n; c += 1) end[c] = q0[c]! + h * v0[c]!;
        for (const element of system.elements) if (element.signature && element.signature(q0) !== element.signature(end)) { changes = true; break; }
      }
      if (changes) {
        if (depth === 0) { this.refined += 1; if (closing) this.refinedClosing += 1; }
        for (let k = 0; k < REFINE; k += 1) this.advance(h / REFINE, depth + 1);
        return;
      }
    }
    // Normal rows first, then friction, then the bounds.
    const order = rows.map((_, i) => i).sort((a, b) => rank(rows[a]!) - rank(rows[b]!));
    const p = new Float64Array(rows.length);
    if (rows.length) solveRows(rows, order, p, v, v0, this.inv, system.restitution, h);
    // The work each impulse did, over the step's mean velocity.
    this.lastRows = [];
    for (let k = 0; k < rows.length; k += 1) {
      if (p[k] === 0) continue;
      const row = rows[k]!;
      let w = 0;
      for (let c = 0; c < n; c += 1) w += row.j[c]! * (v[c]! + v0[c]!) * 0.5;
      this.add(row.ledger, -p[k]! * w);
      this.lastRows.push({ row, p: p[k]! });
    }
    const q = new Float64Array(n);
    for (let c = 0; c < n; c += 1) q[c] = qm[c]! + 0.5 * h * v[c]!;
    for (let c = 0; c < n; c += 1) this.torqueWork += system.coords[c]!.torque * (q[c]! - q0[c]!);
    this.q = q;
    this.v = v;
    for (const element of system.elements) element.after?.(q);
    this.t += h;
  }

  private add(key: string, value: number): void {
    this.ledger.out[key] = (this.ledger.out[key] ?? 0) + value;
  }
}

/** A contact counts as made within this, mm (or radians on a stop): far wider than a resting contact's stray. */
export const BAND = 1e-4;
/** Sub-steps a step is cut into at an event. */
export const REFINE = 8;
/** A speculative row further apart than this (mm, or radians on a stop) is a contact still to be made: an event. A sliding or resting contact strays from its face by far less (curvature times the step squared). */
const CLOSING = 1e-5;

const rank = (row: Row) => (row.kind === "normal" ? 0 : row.kind === "friction" ? 1 : 2);

/**
 * Projected Gauss–Seidel over a handful of rows: a normal row's impulse is at least 0 and brings its velocity to at
 * least the restitution's rebound; a friction row's stays within μ times its normal's; a bound row's within its bounds.
 * `v` comes in as the free velocity and leaves as the step's.
 */
function solveRows(rows: Row[], order: number[], p: Float64Array, v: Float64Array, v0: Float64Array, inv: Float64Array, e: number, h: number): void {
  const n = v.length, m = rows.length;
  const w: Float64Array[] = new Array(m), d = new Float64Array(m), target = new Float64Array(m);
  for (let k = 0; k < m; k += 1) {
    const j = rows[k]!.j, wk = new Float64Array(n);
    let dk = 0, a = 0;
    for (let c = 0; c < n; c += 1) { wk[c] = j[c]! * inv[c]!; dk += j[c]! * wk[c]!; a += j[c]! * v0[c]!; }
    w[k] = wk; d[k] = dk;
    const row = rows[k]!;
    if (row.kind !== "normal") target[k] = 0;
    else {
      const close = row.gap !== undefined && row.gap > 0 ? (-2 * row.gap) / h : 0;
      target[k] = e > 0 && a < 0 ? Math.max(-e * a, close) : close;
    }
  }
  for (let sweep = 0; sweep < 400; sweep += 1) {
    let change = 0, size = 0;
    for (const k of order) {
      const row = rows[k]!;
      if (!(d[k]! > 0)) continue;
      let jv = 0;
      for (let c = 0; c < n; c += 1) jv += row.j[c]! * v[c]!;
      let next = p[k]! + (target[k]! - jv) / d[k]!;
      if (row.kind === "normal") next = Math.max(0, next);
      else if (row.kind === "friction") { const bound = (row.mu ?? 0) * p[row.normal!]!; next = Math.max(-bound, Math.min(bound, next)); }
      else next = Math.max(row.lo, Math.min(row.hi, next));
      const dp = next - p[k]!;
      if (dp !== 0) {
        for (let c = 0; c < n; c += 1) v[c] = v[c]! + w[k]![c]! * dp;
        p[k] = next;
      }
      change = Math.max(change, Math.abs(dp) * Math.sqrt(d[k]!));
      size = Math.max(size, Math.abs(next) * Math.sqrt(d[k]!));
    }
    if (change <= 1e-13 * size + 1e-300) break;
  }
}

/**
 * A swing measured as it runs: upward crossings of its rest angle (interpolated between steps) and the turning points,
 * so periods and amplitudes come from the run, not from a formula.
 */
export class SwingMeter {
  crossings: number[] = [];
  /** Each turning point: its time and its distance from rest, radians. */
  extremes: { t: number; a: number }[] = [];
  private last: { t: number; x: number; v: number } | null = null;
  readonly rest: number;
  constructor(rest: number) { this.rest = rest; }
  feed(t: number, q: number, v: number): void {
    const x = q - this.rest;
    const last = this.last;
    if (last) {
      if (last.x < 0 && x >= 0) this.crossings.push(last.t + ((t - last.t) * -last.x) / (x - last.x));
      if ((last.v > 0 && v <= 0) || (last.v < 0 && v >= 0)) {
        // The turning point between the two steps, where the velocity is 0 (linear in it): its distance from rest.
        const s = last.v === v ? 0 : last.v / (last.v - v);
        this.extremes.push({ t: last.t + (t - last.t) * s, a: Math.abs(last.x + (x - last.x) * s) });
      }
    }
    this.last = { t, x, v };
  }
  /** Mean period over the crossings from `from` s on, or NaN. */
  period(from = 0): number {
    const rows = this.crossings.filter((t) => t >= from);
    return rows.length >= 2 ? (rows[rows.length - 1]! - rows[0]!) / (rows.length - 1) : NaN;
  }
}

/** A coordinate's stable rest: where gravity's force on it is 0 and pushes back, nearest its start. Null if none. */
export function restOf(stepper: Stepper, c: number): number | null {
  const q = Float64Array.from(stepper.q);
  const f = new Float64Array(stepper.n);
  const force = (x: number) => { q[c] = x; stepper.forces(q, f); return f[c]! - stepper.system.coords[c]!.torque; };
  let best: number | null = null;
  const span = Math.PI, steps = 1440;
  let a = -span, fa = force(a);
  for (let k = 1; k <= steps; k += 1) {
    const b = -span + (2 * span * k) / steps, fb = force(b);
    if (fa > 0 && fb <= 0) {
      let lo = a, hi = b;
      for (let i = 0; i < 80; i += 1) { const mid = 0.5 * (lo + hi); if (force(mid) > 0) lo = mid; else hi = mid; }
      const root = 0.5 * (lo + hi);
      if (best === null || Math.abs(root) < Math.abs(best)) best = root;
    }
    a = b; fa = fb;
  }
  return best;
}

/** K(k), the complete elliptic integral of the first kind, by the arithmetic-geometric mean. */
export function ellipticK(k: number): number {
  let a = 1, b = Math.sqrt(1 - k * k);
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-16 * a; i += 1) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
}

/** A pendulum's period at amplitude `amplitude` (radians), from its small-swing period: T₀ · 2K(sin(a/2))/π. */
export function largeSwingPeriod(smallPeriod: number, amplitude: number): number {
  return (smallPeriod * 2 * ellipticK(Math.sin(amplitude / 2))) / Math.PI;
}
