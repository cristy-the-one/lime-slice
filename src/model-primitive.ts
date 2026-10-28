/**
 * Primitive solids as data: the kinds the engine builds (`docs/step-modeler.md`), their numbers, their labels,
 * where a new solid's root sits in its own frame, and the ghost mesh the view draws while the numbers change.
 * The ghost never asks the engine: it is built here, from the sizes alone.
 */
import { formatMm } from "./model-plane.ts";

type Vec3 = [number, number, number];

export type PrimitiveKind = "box" | "cylinder" | "sphere" | "ellipsoid" | "cone" | "torus" | "wedge" | "polygon" | "tube";

/** Every primitive, in the order the picker lists them, with its name for a new object. */
export const PRIMITIVES: readonly { kind: PrimitiveKind; label: string }[] = [
  { kind: "box", label: "Box" },
  { kind: "cylinder", label: "Cylinder" },
  { kind: "sphere", label: "Sphere" },
  { kind: "ellipsoid", label: "Ellipsoid" },
  { kind: "cone", label: "Cone" },
  { kind: "torus", label: "Torus" },
  { kind: "wedge", label: "Wedge" },
  { kind: "polygon", label: "Polygon" },
  { kind: "tube", label: "Tube" },
];

export function isPrimitiveKind(value: unknown): value is PrimitiveKind {
  return PRIMITIVES.some((entry) => entry.kind === value);
}

/**
 * A primitive as the engine stores it, in millimetres, turned about its centre by `turn` degrees about X, then
 * Y, then Z. `size`, `radius`, and `height` are always there; the newer fields only on the kinds that read them.
 */
export interface PrimitiveSpec {
  primitive: PrimitiveKind;
  origin: Vec3;
  size: Vec3;
  radius: number;
  height: number;
  turn: Vec3;
  /** A cone's top radius. 0 is a point. */
  topRadius?: number;
  /** A torus's tube radius. `radius` is its ring, to the middle of the tube. */
  tubeRadius?: number;
  /** A tube's hole. `radius` is its outside. */
  innerRadius?: number;
  /** A wedge's top face, along X from `origin`. */
  topX?: number;
  /** A polygon prism's side count, 3 to 64. */
  sides?: number;
  /** A polygon prism's width across corners, or across flats with `flats`. */
  across?: number;
  flats?: boolean;
  /** A box's four edges along its own Z rounded to this radius, as a rounded pocket or boss cuts them. */
  cornerRadius?: number;
}

/** Every number the panel offers a primitive, whichever kind reads it. */
export interface PrimitiveFields {
  size: Vec3;
  radius: number;
  height: number;
  topRadius: number;
  tubeRadius: number;
  innerRadius: number;
  topX: number;
  sides: number;
  across: number;
  flats: boolean;
}

/** The spec of `kind` from the panel's numbers: the newer fields only where that kind reads them. A sphere does not turn. */
export function primitiveSpec(kind: PrimitiveKind, fields: PrimitiveFields, origin: Vec3, turn: Vec3): PrimitiveSpec {
  const base: PrimitiveSpec = {
    primitive: kind,
    origin,
    size: fields.size,
    radius: fields.radius,
    height: fields.height,
    turn: kind === "sphere" ? [0, 0, 0] : turn,
  };
  switch (kind) {
    case "cone":
      return { ...base, topRadius: fields.topRadius };
    case "torus":
      return { ...base, tubeRadius: fields.tubeRadius };
    case "wedge":
      return { ...base, topX: fields.topX };
    case "polygon":
      return { ...base, sides: fields.sides, across: fields.across, flats: fields.flats };
    case "tube":
      return { ...base, innerRadius: fields.innerRadius };
    default:
      return base;
  }
}

/** Which of the three older fields each kind reads. A Boolean op keeps the others as typed, as it always has. */
const READS: Record<PrimitiveKind, { size: boolean; radius: boolean; height: boolean }> = {
  box: { size: true, radius: false, height: false },
  cylinder: { size: false, radius: true, height: true },
  sphere: { size: false, radius: true, height: false },
  ellipsoid: { size: true, radius: false, height: false },
  cone: { size: false, radius: true, height: true },
  torus: { size: false, radius: true, height: false },
  wedge: { size: true, radius: false, height: false },
  polygon: { size: false, radius: false, height: true },
  tube: { size: false, radius: true, height: true },
};

/**
 * The primitive moved so it stands centred over the origin, its lowest point on Z = 0, untilted: a new solid's
 * root in its own frame. Model space then places it with a pose. A root is new data, so the fields its kind does
 * not read are 0 rather than whatever the panel held.
 */
export function rootSpec(spec: PrimitiveSpec): PrimitiveSpec {
  const lift = spec.primitive === "sphere" ? spec.radius : spec.primitive === "torus" ? spec.tubeRadius ?? 0 : spec.primitive === "ellipsoid" ? spec.size[2] / 2 : 0;
  const corner = spec.primitive === "box" || spec.primitive === "wedge";
  const origin: Vec3 = corner ? [-spec.size[0] / 2, -spec.size[1] / 2, 0] : [0, 0, lift];
  const reads = READS[spec.primitive];
  return {
    ...spec,
    origin,
    size: reads.size ? spec.size : [0, 0, 0],
    radius: reads.radius ? spec.radius : 0,
    height: reads.height ? spec.height : 0,
    turn: [0, 0, 0],
  };
}

/** The untilted primitive's box, where `origin` puts it: exact, from the sizes alone. */
export function primitiveBounds(spec: PrimitiveSpec): { min: Vec3; max: Vec3 } {
  const [x, y, z] = spec.origin;
  const at = (min: Vec3, max: Vec3) => ({ min: [x + min[0], y + min[1], z + min[2]] as Vec3, max: [x + max[0], y + max[1], z + max[2]] as Vec3 });
  const round = (r: number, h: number) => at([-r, -r, 0], [r, r, h]);
  switch (spec.primitive) {
    case "box":
    case "wedge":
      return at([0, 0, 0], spec.size);
    case "cylinder":
    case "tube":
      return round(spec.radius, spec.height);
    case "cone":
      return round(Math.max(spec.radius, spec.topRadius ?? 0), spec.height);
    case "sphere":
      return at([-spec.radius, -spec.radius, -spec.radius], [spec.radius, spec.radius, spec.radius]);
    case "ellipsoid":
      return at([-spec.size[0] / 2, -spec.size[1] / 2, -spec.size[2] / 2], [spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2]);
    case "torus": {
      const tube = spec.tubeRadius ?? 0;
      const reach = spec.radius + tube;
      return at([-reach, -reach, -tube], [reach, reach, tube]);
    }
    case "polygon": {
      const corners = polygonCorners(spec.sides ?? 0, spec.across ?? 0, spec.flats ?? false);
      if (corners.length === 0) return at([0, 0, 0], [0, 0, spec.height]);
      const xs = corners.map((corner) => corner[0]);
      const ys = corners.map((corner) => corner[1]);
      return at([Math.min(...xs), Math.min(...ys), 0], [Math.max(...xs), Math.max(...ys), spec.height]);
    }
  }
}

/** A polygon prism's corners about its axis, counter-clockwise from above with one flat facing −Y, as the engine builds them. */
function polygonCorners(sides: number, across: number, flats: boolean): [number, number][] {
  if (!Number.isInteger(sides) || sides < 3 || sides > 64 || !(across > 0)) return [];
  const corner = flats ? across / 2 / Math.cos(Math.PI / sides) : across / 2;
  return Array.from({ length: sides }, (_, i) => {
    const angle = -Math.PI / 2 - Math.PI / sides + (2 * Math.PI * i) / sides;
    return [corner * Math.cos(angle), corner * Math.sin(angle)];
  });
}

/** Where the primitive turns, from its origin: a box's or a wedge's middle, a torus's, sphere's, or ellipsoid's centre, else halfway up its axis. */
export function turnCentre(spec: PrimitiveSpec): Vec3 {
  if (spec.primitive === "box" || spec.primitive === "wedge") return [spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2];
  if (spec.primitive === "torus" || spec.primitive === "sphere" || spec.primitive === "ellipsoid") return [0, 0, 0];
  return [0, 0, spec.height / 2];
}

const POLYGON_NAMES: Record<number, string> = { 3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon" };

/** A short name for the primitive and its sizes: "box 10×10×10", "cone ⌀10 to ⌀4 h 10", "hexagon 10 across flats h 5". */
export function primitiveLabel(spec: PrimitiveSpec): string {
  const n = formatMm;
  switch (spec.primitive) {
    case "box":
      return `box ${n(spec.size[0])}×${n(spec.size[1])}×${n(spec.size[2])}`;
    case "cylinder":
      return `cylinder ⌀${n(spec.radius * 2)} h ${n(spec.height)}`;
    case "sphere":
      return `sphere ⌀${n(spec.radius * 2)}`;
    case "ellipsoid":
      return `ellipsoid ${n(spec.size[0])}×${n(spec.size[1])}×${n(spec.size[2])}`;
    case "cone":
      return `cone ⌀${n(spec.radius * 2)} to ⌀${n((spec.topRadius ?? 0) * 2)} h ${n(spec.height)}`;
    case "torus":
      return `torus ⌀${n(spec.radius * 2)} tube ⌀${n((spec.tubeRadius ?? 0) * 2)}`;
    case "wedge":
      return `wedge ${n(spec.size[0])}×${n(spec.size[1])}×${n(spec.size[2])} top ${n(spec.topX ?? 0)}`;
    case "polygon": {
      const sides = spec.sides ?? 0;
      return `${POLYGON_NAMES[sides] ?? `${sides}-gon`} ${n(spec.across ?? 0)} across ${spec.flats ? "flats" : "corners"} h ${n(spec.height)}`;
    }
    case "tube":
      return `tube ⌀${n(spec.radius * 2)} inside ⌀${n((spec.innerRadius ?? 0) * 2)} h ${n(spec.height)}`;
  }
}

/** The plate name of a new solid: the primitive's name and the first number no object of that kind has yet. */
export function primitiveName(names: Iterable<string>, kind: PrimitiveKind): string {
  const label = PRIMITIVES.find((entry) => entry.kind === kind)?.label ?? "Solid";
  const taken = new Set(names);
  let at = 1;
  while (taken.has(`${label} ${at}`)) at += 1;
  return `${label} ${at}`;
}

/** Segments around a round primitive. A multiple of 4, so the ghost's box is the solid's own. */
const ROUND = 32;
/** Facets in one rounded corner of a box ghost: 11.25 degrees each, under the ghost's crease angle. */
const CORNER_STEPS = 8;

/**
 * The primitive's ghost as a triangle soup, wound outward, in its own frame: from `origin` = 0, untilted. The
 * view moves and turns it, so only a size change builds it again. Empty when a size could not build.
 */
export function primitiveMesh(spec: PrimitiveSpec): Float32Array {
  const out: number[] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
    if (area > 1e-12) out.push(...a, ...b, ...c);
  };
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    tri(a, b, c);
    tri(a, c, d);
  };
  const ok = (...values: number[]) => values.every((value) => Number.isFinite(value) && value > 0);
  switch (spec.primitive) {
    case "box":
    case "wedge": {
      const [dx, dy, dz] = spec.size;
      const top = spec.primitive === "wedge" ? spec.topX ?? 0 : dx;
      if (!ok(dx, dy, dz) || !(top >= 0 && top <= dx)) break;
      const round = spec.primitive === "box" ? Math.min(spec.cornerRadius ?? 0, dx / 2, dy / 2) : 0;
      if (round > 1e-9) roundedBlock(quad, dx, dy, dz, round);
      else block(quad, dx, dy, dz, top);
      break;
    }
    case "cylinder":
      if (ok(spec.radius, spec.height)) lathe(quad, ROUND, 0, spec.radius, spec.radius, spec.height, 0);
      break;
    case "cone": {
      const top = spec.topRadius ?? 0;
      if (ok(spec.height) && spec.radius >= 0 && top >= 0 && (spec.radius > 0 || top > 0)) lathe(quad, ROUND, 0, spec.radius, top, spec.height, 0);
      break;
    }
    case "tube": {
      const inner = spec.innerRadius ?? 0;
      if (ok(spec.radius, spec.height) && inner >= 0 && inner < spec.radius) lathe(quad, ROUND, 0, spec.radius, spec.radius, spec.height, inner);
      break;
    }
    case "polygon": {
      const sides = spec.sides ?? 0;
      const across = spec.across ?? 0;
      if (!Number.isInteger(sides) || sides < 3 || sides > 64 || !ok(across, spec.height)) break;
      const corner = spec.flats ? across / 2 / Math.cos(Math.PI / sides) : across / 2;
      // One flat faces −Y, as the engine builds it.
      lathe(quad, sides, -Math.PI / 2 - Math.PI / sides, corner, corner, spec.height, 0);
      break;
    }
    case "sphere":
      if (ok(spec.radius)) ring(quad, ROUND, ROUND / 2, (u, v) => {
        const lat = -Math.PI / 2 + v * Math.PI;
        return [spec.radius * Math.cos(lat) * Math.cos(u), spec.radius * Math.cos(lat) * Math.sin(u), spec.radius * Math.sin(lat)];
      });
      break;
    case "ellipsoid": {
      const [a, b, c] = spec.size.map((v) => v / 2) as Vec3;
      if (ok(a, b, c)) ring(quad, ROUND, ROUND / 2, (u, v) => {
        const lat = -Math.PI / 2 + v * Math.PI;
        return [a * Math.cos(lat) * Math.cos(u), b * Math.cos(lat) * Math.sin(u), c * Math.sin(lat)];
      });
      break;
    }
    case "torus": {
      const tube = spec.tubeRadius ?? 0;
      if (ok(spec.radius, tube) && tube < spec.radius) ring(quad, ROUND, ROUND / 2, (u, v) => {
        const around = v * 2 * Math.PI;
        const reach = spec.radius + tube * Math.cos(around);
        return [reach * Math.cos(u), reach * Math.sin(u), tube * Math.sin(around)];
      });
      break;
    }
  }
  return new Float32Array(out);
}

type Quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => void;

/** A box, or a wedge whose top runs from X 0 to `top`. */
function block(quad: Quad, dx: number, dy: number, dz: number, top: number) {
  const p = (x: number, y: number, z: number): Vec3 => [x, y, z];
  quad(p(0, 0, 0), p(0, dy, 0), p(dx, dy, 0), p(dx, 0, 0));
  quad(p(0, 0, dz), p(top, 0, dz), p(top, dy, dz), p(0, dy, dz));
  quad(p(0, 0, 0), p(dx, 0, 0), p(top, 0, dz), p(0, 0, dz));
  quad(p(0, dy, 0), p(0, dy, dz), p(top, dy, dz), p(dx, dy, 0));
  quad(p(0, 0, 0), p(0, 0, dz), p(0, dy, dz), p(0, dy, 0));
  quad(p(dx, 0, 0), p(dx, dy, 0), p(top, dy, dz), p(top, 0, dz));
}

/** A box whose four edges along Z are rounded to `r`, each corner an arc of `CORNER_STEPS` facets. */
function roundedBlock(quad: Quad, dx: number, dy: number, dz: number, r: number) {
  const outline: [number, number][] = [];
  const corners: [number, number, number][] = [[dx - r, r, -90], [dx - r, dy - r, 0], [r, dy - r, 90], [r, r, 180]];
  for (const [cx, cy, from] of corners) {
    for (let i = 0; i <= CORNER_STEPS; i += 1) {
      const angle = ((from + (90 * i) / CORNER_STEPS) * Math.PI) / 180;
      outline.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
  }
  const low: Vec3 = [dx / 2, dy / 2, 0];
  const high: Vec3 = [dx / 2, dy / 2, dz];
  for (let i = 0; i < outline.length; i += 1) {
    const [x0, y0] = outline[i]!;
    const [x1, y1] = outline[(i + 1) % outline.length]!;
    quad([x0, y0, 0], [x1, y1, 0], [x1, y1, dz], [x0, y0, dz]);
    quad(low, [x1, y1, 0], [x0, y0, 0], [x0, y0, 0]);
    quad(high, [x0, y0, dz], [x1, y1, dz], [x1, y1, dz]);
  }
}

/**
 * A solid of `count` sides about Z, from radius `bottom` at Z 0 to `top` at `height`, the first corner at `phase`,
 * with a round hole of radius `inner` when it is above 0.
 */
function lathe(quad: Quad, count: number, phase: number, bottom: number, top: number, height: number, inner: number) {
  const at = (i: number, r: number, z: number): Vec3 => {
    const angle = phase + (2 * Math.PI * i) / count;
    return [r * Math.cos(angle), r * Math.sin(angle), z];
  };
  for (let i = 0; i < count; i += 1) {
    const j = i + 1;
    quad(at(i, bottom, 0), at(j, bottom, 0), at(j, top, height), at(i, top, height));
    quad(at(i, top, height), at(j, top, height), at(j, inner, height), at(i, inner, height));
    quad(at(i, inner, 0), at(j, inner, 0), at(j, bottom, 0), at(i, bottom, 0));
    if (inner > 0) quad(at(i, inner, height), at(j, inner, height), at(j, inner, 0), at(i, inner, 0));
  }
}

/** A closed surface over a grid: `u` once around Z, `v` from 0 to 1 along the other way. */
function ring(quad: Quad, around: number, along: number, point: (u: number, v: number) => Vec3) {
  for (let i = 0; i < around; i += 1) {
    for (let k = 0; k < along; k += 1) {
      const u0 = (2 * Math.PI * i) / around;
      const u1 = (2 * Math.PI * (i + 1)) / around;
      quad(point(u0, k / along), point(u1, k / along), point(u1, (k + 1) / along), point(u0, (k + 1) / along));
    }
  }
}
