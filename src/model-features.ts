/**
 * Composite feature tools: Pocket, Boss, Texture, Array, Ribs, and Text.
 * Each one expands through the shared modelling module into a group of boolean steps, the same pieces the MCP builds
 * for the same solid and the same spec. The panel, the ghost, and the drag handles live with the other Model tools.
 */
import { facesMatching } from "../mcp/selectors.ts";
import { standRegion } from "../mcp/plane-region.ts";
import { faceRows, type FaceRow } from "../mcp/solid-geometry.ts";
import { closeCracks } from "./mesh-check.ts";
import { outwardFromMesh } from "./model-blend.ts";
import { expand, primitiveFrom, type Piece } from "./modeling/compose.ts";
import { expandContextFromSolid, type FrameFace } from "./modeling/frames.ts";
import { applyPose, isIdentity, turnDir, type Affine } from "./model-space.ts";
import type { GroupOp, ModelOp } from "./model-tree.ts";
import { planePrimitive, axesOf, GLOBAL_WORKPLANE, type Workplane } from "./workplane.ts";

/** One toolbar entry; the menu chooses which of these is on the button. */
export const FEATURE_TOOLS = ["pocket", "boss", "texture", "array", "ribs", "text"] as const;
export type FeatureTool = (typeof FEATURE_TOOLS)[number];

/** Past this many pieces the ghost draws outlines only. Expansion itself stops at MAX_PIECES (400). */
export const GHOST_PIECE_CAP = 2000;

/** Shown when the selection is not exactly one flat face. */
export const PICK_ONE_FLAT_FACE = "Pick one flat face.";

export function isFeatureTool(tool: unknown): tool is FeatureTool {
  return typeof tool === "string" && (FEATURE_TOOLS as readonly string[]).includes(tool);
}

export function piecesOutlineOnly(count: number): boolean {
  return count > GHOST_PIECE_CAP;
}

const FEATURE_NAMES: Record<FeatureTool, string> = {
  pocket: "Pocket",
  boss: "Boss",
  texture: "Texture",
  array: "Array",
  ribs: "Ribs",
  text: "Text",
};

/** The button label and the history row's first word. */
export function featureName(tool: FeatureTool): string {
  return FEATURE_NAMES[tool];
}

export type FeatureShape = "rect" | "circle" | "arch";
export type FeatureFrom = "centre" | "corner" | "bottom" | "top";
export type FeaturePattern = "lines" | "grid" | "brick" | "shingle";
export type FeatureCell = "rect" | "circle" | "polygon";
export type FeatureAlong = "u" | "v";
export type FeatureFit = "inside" | "centre";
export type FeatureAlign = "centre" | "left";

/** The panel's choices, which are not number fields. `face` is the picked face a saved step reopens on. */
export interface FeatureChoices {
  shape: FeatureShape;
  from: FeatureFrom;
  pattern: FeaturePattern;
  cell: FeatureCell;
  along: FeatureAlong;
  op: "fuse" | "cut";
  fit: FeatureFit;
  stagger: boolean;
  align: FeatureAlign;
  text: string;
  face?: number;
}

export const FEATURE_CHOICE_DEFAULTS: FeatureChoices = {
  shape: "rect",
  from: "centre",
  pattern: "lines",
  cell: "rect",
  along: "u",
  op: "fuse",
  fit: "inside",
  stagger: false,
  align: "centre",
  text: "A",
};

/** Number fields a fresh tool starts from. Shared ids keep the last typed value when the tool changes. */
export const FEATURE_FIELD_DEFAULTS: Record<string, number> = {
  modelFeatW: 10,
  modelFeatH: 10,
  modelFeatDia: 10,
  modelFeatDepth: 2,
  modelFeatU: 0,
  modelFeatV: 0,
  modelFeatBarsV: 0,
  modelFeatBarsH: 0,
  modelFeatBarW: 1,
  modelTexPitchU: 5,
  modelTexPitchV: 5,
  modelTexGroove: 0.8,
  modelArrW: 4,
  modelArrH: 3,
  modelArrDia: 4,
  modelArrSides: 6,
  modelArrAcross: 4,
  modelArrTurn: 0,
  modelArrPitchU: 6,
  modelArrPitchV: 5,
  modelArrAngle: 0,
  modelArrMargin: 0,
  modelRibWidth: 1.2,
  modelRibPitch: 4,
  modelRibCount: 0,
  modelRibAngle: 0,
  modelRibMargin: 0,
  modelTextHeight: 6,
  modelTextStroke: 0.9,
  modelTextSpace: 2,
  modelTextAngle: 0,
};

/** The choices the panel is showing. `tool` picks which Raise/Cut group is read; text has its own. */
export function panelChoices(tool?: FeatureTool): FeatureChoices {
  const pressed = (id: string, attr: string) => document.querySelector<HTMLElement>(`#${id} [aria-pressed="true"]`)?.dataset[attr];
  const shape = pressed("modelFeatShape", "shape");
  const from = pressed("modelFeatFrom", "from");
  const pattern = pressed("modelTexPattern", "pattern");
  const cell = pressed("modelArrCell", "cell");
  const along = pressed("modelRibAlong", "along");
  const fit = pressed("modelArrFit", "fit");
  const align = pressed("modelTextAlign", "align");
  const op = pressed(tool === "text" ? "modelTextOp" : "modelFeatOp", "op");
  return {
    shape: shape === "circle" || shape === "arch" ? shape : "rect",
    from: from === "corner" || from === "bottom" || from === "top" ? from : "centre",
    pattern: pattern === "grid" || pattern === "brick" || pattern === "shingle" ? pattern : "lines",
    cell: cell === "circle" || cell === "polygon" ? cell : "rect",
    along: along === "v" ? "v" : "u",
    op: op === "cut" ? "cut" : "fuse",
    fit: fit === "centre" ? "centre" : "inside",
    stagger: document.querySelector<HTMLInputElement>("#modelArrStagger")?.checked ?? false,
    align: align === "left" ? "left" : "centre",
    text: document.querySelector<HTMLInputElement>("#modelFeatText")?.value ?? FEATURE_CHOICE_DEFAULTS.text,
  };
}

function numOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mm(value: unknown): string {
  const n = Math.round(numOf(value, 0) * 100) / 100;
  return String(n);
}

/**
 * The spec `expand` takes, from the panel's numbers and choices. A count of 0, a centre anchor, and a default op are
 * left out, so the stored source matches what the expander defaults to.
 */
export function readFeatureSpec(tool: FeatureTool, read: (id: string) => number, choices: FeatureChoices, faceIndex: number): Record<string, unknown> {
  const spec: Record<string, unknown> = { kind: tool, faceIndex };
  if (choices.from !== "centre") spec.from = choices.from;
  if (tool === "pocket" || tool === "boss") {
    spec.shape = choices.shape;
    spec.depth = read("modelFeatDepth");
    spec.at = { u: read("modelFeatU"), v: read("modelFeatV") };
    if (choices.shape === "circle") spec.diameter = read("modelFeatDia");
    else {
      spec.width = read("modelFeatW");
      spec.height = read("modelFeatH");
    }
    if (tool === "pocket") {
      const vertical = Math.round(read("modelFeatBarsV"));
      const horizontal = Math.round(read("modelFeatBarsH"));
      if (vertical > 0 || horizontal > 0) spec.bars = { vertical, horizontal, width: read("modelFeatBarW") };
    }
    return spec;
  }
  if (tool === "texture") {
    if (choices.pattern !== "lines") spec.pattern = choices.pattern;
    spec.pitch = [read("modelTexPitchU"), read("modelTexPitchV")];
    spec.grooveWidth = read("modelTexGroove");
    spec.depth = read("modelFeatDepth");
    return spec;
  }
  if (tool === "array") {
    const cell: Record<string, unknown> = { shape: choices.cell };
    if (choices.cell === "circle") cell.diameter = read("modelArrDia");
    else if (choices.cell === "polygon") {
      cell.sides = Math.round(read("modelArrSides"));
      cell.across = read("modelArrAcross");
      const turn = read("modelArrTurn");
      if (turn !== 0) cell.turnDeg = turn;
    } else {
      cell.width = read("modelArrW");
      cell.height = read("modelArrH");
    }
    spec.cell = cell;
    spec.pitch = [read("modelArrPitchU"), read("modelArrPitchV")];
    if (choices.stagger) spec.stagger = true;
    if (choices.fit !== "inside") spec.fit = choices.fit;
    const angle = read("modelArrAngle");
    if (angle !== 0) spec.angleDeg = angle;
    const margin = read("modelArrMargin");
    if (margin !== 0) spec.margin = margin;
    spec.depth = read("modelFeatDepth");
    if (choices.op !== "fuse") spec.op = choices.op;
    return spec;
  }
  if (tool === "ribs") {
    if (choices.along !== "u") spec.along = choices.along;
    spec.width = read("modelRibWidth");
    const count = Math.round(read("modelRibCount"));
    if (count >= 1) spec.count = count;
    else spec.pitch = read("modelRibPitch");
    const angle = read("modelRibAngle");
    if (angle !== 0) spec.angleDeg = angle;
    const margin = read("modelRibMargin");
    if (margin !== 0) spec.margin = margin;
    spec.depth = read("modelFeatDepth");
    if (choices.op !== "fuse") spec.op = choices.op;
    return spec;
  }
  spec.text = choices.text;
  spec.height = read("modelTextHeight");
  spec.strokeWidth = read("modelTextStroke");
  spec.spacing = read("modelTextSpace");
  if (choices.align !== "centre") spec.align = choices.align;
  const angle = read("modelTextAngle");
  if (angle !== 0) spec.angleDeg = angle;
  spec.depth = read("modelFeatDepth");
  spec.at = { u: read("modelFeatU"), v: read("modelFeatV") };
  if (choices.op !== "fuse") spec.op = choices.op;
  return spec;
}

/** The history row: "Pocket 10 × 10, 2 bars". */
export function featureLabel(spec: Record<string, unknown>): string {
  const kind = spec.kind;
  const name = isFeatureTool(kind) ? FEATURE_NAMES[kind] : "Feature";
  if (kind === "pocket" || kind === "boss") {
    const shape = spec.shape === "circle" || spec.shape === "arch" ? spec.shape : "rect";
    const size = shape === "circle" ? `⌀${mm(spec.diameter)}` : `${mm(spec.width)} × ${mm(spec.height)}`;
    const bars = spec.bars as { vertical?: unknown; horizontal?: unknown } | undefined;
    const count = Math.round(numOf(bars?.vertical, 0)) + Math.round(numOf(bars?.horizontal, 0));
    const arch = shape === "arch" ? " arch" : "";
    return count > 0 ? `${name}${arch} ${size}, ${count} bar${count === 1 ? "" : "s"}` : `${name}${arch} ${size}`;
  }
  if (kind === "texture") {
    const pattern = spec.pattern === "grid" || spec.pattern === "brick" || spec.pattern === "shingle" ? spec.pattern : "lines";
    return `${name} ${pattern}`;
  }
  if (kind === "array") {
    const cell = (spec.cell ?? {}) as Record<string, unknown>;
    const shape = cell.shape === "circle" || cell.shape === "polygon" ? cell.shape : "rect";
    const size = shape === "circle" ? `⌀${mm(cell.diameter)}` : shape === "polygon" ? `${mm(cell.sides)}-gon` : `${mm(cell.width)} × ${mm(cell.height)}`;
    return `${name} ${size}`;
  }
  if (kind === "ribs") {
    const count = Math.round(numOf(spec.count, 0));
    return count >= 1 ? `${name} × ${count}` : `${name} ${mm(spec.pitch)} apart`;
  }
  const text = typeof spec.text === "string" && spec.text.trim() ? spec.text.trim() : "";
  const shown = [...text].slice(0, 24).join("");
  return shown ? `${name} ${shown}` : name;
}

/** One group: the label, the spec that was typed, and each piece as a boolean. */
export function groupFromPieces(label: string, source: Record<string, unknown>, pieces: Piece[]): GroupOp {
  return {
    kind: "group",
    label,
    source,
    steps: pieces.map((piece) => ({ kind: "boolean", op: piece.op, ...piece.spec })),
  };
}

/** A group's composite, when it is one of these tools. Pattern and mirror reopen from their own source (A4). */
export function featureSource(op: ModelOp): Record<string, unknown> | null {
  if (op.kind !== "group" || !op.source || typeof op.source !== "object") return null;
  const source = op.source as Record<string, unknown>;
  return isFeatureTool(source.kind) ? source : null;
}

/** The panel an edited feature group reopens with. */
export function featurePanel(source: Record<string, unknown>): { tool: FeatureTool; fields: Record<string, number>; feature: FeatureChoices } {
  const tool: FeatureTool = isFeatureTool(source.kind) ? source.kind : "pocket";
  const at = (source.at ?? {}) as { u?: unknown; v?: unknown };
  const bars = (source.bars ?? {}) as { vertical?: unknown; horizontal?: unknown; width?: unknown };
  const cell = (source.cell ?? {}) as Record<string, unknown>;
  const pitch = Array.isArray(source.pitch) ? source.pitch : [];
  const height = numOf(source.height, FEATURE_FIELD_DEFAULTS.modelTextHeight!);
  const shape = source.shape === "circle" || source.shape === "arch" ? source.shape : "rect";
  const cellShape = cell.shape === "circle" || cell.shape === "polygon" ? cell.shape : "rect";
  const fields: Record<string, number> = {};
  const put = (id: string, value: unknown, fallback: number) => {
    fields[id] = numOf(value, fallback);
  };
  if (tool === "pocket" || tool === "boss") {
    put("modelFeatW", source.width, 10);
    put("modelFeatH", source.height, 10);
    put("modelFeatDia", source.diameter, 10);
    put("modelFeatDepth", source.depth, 2);
    put("modelFeatU", at.u, 0);
    put("modelFeatV", at.v, 0);
    if (tool === "pocket") {
      put("modelFeatBarsV", bars.vertical, 0);
      put("modelFeatBarsH", bars.horizontal, 0);
      put("modelFeatBarW", bars.width, 1);
    }
  } else if (tool === "texture") {
    put("modelTexPitchU", pitch[0], 5);
    put("modelTexPitchV", pitch[1], 5);
    put("modelTexGroove", source.grooveWidth, 0.8);
    put("modelFeatDepth", source.depth, 0.6);
  } else if (tool === "array") {
    put("modelArrW", cell.width, 4);
    put("modelArrH", cell.height, 3);
    put("modelArrDia", cell.diameter, 4);
    put("modelArrSides", cell.sides, 6);
    put("modelArrAcross", cell.across, 4);
    put("modelArrTurn", cell.turnDeg, 0);
    put("modelArrPitchU", pitch[0], 6);
    put("modelArrPitchV", pitch[1], 5);
    put("modelArrAngle", source.angleDeg, 0);
    put("modelArrMargin", source.margin, 0);
    put("modelFeatDepth", source.depth, 1);
  } else if (tool === "ribs") {
    put("modelRibWidth", source.width, 1.2);
    put("modelRibPitch", source.pitch, 4);
    put("modelRibCount", source.count, 0);
    put("modelRibAngle", source.angleDeg, 0);
    put("modelRibMargin", source.margin, 0);
    put("modelFeatDepth", source.depth, 2);
  } else {
    put("modelTextHeight", source.height, 6);
    put("modelTextStroke", source.strokeWidth, height * 0.15);
    put("modelTextSpace", source.spacing, height / 3);
    put("modelTextAngle", source.angleDeg, 0);
    put("modelFeatDepth", source.depth, 1);
    put("modelFeatU", at.u, 0);
    put("modelFeatV", at.v, 0);
  }
  const from = source.from === "corner" || source.from === "bottom" || source.from === "top" ? source.from : "centre";
  const pattern = source.pattern === "grid" || source.pattern === "brick" || source.pattern === "shingle" ? source.pattern : "lines";
  const feature: FeatureChoices = {
    shape,
    from,
    pattern,
    cell: cellShape,
    along: source.along === "v" ? "v" : "u",
    op: source.op === "cut" ? "cut" : "fuse",
    fit: source.fit === "centre" ? "centre" : "inside",
    stagger: source.stagger === true,
    align: source.align === "left" ? "left" : "centre",
    text: typeof source.text === "string" ? source.text : "A",
    ...(typeof source.faceIndex === "number" ? { face: source.faceIndex } : {}),
  };
  return { tool, fields, feature };
}

export interface FeatureSolid {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
  faces: readonly { areaMm2: number; normal?: readonly [number, number, number] | readonly number[] }[];
}

/** The same deps the session passes, so the two contexts select and stand the same way. */
function featureDeps() {
  return {
    matchFaces: (faces: readonly FrameFace[], input: Record<string, unknown>) => facesMatching(faces as readonly FaceRow[], input),
    stand: (positions: ArrayLike<number>, frame: Workplane, depth: number, overlap: number) => standRegion(positions as Float32Array, frame, depth, overlap),
    closeCracks,
  };
}

/**
 * The app's ExpandContext for one solid. Missing normals are recovered from the mesh, then the shared builder runs,
 * which is what the session calls with the faces it already stored.
 */
export function featureExpandContext(solid: FeatureSolid, plane: Workplane) {
  const faces = solid.faces.map((face, index) => {
    const recovered = face.normal ?? outwardFromMesh(solid.positions, solid.triangles, index);
    return { areaMm2: face.areaMm2, ...(recovered ? { normal: [recovered[0]!, recovered[1]!, recovered[2]!] as [number, number, number] } : {}) };
  });
  const rows = faceRows(solid.positions, solid.triangles, faces);
  return expandContextFromSolid({ positions: solid.positions, triangles: solid.triangles, faces: rows as FrameFace[] }, plane, featureDeps());
}

/** The mesh in model space, so a posed part expands where it is drawn and `toSolidOp` stores the steps in the solid's frame. */
export function featureSolidInModel(solid: FeatureSolid, pose: Affine): FeatureSolid {
  if (isIdentity(pose)) return solid;
  const positions = new Float32Array(solid.positions.length);
  for (let i = 0; i + 2 < solid.positions.length; i += 3) {
    const at = applyPose(pose, [solid.positions[i]!, solid.positions[i + 1]!, solid.positions[i + 2]!]);
    positions[i] = at[0];
    positions[i + 1] = at[1];
    positions[i + 2] = at[2];
  }
  const faces = solid.faces.map((face, index) => {
    const normal = face.normal ? turnDir(pose, face.normal) : outwardFromMesh(positions, solid.triangles, index);
    return { areaMm2: face.areaMm2, ...(normal ? { normal } : {}) };
  });
  return { positions, triangles: solid.triangles, faces };
}

export interface ExpandedFeature {
  note: string | null;
  pieces: Piece[] | null;
  group: GroupOp | null;
  frame: Workplane | null;
  outward: [number, number, number] | null;
}

export function emptyFeature(note: string): ExpandedFeature {
  return { note, pieces: null, group: null, frame: null, outward: null };
}

function trimmed(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * The first shown number field of `tool` whose value (`read`, which also evaluates an expression) is outside its
 * `min` or `max`, as a sentence; null when all are in range. A typed value is not clamped: the user sees why.
 */
export function rangeNote(tool: FeatureTool, read: (id: string) => number): string | null {
  if (typeof document === "undefined") return null;
  // A field that takes an expression is a text input, so the range is read from its attributes.
  for (const input of document.querySelectorAll<HTMLInputElement>("#modelPanel label[data-for] input:is([min], [max])")) {
    const label = input.closest<HTMLElement>("label");
    if (!input.id || !label || label.closest("[hidden]") || !(label.dataset.for ?? "").split(" ").includes(tool)) continue;
    const value = read(input.id);
    const name = input.getAttribute("aria-label")?.split(",")[0] ?? input.id;
    const min = Number(input.getAttribute("min") ?? NaN);
    const max = Number(input.getAttribute("max") ?? NaN);
    if (Number.isFinite(min) && value < min) return `${name} is at least ${trimmed(min)}.`;
    if (Number.isFinite(max) && value > max) return `${name} is at most ${trimmed(max)}.`;
  }
  return null;
}

/** A plain boolean, for a nested pattern. Feature tools do not call it. */
function toPart(op: Record<string, unknown>): Piece | { reason: string } {
  const made = primitiveFrom(op);
  if ("reason" in made) return made;
  const which = op.op === "cut" || op.op === "common" ? op.op : "fuse";
  return { op: which, spec: planePrimitive(made, GLOBAL_WORKPLANE) };
}

/**
 * Expand `spec` on `solid` at `pose`. `faceIndex` null, or a curved face, is the panel's "Pick one flat face."
 * Other refusals keep the expander's own sentence.
 */
export function expandFeature(spec: Record<string, unknown>, solid: FeatureSolid | null, pose: Affine, faceIndex: number | null): ExpandedFeature {
  if (!solid || faceIndex == null || faceIndex < 0 || faceIndex >= solid.faces.length) return emptyFeature(PICK_ONE_FLAT_FACE);
  const posed = featureSolidInModel(solid, pose);
  const ctx = featureExpandContext(posed, GLOBAL_WORKPLANE);
  const face = ctx.face(faceIndex);
  if ("reason" in face) return emptyFeature(PICK_ONE_FLAT_FACE);
  const typed = { ...spec, faceIndex };
  const pieces = expand(typed, ctx, toPart);
  if ("reason" in pieces) return emptyFeature(pieces.reason);
  const label = featureLabel(typed);
  const outward = axesOf(face.plane)[2];
  return { note: null, pieces, group: groupFromPieces(label, typed, pieces), frame: face.plane, outward };
}
