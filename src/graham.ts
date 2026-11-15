/**
 * The Graham escapement as `lime_recipe::horology` builds it (crates/lime-recipe/src/lib.rs, `EscapeWheel` and `Graham`),
 * ported line by line for the hinge dynamics' escapement element (docs/plan-hinge-dynamics.md, section 2) and for parts
 * built in tests. The crate computes its trig with its own `sin_cos` and `atan2`; this port uses Math's, so it agrees
 * with the crate to rounding (mcp/graham-port.test.ts holds it there), not to the bit.
 *
 * The anchor stands about its pivot at the origin in its middle position, the wheel's centre at (0, −pivot distance); the
 * wheel turns clockwise. Angles are radians inside, degrees where a field says so.
 */

export type P2 = [number, number];
type Piece = { line: P2 } | { arc: [P2, P2] };
export interface Outline { start: P2; pieces: Piece[] }

const PI = Math.PI;
const DEG = PI / 180;
const sinCos = (a: number): [number, number] => [Math.sin(a), Math.cos(a)];
const polar = (rho: number, a: number): P2 => [rho * Math.cos(a), rho * Math.sin(a)];
const rot = (p: P2, a: number): P2 => { const [s, c] = sinCos(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const len = (a: P2) => Math.sqrt(a[0] * a[0] + a[1] * a[1]);
const angle = (p: P2) => Math.atan2(p[1], p[0]);
const asin = (x: number) => Math.atan2(x, Math.sqrt(Math.max(0, 1 - x * x)));
const ok = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function segDist(p: P2, a: P2, b: P2): number {
  const d = sub(b, a), l2 = dot(d, d);
  const t = l2 > 0 ? clamp(dot(sub(p, a), d) / l2, 0, 1) : 0;
  return len(sub(p, add(a, mul(d, t))));
}
function crosses(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = cross(sub(b, a), sub(c, a)), d2 = cross(sub(b, a), sub(d, a)), d3 = cross(sub(d, c), sub(a, c)), d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** horology's `outline_points`: lines as they are, arcs in steps of at most `arcStepDeg`; the start not repeated. */
export function outlinePoints(outline: Outline, arcStepDeg: number): P2[] {
  const step = Math.max(arcStepDeg, 0.01) * DEG;
  const pts: P2[] = [outline.start];
  let from = outline.start;
  for (const piece of outline.pieces) {
    if ("line" in piece) { pts.push(piece.line); from = piece.line; continue; }
    const [through, to] = piece.arc;
    arcPoints(pts, from, through, to, step);
    from = to;
  }
  if (pts.length > 1) pts.pop();
  return pts;
}
function arcPoints(pts: P2[], a: P2, b: P2, c: P2, step: number): void {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-18) { pts.push(c); return; }
  const [a2, b2, c2] = [dot(a, a), dot(b, b), dot(c, c)];
  const o: P2 = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  const rho = len(sub(a, o));
  const ccw = cross(sub(b, a), sub(c, b)) > 0;
  const a0 = angle(sub(a, o));
  let a1 = angle(sub(c, o));
  if (ccw) while (a1 <= a0) a1 += 2 * PI;
  else while (a1 >= a0) a1 -= 2 * PI;
  const n = Math.max(Math.ceil(Math.abs(a1 - a0) / step), 1);
  for (let i = 1; i < n; i += 1) pts.push(add(o, polar(rho, a0 + ((a1 - a0) * i) / n)));
  pts.push(c);
}

/** horology's `EscapeWheel`: pointed teeth leaning `leanDeg` forward, turning clockwise. */
export interface EscapeWheel { teeth: number; tipRadius: number; rootRadius: number; leanDeg: number; rootShare: number }

export function escapeWheel(teeth: number, tipRadius: number, rootRadius: number, leanDeg: number, rootShare = 1 / 3): EscapeWheel {
  return { teeth, tipRadius, rootRadius, leanDeg, rootShare };
}

export function wheelRefusal(w: EscapeWheel): string | null {
  if (w.teeth < 12 || w.teeth > 200) return "An escape wheel takes 12 to 200 teeth.";
  if (!ok(w.tipRadius, 1, 500)) return "An escape wheel's tip radius is 1 to 500 mm.";
  if (!ok(w.rootRadius, 0.1 * w.tipRadius, 0.98 * w.tipRadius)) return "An escape wheel's root radius is under its tip radius, and more than a tenth of it.";
  if (!ok(w.leanDeg, 0, 30)) return "An escape wheel's teeth lean 0 to 30 degrees forward.";
  if (!ok(w.rootShare, 0.1, 0.7)) return "A tooth's root takes 0.1 to 0.7 of the pitch.";
  if (w.rootRadius <= w.tipRadius * Math.sin(w.leanDeg * DEG)) return "The front faces lean so far they miss the root circle: lean the teeth less or cut the roots deeper.";
  return null;
}

/** The polar offsets, radians counter-clockwise from a tooth's tip, of its front face's and its back's roots. */
export function wheelRoots(w: EscapeWheel): [number, number] {
  const [rTip, rRoot] = [w.tipRadius, w.rootRadius];
  const [sl, cl] = sinCos(w.leanDeg * DEG);
  const t = rTip * cl - Math.sqrt(Math.max(0, rRoot * rRoot - rTip * rTip * sl * sl));
  const front = angle([rTip - t * cl, t * sl]);
  return [front, front + (w.rootShare * 2 * PI) / w.teeth];
}

/** The wheel's outline with tooth 0's tip at `phaseDeg` from +X, about its own centre. */
export function wheelOutline(w: EscapeWheel, phaseDeg: number): Outline | { reason: string } {
  const why = wheelRefusal(w);
  if (why) return { reason: why };
  const [front, back] = wheelRoots(w);
  const pitch = (2 * PI) / w.teeth;
  const c0 = phaseDeg * DEG;
  const start = polar(w.rootRadius, c0 + front);
  const pieces: Piece[] = [];
  for (let k = 0; k < w.teeth; k += 1) {
    const c = c0 + pitch * k;
    pieces.push({ line: polar(w.tipRadius, c) });
    pieces.push({ line: polar(w.rootRadius, c + back) });
    const to = k + 1 === w.teeth ? start : polar(w.rootRadius, c + pitch + front);
    pieces.push({ arc: [polar(w.rootRadius, c + 0.5 * (back + pitch + front)), to] });
  }
  return { start, pieces };
}

/** horology's `Graham`, with `Graham::new`'s defaults for what is not given. */
export interface Graham {
  wheel: EscapeWheel;
  spanTeeth: number;
  lockDeg: number;
  impulseDeg: number;
  dropDeg: number;
  supplementaryDeg: number;
  armWidth: number;
  hubRadius: number;
  clearance: number;
  friction: number;
}

export function graham(wheel: EscapeWheel, spanTeeth: number, over: Partial<Omit<Graham, "wheel" | "spanTeeth">> = {}): Graham {
  const beta = (PI * spanTeeth) / wheel.teeth;
  const d = wheel.tipRadius / Math.cos(beta);
  const hub = 0.5 * (d - wheel.tipRadius);
  return { wheel, spanTeeth, lockDeg: 1.5, impulseDeg: 2.5, dropDeg: 1.5, supplementaryDeg: 2, armWidth: Math.min(0.15 * wheel.tipRadius, 1.5 * hub), hubRadius: hub, clearance: 0.2, friction: 0.3, ...over };
}

export interface Pallet { lockingCorner: P2; letoffCorner: P2; lockingRadius: number; faceEnd: P2 }
export interface Layout { d: number; thetaLo: number; thetaHi: number; rhoIn: number; rhoOut: number; alphaE: number; alphaX: number; entry: Pallet; exit: Pallet; spokeEntry: number; spokeExit: number }

const atGamma = (rho: number, g: number): P2 => polar(rho, -g - PI / 2);
export const gammaOf = (p: P2) => -angle(p) - PI / 2;

export function pivotDistance(g: Graham): number {
  return g.wheel.tipRadius / Math.cos((PI * g.spanTeeth) / g.wheel.teeth);
}
export function swingDeg(g: Graham): number {
  return g.lockDeg + g.impulseDeg;
}
export function letoffDeg(g: Graham): [number, number] {
  return [-swingDeg(g) / 2, swingDeg(g) / 2];
}

function numbersRefusal(g: Graham): string | null {
  const why = wheelRefusal(g.wheel);
  if (why) return why;
  const twice = g.spanTeeth * 2;
  if (!Number.isFinite(twice) || Math.round(twice) !== twice || Math.trunc(twice) % 2 !== 1 || g.spanTeeth < 1.5) return "The pallets span a whole number of teeth and a half (7.5, say), at least 1.5.";
  if ((PI * g.spanTeeth) / g.wheel.teeth > 70 * DEG) return "The span reaches more than 70 degrees round the wheel each side of the pivot: span fewer teeth.";
  if (!ok(g.lockDeg, 0.1, 10)) return "The lock is 0.1 to 10 degrees of the anchor.";
  if (!ok(g.impulseDeg, 0.1, 15)) return "The impulse is 0.1 to 15 degrees of the anchor.";
  if (!(Number.isFinite(g.dropDeg) && g.dropDeg > 0)) return "A drop of nothing leaves no room: a tooth leaving one pallet would strike the other.";
  if (g.dropDeg >= 360 / g.wheel.teeth / 2) return "A drop of half a tooth pitch or more leaves the pallets no thickness.";
  if (!ok(g.supplementaryDeg, 0, 20)) return "The supplementary arc is 0 to 20 degrees of the anchor.";
  if (!ok(g.clearance, 0, g.wheel.tipRadius) || !ok(g.friction, 0, 1)) return "The clearance is 0 mm or more, and the friction 0 to 1.";
  if (g.wheel.tipRadius * g.dropDeg * DEG < g.clearance) return "The drop is smaller than the clearance at the wheel's tips: use more drop or less clearance.";
  if (!(Number.isFinite(g.armWidth) && g.armWidth > 0 && Number.isFinite(g.hubRadius) && g.hubRadius > g.armWidth / 2)) return "The anchor's arms need a width, and its hub must be wider than they are.";
  if (g.hubRadius + g.clearance >= pivotDistance(g) - g.wheel.tipRadius) return "The anchor's hub reaches the wheel's tips: use a smaller hub or span more teeth.";
  return null;
}

export function layout(g: Graham): Layout | { reason: string } {
  const why = numbersRefusal(g);
  if (why) return { reason: why };
  const r = g.wheel.tipRadius;
  const pitch = (2 * PI) / g.wheel.teeth;
  const d = pivotDistance(g);
  const a = pitch / 2 - g.dropDeg * DEG;
  const beta = (PI * g.spanTeeth) / g.wheel.teeth;
  const [thetaLo, thetaHi] = [beta - a / 2, beta + a / 2];
  const tip = (side: number, theta: number): P2 => { const [s, c] = sinCos(theta); return [-side * r * s, r * c - d]; };
  const rhoIn = len(tip(1, thetaLo));
  const rhoOut = len(tip(1, thetaHi));
  const [lock, imp, supp] = [g.lockDeg * DEG, g.impulseDeg * DEG, g.supplementaryDeg * DEG];
  const alphaE = -(lock + imp) / 2;
  const alphaX = (lock + imp) / 2;
  const eLo = rot(tip(1, thetaLo), -alphaE);
  const eLk = rot(tip(1, thetaHi), -(alphaE + imp));
  const xLo = rot(tip(-1, thetaHi), -alphaX);
  const xLk = rot(tip(-1, thetaLo), -(alphaX - imp));
  for (const [corner, end] of [[eLk, eLo], [xLk, xLo]] as [P2, P2][]) {
    const u = sub(end, corner);
    const t: P2 = [-corner[1], corner[0]];
    if (Math.abs(cross(u, t)) <= g.friction * Math.abs(dot(u, t))) return { reason: "The impulse faces lie within the friction angle of the locking faces, so a tooth would stick at the corner: use less impulse or less drop." };
  }
  const w = g.armWidth, h = g.hubRadius;
  const off = (rho: number) => asin(w / (2 * rho));
  const need = r + g.clearance;
  const arms = "The anchor's arms cannot clear the wheel: use narrower arms, a smaller hub or less supplementary arc.";
  const farE = rot([0, -d], -(alphaX + supp));
  const clearE = (gm: number) => segDist(farE, atGamma(h, gm - off(h)), atGamma(rhoIn, gm - off(rhoIn))) >= need;
  let [lo, hi] = [gammaOf(eLk), 0.95 * PI];
  if (!clearE(hi)) return { reason: arms };
  for (let i = 0; i < 60; i += 1) { const mid = 0.5 * (lo + hi); if (clearE(mid)) hi = mid; else lo = mid; }
  const spokeEntry = hi;
  const farX = rot([0, -d], -(alphaE - supp));
  const clearX = (gm: number) => segDist(farX, atGamma(h, gm + off(h)), atGamma(rhoIn, gm + off(rhoIn))) >= need;
  [lo, hi] = [-0.95 * PI, gammaOf(xLk)];
  if (!clearX(lo)) return { reason: arms };
  for (let i = 0; i < 60; i += 1) { const mid = 0.5 * (lo + hi); if (clearX(mid)) lo = mid; else hi = mid; }
  const spokeExit = lo;
  if (spokeEntry + off(h) >= PI || spokeExit - off(h) <= -PI || spokeEntry - off(h) <= spokeExit + off(h)) return { reason: arms };
  const entry: Pallet = { lockingCorner: eLk, letoffCorner: eLo, lockingRadius: rhoOut, faceEnd: atGamma(rhoOut, spokeEntry + off(rhoOut)) };
  const exit: Pallet = { lockingCorner: xLk, letoffCorner: xLo, lockingRadius: rhoIn, faceEnd: atGamma(rhoIn, spokeExit + off(rhoIn)) };
  if (gammaOf(entry.faceEnd) - gammaOf(eLk) < lock + supp || gammaOf(xLk) - gammaOf(exit.faceEnd) < lock + supp || spokeEntry - off(rhoIn) <= gammaOf(eLo) || spokeExit - off(rhoOut) >= gammaOf(xLo)) {
    return { reason: "The locking faces are shorter than the lock and the supplementary arc: use narrower arms." };
  }
  return { d, thetaLo, thetaHi, rhoIn, rhoOut, alphaE, alphaX, entry, exit, spokeEntry, spokeExit };
}

function anchorFrom(g: Graham, l: Layout): Outline {
  const h = g.hubRadius, w = g.armWidth;
  const off = (rho: number) => asin(w / (2 * rho));
  const arc = (rho: number, g0: number, g1: number, to: P2): Piece => ({ arc: [atGamma(rho, 0.5 * (g0 + g1)), to] });
  const [ge, gx] = [l.spokeEntry, l.spokeExit];
  const [e, x] = [l.entry, l.exit];
  const start = atGamma(h, PI);
  const pieces: Piece[] = [
    arc(h, PI, ge + off(h), atGamma(h, ge + off(h))),
    { line: atGamma(l.rhoOut, ge + off(l.rhoOut)) },
    arc(l.rhoOut, ge + off(l.rhoOut), gammaOf(e.lockingCorner), e.lockingCorner),
    { line: e.letoffCorner },
    arc(l.rhoIn, gammaOf(e.letoffCorner), ge - off(l.rhoIn), atGamma(l.rhoIn, ge - off(l.rhoIn))),
    { line: atGamma(h, ge - off(h)) },
    arc(h, ge - off(h), gx + off(h), atGamma(h, gx + off(h))),
    { line: atGamma(l.rhoIn, gx + off(l.rhoIn)) },
    arc(l.rhoIn, gx + off(l.rhoIn), gammaOf(x.lockingCorner), x.lockingCorner),
    { line: x.letoffCorner },
    arc(l.rhoOut, gammaOf(x.letoffCorner), gx - off(l.rhoOut), atGamma(l.rhoOut, gx - off(l.rhoOut))),
    { line: atGamma(h, gx - off(h)) },
    arc(h, gx - off(h), -PI, start),
  ];
  return { start, pieces };
}

function clash(g: Graham, l: Layout, anchor: Outline): boolean {
  const r = g.wheel.tipRadius;
  const aPts = outlinePoints(anchor, 0.5);
  const [imp, supp, drop] = [g.impulseDeg * DEG, g.supplementaryDeg * DEG, g.dropDeg * DEG];
  const pull = 0.02 * DEG;
  const up = PI / 2;
  const faceTip = (corner: P2, end: P2, alpha: number): number | null => {
    const a = add(rot(corner, alpha), [0, l.d]);
    const b = add(rot(end, alpha), [0, l.d]);
    const v = sub(b, a);
    const [qa, qb, qc] = [dot(v, v), 2 * dot(a, v), dot(a, a) - r * r];
    const disc = qb * qb - 4 * qa * qc;
    if (qa <= 0 || disc < 0) return null;
    for (const s of [(-qb - Math.sqrt(disc)) / (2 * qa), (-qb + Math.sqrt(disc)) / (2 * qa)]) if (Math.abs(s - 0.5) <= 0.5 + 1e-9) return angle(add(a, mul(v, s)));
    return null;
  };
  const poses: [number, number][] = [];
  const spanE = l.alphaX + supp - (l.alphaE + imp);
  for (let k = 0; k <= 4; k += 1) poses.push([up + l.thetaHi, l.alphaE + imp + (spanE * k) / 4]);
  for (let k = 0; k <= 6; k += 1) { const alpha = l.alphaE + imp - (imp * k) / 6; const phi = faceTip(l.entry.lockingCorner, l.entry.letoffCorner, alpha); if (phi !== null) poses.push([phi, alpha]); }
  for (let k = 0; k <= 2; k += 1) poses.push([up + l.thetaLo - (drop * k) / 2, l.alphaE]);
  const spanX = l.alphaX - imp - (l.alphaE - supp);
  for (let k = 0; k <= 4; k += 1) poses.push([up + l.thetaLo - drop, l.alphaE - supp + (spanX * k) / 4]);
  for (let k = 0; k <= 6; k += 1) { const alpha = l.alphaX - imp + (imp * k) / 6; const phi = faceTip(l.exit.lockingCorner, l.exit.letoffCorner, alpha); if (phi !== null) poses.push([phi, alpha]); }
  for (let k = 0; k <= 2; k += 1) poses.push([up - l.thetaHi - (drop * k) / 2, l.alphaX]);
  for (const [phi, alpha] of poses) {
    const outline = wheelOutline(g.wheel, (phi + pull) / DEG);
    if ("reason" in outline) return true;
    const wheel = outlinePoints(outline, 2);
    const placed = aPts.map((q) => add(rot(q, alpha), [0, l.d]));
    let lo = placed[0]!, hi = placed[0]!;
    for (const q of placed) { lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])]; hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])]; }
    const [n, m] = [wheel.length, placed.length];
    for (let i = 0; i < n; i += 1) {
      const a = wheel[i]!, b = wheel[(i + 1) % n]!;
      if (Math.max(a[0], b[0]) < lo[0] || Math.min(a[0], b[0]) > hi[0] || Math.max(a[1], b[1]) < lo[1] || Math.min(a[1], b[1]) > hi[1]) continue;
      for (let j = 0; j < m; j += 1) if (crosses(a, b, placed[j]!, placed[(j + 1) % m]!)) return true;
    }
  }
  return false;
}

/** The anchor's outline about its pivot in its middle position, or horology's refusal. */
export function anchorOutline(g: Graham): Outline | { reason: string } {
  const l = layout(g);
  if ("reason" in l) return l;
  const outline = anchorFrom(g, l);
  if (clash(g, l, outline)) return { reason: "A pallet meets the wheel away from the tooth tips: lean the teeth further forward, cut the roots deeper, or use less lock, impulse or supplementary arc." };
  return outline;
}

export function grahamRefusal(g: Graham): string | null {
  const a = anchorOutline(g);
  return "reason" in a ? a.reason : null;
}

/** The wheel's phase (tooth 0's tip, degrees from +X) and the anchor's angle (degrees) just after the exit let-off. */
export function restPose(g: Graham): [number, number] | { reason: string } {
  const l = layout(g);
  if ("reason" in l) return l;
  return [90 + l.thetaHi / DEG, l.alphaX / DEG];
}
