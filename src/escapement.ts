/**
 * The Graham escapement as a contact element of the hinge dynamics (docs/plan-hinge-dynamics.md, section 2): each tooth
 * tip of the wheel against each pallet's two working faces, the locking arc about the anchor's pivot and the straight
 * impulse face, from `horology`'s numbers (src/graham.ts). horology's clash check guarantees that over the whole beat
 * the pallets meet the wheel only at its tips, so nothing else can touch.
 *
 * The plane: origin at the anchor's pivot, +Y toward it from the wheel's centre (which is at (0, −d)), +Z the frame's
 * normal, chosen so the wheel's teeth lean as horology draws them (it turns clockwise). `fitEscapement` reads that frame,
 * the wheel's phase and the anchor's angle from the parts' meshes, and checks the element against the meshes.
 */
import { meshDistance } from "./contact.ts";
import { layout, pivotDistance, wheelRoots, type Graham, type Layout, type P2 } from "./graham.ts";
import { BAND, driveSense, type Element, type Row, type Stepper, type System, type Vec3 } from "./dynamics.ts";
import type { Affine } from "./model-space.ts";

const DEG = Math.PI / 180;
/** How far from a face a tip is looked at for a speculative contact, mm: more than a step's travel at any clock speed. */
const SPECULATE_MM = 0.5;
const rot = (p: P2, a: number): P2 => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
const gammaOf = (p: P2) => -Math.atan2(p[1], p[0]) - Math.PI / 2;

/** How the element's two angles follow the run's coordinates. */
export interface EscapementLink {
  n: number;
  /** The wheel's plane angle moves `rate` radians per unit of coordinate `coord`; tooth 0's tip starts at `psi0`. */
  wheel: { coord: number; rate: number };
  /** The anchor's plane angle from its middle position, `alpha0` where the run starts. */
  anchor: { coord: number; rate: number };
  psi0: number;
  alpha0: number;
  /** Coulomb friction at the tooth tips. */
  mu: number;
}

interface Face {
  pallet: "entry" | "exit";
  rho: number;
  /** +1: the material lies inside the arc (entry); −1: outside (exit). */
  side: 1 | -1;
  gLo: number;
  gHi: number;
  a: P2;
  b: P2;
  normal: P2;
  rhoIn: number;
  rhoOut: number;
  /** The outward normal at the let-off corner of the pallet's back arc, beyond it: the corner's normals lie between it and the impulse face's. */
  backNormal: P2;
}

function faces(l: Layout): Face[] {
  const make = (pallet: "entry" | "exit"): Face => {
    const p = pallet === "entry" ? l.entry : l.exit;
    const [a, b] = [p.lockingCorner, p.letoffCorner];
    const [g0, g1] = [gammaOf(a), gammaOf(p.faceEnd)];
    const u: P2 = [b[0] - a[0], b[1] - a[1]];
    const length = Math.hypot(u[0], u[1]);
    let normal: P2 = [-u[1] / length, u[0] / length];
    // The material lies on the arm's side of the impulse face, toward the face's end along the locking arc.
    const toward = rot(p.faceEnd, 0);
    const probe: P2 = [(toward[0] + a[0] + b[0]) / 3 - a[0], (toward[1] + a[1] + b[1]) / 3 - a[1]];
    if (normal[0] * probe[0] + normal[1] * probe[1] > 0) normal = [-normal[0], -normal[1]];
    const side = pallet === "entry" ? 1 : -1;
    const lb = Math.hypot(b[0], b[1]);
    return { pallet, rho: p.lockingRadius, side, gLo: Math.min(g0, g1), gHi: Math.max(g0, g1), a, b, normal, rhoIn: l.rhoIn, rhoOut: l.rhoOut, backNormal: [(-side * b[0]) / lb, (-side * b[1]) / lb] };
  };
  return [make("entry"), make("exit")];
}

export interface Touch { gap: number; normal: P2; point: P2; face: "locking" | "impulse" | "corner" }

/** A point's signed distance to a pallet in the anchor's frame: negative inside, with the face it is nearest. */
export function palletGap(f: Face, p: P2): Touch {
  const rho = Math.hypot(p[0], p[1]), g = gammaOf(p);
  const inArc = g >= f.gLo && g <= f.gHi;
  const dArc = f.side * (rho - f.rho);
  const radial: P2 = [(f.side * p[0]) / rho, (f.side * p[1]) / rho];
  const u: P2 = [f.b[0] - f.a[0], f.b[1] - f.a[1]];
  const t = ((p[0] - f.a[0]) * u[0] + (p[1] - f.a[1]) * u[1]) / (u[0] * u[0] + u[1] * u[1]);
  const dSeg = f.normal[0] * (p[0] - f.a[0]) + f.normal[1] * (p[1] - f.a[1]);
  const inside = rho >= f.rhoIn && rho <= f.rhoOut && dSeg < 0 && (f.side === 1 ? g <= f.gHi : g >= f.gLo);
  const onArc = (d: number): Touch => ({ gap: d, normal: radial, point: [p[0] - radial[0] * d, p[1] - radial[1] * d], face: "locking" });
  const onSeg = (d: number): Touch => ({ gap: d, normal: f.normal, point: [p[0] - f.normal[0] * d, p[1] - f.normal[1] * d], face: "impulse" });
  if (inside) {
    const arc = inArc && dArc < 0 ? onArc(dArc) : null;
    const seg = t >= 0 && t <= 1 ? onSeg(dSeg) : null;
    if (arc && seg) return Math.abs(arc.gap) <= Math.abs(seg.gap) ? arc : seg;
    return arc ?? seg ?? onSeg(dSeg);
  }
  let best: Touch | null = null;
  const offer = (one: Touch) => { if (!best || one.gap < best.gap) best = one; };
  if (inArc && dArc >= 0) offer(onArc(dArc));
  if (t >= 0 && t <= 1 && dSeg >= 0) offer(onSeg(dSeg));
  for (const c of [f.a, f.b]) {
    const dx = p[0] - c[0], dy = p[1] - c[1], d = Math.hypot(dx, dy);
    if (!(d > 0)) continue;
    const n: P2 = [dx / d, dy / d];
    // Past the let-off corner the pallet's back arc follows, which no tip reaches: the corner is a contact only for
    // directions between the impulse face's normal and the back's. A tip sliding off the face leaves it.
    if (c === f.b) {
      const cr = (u: P2, w: P2) => u[0] * w[1] - u[1] * w[0];
      const span = cr(f.normal, f.backNormal);
      if (cr(f.normal, n) * span < 0 || cr(n, f.backNormal) * span < 0) continue;
    }
    offer({ gap: d, normal: n, point: c, face: "corner" });
  }
  return best!;
}

export interface EscapementState {
  /** Each tooth tip in contact: which pallet, which face, the tooth. */
  touching: { pallet: "entry" | "exit"; face: Touch["face"]; tooth: number }[];
  /** The least gap over every tip and both pallets, mm, and where: the tooth, the pallet and its face. */
  leastGap: number;
  least: { tooth: number; pallet: "entry" | "exit"; face: Touch["face"] } | null;
  wheelDeg: number;
  anchorDeg: number;
}

export interface EscapementElement extends Element {
  state(q: ArrayLike<number>): EscapementState;
  graham: Graham;
  layout: Layout;
  link: EscapementLink;
}

/** The element for `g`, linked to the run's coordinates. */
export function escapementElement(g: Graham, link: EscapementLink): EscapementElement | { reason: string } {
  const l = layout(g);
  if ("reason" in l) return l;
  const fs = faces(l);
  const r = g.wheel.tipRadius, teeth = g.wheel.teeth, pitch = (2 * Math.PI) / teeth;
  const centre: P2 = [0, -l.d];
  const angles = (q: ArrayLike<number>) => ({ psi: link.psi0 + link.wheel.rate * q[link.wheel.coord]!, alpha: link.alpha0 + link.anchor.rate * q[link.anchor.coord]! });
  /** Every tip near a pallet, with its touch in the plane. */
  // Each tooth's offset from tooth 0, as a cosine and a sine: a step turns them, it does not call trig per tooth.
  const ck = Array.from({ length: teeth }, (_, k) => Math.cos(k * pitch)), sk = Array.from({ length: teeth }, (_, k) => Math.sin(k * pitch));
  const near = (q: ArrayLike<number>, within: number, visit: (tooth: number, face: Face, touch: Touch, tip: P2, alpha: number) => void) => {
    const { psi, alpha } = angles(q);
    const cp = Math.cos(psi), sp = Math.sin(psi);
    const lo = Math.max(0, l.rhoIn - within - 1) ** 2, hi = (l.rhoOut + within + 1) ** 2;
    for (let k = 0; k < teeth; k += 1) {
      const tx = centre[0] + r * (cp * ck[k]! - sp * sk[k]!), ty = centre[1] + r * (sp * ck[k]! + cp * sk[k]!);
      // The distance from the pivot does not change as the anchor turns: most tips are dropped before any rotation.
      const rho2 = tx * tx + ty * ty;
      if (rho2 < lo || rho2 > hi) continue;
      const tip: P2 = [tx, ty];
      const local = rot(tip, -alpha);
      for (const f of fs) {
        const touch = palletGap(f, local);
        if (touch.gap <= within) visit(k, f, touch, tip, alpha);
      }
    }
  };
  const element: EscapementElement = {
    kind: "escapement",
    graham: g,
    layout: l,
    link,
    rows(q, v, h, out: Row[]) {
      // Speculative: a tip within half a step's travel of a face gets its row now, so the contact is met as the step
      // ends rather than found after it has gone in (docs/plan-hinge-dynamics.md, section 3).
      near(q, SPECULATE_MM, (_k, _f, touch, tip, alpha) => {
        const n = rot(touch.normal, alpha), point = rot(touch.point, alpha);
        const t: P2 = [-n[1], n[0]];
        // The tip turns about the wheel's centre, the face's point about the pivot (the origin).
        const tipArm: P2 = [-(tip[1] - centre[1]), tip[0] - centre[0]];
        const faceArm: P2 = [-point[1], point[0]];
        const row = (dir: P2) => {
          const j = new Float64Array(link.n);
          j[link.wheel.coord] = (j[link.wheel.coord] ?? 0) + (dir[0] * tipArm[0] + dir[1] * tipArm[1]) * link.wheel.rate;
          j[link.anchor.coord] = (j[link.anchor.coord] ?? 0) - (dir[0] * faceArm[0] + dir[1] * faceArm[1]) * link.anchor.rate;
          return j;
        };
        const j = row(n);
        let approach = 0;
        for (let c = 0; c < link.n; c += 1) approach += j[c]! * v[c]!;
        if (touch.gap > 0 && touch.gap + 0.5 * h * Math.min(0, approach) > 0) return;
        out.push({ j, kind: "normal", lo: 0, hi: Infinity, ledger: "impacts", gap: touch.gap });
        if (link.mu > 0) out.push({ j: row(t), kind: "friction", lo: 0, hi: 0, mu: link.mu, normal: out.length - 1, ledger: "pallets" });
      });
    },
    signature(q) {
      let out = "";
      near(q, BAND, (k, f, touch) => { out += `${k}${f.pallet[1]}${touch.face[0]} `; });
      return out;
    },
    state(q) {
      const touching: EscapementState["touching"] = [];
      let leastGap = Infinity;
      let least: EscapementState["least"] = null;
      near(q, 1e9, (k, f, touch) => {
        if (touch.gap < leastGap) { leastGap = touch.gap; least = { tooth: k, pallet: f.pallet, face: touch.face }; }
        if (touch.gap <= 1e-3) touching.push({ pallet: f.pallet, face: touch.face, tooth: k });
      });
      const { psi, alpha } = angles(q);
      return { touching, leastGap, least, wheelDeg: psi / DEG, anchorDeg: alpha / DEG };
    },
  };
  return element;
}

// --- Fitting the numbers to the parts.

export interface EscapementParts {
  wheel: { object: string; name: string; positions: ArrayLike<number>; pose: Affine; coord: number; scale: number; point: Vec3; axis: Vec3 };
  anchor: { object: string; name: string; positions: ArrayLike<number>; pose: Affine; coord: number; scale: number; point: Vec3; axis: Vec3 };
}

export interface Fitted {
  element: EscapementElement;
  /** What was read from the meshes and how well, in sentences and numbers. */
  fit: { pivotDistanceMm: number; wheelResidualMm: number; anchorResidualMm: number; analyticGapMm: number; meshGapMm: number; sense: 1 | -1 };
}

const FIT_MM = 0.02, PIVOT_MM = 0.05, CHECK_MM = 0.1;
/** A pallet this far inside a tooth, mm, is an overlap the parts cannot stand in: refused (a mesh's chord is less). */
export const OVERLAP_MM = 0.02;

function posed(positions: ArrayLike<number>, pose: Affine): Vec3[] {
  const seen = new Set<string>();
  const out: Vec3[] = [];
  const m = pose.m, t = pose.t;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    const key = `${x},${y},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([m[0] * x + m[1] * y + m[2] * z + t[0], m[3] * x + m[4] * y + m[5] * z + t[1], m[6] * x + m[7] * y + m[8] * z + t[2]]);
  }
  return out;
}
const nearest = (pts: readonly P2[], p: P2) => { let best = Infinity; for (const q of pts) { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < best) best = d; } return Math.sqrt(best); };

/**
 * The escapement element for `g` read from the parts: the frame's sense from the way the wheel's teeth lean, the
 * wheel's phase from its tips and roots, the anchor's angle from its four pallet corners (each to 0.02 mm), the
 * anchor's pivot at horology's distance from the wheel's axis (to 0.05 mm); then the element's least gap at the start
 * against the meshes' distance (to 0.1 mm). Refused, with the number that did not fit.
 */
export function fitEscapement(system: System, g: Graham, parts: EscapementParts, mu: number, stepper: Stepper): Fitted | { reason: string } {
  const l = layout(g);
  if ("reason" in l) return l;
  const { wheel, anchor } = parts;
  if (wheel.coord === anchor.coord) return { reason: `${wheel.name} and ${anchor.name} move together (one train): an escapement's wheel and anchor turn on their own.` };
  const nw = wheel.axis;
  const rel: Vec3 = [anchor.point[0] - wheel.point[0], anchor.point[1] - wheel.point[1], anchor.point[2] - wheel.point[2]];
  const along = rel[0] * nw[0] + rel[1] * nw[1] + rel[2] * nw[2];
  const v: Vec3 = [rel[0] - along * nw[0], rel[1] - along * nw[1], rel[2] - along * nw[2]];
  const dMeas = Math.hypot(...v);
  const d = pivotDistance(g);
  if (Math.abs(dMeas - d) > PIVOT_MM) return { reason: `${anchor.name}'s pivot is ${dMeas.toFixed(3)} mm from ${wheel.name}'s axis; horology's numbers put it at ${d.toFixed(3)} mm (span ${g.spanTeeth} teeth on a ${g.wheel.tipRadius} mm tip radius). Check the numbers, or place the anchor there.` };
  const y: Vec3 = [v[0] / dMeas, v[1] / dMeas, v[2] / dMeas];
  const wheelPts = posed(wheel.positions, wheel.pose), anchorPts = posed(anchor.positions, anchor.pose);
  const [front, back] = wheelRoots(g.wheel);
  const pitch = (2 * Math.PI) / g.wheel.teeth;
  const tries: { sense: 1 | -1; psi0: number; alpha0: number; wheelRes: number; anchorRes: number }[] = [];
  for (const sense of [1, -1] as const) {
    const N: Vec3 = [sense * nw[0], sense * nw[1], sense * nw[2]];
    const x: Vec3 = [y[1] * N[2] - y[2] * N[1], y[2] * N[0] - y[0] * N[2], y[0] * N[1] - y[1] * N[0]];
    const plane = (X: Vec3): P2 => { const dx = X[0] - anchor.point[0], dy = X[1] - anchor.point[1], dz = X[2] - anchor.point[2]; return [dx * x[0] + dy * x[1] + dz * x[2], dx * y[0] + dy * y[1] + dz * y[2]]; };
    const c: P2 = [0, -dMeas];
    const wp = wheelPts.map(plane);
    // The tips: points on the tip circle; their angles modulo a pitch give the phase (a circular mean).
    let sx = 0, sy = 0;
    for (const p of wp) {
      const r = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (Math.abs(r - g.wheel.tipRadius) > FIT_MM) continue;
      const a = Math.atan2(p[1] - c[1], p[0] - c[0]) * g.wheel.teeth;
      sx += Math.cos(a); sy += Math.sin(a);
    }
    if (sx === 0 && sy === 0) continue;
    const psi0 = Math.atan2(sy, sx) / g.wheel.teeth;
    let wheelRes = 0;
    for (let k = 0; k < g.wheel.teeth; k += 1) {
      for (const [radius, offset] of [[g.wheel.tipRadius, 0], [g.wheel.rootRadius, front], [g.wheel.rootRadius, back]] as const) {
        const a = psi0 + k * pitch + offset;
        wheelRes = Math.max(wheelRes, nearest(wp, [c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)]));
      }
    }
    // The anchor: the angle that puts horology's four pallet corners on its mesh's vertices.
    const ap = anchorPts.map(plane).filter((p) => { const r = Math.hypot(p[0], p[1]); return r > l.rhoIn - 0.5 && r < l.rhoOut + 0.5; });
    const corners = [l.entry.lockingCorner, l.entry.letoffCorner, l.exit.lockingCorner, l.exit.letoffCorner];
    const cost = (a: number) => Math.max(...corners.map((q) => nearest(ap, rot(q, a))));
    let alpha0 = 0, best = Infinity;
    if (ap.length) {
      for (let a = -45; a <= 45; a += 0.02) { const k = cost(a * DEG); if (k < best) { best = k; alpha0 = a * DEG; } }
      let lo = alpha0 - 0.02 * DEG, hi = alpha0 + 0.02 * DEG;
      for (let i = 0; i < 60; i += 1) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (cost(m1) <= cost(m2)) hi = m2; else lo = m1; }
      alpha0 = 0.5 * (lo + hi); best = cost(alpha0);
    }
    tries.push({ sense, psi0, alpha0, wheelRes, anchorRes: best });
  }
  const fits = tries.filter((row) => row.wheelRes <= FIT_MM && row.anchorRes <= FIT_MM);
  if (!fits.length) {
    const bestWheel = Math.min(...tries.map((row) => row.wheelRes), Infinity), bestAnchor = Math.min(...tries.map((row) => row.anchorRes), Infinity);
    if (!(bestWheel <= FIT_MM)) return { reason: `${wheel.name}'s mesh does not have the teeth of these numbers (${g.wheel.teeth} teeth, tip ${g.wheel.tipRadius} mm, root ${g.wheel.rootRadius} mm, lean ${g.wheel.leanDeg}°): its nearest corner is ${Number.isFinite(bestWheel) ? bestWheel.toFixed(3) : "nowhere"} mm off (0.02 allowed).` };
    return { reason: `${anchor.name}'s pallets are not where these numbers put them: at its best angle a pallet corner is ${Number.isFinite(bestAnchor) ? bestAnchor.toFixed(3) : "nowhere"} mm off (0.02 allowed). Check lock, impulse, drop and span, and that the anchor is not mirrored.` };
  }
  // With teeth that do not lean, both senses fit: take the one in which the drive turns the wheel clockwise. The drive's
  // own sense, carried through any ratchet between it and the wheel (one turned its free way is refused); with no drive,
  // the wheel train's static force (its parts' weight).
  const driven = driveSense(system, stepper.q, wheel.coord);
  if ("reason" in driven) return driven;
  const f = new Float64Array(stepper.n);
  stepper.forces(stepper.q, f);
  const pushes = driven.sense !== 0 ? driven.sense : f[wheel.coord]!;
  const choice = fits.find((row) => Math.sign(pushes * row.sense * wheel.scale) < 0) ?? fits[0]!;
  const wheelRate = choice.sense * wheel.scale, anchorRate = choice.sense * (anchor.axis[0] * nw[0] + anchor.axis[1] * nw[1] + anchor.axis[2] * nw[2] > 0 ? 1 : -1) * anchor.scale;
  if (pushes * wheelRate > 0) return { reason: `The drive turns ${wheel.name}${driven.via ? ` (through the ratchet between ${driven.via})` : ""} against its teeth: they lean for the other way. Reverse the drive (or the cord's winding), or mirror the wheel and the anchor.` };
  const link: EscapementLink = { n: stepper.n, wheel: { coord: wheel.coord, rate: wheelRate }, anchor: { coord: anchor.coord, rate: anchorRate }, psi0: choice.psi0, alpha0: choice.alpha0, mu };
  const element = escapementElement(g, link);
  if ("reason" in element) return element;
  const start = element.state(stepper.q);
  const analyticGap = start.leastGap;
  if (analyticGap < -OVERLAP_MM && start.least) {
    // A pallet inside a tooth: the wheel was not phased for this anchor. The smallest wheel turn, either way, that clears it.
    const clear = (dir: number) => {
      const q = Float64Array.from(stepper.q);
      const at = (deg: number) => { q[wheel.coord] = stepper.q[wheel.coord]! + (dir * deg * DEG) / wheelRate; return element.state(q).leastGap; };
      let lo = 0, hi = NaN;
      for (let deg = 0.01; deg <= 360 / g.wheel.teeth; deg += 0.01) { if (at(deg) >= 0) { hi = deg; break; } lo = deg; }
      if (!Number.isFinite(hi)) return NaN;
      for (let i = 0; i < 40; i += 1) { const mid = 0.5 * (lo + hi); if (at(mid) >= 0) hi = mid; else lo = mid; }
      return hi;
    };
    // The drive turns the wheel's plane angle down (clockwise, as horology draws it).
    const fwd = clear(-1), back = clear(1);
    const turns = [Number.isFinite(fwd) ? `${fwd.toFixed(2)}° the way the drive turns it` : "", Number.isFinite(back) ? `${back.toFixed(2)}° back` : ""].filter(Boolean).join(" or ");
    return { reason: `${anchor.name}'s ${start.least.pallet} pallet stands ${(-analyticGap).toFixed(3)} mm inside tooth ${start.least.tooth} of ${wheel.name} (its ${start.least.face === "corner" ? "corner" : `${start.least.face} face`}; ${OVERLAP_MM} mm allowed): the wheel is not phased for this anchor. ${turns ? `Turning the wheel ${turns} clears it` : "No wheel turn within a tooth clears it"}; or pose the anchor where its pallets clear the teeth.` };
  }
  const meshGap = meshDistance({ positions: Float32Array.from(wheel.positions), pose: wheel.pose }, { positions: Float32Array.from(anchor.positions), pose: anchor.pose });
  if (Math.abs(Math.max(0, analyticGap) - meshGap) > CHECK_MM) return { reason: `The escapement's numbers do not describe the parts as they stand: the element's least gap is ${analyticGap.toFixed(3)} mm, the meshes' ${meshGap.toFixed(3)} mm (0.1 allowed).` };
  return { element, fit: { pivotDistanceMm: dMeas, wheelResidualMm: choice.wheelRes, anchorResidualMm: choice.anchorRes, analyticGapMm: analyticGap, meshGapMm: meshGap, sense: choice.sense } };
}
