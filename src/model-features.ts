/**
 * Composite feature tools: Pocket, Boss, Texture, Array, Ribs, and Text.
 * Each one expands through the shared modelling module into a group of boolean steps, the same pieces the MCP builds
 * for the same solid and the same spec. The panel, the ghost, and the drag handles live with the other Model tools.
 */
import { facesMatching } from "./modeling/selectors.ts";
import { standRegion } from "../mcp/plane-region.ts";
import { faceRows, type FaceRow } from "./modeling/solid-geometry.ts";
import { closeCracks } from "./mesh-check.ts";
import { outwardFromMesh } from "./model-blend.ts";
import { anchorOf, expand, type Piece, type RoundSurface } from "./modeling/compose.ts";
import { DEFAULT_TEXT_FONT, DEFAULT_TEXT_STYLE, fontById, isOutlineFont, isPenFont, isUserFont, penFontOf, STROKE_FONT, styleOf, userFontView, versionedId, type TextStyle } from "./modeling/text-fonts.ts";
import { expandContextFromSolid, type FrameFace } from "./modeling/frames.ts";
import { applyPose, isIdentity, turnDir, type Affine } from "./model-space.ts";
import type { GroupOp, LetteringOp, ModelOp } from "./model-tree.ts";
import { planePoint, axesOf, GLOBAL_WORKPLANE, type Workplane } from "./workplane.ts";

/** One toolbar entry; the menu chooses which of these is on the button. */
export const FEATURE_TOOLS = ["pocket", "boss", "texture", "array", "ribs", "text"] as const;
export type FeatureTool = (typeof FEATURE_TOOLS)[number];

/** Shown when the selection is not exactly one flat face. */
export const PICK_ONE_FLAT_FACE = "Pick one flat face.";
/** Text also goes on a cylinder or a cone. */
export const PICK_ONE_FACE = "Pick one face.";

export function isFeatureTool(tool: unknown): tool is FeatureTool {
  return typeof tool === "string" && (FEATURE_TOOLS as readonly string[]).includes(tool);
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
export type FeatureAlign = "centre" | "left" | "right";

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
  /** The text's font: `stroke` (the single-stroke grid font) or a bundled outline font with its version (`sans@4.0`). */
  font: string;
  /** The outline font's style. The stroke font has one. */
  style: TextStyle;
  /** --- Text on a cylinder or a cone: the baseline runs `around` the part (default) or up its `axis`; `flip` turns it half way. */
  way: "around" | "axis";
  /** --- Text on a sphere, a torus or a freeform face: the baseline starts along the face's `u` (default) or `v`. */
  dir?: "u" | "v";
  /** The same, projected onto the surface along its normal instead of wrapped at true size. */
  project?: boolean;
  flip: boolean;
  face?: number;
  /** A saved text on a cylinder or a cone reopens with the point it sits on. */
  point?: [number, number, number];
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
  // --- Text with real fonts (D4): a new text starts in Sans Bold. A step saved before fonts reopens as `stroke`.
  font: versionedId(fontById(DEFAULT_TEXT_FONT)!),
  style: DEFAULT_TEXT_STYLE,
  way: "around",
  dir: "u",
  project: false,
  flip: false,
};

/** Number fields a fresh tool starts from. Shared ids keep the last typed value when the tool changes. */
export const FEATURE_FIELD_DEFAULTS: Record<string, number> = {
  modelFeatW: 10,
  modelFeatH: 10,
  modelFeatR: 0,
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
  modelTextTrack: 0,
  modelTextLines: 1.3,
  modelTextWeight: 400,
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
  const font = pressed("modelTextFont", "font");
  const style = pressed("modelTextStyle", "style");
  const way = pressed("modelTextWay", "way");
  const dir = pressed("modelTextDir", "dir");
  const wrap = pressed("modelTextWrap", "wrap");
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
    align: align === "left" || align === "right" ? align : "centre",
    text: document.querySelector<HTMLInputElement | HTMLTextAreaElement>("#modelFeatText")?.value ?? FEATURE_CHOICE_DEFAULTS.text,
    font: isPenFont(font) || fontById(font) || isUserFont(font) ? font! : FEATURE_CHOICE_DEFAULTS.font,
    style: style ? styleOf(style) : FEATURE_CHOICE_DEFAULTS.style,
    way: way === "axis" ? "axis" : "around",
    dir: dir === "v" ? "v" : "u",
    project: wrap === "project",
    flip: document.querySelector<HTMLInputElement>("#modelTextFlip")?.checked ?? false,
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
      const corner = read("modelFeatR");
      if (choices.shape === "rect" && corner > 0) spec.cornerRadius = corner;
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
  if (isOutlineFont(choices.font)) {
    // --- Text with real fonts. Spacing is after each letter (0 is the font's own), lines are capital heights apart (1.3).
    spec.font = choices.font;
    // --- Text milestone 4: a variable font takes its weight from the slider, so only its italic is a style.
    const variable = userFontView(choices.font)?.weight;
    if (variable) {
      spec.weight = read("modelTextWeight");
      if (choices.style === "italic" || choices.style === "bold-italic") spec.style = "italic";
    } else if (choices.style !== "regular") spec.style = choices.style;
    const track = read("modelTextTrack");
    if (track !== 0) spec.spacing = track;
    const lines = read("modelTextLines");
    if (lines !== FEATURE_FIELD_DEFAULTS.modelTextLines) spec.lineSpacing = lines;
    if (choices.align !== "centre") spec.align = choices.align;
  } else {
    // --- Text milestone 5: Stroke and Line are pen fonts, one lettering step like any font. Their spacing is the whole gap after a
    // letter (a third of the height as typed since text began), the pen's width is the Stroke field.
    spec.font = penFontOf(choices.font)?.id ?? STROKE_FONT;
    spec.strokeWidth = read("modelTextStroke");
    spec.spacing = read("modelTextSpace");
    const lines = read("modelTextLines");
    if (lines !== FEATURE_FIELD_DEFAULTS.modelTextLines) spec.lineSpacing = lines;
    if (choices.align !== "centre") spec.align = choices.align;
  }
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
    const corner = shape === "rect" && numOf(spec.cornerRadius, 0) > 0 ? ` r ${mm(spec.cornerRadius)}` : "";
    return count > 0 ? `${name}${arch} ${size}${corner}, ${count} bar${count === 1 ? "" : "s"}` : `${name}${arch} ${size}${corner}`;
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
    steps: pieces.map((piece) => (piece.step ? (piece.step as unknown as ModelOp) : { kind: "boolean", op: piece.op, ...piece.spec, ...(piece.merge ? { merge: true as const } : {}) })),
  };
}

/** A group's composite, when it is one of these tools. Pattern and mirror reopen from their own source (A4). */
export function featureSource(op: ModelOp): Record<string, unknown> | null {
  if (op.kind !== "group" || !op.source || typeof op.source !== "object") return null;
  const source = op.source as Record<string, unknown>;
  return isFeatureTool(source.kind) ? source : null;
}

/**
 * --- D28. What an edit keeps from the step it edits that the panel has no field for: a texture's, an array's or ribs'
 * `region` box, which the MCP may type. Empty when there is none.
 */
export function keptFeatureFields(source: Record<string, unknown> | null, tool: FeatureTool): Record<string, unknown> {
  if (!source || source.kind !== tool || (tool !== "texture" && tool !== "array" && tool !== "ribs")) return {};
  const region = source.region as { u?: unknown; v?: unknown } | undefined;
  const pair = (value: unknown) => Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n));
  return region && pair(region.u) && pair(region.v) ? { region: { u: [...(region.u as number[])], v: [...(region.v as number[])] } } : {};
}

/** The panel an edited feature group reopens with. */
export function featurePanel(source: Record<string, unknown>): { tool: FeatureTool; fields: Record<string, number>; feature: FeatureChoices } {
  const tool: FeatureTool = isFeatureTool(source.kind) ? source.kind : "pocket";
  const at = (source.at ?? {}) as { u?: unknown; v?: unknown };
  const bars = (source.bars ?? {}) as { vertical?: unknown; horizontal?: unknown; width?: unknown };
  const cell = (source.cell ?? {}) as Record<string, unknown>;
  // --- D28. The MCP may store one pitch for both directions.
  const pitch = Array.isArray(source.pitch) ? source.pitch : typeof source.pitch === "number" ? [source.pitch, source.pitch] : [];
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
    put("modelFeatR", source.cornerRadius, 0);
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
    // The stroke font's spacing defaults to a third of the height; an outline font's is added to the font's own, 0.
    put("modelTextSpace", isOutlineFont(source.font) ? undefined : source.spacing, height / 3);
    put("modelTextTrack", isOutlineFont(source.font) ? source.spacing : undefined, 0);
    put("modelTextLines", source.lineSpacing, 1.3);
    put("modelTextWeight", source.weight, userFontView(source.font)?.weight?.default ?? 400);
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
    align: source.align === "left" || source.align === "right" ? source.align : "centre",
    text: typeof source.text === "string" ? source.text : "A",
    // A text step saved before fonts has none: it opens as Stroke (milestone 5: pressing Update makes it a one-step pen text).
    font: isOutlineFont(source.font) ? (fontById(source.font) ? versionedId(fontById(source.font)!) : String(source.font)) : penFontOf(source.font)?.id ?? STROKE_FONT,
    style: styleOf(source.style),
    way: source.along === "axis" ? "axis" : "around",
    dir: source.along === "v" ? "v" : "u",
    project: source.wrap === "project",
    flip: source.flip === true,
    ...(Array.isArray(source.point) && source.point.length === 3 && source.point.every((n) => typeof n === "number") ? { point: [source.point[0], source.point[1], source.point[2]] as [number, number, number] } : {}),
    ...(typeof source.faceIndex === "number" ? { face: source.faceIndex } : {}),
  };
  return { tool, fields, feature };
}

export interface FeatureSolid {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
  faces: readonly {
    areaMm2: number;
    normal?: readonly [number, number, number] | readonly number[];
    /** --- Text on a cylinder or a cone: what the engine says the face is, with its axis. */
    surface?: "cylinder" | "cone" | "sphere";
    radiusMm?: number;
    axis?: readonly number[];
    axisPoint?: readonly number[];
  }[];
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
    return {
      areaMm2: face.areaMm2,
      ...(recovered ? { normal: [recovered[0]!, recovered[1]!, recovered[2]!] as [number, number, number] } : {}),
      ...(face.surface ? { surface: face.surface } : {}),
      ...(face.radiusMm !== undefined ? { radiusMm: face.radiusMm } : {}),
      ...(face.axis ? { axis: [face.axis[0]!, face.axis[1]!, face.axis[2]!] as [number, number, number] } : {}),
      ...(face.axisPoint ? { axisPoint: [face.axisPoint[0]!, face.axisPoint[1]!, face.axisPoint[2]!] as [number, number, number] } : {}),
    };
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
    return {
      areaMm2: face.areaMm2,
      ...(normal ? { normal } : {}),
      ...(face.surface ? { surface: face.surface } : {}),
      ...(face.radiusMm !== undefined ? { radiusMm: face.radiusMm } : {}),
      ...(face.axis ? { axis: turnDir(pose, face.axis) } : {}),
      ...(face.axisPoint ? { axisPoint: applyPose(pose, [face.axisPoint[0]!, face.axisPoint[1]!, face.axisPoint[2]!]) } : {}),
    };
  });
  return { positions, triangles: solid.triangles, faces };
}

export interface ExpandedFeature {
  note: string | null;
  pieces: Piece[] | null;
  group: GroupOp | null;
  /** The face's workplane, with U, V = 0 where the spec's `at` is measured from (its From anchor). */
  frame: Workplane | null;
  outward: [number, number, number] | null;
  /**
   * --- Text with real fonts. The lettering step of a text in an outline font, in model space, which the card draws as its
   * live preview instead of boxes (`pieces` is null then). Null for every other feature.
   */
  letters: LetteringOp | null;
  /** --- Text on a cylinder or a cone: the surface and the point the text sits on, or null on a flat face. */
  round: { surface: RoundSurface; point: [number, number, number] } | null;
}

export function emptyFeature(note: string): ExpandedFeature {
  return { note, pieces: null, group: null, frame: null, outward: null, letters: null, round: null };
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
  // An array, as the MCP's DOM types have no NodeList iterator.
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("#modelPanel label[data-for] input:is([min], [max])"))) {
    const label = input.closest("label");
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

/** A feature tool expands no nested op, so `expand` never asks for a plain part here. */
function noNestedPart(): { reason: string } {
  return { reason: "A feature has no nested op." };
}

/**
 * --- D36. The context of the last solid and pose, with each face's frame read once: a drag that moves only `at`
 * reads the whole mesh once, not on every move. A new solid or pose builds it again.
 */
let contextMemo: { solid: FeatureSolid; pose: string; ctx: ReturnType<typeof featureExpandContext> } | null = null;

/** The plate went: the kept mesh copy goes with it. */
export function forgetFeatureContext() {
  contextMemo = null;
}

/** The expand context of `solid` at `pose` in model space, kept for the next call with the same solid and pose. */
export function posedContext(solid: FeatureSolid, pose: Affine): ReturnType<typeof featureExpandContext> {
  const key = JSON.stringify(pose);
  if (contextMemo?.solid === solid && contextMemo.pose === key) return contextMemo.ctx;
  const built = featureExpandContext(featureSolidInModel(solid, pose), GLOBAL_WORKPLANE);
  const frames = new Map<string, ReturnType<typeof built.face>>();
  const ctx: typeof built = {
    ...built,
    face: (index, coplanar = false) => {
      const name = `${index}|${coplanar}`;
      let frame = frames.get(name);
      if (!frame) {
        frame = built.face(index, coplanar);
        frames.set(name, frame);
      }
      return frame;
    },
  };
  contextMemo = { solid, pose: key, ctx };
  return ctx;
}

/**
 * Expand `spec` on `solid` at `pose`. `faceIndex` null, or a curved face, is the panel's "Pick one flat face."
 * Other refusals keep the expander's own sentence.
 */
export function expandFeature(spec: Record<string, unknown>, solid: FeatureSolid | null, pose: Affine, faceIndex: number | null): ExpandedFeature {
  const text = spec.kind === "text";
  if (!solid || faceIndex == null || faceIndex < 0 || faceIndex >= solid.faces.length) return emptyFeature(text ? PICK_ONE_FACE : PICK_ONE_FLAT_FACE);
  const ctx = posedContext(solid, pose);
  // --- Text on a cylinder or a cone: one lettering step anchored at a point on the face, with no frame for a position dot.
  const round = text ? ctx.round?.(faceIndex) : null;
  if (round) {
    if ("reason" in round) return emptyFeature(round.reason);
    const typed = { ...spec, faceIndex };
    const pieces = expand(typed, ctx, noNestedPart);
    if ("reason" in pieces) return emptyFeature(pieces.reason);
    const letters = pieces.length === 1 && pieces[0]!.step ? (pieces[0]!.step as unknown as LetteringOp) : null;
    return { note: null, pieces: null, group: groupFromPieces(featureLabel(typed), typed, pieces), frame: null, outward: null, letters, round: { surface: round.surface, point: letters ? [...letters.origin] as [number, number, number] : round.point } };
  }
  const face = ctx.face(faceIndex);
  if ("reason" in face) return emptyFeature(text ? PICK_ONE_FACE : PICK_ONE_FLAT_FACE);
  const typed = { ...spec, faceIndex };
  const pieces = expand(typed, ctx, noNestedPart);
  if ("reason" in pieces) return emptyFeature(pieces.reason);
  const label = featureLabel(typed);
  const outward = axesOf(face.plane)[2];
  // --- D16. The position dot and its drag measure `at` from where From puts U, V = 0, as the expansion does.
  const shift = spec.from === undefined ? null : anchorOf(spec.from, face.extent);
  const frame = shift && !("reason" in shift) ? { ...face.plane, origin: planePoint(face.plane, [shift[0], shift[1], 0]) } : face.plane;
  // --- Text with real fonts: one lettering step, drawn as outlines, not as the boxes of a piece.
  const lettering = pieces.length === 1 && pieces[0]!.step ? (pieces[0]!.step as unknown as LetteringOp) : null;
  return { note: null, pieces: lettering ? null : pieces, group: groupFromPieces(label, typed, pieces), frame, outward, letters: lettering, round: null };
}
