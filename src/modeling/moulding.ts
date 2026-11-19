/**
 * Moulding checks on a ribs plan (docs/handover-auto-ribs-next.md §4 E1). One pure function, so a later
 * model_check {process:"injection"} (docs/plan-recipe-ingredients.md I24) can call it. This is a report:
 * nothing is resized, drafted or refused because a rule flags.
 *
 * The section is the one ribNet builds (`ribShape`). The junction circle is read from that outline, so the
 * check does not need the planner's Rust geometry.
 *
 * Thresholds are named constants. They are not product defaults: the moulded rib's width, draft and root
 * stay as the planner builds them.
 */
import { ribShape, type RibProfile, type RibShape } from "./rib-net.ts";

type V3 = [number, number, number];
type P2 = [number, number];

/** Root thickness over the local wall. Flag above this (sink marks). */
export const MOULD_ROOT_RATIO = 0.6;
/** Rib height over the local wall. Flag above this. */
export const MOULD_HEIGHT_WALLS = 3;
/** Draft of a flank along the pull, degrees. Flag under this. */
export const MOULD_MIN_DRAFT_DEG = 0.5;
/** Junction circle over the wall's own inscribed circle (the wall thickness). Flag above this. */
export const MOULD_JUNCTION_RATIO = 1.2;
/** Clear gap between parallel ribs, in wall thicknesses (the mould steel between them). Flag under this. */
export const MOULD_SPACING_WALLS = 2;

/** The five rules, in the order the report lists them. An undercut is a flag of the draft rule, not a sixth rule. */
export const MOULD_RULES = ["root", "height", "draft", "junction", "spacing"] as const;
export type MouldRuleId = (typeof MOULD_RULES)[number];
export type MouldFlagRule = MouldRuleId | "undercut";

/** A section as the plan lists it. Absent draft or root takes ribNet's own default for that profile. */
export interface MouldSection {
  profile: "straight" | "drafted" | "tee";
  width: number;
  draftDeg?: number;
  rootRadius?: number;
  flangeWidth?: number;
  flangeThickness?: number;
  flangeChamferDeg?: number;
}

/** One rib on the wall's face. `wallMm` is the local wall thickness at each point. */
export interface MouldRib {
  points: V3[];
  heights: number[];
  sections: MouldSection[];
  normals: V3[];
  wallMm: number[];
}

export interface MouldAt {
  /** Stretch along the rib, 0-based. */
  stretch: number;
  point: V3;
  /** The other rib, when two ribs meet or run side by side. */
  meets?: number;
  /** How two ribs meet. */
  joint?: "crossing" | "tee";
}

export interface MouldFlag {
  rule: MouldFlagRule;
  /** Index into the rib list, 0-based. */
  rib: number;
  at: MouldAt;
  value: number;
  threshold: number;
}

export interface MouldRule {
  rule: MouldRuleId;
  threshold: number;
  /** The worst number for the rule, or null when the plan has nothing it applies to. */
  worst: number | null;
  pass: boolean;
}

export interface MouldingReport {
  rules: MouldRule[];
  flags: MouldFlag[];
}

/**
 * Attach a report only for process moulded. Filament and resin keep the object untouched, so a reply
 * built that way stays byte-identical.
 */
export function mouldedOnly(process: string, plan: Record<string, unknown>, report: MouldingReport): void {
  if (process === "moulded") plan.moulding = report;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 | null => {
  const n = len(a);
  return n < 1e-12 ? null : mul(a, 1 / n);
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const q4 = (n: number) => Math.round(n * 10000) / 10000;
const r4 = (p: V3): V3 => [q4(p[0]), q4(p[1]), q4(p[2])];

/** The drafted section `RibProfile::default_drafted` builds: width at half height, 1° a side, root half the top. Not a new default. */
export function defaultDraftedSection(width: number, height: number): MouldSection {
  const draftDeg = 1;
  const top = width - height * Math.tan((draftDeg * Math.PI) / 180);
  return { profile: "drafted", width, draftDeg, rootRadius: 0.5 * Math.max(0, top) };
}

/** The profile ribNet would build, or null when the section cannot stand at this height. */
function shapeOf(section: MouldSection, height: number): { shape: RibShape; profile: RibProfile } | null {
  const kind = section.profile;
  const draftDeg = kind === "drafted" ? section.draftDeg ?? 1 : 0;
  const top = section.width - height * Math.tan((draftDeg * Math.PI) / 180);
  const profile: RibProfile = {
    kind,
    width: section.width,
    draftDeg,
    rootRadius: section.rootRadius ?? (kind === "straight" ? 0 : 0.5 * (kind === "tee" ? section.width : Math.max(0, top))),
    flangeWidth: kind === "tee" ? section.flangeWidth ?? 3 * section.width : 0,
    flangeThickness: kind === "tee" ? section.flangeThickness ?? section.width : 0,
    flangeChamferDeg: kind === "tee" ? section.flangeChamferDeg ?? 45 : 0,
  };
  const shape = ribShape(profile, height, 0, 0.02);
  return "reason" in shape ? null : { shape, profile };
}

/**
 * Thickness where the rib meets the wall: the widest point of the outline within the fillet's height.
 * A drafted fillet's foot is that point; a straight rib is its own width.
 */
export function rootWidth(section: MouldSection, height: number): number | null {
  const built = shapeOf(section, height);
  if (!built) return null;
  const t = Math.tan((built.profile.draftDeg * Math.PI) / 180);
  const root = built.profile.rootRadius;
  const rootTop = root > 0 ? root * (1 - t / Math.sqrt(1 + t * t)) : 0;
  let maxU = 0;
  for (const [u, v] of built.shape.section(height)) {
    if (v <= rootTop + 1e-4) maxU = Math.max(maxU, Math.abs(u));
  }
  return maxU > 0 ? maxU * 2 : null;
}

const distSeg = (p: P2, a: P2, b: P2): number => {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const ab2 = abx * abx + aby * aby;
  const t = ab2 < 1e-18 ? 0 : clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / ab2, 0, 1);
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
};

/**
 * Diameter of the largest circle that fits in the wall slab (thickness `wall`, infinite in u) union the rib
 * outline above it. `scale` widens the outline: a cut at angle ψ to a rib shows it 1/sin(ψ) wide.
 * The circle sits on the symmetry axis. A straight rib of width w ≤ 2·wall has diameter wall + w²/(4·wall).
 */
export function junctionDiameter(section: MouldSection, height: number, wall: number, scale = 1): number | null {
  const built = shapeOf(section, height);
  if (!built || !(wall > 0) || !(height > 0) || !(scale > 0)) return null;
  return circleDiameter((v) => built.shape.halfAt(height, v) * scale, height, wall);
}

/** Two outlines on one bisector: the circle in their union with the wall. Each outline is already scaled. */
function junctionUnion(a: { section: MouldSection; height: number; scale: number }, b: { section: MouldSection; height: number; scale: number }, wall: number): number | null {
  const sa = shapeOf(a.section, a.height);
  const sb = shapeOf(b.section, b.height);
  if (!sa || !sb || !(wall > 0)) return null;
  const height = Math.max(a.height, b.height);
  const half = (v: number) => Math.max(v <= a.height ? sa.shape.halfAt(a.height, v) * a.scale : 0, v <= b.height ? sb.shape.halfAt(b.height, v) * b.scale : 0);
  return circleDiameter(half, height, wall);
}

function circleDiameter(half: (v: number) => number, height: number, wall: number): number {
  const steps = 96;
  const samples: number[] = [];
  for (let i = 0; i <= steps; i += 1) samples.push(Math.max(0, half((height * i) / steps)));
  const foot = samples[0] ?? 0;
  const top = samples[samples.length - 1] ?? 0;
  const reach = Math.max(foot, ...samples, wall);
  const bound = Math.max(reach * 4, wall * 4, 1);
  const segs: [P2, P2][] = [
    [[-bound, -wall], [bound, -wall]],
    [[-bound, 0], [-foot, 0]],
    [[foot, 0], [bound, 0]],
    [[-top, height], [top, height]],
  ];
  for (let i = 0; i < steps; i += 1) {
    const v0 = (height * i) / steps;
    const v1 = (height * (i + 1)) / steps;
    segs.push([[samples[i]!, v0], [samples[i + 1]!, v1]], [[-samples[i]!, v0], [-samples[i + 1]!, v1]]);
  }
  const clearance = (y: number): number => {
    if (y <= -wall || y >= height) return 0;
    if (y > 0 && half(y) <= 1e-9) return 0;
    let r = y + wall;
    const p: P2 = [0, y];
    for (const [a, b] of segs) r = Math.min(r, distSeg(p, a, b));
    return r;
  };
  let bestY = -wall / 2;
  let best = 0;
  const scan = (y0: number, y1: number, n: number) => {
    for (let i = 1; i < n; i += 1) {
      const y = y0 + ((y1 - y0) * i) / n;
      const r = clearance(y);
      if (r > best) {
        best = r;
        bestY = y;
      }
    }
  };
  scan(-wall, height, 360);
  const span = (height + wall) / 360;
  scan(bestY - span * 3, bestY + span * 3, 80);
  return best * 2;
}

/** Wall thickness nearest a point, from the wall mesh ribWall writes. */
export function nearestWallMm(vertices: readonly V3[], thickness: readonly number[], p: V3): number {
  let best = Infinity;
  let t = thickness[0] ?? 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const v = vertices[i]!;
    const d = (v[0] - p[0]) ** 2 + (v[1] - p[1]) ** 2 + (v[2] - p[2]) ** 2;
    if (d < best) {
      best = d;
      t = thickness[i] ?? t;
    }
  }
  return t;
}

interface Stretch {
  rib: number;
  stretch: number;
  a: V3;
  b: V3;
  dir: V3;
  normal: V3;
  height: number;
  section: MouldSection;
  wall: number;
  root: number;
}

function stretchesOf(ribs: readonly MouldRib[]): Stretch[] {
  const out: Stretch[] = [];
  ribs.forEach((rib, ribIndex) => {
    for (let i = 0; i + 1 < rib.points.length; i += 1) {
      const a = rib.points[i]!;
      const b = rib.points[i + 1]!;
      const dir = unit(sub(b, a));
      const normal = unit(add(rib.normals[i] ?? [0, 0, 1], rib.normals[i + 1] ?? rib.normals[i] ?? [0, 0, 1]));
      if (!dir || !normal) continue;
      const height = rib.heights[i] ?? rib.heights[rib.heights.length - 1] ?? 0;
      const section = rib.sections[i] ?? rib.sections[rib.sections.length - 1] ?? { profile: "straight" as const, width: 0 };
      const wa = rib.wallMm[i] ?? 0;
      const wb = rib.wallMm[i + 1] ?? wa;
      const wall = Math.min(wa > 0 ? wa : Infinity, wb > 0 ? wb : Infinity);
      if (!(height > 0) || !(section.width > 0) || !(wall > 0) || wall === Infinity) continue;
      const root = rootWidth(section, height);
      if (root === null) continue;
      out.push({ rib: ribIndex, stretch: i, a, b, dir, normal, height, section, wall, root });
    }
  });
  return out;
}

/** Draft of each flank along `pull`, degrees. Negative when the flank faces against the pull (an undercut). */
function flankDraft(s: Stretch, pull: V3 | null): number[] {
  const across = unit(cross(s.normal, s.dir));
  const aim = pull ? unit(pull) : s.normal;
  if (!across || !aim) return [];
  const d = ((s.section.profile === "drafted" ? s.section.draftDeg ?? 1 : 0) * Math.PI) / 180;
  const right = add(mul(across, Math.cos(d)), mul(s.normal, Math.sin(d)));
  const left = add(mul(across, -Math.cos(d)), mul(s.normal, Math.sin(d)));
  return [right, left].map((out) => (Math.asin(clamp(dot(out, aim), -1, 1)) * 180) / Math.PI);
}

/** Angle between two directions, 0 to 90. */
function acute(a: V3, b: V3): number {
  return (Math.acos(clamp(Math.abs(dot(a, b)), 0, 1)) * 180) / Math.PI;
}

/** Closest points of two segments: distance, the point on each, and whether each lies at an end. */
function closest(a0: V3, a1: V3, b0: V3, b1: V3): { dist: number; pa: V3; pb: V3; endA: boolean; endB: boolean } | null {
  const u = sub(a1, a0);
  const v = sub(b1, b0);
  const w0 = sub(a0, b0);
  const uu = dot(u, u);
  const vv = dot(v, v);
  if (uu < 1e-12 || vv < 1e-12) return null;
  const uv = dot(u, v);
  const uw = dot(u, w0);
  const vw = dot(v, w0);
  const den = uu * vv - uv * uv;
  let s = den < 1e-10 ? 0 : clamp((uv * vw - vv * uw) / den, 0, 1);
  let t = clamp((uv * s + vw) / vv, 0, 1);
  s = clamp((uv * t - uw) / uu, 0, 1);
  t = clamp((uv * s + vw) / vv, 0, 1);
  const pa = add(a0, mul(u, s));
  const pb = add(b0, mul(v, t));
  return { dist: len(sub(pa, pb)), pa, pb, endA: s < 0.04 || s > 0.96, endB: t < 0.04 || t > 0.96 };
}

const mid = (a: V3, b: V3): V3 => mul(add(a, b), 0.5);

function rule(id: MouldRuleId, threshold: number, worst: number | null, pass: boolean): MouldRule {
  return { rule: id, threshold, worst: worst === null ? null : q4(worst), pass };
}

/**
 * The moulding report for these ribs. `pull` is the mould's pull direction; absent, each rib is checked along
 * the wall normal it stands on. Flags name a rib index, the stretch or the other rib, the number and the threshold.
 */
export function mouldingReport(ribs: readonly MouldRib[], pull?: V3 | null): MouldingReport {
  const stretches = stretchesOf(ribs);
  const flags: MouldFlag[] = [];
  let rootWorst: number | null = null;
  let heightWorst: number | null = null;
  let draftWorst: number | null = null;
  let junctionWorst: number | null = null;
  const rootOf = new Map<number, { value: number; at: MouldAt }>();
  const heightOf = new Map<number, { value: number; at: MouldAt }>();
  const draftOf = new Map<number, { value: number; at: MouldAt }>();
  const underOf = new Map<number, { value: number; at: MouldAt }>();
  const jointOf = new Map<number, { value: number; at: MouldAt }>();

  const keep = (map: Map<number, { value: number; at: MouldAt }>, rib: number, value: number, at: MouldAt, worse: (a: number, b: number) => boolean) => {
    const prev = map.get(rib);
    if (!prev || worse(value, prev.value)) map.set(rib, { value, at });
  };

  for (const s of stretches) {
    const at: MouldAt = { stretch: s.stretch, point: r4(mid(s.a, s.b)) };
    const rootRatio = s.root / s.wall;
    if (rootWorst === null || rootRatio > rootWorst) rootWorst = rootRatio;
    keep(rootOf, s.rib, rootRatio, at, (a, b) => a > b);
    const heightRatio = s.height / s.wall;
    if (heightWorst === null || heightRatio > heightWorst) heightWorst = heightRatio;
    keep(heightOf, s.rib, heightRatio, at, (a, b) => a > b);
    for (const deg of flankDraft(s, pull ?? null)) {
      if (draftWorst === null || deg < draftWorst) draftWorst = deg;
      if (deg < 0) keep(underOf, s.rib, deg, at, (a, b) => a < b);
      else if (deg < MOULD_MIN_DRAFT_DEG) keep(draftOf, s.rib, deg, at, (a, b) => a < b);
    }
    const dia = junctionDiameter(s.section, s.height, s.wall);
    if (dia !== null) {
      const ratio = dia / s.wall;
      if (junctionWorst === null || ratio > junctionWorst) junctionWorst = ratio;
      keep(jointOf, s.rib, ratio, at, (a, b) => a > b);
    }
  }

  // Two ribs: a crossing or a tee (the circle is larger there), or the steel between parallel ribs.
  let spacingWorst: number | null = null;
  const spaced = new Map<string, { value: number; at: MouldAt; rib: number }>();
  for (let i = 0; i < stretches.length; i += 1) {
    for (let j = i + 1; j < stretches.length; j += 1) {
      const p = stretches[i]!;
      const q = stretches[j]!;
      if (p.rib === q.rib) continue;
      const hit = closest(p.a, p.b, q.a, q.b);
      if (!hit) continue;
      const angle = acute(p.dir, q.dir);
      const parallel = angle < 15;
      if (parallel) {
        const overlap = overlapLen(p, q);
        if (overlap < 1) continue;
        const gap = hit.dist - p.root / 2 - q.root / 2;
        const wall = Math.min(p.wall, q.wall);
        const ratio = Math.max(0, gap) / wall;
        if (spacingWorst === null || ratio < spacingWorst) spacingWorst = ratio;
        const key = `${Math.min(p.rib, q.rib)}:${Math.max(p.rib, q.rib)}`;
        const prev = spaced.get(key);
        if (!prev || ratio < prev.value) {
          spaced.set(key, { value: ratio, rib: p.rib, at: { stretch: p.stretch, point: r4(mid(hit.pa, hit.pb)), meets: q.rib } });
        }
        continue;
      }
      const touch = p.root / 2 + q.root / 2 + 0.5;
      if (hit.dist > touch) continue;
      const psi = (angle * Math.PI) / 180 / 2;
      const scale = 1 / Math.sin(psi);
      const dia = junctionUnion({ section: p.section, height: p.height, scale }, { section: q.section, height: q.height, scale }, Math.min(p.wall, q.wall));
      if (dia === null) continue;
      const wall = Math.min(p.wall, q.wall);
      const ratio = dia / wall;
      if (junctionWorst === null || ratio > junctionWorst) junctionWorst = ratio;
      const joint = hit.endA || hit.endB ? "tee" : "crossing";
      const at: MouldAt = { stretch: p.stretch, point: r4(mid(hit.pa, hit.pb)), meets: q.rib, joint };
      const prev = jointOf.get(p.rib);
      if (!prev || ratio > prev.value) jointOf.set(p.rib, { value: ratio, at });
    }
  }

  const push = (ruleId: MouldFlagRule, rib: number, row: { value: number; at: MouldAt }, threshold: number) => {
    flags.push({ rule: ruleId, rib, at: row.at, value: q4(row.value), threshold });
  };
  for (const [rib, row] of rootOf) if (row.value > MOULD_ROOT_RATIO) push("root", rib, row, MOULD_ROOT_RATIO);
  for (const [rib, row] of heightOf) if (row.value > MOULD_HEIGHT_WALLS) push("height", rib, row, MOULD_HEIGHT_WALLS);
  for (const [rib, row] of draftOf) push("draft", rib, row, MOULD_MIN_DRAFT_DEG);
  for (const [rib, row] of underOf) push("undercut", rib, row, 0);
  for (const [rib, row] of jointOf) if (row.value > MOULD_JUNCTION_RATIO) push("junction", rib, row, MOULD_JUNCTION_RATIO);
  for (const row of spaced.values()) if (row.value < MOULD_SPACING_WALLS) push("spacing", row.rib, row, MOULD_SPACING_WALLS);

  flags.sort((a, b) => a.rib - b.rib || a.rule.localeCompare(b.rule) || a.at.stretch - b.at.stretch);
  return {
    rules: [
      rule("root", MOULD_ROOT_RATIO, rootWorst, rootWorst === null || rootWorst <= MOULD_ROOT_RATIO),
      rule("height", MOULD_HEIGHT_WALLS, heightWorst, heightWorst === null || heightWorst <= MOULD_HEIGHT_WALLS),
      rule("draft", MOULD_MIN_DRAFT_DEG, draftWorst, draftWorst === null || draftWorst >= MOULD_MIN_DRAFT_DEG),
      rule("junction", MOULD_JUNCTION_RATIO, junctionWorst, junctionWorst === null || junctionWorst <= MOULD_JUNCTION_RATIO),
      rule("spacing", MOULD_SPACING_WALLS, spacingWorst, spacingWorst === null || spacingWorst >= MOULD_SPACING_WALLS),
    ],
    flags,
  };
}

/** How far two nearly parallel stretches run side by side, mm. */
function overlapLen(p: Stretch, q: Stretch): number {
  const dir = unit(add(p.dir, dot(p.dir, q.dir) < 0 ? mul(q.dir, -1) : q.dir)) ?? p.dir;
  const proj = (s: Stretch) => [dot(s.a, dir), dot(s.b, dir)].sort((a, b) => a - b) as [number, number];
  const [a0, a1] = proj(p);
  const [b0, b1] = proj(q);
  return Math.min(a1, b1) - Math.max(a0, b0);
}

const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return String(r);
};

function flagLine(flag: MouldFlag): string {
  const where = flag.at.joint === "crossing" ? `, crossing rib ${flag.at.meets! + 1}` : flag.at.joint === "tee" ? `, tee with rib ${flag.at.meets! + 1}` : flag.rule === "spacing" && flag.at.meets !== undefined ? `, beside rib ${flag.at.meets + 1}` : `, stretch ${flag.at.stretch + 1}`;
  const rib = `Rib ${flag.rib + 1}${where}`;
  if (flag.rule === "root") return `${rib}: root ${fmt(flag.value)} × the wall, over ${fmt(flag.threshold)}`;
  if (flag.rule === "height") return `${rib}: height ${fmt(flag.value)} × the wall, over ${fmt(flag.threshold)}`;
  if (flag.rule === "draft") return `${rib}: draft ${fmt(flag.value)}°, under ${fmt(flag.threshold)}°`;
  if (flag.rule === "undercut") return `${rib}: flank faces against the pull (draft ${fmt(flag.value)}°)`;
  if (flag.rule === "junction") return `${rib}: junction circle ${fmt(flag.value)} × the wall, over ${fmt(flag.threshold)}`;
  return `${rib}: gap ${fmt(flag.value)} × the wall, under ${fmt(flag.threshold)}`;
}

/** The lines under the result: one per flag, or one line when every rule passes. */
export function mouldingLines(report: MouldingReport): string[] {
  if (report.flags.length === 0) return [`Moulding checks pass (${report.rules.length} rules)`];
  const shown = report.flags.slice(0, 8).map(flagLine);
  if (report.flags.length > 8) shown.push(`and ${report.flags.length - 8} more`);
  return shown;
}

export interface DefaultRow {
  wall: number;
  height: number;
  /** Fillet sized at this height, mm (the height `default_drafted` was given). */
  filletAt: number;
  width: number;
  root: number | null;
  rootRatio: number | null;
  junctionRatio: number | null;
}

/**
 * Rule 1 and rule 4 for today's moulded default: width 0.6 × the wall at half height, draft 1°, root half the
 * top. `filletAt` sizes that root; the outline is then measured at `height`. The product default is not changed.
 */
export function mouldedDefaultRow(wall: number, heightOverWall: number, filletOverWall = heightOverWall): DefaultRow {
  const height = wall * heightOverWall;
  const filletAt = wall * filletOverWall;
  const width = Math.max(0.4, 0.6 * wall);
  const sized = defaultDraftedSection(width, filletAt);
  const section: MouldSection = { ...sized, width };
  const root = rootWidth(section, height);
  const dia = junctionDiameter(section, height, wall);
  return { wall, height, filletAt, width, root, rootRatio: root === null ? null : root / wall, junctionRatio: dia === null ? null : dia / wall };
}
