/**
 * A ratchet's click riding its wheel (docs/plan-coupling-kinds.md, stage 3), in the plane of the wheel. The ratchet and
 * the click are built as `lime_recipe::horology` builds them (`Ratchet::outline`, `Ratchet::click` with `click_size`): saw
 * teeth between `tip` and `root`, each a radial face and a straight back; the click's nose `seat_gap` (0.1 of the tooth
 * depth) off the root against tooth 0's face, its underside parallel to the next tooth's back, its pivot on the tangent
 * through the middle of the face at `arm` from it. In this frame the wheel runs free clockwise, as horology's does.
 *
 * `clickLift` is the click's turn about its pivot (counter-clockwise, outward) when the wheel has run `phase` degrees
 * free past the notch: the least turn that keeps the nose and the underside out of every tooth. So the nose rides each
 * tooth's back up to the tip and drops into the next notch, from the geometry alone, with no contact search.
 */

type P = [number, number];
const polar = (r: number, a: number): P => [r * Math.cos(a), r * Math.sin(a)];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const len = (a: P) => Math.hypot(a[0], a[1]);
const ang = (a: P) => Math.atan2(a[1], a[0]);
const rot = (p: P, a: number): P => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
const DEG = Math.PI / 180;

/** A ratchet's teeth and its click's arm: horology's `Ratchet {teeth, tip_radius, root_radius}` and `Click.length`. */
export interface ClickShape {
  teeth: number;
  tip: number;
  root: number;
  /** From the middle of the face the click bears on to its pivot, along the tangent there, mm. */
  arm: number;
}

export interface ClickGeometry {
  pivot: P;
  nose: P;
  under: P;
  /** horology's `lift_deg`: the turn that brings the nose to the tip circle, degrees. */
  liftDeg: number;
  pitchDeg: number;
  /** Where the click's face bears, from the wheel's axis: the middle of the face (horology's `mid`), mm. */
  midRadius: number;
}

/** The radius of the face's middle, where horology's click bears: the arm runs at right angles to it to the pivot. */
export function faceMiddle(tip: number, root: number): number {
  const h = tip - root;
  return 0.5 * (root + 0.1 * h + tip);
}

/** A ratchet and click horology would refuse, in its sentence; null when it builds. */
export function clickRefusal(shape: ClickShape): string | null {
  const { teeth, tip, root, arm } = shape;
  if (!Number.isInteger(teeth) || teeth < 6 || teeth > 200) return "A ratchet takes 6 to 200 teeth.";
  if (!(tip >= 1 && tip <= 500) || !(root >= 0.3 * tip && root <= 0.97 * tip)) return "A ratchet's tip radius is 1 to 500 mm, its root radius 0.3 to 0.97 of it.";
  const h = tip - root;
  if (!(arm >= 0.5 * h && arm <= 20 * tip)) return "The click's hinge is too near the wheel or too far from it for a click on this ratchet.";
  return null;
}

/** The click as `Ratchet::click` places it with tooth 0's face along +X, and its lift (horology, ported line by line). */
export function clickGeometry(shape: ClickShape): ClickGeometry {
  const { teeth, tip: big, root: small, arm } = shape;
  const h = big - small, gap = 0.1 * h, rise = 0.6 * h;
  const pitch = (2 * Math.PI) / teeth;
  const nose = polar(small + gap, 0);
  const mid = polar(0.5 * (small + gap + big), 0);
  const pivot = add(mid, mul([0, 1], arm));
  const back = sub(polar(big, pitch), polar(small, 0));
  const v = mul(back, 1 / len(back));
  const rhoU = big + 0.5 * rise;
  const kv = dot(nose, v);
  const under = add(nose, mul(v, -kv + Math.sqrt(kv * kv - dot(nose, nose) + rhoU * rhoU)));
  const k = sub(nose, pivot);
  const kl = len(k), cl = len(pivot);
  const cosD = Math.max(-1, Math.min(1, (cl * cl + kl * kl - big * big) / (2 * cl * kl)));
  const toward = ang(mul(pivot, -1)), ak = ang(k);
  const outward = dot(nose, [-k[1], k[0]]) > 0;
  let lift = 4 * Math.PI;
  for (const a of [toward + Math.acos(cosD), toward - Math.acos(cosD)]) {
    let turn = outward ? a - ak : ak - a;
    while (turn <= 0) turn += 2 * Math.PI;
    while (turn > 2 * Math.PI) turn -= 2 * Math.PI;
    lift = Math.min(lift, turn);
  }
  return { pivot, nose, under, liftDeg: ((outward ? 1 : -1) * lift) / DEG, pitchDeg: 360 / teeth, midRadius: 0.5 * (small + gap + big) };
}

/**
 * The ratchet's outline (`Ratchet::outline` with tooth 0's face at 0 degrees), counter-clockwise: from each face's root,
 * the back up to the next tip, then that face down to its root.
 */
export function ratchetOutline(shape: Pick<ClickShape, "teeth" | "tip" | "root">): P[] {
  const pitch = (2 * Math.PI) / shape.teeth;
  const out: P[] = [polar(shape.root, 0)];
  for (let k = 1; k <= shape.teeth; k += 1) {
    out.push(polar(shape.tip, k * pitch));
    if (k < shape.teeth) out.push(polar(shape.root, k * pitch));
  }
  return out;
}

/**
 * The whole click's outline seated in tooth 0's notch, in the wheel's frame (`Ratchet::click`, ported): the nose, up the
 * face to `rise` above the tips, the edge tangent to the hub, round the hub (`arcSteps` chords), the edge back to the
 * underside's far end, and the underside to the nose. Null when horology would refuse the click.
 */
export function clickOutline(shape: ClickShape, arcSteps = 24): P[] | null {
  const { teeth, tip: big, root: small, arm } = shape;
  const h = big - small, gap = 0.1 * h, rise = 0.6 * h, hub = h;
  const geometry = clickGeometry(shape);
  const { pivot, nose, under } = geometry;
  const top = polar(big + rise, 0);
  if (len(pivot) - hub <= big + gap || teeth < 6) return null;
  const cross = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
  const tangent = (from: P, toHub: boolean): P | null => {
    const d = len(sub(from, pivot));
    if (d <= hub) return null;
    const base = ang(sub(from, pivot)), o = Math.acos(hub / d);
    for (const a of [base + o, base - o]) {
      const t = add(pivot, polar(hub, a));
      const left = toHub ? cross(sub(t, from), sub(pivot, from)) : cross(sub(from, t), sub(pivot, t));
      if (left > 0) return t;
    }
    return null;
  };
  const up = tangent(top, true), low = tangent(under, false);
  if (!up || !low || arm < 0.5 * h) return null;
  const a0 = ang(sub(up, pivot));
  let a1 = ang(sub(low, pivot));
  while (a1 <= a0) a1 += 2 * Math.PI;
  const arc = Array.from({ length: arcSteps - 1 }, (_, i) => add(pivot, polar(hub, a0 + ((a1 - a0) * (i + 1)) / arcSteps)));
  return [nose, top, up, ...arc, low, under];
}

/** How far `p` (in the wheel's frame) lies inside the teeth, mm: positive inside, negative outside. */
export function toothDepth(shape: Pick<ClickShape, "teeth" | "tip" | "root">, p: P): number {
  const pitch = (2 * Math.PI) / shape.teeth;
  let a = ang(p) % pitch;
  if (a < 0) a += pitch;
  // The back runs from (root, 0) to (tip, pitch): its radius at angle a, on the line through those two polar points.
  const r = (shape.root * shape.tip * Math.sin(pitch)) / (shape.root * Math.sin(a) + shape.tip * Math.sin(pitch - a));
  return r - len(p);
}

/** The click's points that meet the teeth: the nose and the underside out to its far end. */
function bearing(geometry: ClickGeometry): P[] {
  return [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((f) => add(geometry.nose, mul(sub(geometry.under, geometry.nose), f)));
}

/** The deepest of the click's points inside the teeth with the click turned `liftDeg` and the wheel run `phaseDeg` free. */
export function clickDepth(shape: ClickShape, geometry: ClickGeometry, phaseDeg: number, liftDeg: number): number {
  let worst = -Infinity;
  for (const point of bearing(geometry)) {
    const turned = add(geometry.pivot, rot(sub(point, geometry.pivot), liftDeg * DEG));
    // The wheel has turned clockwise by the phase: read the point in its frame.
    worst = Math.max(worst, toothDepth(shape, rot(turned, phaseDeg * DEG)));
  }
  // A tooth's tip corner can reach into the click between those points: inside the wedge at its nose, past the underside
  // (toward the click's body) and on the body's side of its face (the radial face that bears on the tooth).
  const turn = (p: P) => add(geometry.pivot, rot(sub(p, geometry.pivot), liftDeg * DEG));
  const a = turn(geometry.nose), b = turn(geometry.under);
  const run = sub(b, a), length = len(run);
  const face = rot([1, 0], liftDeg * DEG);
  // The body lies past the underside on the face's side, and past the face on the underside's side.
  let across: P = [-run[1] / length, run[0] / length];
  if (dot(across, face) < 0) across = mul(across, -1);
  let beside: P = [-face[1], face[0]];
  if (dot(beside, run) < 0) beside = mul(beside, -1);
  const pitch = (2 * Math.PI) / shape.teeth;
  for (let k = 0; k < shape.teeth; k += 1) {
    const corner = rot(polar(shape.tip, k * pitch), -phaseDeg * DEG);
    const t = dot(sub(corner, a), run) / (length * length);
    if (t <= 0 || t >= 1) continue;
    worst = Math.max(worst, Math.min(dot(sub(corner, a), across), dot(sub(corner, a), beside)));
  }
  return worst;
}

/**
 * The click's lift, degrees counter-clockwise about its pivot, with the wheel run `phaseDeg` free past its notch: the
 * least turn at which no point of its nose or underside is inside a tooth. Zero in the notch; it rises along the tooth's
 * back to `liftDeg` at the tip, and drops as the tip passes. The same shape and phase give the same answer.
 */
export function clickLift(shape: ClickShape, phaseDeg: number, geometry: ClickGeometry = clickGeometry(shape)): number {
  const phase = ((phaseDeg % geometry.pitchDeg) + geometry.pitchDeg) % geometry.pitchDeg;
  const clear = (lift: number) => clickDepth(shape, geometry, phase, lift) <= 0;
  if (clear(0)) return 0;
  const top = Math.abs(geometry.liftDeg) * 1.5 + 1;
  const steps = 600;
  let low = 0, high = top;
  for (let k = 1; k <= steps; k += 1) {
    const lift = (top * k) / steps;
    if (clear(lift)) { low = (top * (k - 1)) / steps; high = lift; break; }
  }
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (clear(mid)) high = mid;
    else low = mid;
  }
  return high;
}
