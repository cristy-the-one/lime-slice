/** Tool input schemas. They are the contract the handlers validate against. */

import { GROUP_NAMES, groupOf, TOOLS_ENABLE_HELP } from "./groups.ts";
import { MAX_PLAN_STEPS, PLAN_HELP } from "./plan.ts";
import { ALIGN_RELATIONS } from "../src/place-snap.ts";

const handle = { type: "string", minLength: 1, maxLength: 64, description: "Object handle (obj_1) from plate_list. Default: the selected object." };
/** A model_place number: mm or degrees, or an expression over model_params names. The handler reads and checks it. */
const placeNumber = { description: "Number or expression." };
const jobHandle ={ type: "string", minLength: 1, maxLength: 64, description: "job_N from slice_start, or from a long call that answered with a job." };
const step = { type: "string", minLength: 1, maxLength: 80, description: "History step: node_N from model_history, or a step or batch label." };
const cursor = { type: "string", minLength: 1, description: "Page start." };
const vec3 = { type: "array", description: "3 numbers.", minItems: 3, maxItems: 3, items: { type: "number" } };
const page = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor,
    limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
  },
};

const empty = { type: "object", additionalProperties: false, properties: {} };

const at = {
  type: "object",
  additionalProperties: false,
  required: ["u", "v"],
  properties: {
    u: { type: "number", description: "Across, mm." },
    v: { type: "number", description: "Along, mm." },
  },
};

const edgeList = {
  description: "Indexes or a filter.",
  oneOf: [
    { type: "array", items: { type: "integer", minimum: 0 } },
    {
      type: "object",
      additionalProperties: false,
      required: ["fromNode"],
      properties: {
        fromNode: { type: "string", minLength: 1, maxLength: 80, description: "node_N or a step label." },
        filter: { enum: ["all", "convex", "concave"], description: "Default all." },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["select"],
      properties: { select: { type: "object", description: "onFace (index or {normal, nearPoint})." } },
    },
  ],
};

const label = { type: "string", maxLength: 80, description: "Step name." };
const objectName = { type: "string", minLength: 1, maxLength: 120, description: "Name in the app's object list." };
/** A study region, spelled as the paint regions are. A sphere or a box does not renumber after a Model edit. */
const simRegion = { type: "object", description: "{faces}, {sphere}, or {box}." };
const primitiveKind = { enum: ["box", "cylinder", "sphere", "ellipsoid", "cone", "torus", "wedge", "polygon", "tube"], description: "Primitive." };
const booleanKind = { enum: ["fuse", "cut", "common"], description: "cut, fuse, common." };

/** The fields every primitive takes, as solid_new names them. */
const primitiveFields = {
  primitive: primitiveKind,
  dx: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Box X." },
  dy: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Box Y." },
  dz: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Box Z." },
  radius: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "Round kinds." },
  height: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Along local Z." },
  topRadius: { type: "number", minimum: 0, maximum: 500, description: "Cone top." },
  tubeRadius: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "Torus tube." },
  innerRadius: { type: "number", minimum: 0, maximum: 500, description: "Tube hole." },
  topX: { type: "number", minimum: 0, maximum: 1000, description: "Wedge top X." },
  sides: { type: "integer", minimum: 3, maximum: 64, description: "Polygon sides." },
  across: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Polygon width." },
  flats: { type: "boolean", description: "Across flats." },
  origin: { ...vec3, description: "Box min corner, or round base centre, before the turn." },
  centre: { ...vec3, description: "Turn point: box middle, mid-axis." },
  turn: { ...vec3, description: "Degrees X, then Y, then Z." },
};

/** What solid_new and model_build's base take: a primitive's kind and sizes, stood centred on Z = 0. */
const solidFields = (() => {
  const { origin: _origin, centre: _centre, ...rest } = primitiveFields;
  return rest;
})();

const booleanOp = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "op", "primitive"],
  properties: { kind: { const: "boolean" }, op: booleanKind, ...primitiveFields, label },
};

const uv = {
  type: "object",
  additionalProperties: false,
  required: ["u", "v"],
  properties: {
    u: { type: "number", description: "Level, mm." },
    v: { type: "number", description: "Up, mm." },
  },
};

const faceIndex = { type: "integer", minimum: 0, description: "Face index." };
const faceSelector = { type: "object", description: "Flat face." };

const pocketOp = (kind: "pocket" | "boss") => ({
  type: "object",
  additionalProperties: false,
  required: ["kind", "depth"],
  properties: {
    kind: { const: kind },
    faceIndex,
    face: faceSelector,
    shape: { enum: ["rect", "circle", "arch"], description: "rect, circle, arch." },
    from: { enum: ["box", "centre", "corner", "bottom", "top"], description: "Where U, V = 0." },
    at: { ...uv, description: "Centre on the face." },
    width: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "U size." },
    height: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "V size." },
    cornerRadius: { type: "number", minimum: 0, maximum: 500, description: "Rect corners, mm. 0 is sharp." },
    diameter: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Circle." },
    depth: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: kind === "pocket" ? "Into the face." : "Out of the face." },
    ...(kind === "pocket"
      ? {
          bars: {
            type: "object",
            additionalProperties: false,
            description: "Flush bars left across it.",
            properties: {
              vertical: { type: "integer", minimum: 0, maximum: 20, description: "Count." },
              horizontal: { type: "integer", minimum: 0, maximum: 20, description: "Count." },
              width: { type: "number", exclusiveMinimum: 0, maximum: 50, description: "Default 1." },
            },
          },
        }
      : {}),
    label,
  },
});

const textureOp = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "pitch"],
  properties: {
    kind: { const: "texture" },
    faceIndex,
    face: faceSelector,
    pattern: { enum: ["lines", "grid", "brick", "shingle"], description: "brick and shingle stagger rows." },
    pitch: { type: "array", minItems: 2, maxItems: 2, items: { type: "number", exclusiveMinimum: 0 }, description: "[U, V] tile size." },
    grooveWidth: { type: "number", exclusiveMinimum: 0, maximum: 20, description: "Default 0.8." },
    depth: { type: "number", exclusiveMinimum: 0, maximum: 50, description: "Default 0.6." },
    region: {
      type: "object",
      additionalProperties: false,
      description: "Default: the face.",
      properties: {
        u: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" }, description: "Range." },
        v: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" }, description: "Range." },
      },
    },
    label,
  },
};

const repeatFields = (inner: Record<string, unknown>) => ({
  pattern: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "op"],
    properties: {
      kind: { const: "pattern" },
      op: inner,
      linear: {
        type: "object",
        additionalProperties: false,
        required: ["step", "count"],
        description: "step2, count2 make a grid.",
        properties: {
          step: { ...vec3, description: "Offset." },
          count: { type: "integer", minimum: 1, maximum: 200, description: "With the original." },
          step2: { ...vec3, description: "Grid offset." },
          count2: { type: "integer", minimum: 1, maximum: 200, description: "Grid count." },
        },
      },
      polar: {
        type: "object",
        additionalProperties: false,
        required: ["count"],
        description: "About an axis.",
        properties: {
          centre: { ...vec3, description: "Axis point." },
          axis: { ...vec3, description: "Default Z." },
          count: { type: "integer", minimum: 1, maximum: 200, description: "With the original." },
          angleDeg: { type: "number", description: "Default 360." },
        },
      },
      path: {
        type: "object",
        additionalProperties: false,
        required: ["points", "count"],
        description: "Along a smooth curve; the op is typed at the first point.",
        properties: {
          points: { type: "array", minItems: 2, maxItems: 100, items: vec3, description: "[x, y, z]." },
          count: { type: "integer", minimum: 1, maximum: 200, description: "Evenly spaced, ends included." },
          align: { type: "boolean", description: "Turn with the curve (default true)." },
          closed: { type: "boolean", description: "Back round to the first point." },
        },
      },
      label,
    },
  },
  mirror: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "op"],
    properties: {
      kind: { const: "mirror" },
      op: inner,
      plane: { enum: ["x", "y", "z"], description: "Normal axis." },
      normal: { ...vec3, description: "Or a normal." },
      origin: { ...vec3, description: "Plane point." },
      keepOriginal: { type: "boolean", description: "false: only the image." },
      label,
    },
  },
});

/** The op a pattern or mirror repeats, listed by name; validateTool checks it against the op branches. */
const outerRepeat = repeatFields({ type: "object", description: "Op to repeat." });

export const OP_HELP = [
  "One edit, by kind. mm and degrees. guide {topic:\"ops\"}.",
  "Composites are one undo. Points may be {anchor, point, offset}.",
  "Numbers may be model_params names. each repeats ops; use places a part.",
].join(" ");

const op = {
  type: "object",
  description: OP_HELP,
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { const: "hole" },
        diameterMm: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
        radius: { type: "number", exclusiveMinimum: 0, maximum: 500 },
        depth: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
        through: { type: "boolean" },
        at,
        origin: vec3,
        axis: vec3,
        counterboreDiameterMm: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
        counterboreDepth: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
        screw: { enum: ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"], description: "Clearance hole and counterbore." },
        label,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "edges", "size"],
      properties: {
        kind: { const: "fillet" },
        edges: edgeList,
        size: { type: "number", exclusiveMinimum: 0, maximum: 100 },
        label,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "edges", "size"],
      properties: {
        kind: { const: "chamfer" },
        edges: edgeList,
        size: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "Along both faces; with size2 or angleDeg, along the upper face." },
        size2: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "Along the other face." },
        angleDeg: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 90, description: "From the upper face." },
        flip: { type: "boolean", description: "size along the lower face." },
        label,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { const: "split" },
        origin: vec3,
        normal: vec3,
        keep: { enum: ["both", "above", "below"], description: "Which half stays on the plate. both adds the other half as a new object." },
        label,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "factor"],
      properties: {
        kind: { const: "scale" },
        factor: { type: "number", minimum: 0.1, maximum: 20 },
        label,
      },
    },
    booleanOp,
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "primitive"],
      properties: { kind: { const: "root" }, primitive: primitiveKind, dx: primitiveFields.dx, dy: primitiveFields.dy, dz: primitiveFields.dz, radius: primitiveFields.radius, height: primitiveFields.height, label },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "toolObject"],
      properties: {
        kind: { const: "join" },
        op: booleanKind,
        toolObject: handle,
        keepTool: { type: "boolean" },
        label,
      },
    },
    pocketOp("pocket"),
    pocketOp("boss"),
    textureOp,
    outerRepeat.pattern,
    outerRepeat.mirror,
  ],
};

const COMPOSITE = new Set(["pocket", "boss", "texture", "pattern", "mirror", "array", "ribs", "text"]);
const REPEATABLE = new Set(["boolean", "extrude", "revolve", "pocket", "boss", "texture", "array", "ribs", "pattern", "mirror", "text"]);

/** The op schema model_apply lists. Other Model tools name it and are checked against it here. */
export const OP_SCHEMA = op;

const opWords = new Set<string>();
/** Adds every enum value, and every one-word constant but a kind's name, under `node` to OP_WORDS. */
function addOpWords(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(addOpWords);
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (key === "enum" && Array.isArray(child)) child.forEach((word) => typeof word === "string" && opWords.add(word));
    // A field that takes one word as a choice, such as a transition's size:"face", holds text too. A kind's name is not a field's text.
    else if (key === "kind" && child && typeof child === "object" && "const" in child) continue;
    else if (key === "const" && typeof child === "string") opWords.add(child);
    else addOpWords(child);
  }
}
/** Every enum value in the op schema: text an op field may hold, never an expression. */
export const OP_WORDS: ReadonlySet<string> = opWords;
addOpWords(op);

const opPointer = (what: string) => ({ type: "object", description: `${what} Same shape as model_apply's op; guide {kind} has a kind's fields.` });

/** An op and every op nested in it, against the op branches. `plain` refuses the composite kinds. */
function checkOp(value: unknown, path: string, plain: boolean, depth = 0): string | null {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  if (plain && typeof kind === "string" && COMPOSITE.has(kind)) return `${path}.kind ${kind} is several steps. Use model_apply or model_apply_batch.`;
  const problem = validate(op, value, path);
  if (problem) return problem;
  if ((kind === "pattern" || kind === "mirror") && depth < 4) {
    const inner = (value as { op?: unknown }).op;
    const innerKind = inner && typeof inner === "object" ? (inner as { kind?: unknown }).kind : undefined;
    if (typeof innerKind !== "string" || !REPEATABLE.has(innerKind)) return `A ${String((value as { kind?: unknown }).kind)} repeats one of ${[...REPEATABLE].join(", ")}; ${typeof innerKind === "string" ? `a ${innerKind}` : "that op"} is applied once per copy instead (${path}.op).`;
    return checkOp(inner, `${path}.op`, false, depth + 1);
  }
  return null;
}

const profilePlace = {
  faceIndex,
  face: faceSelector,
  from: { enum: ["box", "centre", "corner", "bottom", "top"], description: "Where U, V = 0." },
  origin: { ...vec3, description: "Plane origin, in place of a face." },
  turn: { ...vec3, description: "Plane turn, degrees X, Y, Z." },
};
const profile = { type: "array", minItems: 3, maxItems: 200, items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } }, description: "Closed outline, [u, v] points, mm." };
const point2 = { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } };
/** K1: loops in place of a point profile. The first loop is the outline; the rest are holes. */
const loopsField = {
  type: "array",
  minItems: 1,
  maxItems: 32,
  description: "Outline, then holes.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["start", "segments"],
    properties: {
      start: { ...point2, description: "Start, mm." },
      segments: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        description: "Back to the start.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "to"],
          properties: {
            kind: { enum: ["line", "arc", "spline"], description: "line, arc, or spline." },
            to: { ...point2, description: "End." },
            through: { description: "Arc: one point. Spline: points.", oneOf: [point2, { type: "array", minItems: 1, maxItems: 200, items: point2 }] },
          },
        },
      },
    },
  },
};

const profileShape = {
  smooth: { type: "boolean", description: "Spline through points." },
  corners: { type: "array", maxItems: 200, items: { type: "integer", minimum: 0 }, description: "Sharp corners when smooth." },
};
const perPoint = (what: string) => ({ description: `${what}: one number, or one per path point.` });

/** Ops the kernel builds from a sketch, and the shell. Added to op's branches below. */
const sketchOps = [
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "depth"],
    properties: {
      kind: { const: "extrude" },
      op: booleanKind,
      profile,
      loops: loopsField,
      depth: { type: "number", minimum: -1000, maximum: 1000, description: "Along W; negative goes into the face. May be 0 when upTo is set." },
      symmetric: { type: "boolean", description: "Centred on the plane." },
      // K3. Each one is optional. A plain extrude does not send them.
      depth2: { type: "number", exclusiveMinimum: 0, maximum: 100000, description: "The other side of the plane, mm. Not with symmetric or upTo." },
      draftDeg: { type: "number", exclusiveMinimum: -89, exclusiveMaximum: 89, description: "Draft, degrees. Positive shrinks the section as it goes along +W." },
      upTo: {
        description: "Stop at a face of this solid: an index, or {normal, nearPoint}. Depth only says which way.",
        oneOf: [{ type: "integer", minimum: 0 }, faceSelector],
      },
      ...profileShape,
      ...profilePlace,
      label,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: { const: "revolve" },
      op: booleanKind,
      profile,
      loops: loopsField,
      axisOrigin: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" }, description: "[u, v]. Default [0, 0]." },
      axisDir: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" }, description: "In-plane. Default V." },
      angleDeg: { type: "number", minimum: -360, maximum: 360, description: "Default 360." },
      ...profileShape,
      ...profilePlace,
      label,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "sections"],
    properties: {
      kind: { const: "loft" },
      op: booleanKind,
      sections: {
        type: "array",
        minItems: 2,
        maxItems: 200,
        description: "Cross-sections in order, each on its own plane.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["origin"],
          properties: {
            origin: { ...vec3, description: "Plane origin; a circle's centre." },
            turn: { ...vec3, description: "Plane turn, degrees X, Y, Z; W is the plane's normal." },
            radius: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "Circle, or ellipse along U." },
            radiusV: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "Ellipse along V." },
            profile,
            loops: loopsField,
            ...profileShape,
          },
        },
      },
      ruled: { type: "boolean", description: "Flat between sections." },
      label,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "path"],
    properties: {
      kind: { const: "sweep" },
      op: booleanKind,
      path: { type: "array", minItems: 2, maxItems: 100, items: vec3, description: "[x, y, z] points; a smooth curve runs through them." },
      radius: perPoint("Circle radius, mm"),
      radiusV: perPoint("Ellipse radius toward up, mm"),
      profile: { ...profile, description: "Section outline instead of a circle, [u, v] mm about the path; V toward up." },
      scale: perPoint("Profile size factor"),
      ...profileShape,
      up: { ...vec3, description: "Where V points at the start. Default +Z." },
      steps: { type: "integer", minimum: 1, maximum: 12, description: "Sections per span (default 3); 1 is only the points." },
      caps: { enum: ["flat", "round", "point"], description: "Ends: flat (default), round dome, or point, past the path's ends." },
      capStart: { enum: ["flat", "round", "point"], description: "Start end only." },
      capEnd: { enum: ["flat", "round", "point"], description: "Far end only." },
      label,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "thickness"],
    properties: {
      kind: { const: "shell" },
      thickness: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "Wall, mm." },
      openFaces: { type: "array", maxItems: 50, description: "Faces to remove: indexes, or {normal, nearPoint} selectors.", items: { description: "Index or selector." } },
      label,
    },
  },
];
(op.oneOf as unknown[]).splice(5, 0, ...sketchOps);
// --- K4: faceExtrude and moveFaces, immediately after shell. ---
const faceOps = [
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "face", "distance"],
    properties: {
      kind: { const: "faceExtrude" },
      face: { description: "Face to extrude: an index, or {normal, nearPoint}." },
      distance: { type: "number", minimum: -1000, maximum: 1000, description: "Along the outward normal, mm. Positive adds material on an outer face." },
      draftDeg: { type: "number", minimum: -89, maximum: 89, description: "Draft angle, degrees. 0, the default, is a straight prism." },
      upTo: { description: "Face the prism stops at: an index, or {normal, nearPoint}. The distance only picks the direction." },
      label,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "faces"],
    properties: {
      kind: { const: "moveFaces" },
      faces: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        description: "Faces to move, each along its own outward normal. Neighbours extend or trim.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["face", "distance"],
          properties: {
            face: { description: "Index, or {normal, nearPoint}." },
            distance: { type: "number", minimum: -1000, maximum: 1000, description: "Along the outward normal, mm." },
          },
        },
      },
      label,
    },
  },
];
(op.oneOf as unknown[]).splice(5 + sketchOps.length, 0, ...faceOps);
const regionField = {
  type: "object",
  additionalProperties: false,
  description: "U and V ranges. Default: the face.",
  properties: {
    u: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" }, description: "Range." },
    v: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" }, description: "Range." },
  },
};
const surfaceCommon = {
  faceIndex,
  face: faceSelector,
  op: { enum: ["fuse", "cut"], description: "fuse raises (default); cut recesses." },
  depth: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "Out of the face, or into it." },
  margin: { type: "number", minimum: 0, maximum: 100, description: "Kept from the face's edges." },
  angleDeg: { type: "number", minimum: -360, maximum: 360, description: "Turns the layout in the face." },
  region: regionField,
  from: { enum: ["box", "centre", "corner", "bottom", "top"], description: "Where region's U, V = 0 is." },
  label,
};
/** Primitives repeated over a face, kept to its outline: tiles, studs, ribs, grooves. */
const surfaceOps = [
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "text", "height", "depth"],
    properties: {
      kind: { const: "text" },
      text: { type: "string", minLength: 1, maxLength: 80, description: "A-Z, 0-9, space, -+.,:!?/'&." },
      height: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "Capitals, mm." },
      strokeWidth: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "Default height × 0.15." },
      spacing: { type: "number", minimum: 0, maximum: 100, description: "Default height / 3." },
      align: { enum: ["centre", "left"], description: "at is the middle or start." },
      at: { type: "object", description: "{u, v} on the face." },
      faceIndex,
      face: faceSelector,
      from: surfaceCommon.from,
      op: surfaceCommon.op,
      depth: surfaceCommon.depth,
      angleDeg: surfaceCommon.angleDeg,
      label,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "cell", "pitch", "depth"],
    properties: {
      kind: { const: "array" },
      cell: {
        type: "object",
        additionalProperties: false,
        description: "One cell, in the face.",
        properties: {
          shape: { enum: ["rect", "circle", "polygon"], description: "Default rect." },
          width: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "U size." },
          height: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "V size." },
          diameter: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "Circle." },
          sides: { type: "integer", minimum: 3, maximum: 64, description: "Polygon." },
          across: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "Polygon corners." },
          turnDeg: { type: "number", minimum: -360, maximum: 360, description: "Cell turn." },
        },
      },
      pitch: { type: "array", minItems: 2, maxItems: 2, items: { type: "number", exclusiveMinimum: 0 }, description: "[U, V] cell spacing." },
      stagger: { type: "boolean", description: "Every other row half a pitch over." },
      fit: { enum: ["inside", "centre"], description: "Whole cell on the face (default), or its centre." },
      ...surfaceCommon,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "width", "depth"],
    properties: {
      kind: { const: "ribs" },
      along: { enum: ["u", "v"], description: "u is level (default)." },
      width: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "Rib width." },
      pitch: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Centre spacing." },
      count: { type: "integer", minimum: 1, maximum: 200, description: "Or this many, evenly." },
      ...surfaceCommon,
    },
  },
];
(op.oneOf as unknown[]).push(...surfaceOps);

/** --- Split to print (docs/plan-split-connectors.md, section 13). One name on the list; guide {kind} has its fields. */
const partitionOp = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { const: "partition" },
    cuts: {
      type: "array",
      maxItems: 23,
      description: "Planes, all cut at once. model_probe plan:true proposes them.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["origin", "normal"],
        properties: {
          origin: vec3,
          normal: vec3,
          u: { ...vec3, description: "Along the cut. Default: the section's longer side." },
          profile: { type: "object", description: "{kind}: straight (default), lap {depth, height, side}, tongue {width, depth, side}, zigzag {pitch, depth, angle, side}, dovetail {width, angle, depth, slide, side}, sketch {start:[u, w], chain:[{kind:line|arc, to:[u, w], through}]} drawn on the cut's U and W; mm, optional. Connectors work on every profile; beside a tongue or a dovetail they sit either side of it." },
          connectors: {
            type: "object",
            additionalProperties: false,
            description: "Off by default, a plain cut. {on:true} is a dowel with every default; the planner places them and the kernel keeps the ones that build.",
            properties: {
              on: { type: "boolean", description: "Connectors on this cut." },
              types: {
                description: "One connector type for the cut.",
                type: "array",
                maxItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["type"],
                  properties: {
                    type: { enum: ["dowel", "plug", "hardware", "key", "dovetail"], description: "dowel: a hole in both pieces and a pin object. plug: a peg fused to one piece, a socket in the other. hardware: holes for a bought pin or magnet. key, dovetail: not built yet." },
                    radius: { type: "number", minimum: 0, description: "Pin or plug, mm. Default max(3, 4 × nozzle)." },
                    diameter: { type: "number", minimum: 0, description: "Hardware hole: the bought part's, mm." },
                    width: { type: "number", minimum: 0, description: "Key or dovetail, mm." },
                    height: { type: "number", minimum: 0, description: "Key, along V, mm." },
                    angle: { type: "number", minimum: 0, maximum: 60, description: "Dovetail flank, degrees." },
                    slide: { enum: ["u", "v"], description: "Dovetail slide, along U or V." },
                    depth: { type: "number", minimum: 0, description: "Along the cut: a pin's whole length, a plug's height, mm. Default 4." },
                    count: { description: "fit (default): as many as the section holds; or a number.", oneOf: [{ const: "fit" }, { type: "integer", minimum: 0 }] },
                    margin: { type: "number", minimum: 0, description: "Inset from the section outline, mm." },
                    clearance: { description: "Each side: snug (default), loose, press, or mm. Starting fit.", oneOf: [{ enum: ["snug", "loose", "press"] }, { type: "number", minimum: 0 }] },
                    endGap: { type: "number", minimum: 0, description: "A hole deeper than what goes in it, mm." },
                    hole: { enum: ["round", "teardrop"], description: "Default teardrop on FDM, round on resin." },
                    side: { enum: ["positive", "negative"], description: "Plug: the piece it is fused to." },
                    place: { enum: ["fit", "fixed"], description: "fixed: at, in mm on the cut's U and V." },
                    at: { type: "array", description: "With place:fixed, each centre as [u, v].", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } },
                  },
                },
              },
            },
          },
        },
      },
    },
    target: { type: "object", description: "{printer:\"formlabs-form-4\"} (resin, exported) or a machine_list id, or {printer, process, volumeMm}. Default the plate's printer." },
    orient: { description: "keep, or one of keep and joint per part, part 1 first: joint puts the larger cut face on the bed. Not for export targets.", oneOf: [{ enum: ["keep"] }, { type: "array", items: { enum: ["keep", "joint"] } }] },
    arrange: { type: "boolean", description: "model_commit lays the pieces out. Default true; false for an export target." },
    labels: { type: "object", description: "Part numbers on the cut faces: {on, height, depth}. Default on." },
    bedMarginMm: { type: "number", minimum: 0, maximum: 100, description: "Kept from the build volume's edge." },
    maxPieces: { type: "integer", minimum: 2, maximum: 24, description: "Default 12." },
    label,
  },
};
(op.oneOf as unknown[]).push(partitionOp);

/** --- Print transitions (docs/plan-belt-transitions.md, steps 2 and 4). The corner wedge and the lip's gusset or ramp on straight edges; step 6 sweeps the corner wedge along curved edges and faces. */
const transitionOp = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { const: "transition" },
    edges: edgeList,
    mode: { enum: ["auto", "add", "cut"], description: "auto adds; cut ramps a lip's underside." },
    case: { enum: ["lip", "corner"], description: "Default found per edge." },
    angleDeg: { type: "number", exclusiveMinimum: 0, maximum: 85, description: "New face to the layers. Default the support angle." },
    size: { description: "Corner: reach along the flatter face, mm (default 2), or \"face\" to its end.", oneOf: [{ const: "face" }, { type: "number", exclusiveMinimum: 0, maximum: 200 }] },
    maxMm: { type: "number", exclusiveMinimum: 0, maximum: 500, description: "Refuse a wedge or gusset reaching further. Default 20." },
    floorMm: { type: "number", exclusiveMinimum: 0, maximum: 20, description: "Cut: least left at the lip's edge. Default 2 nozzles." },
    build: { description: "Build direction, model space. Default from the pose and the plate's printer; null re-aims.", oneOf: [vec3, { type: "null" }] },
    label,
  },
};
(op.oneOf as unknown[]).push(transitionOp);
// The kinds pushed after OP_WORDS was first filled: their words ("lip", "corner") are text too, not expressions.
addOpWords(op);

/**
 * One line per op kind. tools/list shows model_apply's op as these lines and the kind names, not every kind's full
 * schema (that was a third of the list); guide {kind} serves a kind's full schema, and a refused op names its fields.
 */
export const OP_SUMMARY: Record<string, string> = {
  hole: "hole {diameterMm | screw, through | depth, at:{u, v}}: on the workplane, or origin and axis.",
  fillet: "fillet {edges, size}: round edges.",
  chamfer: "chamfer {edges, size, size2 | angleDeg, flip}: bevel edges; size runs along each edge's upper face.",
  split: "split {origin, normal, keep}: cut in two.",
  partition: "partition {cuts:[{origin, normal, connectors}]}: split to print; model_probe plan:true proposes the cuts.",
  scale: "scale {factor}.",
  extrude: "extrude {op, profile | loops, depth}: a sketch on the workplane or a face.",
  revolve: "revolve {op, profile, axisOrigin, axisDir, angleDeg}: a sketch about an in-plane axis.",
  loft: "loft {op, sections:[{origin, turn, radius | profile}]}: through cross-sections.",
  sweep: "sweep {op, path:[[x, y, z], ...], radius}: a tube along a curve.",
  shell: "shell {thickness, openFaces}: hollow the solid.",
  faceExtrude: "faceExtrude {face, distance}: a prism on a face.",
  moveFaces: "moveFaces {faces:[{face, distance}]}: push or pull faces.",
  boolean: "boolean {op:cut|fuse|common, primitive, dx, dy, dz | radius, height, origin | centre, turn}.",
  root: "root {primitive, sizes}: a new base solid.",
  join: "join {toolObject, op}: another object's solid as the tool.",
  pocket: "pocket {face | faceIndex, shape, at, width, height, cornerRadius | diameter, depth}: a recess.",
  boss: "boss: as pocket, raised.",
  texture: "texture {face, pattern, pitch}: grooves over a face.",
  pattern: "pattern {op, linear | polar | path}: copies of an op.",
  mirror: "mirror {op, plane | normal, origin}: an op and its image.",
  text: "text {text, height, depth, face, at}: raised or cut letters.",
  array: "array {face, cell, pitch, depth}: a shape repeated over a face.",
  ribs: "ribs {face, along, width, pitch | count, depth}: strips across a face.",
  transition: "transition {edges, mode, angleDeg, size}: a wedge in a concave corner or a gusset under a lip, angleDeg to the layers.",
};

/** The op branch of one kind, as the server checks it. */
function opBranch(kind: string): Record<string, unknown> | undefined {
  return (op.oneOf as Record<string, unknown>[]).find((branch) => (branch.properties as { kind?: { const?: unknown } }).kind?.const === kind);
}

/** Every op kind, in schema order. */
export const OP_KINDS: readonly string[] = (op.oneOf as Record<string, unknown>[]).map((branch) => String((branch.properties as { kind: { const: unknown } }).kind.const));

/** A field's expected value in a few words, for a refusal. */
function fieldShape(node: Record<string, unknown>): string {
  if (Array.isArray(node.enum)) return node.enum.join("|");
  if (Array.isArray(node.oneOf)) return "list or object";
  switch (node.type) {
    case "number": return "number";
    case "integer": return "whole number";
    case "string": return "text";
    case "boolean": return "true or false";
    case "array": return node.minItems === 3 && node.maxItems === 3 ? "[x, y, z]" : "list";
    case "object": return "object";
    default: return "index or {normal, nearPoint}";
  }
}

/** The fields one op kind takes, as a sentence a refusal ends with. */
export function opFields(kind: string): string | null {
  const branch = opBranch(kind);
  if (!branch) return null;
  const required = new Set(Array.isArray(branch.required) ? branch.required as string[] : []);
  const fields = Object.entries(branch.properties as Record<string, Record<string, unknown>>)
    .filter(([name]) => name !== "kind")
    .map(([name, node]) => `${name} (${required.has(name) ? "required, " : ""}${fieldShape(node)})`);
  return `A ${kind} op takes ${fields.join(", ")}. guide {kind:"${kind}"} has its full schema.`;
}


/** A wrong field name inside an array's cell, with the right one. */
const CELL_HINTS: Record<string, string> = {
  size: "Use width and height for a rect, diameter for a circle, or sides and across for a polygon.",
  radius: "Use diameter.",
  dx: "Use width.",
  dy: "Use height.",
  depth: "Give depth on the array, not the cell.",
};

/** A wrong field name with the right one, for the refusal. */
export const FIELD_HINTS: Record<string, string> = {
  size: "Use dx, dy, dz for a box, or radius and height for a round kind.",
  sizes: "Use dx, dy, dz.",
  width: "Use dx (box X) on a boolean, or width on a pocket or boss.",
  length: "Use dx, dy, or dz.",
  depthMm: "Use depth.",
  center: "Use centre.",
  position: "Use origin (corner or base centre) or centre.",
  pos: "Use origin or centre.",
  rotation: "Use turn: degrees about X, then Y, then Z.",
  rotate: "Use turn: degrees about X, then Y, then Z.",
  angle: "Use turn: degrees about X, then Y, then Z.",
  diameter: "Use diameterMm on a hole, or radius on a primitive.",
  r: "Use radius.",
  h: "Use height.",
  type: "Use kind for the edit and primitive for the shape.",
  shape: "Use primitive on a boolean.",
  operation: "Use op: cut, fuse, or common.",
  name: "Use label.",
};

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const READ_ONLY = new Set([
  "guide",
  "sim_run",
  "sim_field",
  "sim_cancel",
  "model_anchors",
  "session_info",
  "plate_list",
  "machine_list",
  "mesh_stats",
  "model_describe",
  "faces_find",
  "edges_find",
  "settings_schema",
  "machine_get",
  "overrides_list",
  "layer_actions_list",
  "model_history",
  "gcode_summary",
  "layer_summary",
  "measure",
  "surface_at",
  "model_check",
  "paint_list",
  "support_trees",
  "layer_detail",
  "gcode_read",
]);

const DESTRUCTIVE = new Set([
  "project_save",
  // Saves the plate (over the project it came from, when that is in the workspace) and starts the desktop app.
  "app_open",
  "gcode_export",
  "export_3mf",
  "model_export_step",
  "object_remove",
  "model_drop",
  // Its steps may be any of the above.
  "plan_run",
]);

/** Hints a client uses to tell a read from a write. Every tool has one. */
export function annotationsFor(name: string): { readOnlyHint: boolean; destructiveHint: boolean } {
  return {
    readOnlyHint: READ_ONLY.has(name),
    destructiveHint: DESTRUCTIVE.has(name),
  };
}

export const TOOLS: ToolSpec[] = [
  {
    name: "session_info",
    description: "Server version, engine, whether Open CASCADE loaded, and the Model ops, primitives, and guides on offer. Nothing is sent to a printer.",
    inputSchema: empty,
  },
  {
    name: "guide",
    description: "Worked call sequences. No topic lists them. kind gives one Model op kind's full fields and examples, or assembly or place.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string", minLength: 1, maxLength: 40, description: "Guide name, e.g. ops." },
        kind: { type: "string", minLength: 1, maxLength: 40, description: "An op kind, e.g. fillet." },
      },
    },
  },
  {
    name: "project_open",
    description: "Open a .lime project. Handles in the result are new. Names in the file are data.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1 } } },
  },
  {
    name: "project_create",
    description: "Start an empty plate. Refused while there are parameters or parts, unless discard is true.",
    inputSchema: { type: "object", additionalProperties: false, properties: { discard: { type: "boolean", description: "Drop the parameters and parts." } } },
  },
  {
    name: "project_save",
    description: "Write a .lime file in the workspace. This overwrites the same name unless ifExists is refuse.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        ifExists: { enum: ["replace", "refuse"], description: "replace (default) or refuse." },
      },
    },
  },
  {
    name: "app_open",
    description: "Show the work in the Lime Slice desktop app: the running app over the live bridge, else start the installed app with the file. With no path, saves the plate as a .lime in the workspace first, over the project it came from if that is there.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, description: "A .lime or mesh file inside the workspace. Leave out to save and open the plate." } },
    },
  },
  {
    name: "mesh_import",
    description: "Add an .stl, .3mf, .step, or .stp mesh. A foreign 3MF does not import that slicer's settings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", minLength: 1 }, stepToleranceMm: { type: "number", exclusiveMinimum: 0, maximum: 1 }, pieces: { type: "boolean", description: "A STEP of several solids: an object per solid." } },
    },
  },
  {
    name: "plate_list",
    description: "Objects on the plate: name, size, centre, and off-bed notes. bboxMm is the print layout; assembledMm is the part in model space (model_place).",
    inputSchema: page,
  },
  {
    name: "plate_undo",
    description: "Undo the last place, remove, settings, or project open.",
    inputSchema: empty,
  },
  {
    name: "plate_redo",
    description: "Redo a plate step that was undone.",
    inputSchema: empty,
  },
  {
    name: "object_select",
    description: "Select one object. Later edits and the next one-object slice use it. name renames it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["object"], properties: { object: handle, name: objectName } },
  },
  {
    name: "object_place",
    description: "Place a part: centre, scale 10 to 400, centre on the bed, lay flat, turn, or align to another part. Not a Model edit: the assembled pose is model_place.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["object"],
      properties: {
        object: handle,
        centreX: { type: "number" },
        centreY: { type: "number" },
        scalePercent: { type: "number", minimum: 10, maximum: 400 },
        centreOnBed: { type: "boolean" },
        layFlat: { type: "boolean" },
        settle: { type: "boolean" },
        rotX: { type: "number", description: "Absolute turn about X, degrees." },
        rotY: { type: "number", description: "Absolute turn about Y, degrees." },
        rotZ: { type: "number", description: "Absolute turn about Z, degrees." },
        faceDown: { type: "integer", minimum: 0, description: "Face index to lay on the bed." },
        z: { type: "number", description: "Lift, mm." },
        align: {
          type: "object",
          additionalProperties: false,
          required: ["to", "how"],
          properties: { to: { type: "string", description: "Object id, or bed." }, how: { enum: [...ALIGN_RELATIONS] } },
        },
        turn: {
          type: "object",
          additionalProperties: false,
          required: ["axis", "degrees"],
          properties: { axis: { enum: ["x", "y", "z"] }, degrees: { type: "number" } },
        },
      },
    },
  },
  {
    name: "object_remove",
    description: "Remove one object from the plate.",
    inputSchema: { type: "object", additionalProperties: false, required: ["object"], properties: { object: handle } },
  },
  {
    name: "machine_list",
    description: "Printers and filaments as two lists, with bed size and nozzles. No secrets.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor,
        printerCursor: { type: "string", minLength: 1, description: "Printer page." },
        filamentCursor: { type: "string", minLength: 1, description: "Filament page." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
      },
    },
  },
  {
    name: "machine_select",
    description: "Choose the printer, filament, and nozzle. Start G-code is applied at export.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["printerId", "filamentId"],
      properties: {
        printerId: { type: "string", minLength: 1 },
        filamentId: { type: "string", minLength: 1 },
        nozzleMm: { enum: [0.4, 0.6, 0.8] },
      },
    },
  },
  {
    name: "machine_load",
    description: "Load a .limemachine.json file into this session.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1 } } },
  },
  {
    name: "settings_schema",
    description: "After machine_select. Keys that differ from the default, in panel units. Then settings_set. all lists every key.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        level: { enum: ["simple", "advanced", "expert"], description: "Panel level." },
        query: { type: "string", minLength: 1, description: "Search text." },
        all: { type: "boolean", description: "Every key, including defaults." },
        cursor,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
      },
    },
  },
  {
    name: "settings_set",
    description: "After settings_schema. Many keys at once, then slice_start. dryRun writes nothing. With object: infill 0–1, walls, speed, supports.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["values"],
      properties: {
        object: handle,
        values: { type: "object", description: "Setting keys and values. A key that is auto in settings_schema (null) takes null for auto, and 0 is a real 0." },
        dryRun: { type: "boolean", description: "Report the change only." },
      },
    },
  },
  {
    name: "settings_apply",
    description: "After machine_select. Preset, layer height, or supports, or a .limeprofile.json. Then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1 },
        preset: { enum: ["speed", "efficiency", "toughness", "layer", "region"] },
        layerHeight: { type: "number", minimum: 0.08, maximum: 0.4 },
        supports: { type: "boolean" },
      },
    },
  },
  {
    name: "profile_save",
    description: "After settings_set. Writes a .limeprofile.json in the workspace. Then settings_apply can load it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, description: "Profile name." } } },
  },
  {
    name: "machine_get",
    description: "After machine_select. Bed, temps, flow, and start G-code. No host and no key. Then machine_set.",
    inputSchema: empty,
  },
  {
    name: "machine_set",
    description: "After machine_get. Printer and filament fields, then a slice. dryRun writes nothing. Hosts are refused.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        printer: { type: "object", description: "bedX, bedY, bedZ, startGcode, endGcode, retractLength." },
        filament: { type: "object", description: "nozzleTemp, bedTemp, flow, pressureAdvance." },
        fits: { type: "object", description: "Fit coupon results: {material, snug, loose, press, wallMm?} each side in mm, or {material, reset: true}. process: resin for the Form 4." },
        dryRun: { type: "boolean", description: "Report the change only." },
      },
    },
  },
  {
    name: "machine_save",
    description: "After machine_set. Writes a .limemachine.json. Host and key are left out.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, description: "File name." } } },
  },
  {
    name: "object_duplicate",
    description: "After mesh_import. Copies the object, up to 50. Then plate_arrange.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["object"],
      properties: { object: handle, count: { type: "integer", minimum: 1, maximum: 50, description: "Copies, 1 to 50." } },
    },
  },
  {
    name: "plate_arrange",
    description: "After two objects are on the plate. Packs them on the bed. dryRun moves nothing. Then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { gapMm: { type: "number", minimum: 0, maximum: 100, description: "Gap, mm." }, dryRun: { type: "boolean", description: "Report the move only." }, assembly: { type: "string", minLength: 1, maxLength: 80, description: "Lay out only this assembly's parts." } },
    },
  },
  {
    name: "object_split_shells",
    description: "After mesh_import of a mesh with separate shells, or a STEP of several solids. Each shell or solid becomes an object. Then plate_arrange.",
    inputSchema: { type: "object", additionalProperties: false, required: ["object"], properties: { object: handle } },
  },
  {
    name: "plate_print_order",
    description: "After the plate is placed. together or sequential. A tight pair is named. Then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["order"],
      properties: {
        order: { enum: ["together", "sequential"], description: "together or sequential." },
        clearanceMm: { type: "number", minimum: 0, maximum: 100, description: "Toolhead gap, mm." },
        gantryMm: { type: "number", minimum: 0, maximum: 500, description: "Gantry height, mm." },
        dryRun: { type: "boolean", description: "Report the change only." },
      },
    },
  },
  {
    name: "range_add",
    description: "After a mesh is on the plate. A Z span's infill, walls, or speed. Then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["zFromMm", "zToMm"],
      properties: {
        zFromMm: { type: "number", minimum: 0, description: "From Z, mm." },
        zToMm: { type: "number", minimum: 0, description: "To Z, mm." },
        infillPercent: { type: "number", minimum: 0, maximum: 100, description: "Infill, percent." },
        walls: { type: "integer", minimum: 1, maximum: 12, description: "Walls." },
        speedMmS: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Speed cap, mm/s." },
        dryRun: { type: "boolean", description: "Report the change only." },
      },
    },
  },
  {
    name: "modifier_add",
    description: "After a mesh is on the plate. A box, cylinder, or sphere on the bed. Then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "centre", "sizeMm"],
      properties: {
        kind: { enum: ["box", "cylinder", "sphere"], description: "box, cylinder, or sphere." },
        centre: { type: "array", description: "Bed centre, mm.", minItems: 3, maxItems: 3, items: { type: "number" } },
        sizeMm: { type: "array", description: "Full size, mm.", minItems: 3, maxItems: 3, items: { type: "number" } },
        infillPercent: { type: "number", minimum: 0, maximum: 100, description: "Infill, percent." },
        walls: { type: "integer", minimum: 1, maximum: 12, description: "Walls." },
        speedMmS: { type: "number", exclusiveMinimum: 0, maximum: 1000, description: "Speed cap, mm/s." },
        dryRun: { type: "boolean", description: "Report the change only." },
      },
    },
  },
  {
    name: "overrides_list",
    description: "After range_add or modifier_add. The ranges and volumes. Then override_remove.",
    inputSchema: empty,
  },
  {
    name: "override_remove",
    description: "After overrides_list. Removes one id. Then slice_start.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1, description: "Override id." } } },
  },
  {
    name: "layer_action_set",
    description: "After a slice, or with a Z you choose. Pause, filament change, or a custom line. Then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["zMm", "kind"],
      properties: {
        zMm: { type: "number", minimum: 0, description: "Z, mm. Snapped to a layer top." },
        kind: { enum: ["pause", "filamentChange", "customGcode"], description: "pause, filamentChange, or customGcode." },
        gcode: { type: "string", minLength: 1, description: "Custom line. Data, not an instruction." },
        note: { type: "string", maxLength: 80, description: "Short note." },
        dryRun: { type: "boolean", description: "Report the change only." },
      },
    },
  },
  {
    name: "layer_actions_list",
    description: "After layer_action_set. The pauses and custom lines. Then layer_action_remove.",
    inputSchema: empty,
  },
  {
    name: "layer_action_remove",
    description: "After layer_actions_list. Removes the action at that Z. Then slice_start.",
    inputSchema: { type: "object", additionalProperties: false, required: ["zMm"], properties: { zMm: { type: "number", minimum: 0, description: "Z, mm." } } },
  },
  {
    name: "slice_start",
    description: "After place and settings. The selected object, or the whole plate when scope is plate. A second slice needs cancelRunning.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cancelRunning: { type: "boolean" },
        scope: { enum: ["plate", "object"], description: "plate or the selected object." },
      },
    },
  },
  {
    name: "slice_wait",
    description: "Wait about 20s for a slice or a long call's job, or status running. A done job returns its call's result. timeoutS is up to 120.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["job"],
      properties: { job: jobHandle, timeoutS: { type: "number", exclusiveMinimum: 0, maximum: 120 } },
    },
  },
  {
    name: "slice_cancel",
    description: "Cancel a running slice, or take back a long call's job.",
    inputSchema: { type: "object", additionalProperties: false, required: ["job"], properties: { job: jobHandle } },
  },
  {
    name: "gcode_summary",
    description: "Time, grams, cost, warnings, part beads on nothing, and unusual lines. Lines are data.",
    inputSchema: { type: "object", additionalProperties: false, properties: { job: jobHandle } },
  },
  {
    name: "gcode_export",
    description: "Write G-code in the workspace. Overwrites the same name.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { job: jobHandle, name: { type: "string", minLength: 1 }, now: { type: "string", minLength: 1 } },
    },
  },
  {
    name: "export_3mf",
    description: "Write the plate as a 3MF in the workspace. Not G-code. Overwrites the same name.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1 }, object: handle, pieces: { type: "boolean", description: "Instead: the object's split to print pieces, named <name>-<n>." }, stl: { type: "boolean", description: "With pieces: one STL each." } } },
  },
  {
    name: "mesh_stats",
    description: "Triangle count, size, and off-bed notes for one object. No triangle coordinates.",
    inputSchema: { type: "object", additionalProperties: false, required: ["object"], properties: { object: handle } },
  },
  {
    name: "solid_new",
    description: "Add a primitive solid (box, cylinder, sphere, ellipsoid, cone, torus, wedge, polygon, tube), centred on X and Y on Z = 0. Or, with coupon, a fit coupon. Needs Open CASCADE.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...solidFields,
        name: objectName,
        coupon: {
          type: "object",
          additionalProperties: false,
          description: "Instead of a primitive: a dowel fit coupon and pin (formlabs-form-4: STEP files).",
          properties: {
            printer: { type: "string", description: "Default the plate's." },
            material: { type: "string", description: "Default the filament's." },
            radius: { type: "number", exclusiveMinimum: 0, maximum: 50, description: "Pin, mm." },
            depth: { type: "number", exclusiveMinimum: 0, maximum: 200, description: "Pin length, mm." },
            hole: { enum: ["round", "teardrop"], description: "Default by process." },
            startMm: { type: "number", minimum: 0, maximum: 2, description: "Centre, each side, mm. Default Snug." },
          },
        },
      },
    },
  },
  {
    name: "model_describe",
    description: "After a STEP import or solid_new. Centres are part-frame mm. Then faces_find or edges_find.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        cursor,
        facesCursor: cursor,
        edgesCursor: cursor,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
      },
    },
  },
  {
    name: "faces_find",
    description: "After solid_new or a STEP import. Part-frame centres, mm. Then workplane_set with faceIndex.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        normal: { type: "array", description: "Outward normal, part frame.", minItems: 3, maxItems: 3, items: { type: "number" } },
        withinDeg: { type: "number", minimum: 0, maximum: 180, description: "Degrees. Default 5." },
        kind: { enum: ["plane", "cylinder", "cone", "sphere", "other"], description: "Surface; cylinder and cone have radiusMm and axis." },
        areaMinMm2: { type: "number", minimum: 0, description: "Minimum area, mm²." },
        nearPoint: { type: "array", description: "Point, part frame, mm. Nearest faces first, with distanceMm.", minItems: 3, maxItems: 3, items: { type: "number" } },
        cursor,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
      },
    },
  },
  {
    name: "edges_find",
    description: "After solid_new or a STEP import. Part-frame mids, mm. Then model_probe a fillet with edges.select.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        direction: { type: "array", description: "Edge direction, part frame.", minItems: 3, maxItems: 3, items: { type: "number" } },
        withinDeg: { type: "number", minimum: 0, maximum: 180, description: "Degrees. Default 5." },
        onFace: { description: "Face index, or a flat face selector {normal, withinDeg, nearPoint}." },
        lengthMinMm: { type: "number", minimum: 0, description: "Minimum length, mm." },
        convex: { type: "boolean", description: "Convex edges only." },
        cursor,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
      },
    },
  },
  {
    name: "workplane_set",
    description: "After faces_find. Flat faceIndex, part frame. A curved face is refused. Then model_probe a hole.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        source: { enum: ["global", "bed", "face"], description: "global, bed, or face." },
        faceIndex: { type: "integer", minimum: 0 },
        origin: vec3,
        turn: vec3,
      },
    },
  },
  {
    name: "workplane_print_up",
    description: "Turn the part so the chosen face points up. Refused when no face has been chosen.",
    inputSchema: { type: "object", additionalProperties: false, properties: { object: handle } },
  },
  {
    name: "model_place",
    description: "Set the assembled pose: model space, mm and degrees; numbers may be expressions. The print layout does not move. With to, an offset in that part's frame, and both join one assembly. guide {kind:\"assembly\"}.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        x: placeNumber,
        y: placeNumber,
        z: placeNumber,
        turnX: placeNumber,
        turnY: placeNumber,
        turnZ: placeNumber,
        to: { type: "string", minLength: 1, maxLength: 64, description: "Sit on this part: the numbers are its frame." },
        assembly: { type: "string", minLength: 1, maxLength: 80, description: "Assembly name." },
        frame: { enum: ["part", "model"], description: "Frame of later Model numbers. Default part for a member, else model." },
      },
    },
  },
  {
    name: "model_probe",
    description: "Check one plain edit; the solid does not change. Ok adds metrics: volume, bbox, and shells before and after, and warns on separate pieces. Then model_apply the same op.",
    inputSchema: { type: "object", additionalProperties: false, required: ["op"], properties: { object: handle, op: opPointer("One plain edit, not a composite."), node: step, plan: { type: "boolean", description: "partition: propose cuts for the printer; transition: edges that start in the air. Nothing changes." } } },
  },
  {
    name: "surface_at",
    description: "First hit of a ray on the solid, part frame, mm: point, normal, distanceMm, faceIndex. Give point and direction, or x and y for a ray down from above. Mesh, 0.05 mm.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        point: { ...vec3, description: "Ray start." },
        direction: { ...vec3, description: "Ray direction. Default down with x, y." },
        x: { type: "number", description: "With y: ray down." },
        y: { type: "number", description: "With x." },
      },
    },
  },
  {
    name: "model_check",
    description: "Before slicing, the solid as it stands on the bed: overhang area and places, down faces above the bed, floating pieces, bed contact, size against the build volume, walls thinner than two nozzle widths, and open or touching mesh edges, each with where it is.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        overhangDeg: { type: "number", minimum: 1, maximum: 89, description: "From vertical. Default 45." },
        minWallMm: { type: "number", minimum: 0.1, maximum: 20, description: "Thinnest wall to accept. Default twice the nozzle." },
        interference: { type: "boolean", description: "Instead: pairs of parts in its assembly that cross, as assembled." },
        exact: { type: "boolean", description: "With interference: each pair's common volume by the kernel." },
      },
    },
  },
  {
    name: "model_apply",
    description: "Apply one edit. A plain op needs model_probe first, or probe: true. A composite op is checked step by step, rolled back on a refusal, and undone as one step. Then model_commit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["op"],
      properties: {
        object: handle,
        op,
        probe: { type: "boolean", description: "Check first; apply only if it passes." },
      },
    },
  },
  {
    name: "model_apply_batch",
    description: "Apply edits in order, each checked first. A refusal stops the batch and rolls it back unless onError is stop. One undo step. Then model_commit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ops"],
      properties: {
        object: handle,
        ops: { type: "array", minItems: 1, maxItems: 1000, items: opPointer("One edit."), description: "Edits, in order; each and use expand first." },
        label: { type: "string", minLength: 1, maxLength: 80, description: "Batch name; node fields take it." },
        onError: { enum: ["rollback", "stop", "skip"], description: "rollback, stop, or skip." },
        params: { type: "object", description: "This call only, on top of model_params." },
      },
    },
  },
  {
    name: "model_build",
    description: "New solid, a batch of edits, and a commit, in one call. Called again after a refusal with the same base, it reuses the ops before the first changed one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        base: {
          type: "object",
          additionalProperties: false,
          required: ["primitive"],
          description: "As solid_new takes it.",
          properties: solidFields,
        },
        ops: { type: "array", maxItems: 1000, items: opPointer("One edit."), description: "Edits, in order; each and use expand first." },
        params: { type: "object", description: "This call only, e.g. {\"wallH\": 35}." },
        name: { type: "string", minLength: 1, maxLength: 120, description: "Object name." },
        label: { type: "string", minLength: 1, maxLength: 80, description: "Name for the batch." },
        onError: { enum: ["rollback", "stop", "skip"], description: "rollback, stop, or skip." },
        commit: { type: "boolean", description: "Put the result on the plate (default true)." },
        resume: { type: "boolean", description: "Reuse a refused build with this base (default true)." },
        object: { type: "string", description: "An earlier build to rebuild in place, reusing its matching ops. Alone with params: rerun its recipe." },
      },
    },
  },
  {
    name: "model_define",
    description: "Store a named part: default params and ops. {kind:\"use\", part, with:{...}, label} in any op list places it. Session and project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 60, description: "Part name." },
        params: { type: "object", description: "Defaults, numbers or expressions." },
        ops: { type: "array", maxItems: 400, items: { type: "object" }, description: "The part's ops, as model_build takes them." },
        clear: { type: "boolean", description: "Forget every part first." },
      },
    },
  },
  {
    name: "model_anchors",
    description: "Labelled steps with the box of what each applied, as anchors read them: min, max, centre, size.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        label: { type: "string", minLength: 1, maxLength: 80, description: "One label; default all." },
      },
    },
  },
  {
    name: "model_params",
    description: "Named numbers ops may use as text, e.g. dx: \"wallW / 2\". Saved in the project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        set: { type: "object", description: "Name to number or expression; later names may use earlier ones." },
        clear: { type: "boolean", description: "Forget every name first." },
        rebuild: { type: "boolean", description: "Then rebuild each part that uses them, as the app's Rebuild does, and check it." },
      },
    },
  },
  {
    name: "model_history",
    description: "One page of history: id, parent, and label.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { object: handle, cursor, limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." } },
    },
  },
  {
    name: "model_goto",
    description: "Show another history step. The plate mesh changes only after model_commit.",
    inputSchema: { type: "object", additionalProperties: false, required: ["node"], properties: { object: handle, node: step } },
  },
  {
    name: "model_undo",
    description: "Move to the parent step, or back over a whole batch or composite edit. At the root, nothing changes.",
    inputSchema: { type: "object", additionalProperties: false, properties: { object: handle } },
  },
  {
    name: "model_redo",
    description: "Move to the step redo remembers. When redo is empty, nothing changes.",
    inputSchema: { type: "object", additionalProperties: false, properties: { object: handle } },
  },
  {
    name: "model_edit",
    description: "Replace a probed step and replay the steps under it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["node", "op"], properties: { object: handle, node: step, op: opPointer("The replacement plain edit.") } },
  },
  {
    name: "model_rename",
    description: "After model_history. Renames one step. Then model_history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["node", "label"],
      properties: { object: handle, node: step, label: { type: "string", minLength: 1, maxLength: 80, description: "Step name." } },
    },
  },
  {
    name: "model_drop",
    description: "Delete a history branch. The root and the plated step are refused.",
    inputSchema: { type: "object", additionalProperties: false, required: ["node"], properties: { object: handle, node: step } },
  },
  {
    name: "model_commit",
    description: "After model_apply. Puts the solid on the plate and writes its STEP. The desktop reloads that file. Then slice_start.",
    inputSchema: { type: "object", additionalProperties: false, properties: { object: handle } },
  },
  {
    name: "model_export_step",
    description: "Write a .step file in the workspace. Overwrites the same name.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { object: handle, name: { type: "string", minLength: 1 }, pieces: { type: "boolean", description: "Its split to print pieces, a named solid each." }, assembly: { type: "boolean", description: "Its assembly's parts at their assembled poses, a named solid each." } } },
  },
  {
    name: "measure",
    description: "Distance in millimetres between two points or two faces.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        a: vec3,
        b: vec3,
        faceA: { type: "integer", minimum: 0 },
        faceB: { type: "integer", minimum: 0 },
        frame: { enum: ["model", "workplane"] },
      },
    },
  },
  {
    name: "layer_summary",
    description: "Layer count and the first and last height. Not the toolpath.",
    inputSchema: { type: "object", additionalProperties: false, properties: { job: jobHandle } },
  },
  {
    name: "render_view",
    description: "PNG inline and in the workspace. Cameras on the part's axes: front shows the −Y face, back, left (−X), right, top, bottom, iso; or direction and up. views: several cameras, one image each. op: a boolean's tool in orange, not applied.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        camera: { enum: ["front", "back", "left", "right", "top", "bottom", "iso"] },
        direction: { ...vec3, description: "Part toward camera." },
        up: { ...vec3, description: "Picture up. Default Z." },
        views: { type: "array", minItems: 1, maxItems: 6, description: "Names or {direction, up}.", items: {} },
        turntable: { type: "integer", minimum: 2, maximum: 12, description: "That many views all round, in place of views." },
        op: { type: "object", description: "Boolean op. Drawn only." },
        highlight: { description: "A label, or a list: those steps in orange." },
        colours: { type: "object", description: "Label to colour, e.g. {\"fish\": \"#b08040\"}." },
        section: { type: "object", additionalProperties: false, description: "Cut away the side normal points to; the inside shows red.", properties: { normal: vec3, point: { ...vec3, description: "Default: the part's centre." } } },
        smooth: { type: "boolean", description: "Smooth shading on curves (default true)." },
        view: { enum: ["assembly", "print"], description: "Several parts: the object's assembly as assembled, or the bed as it prints." },
        inline: { type: "boolean", description: "Default true." },
        name: { type: "string", minLength: 1 },
        longEdge: { type: "integer", minimum: 32, maximum: 1024 },
      },
    },
  },
  {
    name: "paint_supports",
    description: "Paint enforce or block disks, then slice_start. lime://guide/paint.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["region"],
      properties: {
        object: handle,
        mode: { enum: ["enforce", "block", "erase"], description: "enforce, block, or erase." },
        region: { type: "object", description: "faces, overhangBelowDeg, box, sphere, or stroke." },
        radiusMm: { type: "number", minimum: 0.5, maximum: 20, description: "Brush mm. Default 3." },
        frame: { enum: ["part", "bed"], description: "part or bed." },
        dryRun: { type: "boolean", description: "Do not write." },
      },
    },
  },
  {
    name: "paint_seam",
    description: "Paint the seam, then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["region"],
      properties: {
        object: handle,
        region: { type: "object", description: "faces, overhangBelowDeg, box, sphere, or stroke." },
        radiusMm: { type: "number", minimum: 0.5, maximum: 20, description: "Brush mm. Default 3." },
        erase: { type: "boolean", description: "Remove paint there." },
        frame: { enum: ["part", "bed"], description: "part or bed." },
        dryRun: { type: "boolean", description: "Do not write." },
      },
    },
  },
  {
    name: "reinforce_add",
    description: "Add infill paint or a volume, then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        object: handle,
        kind: { enum: ["paint", "box", "cylinder"], description: "paint, box, or cylinder." },
        region: { type: "object", description: "Paint region. faces, box, sphere, or stroke." },
        centre: vec3,
        sizeMm: vec3,
        density: { type: "number", minimum: 0, maximum: 1, description: "0 to 1. Default 1." },
        depthMm: { type: "number", minimum: 0.2, maximum: 100, description: "Paint depth, mm." },
        fillThrough: { type: "boolean", description: "Fill through the part." },
        frame: { enum: ["part", "bed"], description: "part or bed." },
        dryRun: { type: "boolean", description: "Do not write." },
      },
    },
  },
  {
    name: "paint_list",
    description: "Disks already painted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        layer: { enum: ["supports", "seam", "reinforce"], description: "supports, seam, or reinforce." },
        cursor: cursor,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
      },
    },
  },
  {
    name: "paint_clear",
    description: "Remove one paint layer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: handle,
        layer: { enum: ["supports", "seam", "reinforce"], description: "supports, seam, or reinforce." },
      },
    },
  },
  {
    name: "support_edit",
    description: "Prune or regrow a tree. support_trees first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "site"],
      properties: {
        object: handle,
        action: { enum: ["prune", "regrow"], description: "prune or regrow." },
        site: { type: "object", description: "xy and zMm of the limb." },
        scope: { enum: ["branch", "tree"], description: "branch or tree." },
        dryRun: { type: "boolean", description: "Do not write." },
      },
    },
  },
  {
    name: "support_trees",
    description: "Trees from the last slice.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: jobHandle,
        cursor: cursor,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
      },
    },
  },
  {
    name: "layer_detail",
    description: "Layer heights and seconds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: jobHandle,
        layers: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer", minimum: 0 }, description: "First and last layer index." },
        cursor: cursor,
      },
    },
  },
  {
    name: "layer_paths",
    description: "Write one layer as SVG.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: jobHandle,
        layer: { type: "integer", minimum: 0, description: "Layer index." },
        simplifyMm: { type: "number", minimum: 0, description: "Drop points closer than this." },
        name: { type: "string", minLength: 1, description: "Workspace file." },
      },
    },
  },
  {
    name: "layer_image",
    description: "PNG of one layer, inline and in the workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: jobHandle,
        inline: { type: "boolean", description: "Default true." },
        layer: { type: "integer", minimum: 0, description: "Layer index." },
        colourBy: { enum: ["feature", "speed", "weight", "stress", "safety"], description: "stress and safety read the last sliced sim_run." },
        longEdge: { type: "integer", minimum: 32, maximum: 1024, description: "Pixels, 32–1024." },
        name: { type: "string", minLength: 1, description: "Workspace file." },
      },
    },
  },
  {
    name: "gcode_read",
    description: "A page of G-code lines.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: jobHandle,
        fromLine: { type: "integer", minimum: 1, description: "First line, from 1." },
        count: { type: "integer", minimum: 1, maximum: 500, description: "At most 500 lines." },
        grep: { type: "string", description: "Keep lines that contain this text." },
      },
    },
  },
  {
    name: "calibration_tower",
    description: "Write a calibration tower. lime://guide/calibrate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "start", "end", "step"],
      properties: {
        kind: { enum: ["pa", "flow", "temp", "retract"], description: "pa, flow, temp, or retract." },
        start: { type: "number", description: "First band." },
        end: { type: "number", description: "Last band." },
        step: { type: "number", exclusiveMinimum: 0, description: "Step between bands." },
        bandHeightMm: { type: "number", exclusiveMinimum: 0, description: "Band height, mm." },
        layerHeight: { type: "number", minimum: 0.08, maximum: 0.4, description: "mm, 0.08 to 0.4." },
        dryRun: { type: "boolean", description: "Do not write." },
      },
    },
  },
  {
    name: "calibration_apply",
    description: "Save a tower value on the filament.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "value"],
      properties: {
        kind: { enum: ["pa", "flow", "temp", "retract"], description: "pa, flow, temp, or retract." },
        value: { type: "number", description: "The value to save." },
      },
    },
  },
  {
    name: "blend_compare",
    description: "Compare a few blends. Then blend_apply.",
    inputSchema: { type: "object", additionalProperties: false, properties: { object: handle } },
  },
  {
    name: "blend_apply",
    description: "Keep one blend point, then slice_start.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["index"],
      properties: { index: { type: "integer", minimum: 0, description: "Point from blend_compare." } },
    },
  },
  {
    name: "plan_run",
    description: PLAN_HELP,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PLAN_STEPS,
          description: "Calls, in order.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["tool"],
            properties: {
              tool: { type: "string", minLength: 1, maxLength: 64, description: "Tool name." },
              args: { type: "object", description: "Its arguments; \"$N.path\" strings are references." },
            },
          },
        },
      },
    },
  },
  {
    name: "tools_enable",
    description: TOOLS_ENABLE_HELP,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["groups"],
      properties: { groups: { type: "array", minItems: 1, maxItems: GROUP_NAMES.length, items: { enum: GROUP_NAMES }, description: "Group names." } },
    },
  },
  {
    name: "sim_setup",
    description: "Write a study. Does not solve.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: { type: "string", description: "Handle." },
        beam: {
          type: "object",
          additionalProperties: false,
          description: "Generated box, mm.",
          properties: {
            lengthMm: { type: "number", exclusiveMinimum: 0, description: "X." },
            widthMm: { type: "number", exclusiveMinimum: 0, description: "Y." },
            heightMm: { type: "number", exclusiveMinimum: 0, description: "Z." },
          },
        },
        fixtures: {
          type: "array",
          maxItems: 8,
          description: "Holds.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { enum: ["bed", "faces", "plane", "region"], description: "Hold kind." },
              faces: { type: "array", maxItems: 8, items: { type: "integer", minimum: 0 }, description: "Face indexes." },
              region: simRegion,
              normal: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "Plane normal." },
              origin: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "Plane point." },
            },
          },
        },
        loads: {
          type: "array",
          maxItems: 8,
          description: "Loads.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { enum: ["force", "pressure"], description: "force (N) or pressure (MPa)." },
              faces: { type: "array", maxItems: 8, items: { type: "integer", minimum: 0 }, description: "Face indexes." },
              region: simRegion,
              magnitude: { type: "number", description: "N or MPa." },
              direction: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "Direction." },
            },
          },
        },
        card: { description: "Card id, or an inline card.", oneOf: [{ type: "string", minLength: 1 }, { type: "object" }] },
        printer: { type: "boolean", description: "Use the printer axis." },
        buildAxis: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "Build direction." },
        hMm: { type: "number", exclusiveMinimum: 0, description: "Edge length, mm." },
        element: { type: "string", description: "Only tet10." },
        gravity: { type: "boolean", description: "Self weight, off by default." },
        representation: { enum: ["sliced", "smear"], description: "Default: sliced for STL or STEP with a printer." },
        constraints: {
          type: "array",
          maxItems: 8,
          description: "Targets; a sliced run returns margins.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: {
                enum: ["minSafetyFactor", "maxDeflectionMm", "deflectionBandMm", "minStiffnessNPerMm", "stiffnessBandNPerMm", "relativeDeflectionMm", "maxMassG", "minMassG"],
                description: "See guide sim.",
              },
              value: { type: "number", exclusiveMinimum: 0, description: "The limit." },
              band: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" }, description: "lo, hi." },
              region: simRegion,
              other: { type: "object", description: "Second region." },
            },
          },
        },
      },
    },
  },
  {
    name: "sim_run",
    description: "Solve. A sliced part returns margins. No triangles.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        object: { type: "string", description: "Handle." },
        includeSlicerMass: { type: "boolean", description: "Grams from a finished slice." },
        checkResolution: { type: "boolean", description: "A second cell size. Default true." },
      },
    },
  },
  {
    name: "sim_field",
    description: "One field, paged at 100.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["field"],
      properties: {
        object: { type: "string", description: "Handle." },
        field: { type: "string", minLength: 1, description: "Field name." },
        points: { type: "array", maxItems: 100, items: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } }, description: "Points, mm." },
        box: {
          type: "object",
          additionalProperties: false,
          description: "Box, mm.",
          properties: {
            min: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "Min corner." },
            max: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" }, description: "Max corner." },
          },
        },
        face: { type: "integer", minimum: 0, description: "Face index." },
        stride: { type: "integer", minimum: 1, description: "Every nth node." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "1 to 100." },
        cursor: { type: "string", description: "Page start." },
      },
    },
  },
  {
    name: "sim_sweep",
    description: "Up to 16 variants. A sliced study needs reslice.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["variants"],
      properties: {
        object: { type: "string", description: "Handle." },
        variants: {
          type: "array",
          maxItems: 32,
          description: "Patches. Over 16 is refused.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              parameters: { type: "object", description: "model_params names." },
              walls: { type: "integer", minimum: 1, maximum: 12, description: "Walls." },
              infill: { type: "number", minimum: 0, maximum: 1, description: "0 to 1." },
              pattern: { enum: ["lines", "grid", "gyroid", "lightning"], description: "Infill pattern." },
              loadScale: { type: "number", exclusiveMinimum: 0, description: "Scales the loads." },
            },
          },
        },
        constraints: {
          type: "object",
          additionalProperties: false,
          description: "A rough row is not met.",
          properties: {
            maxDeflectionMm: { type: "number", exclusiveMinimum: 0, description: "mm." },
            minSafetyFactor: { type: "number", exclusiveMinimum: 0, description: "Max-stress." },
            maxMassG: { type: "number", exclusiveMinimum: 0, description: "g." },
            minMassG: { type: "number", exclusiveMinimum: 0, description: "g." },
          },
        },
        commit: { type: "boolean", description: "Apply one variant. Default false." },
        variant: { type: "integer", minimum: 0, description: "Index to keep." },
        includePrintTime: { type: "boolean", description: "Off. Does not slice." },
        reslice: { type: "boolean", description: "Slice plus solve per variant." },
        checkResolution: { type: "boolean", description: "Second cell size. Off." },
      },
    },
  },
  {
    name: "sim_cancel",
    description: "Leave the last result.",
    inputSchema: empty,
  },
];

const FIELD_TEXT: Record<string, string> = {
  path: "absolute, or relative to the workspace",
  name: "Workspace file.",
  stepToleranceMm: "mm. Default 0.05.",
  centreX: "Bed X, mm.",
  centreY: "Bed Y, mm.",
  scalePercent: "10 to 400.",
  centreOnBed: "Centre on bed.",
  layFlat: "Lay flattest face.",
  how: "A relation: flush-left, centre, on-top.",
  align: "Flush, touch, centre or stack on a part or the bed. Applied last. Front is low Y.",
  settle: "After any turn, rest on the bed at the best contact within 12 degrees; reports rotationDeg and contactMm2.",
  axis: "x, y, or z.",
  degrees: "Degrees.",
  turn: "Axis and degrees.",
  printerId: "Printer id.",
  filamentId: "Filament id.",
  nozzleMm: "0.4, 0.6, 0.8.",
  preset: "Preset name.",
  layerHeight: "mm, 0.08 to 0.4.",
  supports: "Supports on.",
  cancelRunning: "Cancel the slice.",
  job: "Job handle.",
  timeoutS: "Seconds. Max 120.",
  now: "ISO time.",
  faceIndex: "Face index.",
  x: "X, mm.",
  y: "Y, mm.",
  z: "Z, mm.",
  turnX: "Degrees.",
  turnY: "Degrees.",
  turnZ: "Degrees.",
  node: "History step.",
  facesCursor: "Face page.",
  edgesCursor: "Edge page.",
  faceA: "Face index.",
  faceB: "Face index.",
  frame: "model or workplane.",
  camera: "top, front, iso.",
  longEdge: "Pixels, 32–1024.",
  kind: "Edit kind.",
  diameterMm: "Diameter, mm.",
  radius: "Radius, mm.",
  depth: "Depth, mm.",
  through: "Drill through.",
  at: "Workplane point.",
  origin: "Point, mm.",
  counterboreDiameterMm: "Diameter, mm.",
  counterboreDepth: "Depth, mm.",
  edges: "Edge indexes.",
  size: "Size, mm.",
  normal: "Direction.",
  factor: "0.1 to 20.",
  primitive: "box, cylinder, sphere.",
  dx: "X or diameter, mm.",
  dy: "Y, mm.",
  dz: "Z or height, mm.",
  toolObject: "Other solid.",
  keepTool: "Keep the tool.",
  printerCursor: "Printer page.",
  filamentCursor: "Filament page.",
};

function annotate(node: Record<string, unknown>): void {
  const properties = node.properties;
  if (properties && typeof properties === "object") {
    for (const [key, child] of Object.entries(properties as Record<string, Record<string, unknown>>)) {
      if (child && typeof child === "object") {
        if (typeof child.description !== "string" && FIELD_TEXT[key]) child.description = FIELD_TEXT[key];
        annotate(child);
      }
    }
  }
  if (node.items && typeof node.items === "object") annotate(node.items as Record<string, unknown>);
  if (Array.isArray(node.oneOf)) {
    for (const branch of node.oneOf) {
      if (branch && typeof branch === "object") annotate(branch as Record<string, unknown>);
    }
  }
}

for (const tool of TOOLS) annotate(tool.inputSchema);

/** Model tools whose op, ops, and base take text such as "wallH / 2" where a number goes. */
export const EXPRESSION_TOOLS: ReadonlySet<string> = new Set(["model_probe", "model_apply", "model_apply_batch", "model_edit", "model_build", "model_define", "render_view", "workplane_set"]);

/**
 * A schema as a client sees it: a number may also be text (an expression the server reads before checking), and a
 * point [x, y, z] may also be an anchor object. Dropping `type` says both in fewer bytes than a type list. The server
 * checks the numbers it reads against the full schema itself.
 */
function textNumbers(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(textNumbers);
  const row = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(row)) {
    out[key] = key === "properties" && child && typeof child === "object"
      ? Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([name, value]) => [name, textNumbers(value)]))
      : key === "items" || key === "oneOf" || key === "anyOf" ? textNumbers(child) : child;
  }
  // No type: minimum, maximum, and items bind only a number or a list, so text and an anchor object pass through.
  if (row.type === "number" || row.type === "integer" || (row.type === "array" && row.minItems === 3 && row.maxItems === 3)) delete out.type;
  return out;
}

let advertisedCache: ToolSpec[] | null = null;

/**
 * model_apply's op as tools/list sends it: the kind names and one line each. The server still checks every call
 * against the full op schema, and guide {kind} serves one kind's.
 */
const LEAN_OP = {
  type: "object",
  required: ["kind"],
  description: `${OP_HELP} Kinds: ${OP_KINDS.map((kind) => OP_SUMMARY[kind]).join(" ")} guide {kind:"fillet"} gives a kind's full fields; a wrong field is refused with the fields its kind takes.`,
  properties: { kind: { enum: [...OP_KINDS], description: "Edit kind." } },
};

/** One op kind's full schema, as a client may send it (numbers may be text, points anchors). */
export function opSchemaFor(kind: string): Record<string, unknown> | null {
  const branch = opBranch(kind);
  return branch ? textNumbers(branch) as Record<string, unknown> : null;
}

/** TOOLS as tools/list sends them: the Model tools' op, ops, and base take text numbers and anchors. */
export function advertisedTools(): ToolSpec[] {
  advertisedCache ??= TOOLS.map((tool) => {
    if (!EXPRESSION_TOOLS.has(tool.name)) return tool;
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    const next = Object.fromEntries(Object.entries(props).map(([name, value]) => [
      name,
      tool.name === "model_apply" && name === "op" ? LEAN_OP : name === "op" || name === "ops" || name === "base" || (tool.name === "workplane_set" && (name === "origin" || name === "turn")) ? textNumbers(value) : value,
    ]));
    return { ...tool, inputSchema: { ...tool.inputSchema, properties: next } };
  });
  return advertisedCache;
}

/**
 * The tools tools/list sends. With groups off (null), every tool but tools_enable, as before groups existed. With
 * groups on, the core tools, tools_enable, and the tools of each enabled group.
 */
export function listedTools(groups: ReadonlySet<string> | null): ToolSpec[] {
  if (groups === null) return advertisedTools().filter((tool) => tool.name !== "tools_enable");
  return advertisedTools().filter((tool) => {
    const group = groupOf(tool.name);
    return group === null || groups.has(group);
  });
}

export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

function fieldName(path: string): string {
  return path.startsWith("input.") ? path.slice("input.".length) : path;
}

export function validate(schema: Record<string, unknown>, value: unknown, path = "input"): string | null {
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as Record<string, unknown>[];
    const kinds = branches.map((branch) => {
      const props = branch.properties as { kind?: { const?: unknown } } | undefined;
      return props?.kind?.const;
    }).filter((kind): kind is string => typeof kind === "string");
    const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
    if (kinds.length > 0 && (typeof kind !== "string" || !kinds.includes(kind))) {
      return `op.kind must be one of ${kinds.join(", ")}.`;
    }
    const matched = branches.filter((branch) => {
      const props = branch.properties as { kind?: { const?: unknown } } | undefined;
      const expect = props?.kind?.const;
      return expect === undefined || expect === kind;
    });
    const tryThese = matched.length > 0 ? matched : branches;
    let first: string | null = null;
    for (const branch of tryThese) {
      const problem = validate(branch, value, path);
      if (!problem) return null;
      first ??= problem;
    }
    return first ?? `${path} does not match.`;
  }
  if (schema.const !== undefined && value !== schema.const) return `${fieldName(path)} must be ${JSON.stringify(schema.const)}.`;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
    const values = schema.enum.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(", ");
    return `${fieldName(path)} must be one of ${values}.`;
  }
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object.`;
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          const hint = (path.endsWith(".cell") ? CELL_HINTS[key] : undefined) ?? FIELD_HINTS[key];
          return `${path}.${key} is not a field of this tool.${hint ? ` ${hint}` : ""}`;
        }
      }
    }
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) {
      if (record[key] === undefined) return `${path}.${key} is required.`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (record[key] !== undefined) {
        const problem = validate(child, record[key], `${path}.${key}`);
        if (problem) return problem;
      }
    }
    return null;
  }
  if (type === "array") {
    // A point may be an anchor, read when its op's turn comes (src/modeling/anchors.ts).
    if (schema.maxItems === 3 && value && typeof value === "object" && !Array.isArray(value) && typeof (value as { anchor?: unknown }).anchor === "string") return null;
    if (!Array.isArray(value)) return `${path} must be a list.`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} is too short.`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} is too long.`;
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < value.length; i += 1) {
        const problem = validate(schema.items as Record<string, unknown>, value[i], `${path}[${i}]`);
        if (problem) return problem;
      }
    }
    return null;
  }
  if (type === "string") {
    if (typeof value !== "string") return `${path} must be text.`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is empty.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is too long.`;
    return null;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number.`;
    if (type === "integer" && !Number.isInteger(value)) return `${path} must be a whole number.`;
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${fieldName(path)} must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${fieldName(path)} must be at most ${schema.maximum}.`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path} must be greater than ${schema.exclusiveMinimum}.`;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `${path} must be less than ${schema.exclusiveMaximum}.`;
    return null;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") return `${path} must be true or false.`;
    return null;
  }
  if (Array.isArray(schema.enum) || schema.const !== undefined) return null;
  return null;
}

/** Tools that take an op or op list. */
const OP_TOOLS = new Set(["model_probe", "model_edit", "render_view", "model_apply", "model_apply_batch", "model_build"]);

/**
 * A refusal of a field inside an op, ending with the fields that op's kind takes, so a caller that guessed the shape
 * from the one-line summary learns it from the refusal. The innermost op on the refused path names the kind.
 */
function withOpFields(problem: string, input: unknown): string {
  if (/\bkind must be one of\b/.test(problem)) return problem;
  const path = (problem.split(" ")[0] ?? "").replace(/^input\./, "");
  if (!/^ops?\b/.test(path)) return problem;
  let node: unknown = input;
  let kind: string | null = null;
  let previous = "";
  for (const token of path.split(/\.|(?=\[)/)) {
    if (!node || typeof node !== "object") break;
    const key = token.startsWith("[") ? Number(token.slice(1, -1)) : token;
    node = (node as Record<string | number, unknown>)[key];
    const isOp = token === "op" || (token.startsWith("[") && previous === "ops");
    const found = node && typeof node === "object" ? (node as { kind?: unknown }).kind : undefined;
    if (isOp && typeof found === "string" && OP_SUMMARY[found]) kind = found;
    previous = token;
  }
  const fields = kind ? opFields(kind) : null;
  return fields ? `${problem} ${fields}` : problem;
}

export function validateTool(name: string, input: unknown): string | null {
  const problem = checkTool(name, input);
  return problem && OP_TOOLS.has(name) ? withOpFields(problem, input ?? {}) : problem;
}

function checkTool(name: string, input: unknown): string | null {
  const tool = toolByName(name);
  if (!tool) return `There is no tool named ${name}.`;
  const problem = validate(tool.inputSchema, input ?? {});
  if (problem) return problem;
  const record = (input ?? {}) as { op?: unknown; ops?: unknown[] };
  if (name === "model_probe" || name === "model_edit") return checkOp(record.op, "op", true);
  if (name === "render_view" && record.op !== undefined) return checkOp(record.op, "op", true);
  if (name === "model_apply") return checkOp(record.op, "op", false);
  if ((name === "model_apply_batch" || name === "model_build") && Array.isArray(record.ops)) {
    for (let i = 0; i < record.ops.length; i += 1) {
      const found = checkOp(record.ops[i], `ops[${i}]`, false);
      if (found) return found;
    }
  }
  return null;
}
