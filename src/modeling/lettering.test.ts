// Text in a bundled outline font (docs/plan-text-on-curves-and-fonts.md, milestone 1) expands to one lettering step, in the
// part's frame; a text with no font, or the stroke font, still expands to the boxes it always did.
import { expand, type ExpandContext, type Piece } from "./compose.ts";
import { fontById, isOutlineFont, STROKE_FONT, TEXT_FONTS, versionedId } from "./text-fonts.ts";
import { textStrokes } from "./text.ts";
import { featureExpandContext, featureLabel, featurePanel, groupFromPieces, readFeatureSpec, type FeatureChoices } from "../model-features.ts";
import { fromSolidOp, toSolidOp, type Affine } from "../model-space.ts";
import type { GroupOp, LetteringOp } from "../model-tree.ts";
import { loadedTree, readSavedTree, savedTree } from "../model-tree-file.ts";
import { newTree, opLabel, withChild } from "../model-tree.ts";
import { GLOBAL_WORKPLANE } from "../workplane.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : `\n  ${JSON.stringify(detail)}`}`);
}
function eq(name: string, got: unknown, want: unknown) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

/** A 20 × 20 × 10 box from the origin. Face 1 is the top, facing +Z. */
function boxSolid() {
  const c = (x: number, y: number, z: number): [number, number, number] => [x * 20, y * 20, z * 10];
  const quads: [number, number, number][][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const normals: [number, number, number][] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((quad, face) => {
    for (const tri of [[0, 1, 2], [0, 2, 3]] as const) {
      for (const i of tri) positions.push(...quad[i]!);
      triangles.push(face);
    }
  });
  return { positions, triangles, faces: quads.map((_, index) => ({ areaMm2: index < 2 ? 400 : 200, normal: normals[index]! })) };
}
const ctx: ExpandContext = featureExpandContext(boxSolid(), GLOBAL_WORKPLANE);
const nothing = () => ({ reason: "unused" });
const text = (extra: Record<string, unknown>) => ({ kind: "text", faceIndex: 1, text: "LIME", height: 6, depth: 1, ...extra });

function one(spec: Record<string, unknown>): Piece {
  const pieces = expand(spec, ctx, nothing);
  if ("reason" in pieces) throw new Error(pieces.reason);
  if (pieces.length !== 1) throw new Error(`${pieces.length} pieces`);
  return pieces[0]!;
}
function refusal(spec: Record<string, unknown>): string {
  const pieces = expand(spec, ctx, nothing);
  return "reason" in pieces ? pieces.reason : `${pieces.length} pieces`;
}

// --- The bundled fonts as the picker and the guide read them.
eq("the bundled fonts", TEXT_FONTS.map(versionedId), ["sans@4.0", "mono@1", "serif@1", "stencil@1"]);
check("an id names a font with or without its version", fontById("sans")?.name === "Inter" && fontById("sans@4.0")?.name === "Inter" && fontById("sans@9") === undefined && fontById("comic") === undefined);
check("only a named font is an outline font", isOutlineFont("sans") && !isOutlineFont(undefined) && !isOutlineFont("") && !isOutlineFont(STROKE_FONT));

// --- A text in a font is one step, on the face, in the part's frame.
const step = one(text({ font: "sans", style: "bold", align: "left", spacing: 0.5, lineSpacing: 1.6, angleDeg: 15, op: "cut", at: { u: 2, v: -1 } })).step as unknown as LetteringOp;
eq("the lettering step", step, {
  kind: "lettering",
  op: "cut",
  origin: [12, 9, 10],
  turn: [0, 0, 0],
  text: "LIME",
  font: "sans@4.0",
  style: "bold",
  height: 6,
  depth: 1,
  spacing: 0.5,
  lineSpacing: 1.6,
  align: "left",
  angleDeg: 15,
});
const plain = one(text({ font: "mono" })).step as unknown as LetteringOp;
eq("a plain text keeps only what it was given", Object.keys(plain).sort(), ["depth", "font", "height", "kind", "op", "origin", "text", "turn"]);
eq("it raises by default, from the face's middle", [plain.op, plain.origin], ["fuse", [10, 10, 10]]);
check("the piece's own box is a placeholder, never built", one(text({ font: "sans" })).step !== undefined);
const lines = one(text({ font: "serif", text: "ONE\nTWO" })).step as unknown as LetteringOp;
eq("a new line stays in the text", lines.text, "ONE\nTWO");

// --- One group, one step, with the typed spec kept so Edit reopens the card.
const typed = text({ font: "sans", style: "bold" });
const pieces = expand(typed, ctx, nothing);
const group: GroupOp = groupFromPieces(featureLabel(typed), typed, "reason" in pieces ? [] : pieces);
eq("the row names the text", group.label, "Text LIME");
eq("the group is one lettering step", group.steps.map((s) => s.kind), ["lettering"]);
eq("the typed spec is its source", (group.source as { font?: string }).font, "sans");

// --- A part posed in model space stores the step in its own frame, and the card reads it back.
const pose: Affine = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [30, 5, 0] };
const stored = toSolidOp(group, pose) as GroupOp;
const placed = stored.steps[0] as LetteringOp;
check("the step's plane goes through the pose", JSON.stringify(placed.origin) !== JSON.stringify([10, 10, 10]) && placed.text === "LIME" && placed.font === "sans@4.0");
const back = fromSolidOp(stored, pose) as GroupOp;
const there = (back.steps[0] as LetteringOp).origin;
check("and comes back to model space", there.every((v, i) => Math.abs(v - [10, 10, 10][i]!) < 1e-9), there);
eq("the angle in the face does not move with the pose", placed.angleDeg, undefined);

// --- The step survives the file: a project saved with a text in a font opens with the same group, and a step the file
// garbled is not taken for one.
const solid = { primitive: "box" as const, origin: [0, 0, 0] as [number, number, number], size: [40, 20, 10] as [number, number, number], radius: 0, height: 0, turn: [0, 0, 0] as [number, number, number] };
const block = newTree("block", { kind: "primitive", solid }, "Box", null);
const lettered = withChild(block, 0, { id: 1, op: group, label: opLabel(group), fingerprint: { volumeMm3: 8050, faces: 90, edges: 280 } });
const file = JSON.parse(JSON.stringify({ ...savedTree(lettered, lettered.committed, () => undefined), rootPrimitive: solid })) as { nodes: { id: number; op?: { steps?: Record<string, unknown>[] } }[] };
const reopened = loadedTree(file as never, "block#1", lettered.root, "Box", null, () => undefined);
eq("a saved text group opens as it was", reopened.nodes.get(1)?.op, group);
eq("its row still names the text", reopened.nodes.get(1) ? opLabel(reopened.nodes.get(1)!.op!) : null, "Text LIME");
const garbled = JSON.parse(JSON.stringify(file)) as typeof file;
garbled.nodes.find((node) => node.id === 1)!.op!.steps![0]!.depth = "deep";
check("a file with its lettering step intact reads", readSavedTree(file) !== null);
check("a garbled lettering step drops the tree, as any other garbled step does", readSavedTree(garbled) === null);

// --- Refusals are sentences.
eq("an unknown font", refusal(text({ font: "comic" })), "There is no font called ‘comic’. The fonts are stroke, line, sans, mono, serif, stencil.");
eq("a bold the family lacks", refusal(text({ font: "stencil", style: "bold" })), "Allerta Stencil has no bold. Pick Regular, or another font.");
check("an italic the family lacks is slanted, not refused", !refusal(text({ font: "mono", style: "italic" })).includes("no italic"));
eq("too much text", refusal(text({ font: "sans", text: "A".repeat(401) })), "Text takes at most 400 characters a step; use several.");
eq("the stroke font keeps its limit", refusal({ ...text({ text: "A".repeat(81) }) }), "Text takes at most 80 characters a step; use several.");
eq("no text", refusal(text({ font: "sans", text: "  " })), "Text needs text.");
eq("a depth of 0", refusal(text({ font: "sans", depth: 0 })), "Text needs a height (the capitals') and a depth, in millimetres.");
eq("an align that is not one", refusal(text({ font: "sans", align: "middle" })), "align is left, centre, or right.");
check("a pattern of lettering is refused, not half built", refusal({ kind: "pattern", op: text({ font: "sans" }), linear: { step: [5, 0, 0], count: 2 } }).includes("not supported yet"));

// --- No font: the boxes it always built. The stroke font by name is a pen font, one lettering step (milestone 5).
const strokes = textStrokes("LIME", 6, 0.9, undefined, "centre");
const boxes = expand(text({}), ctx, nothing);
check("a text with no font is a box a stroke", !("reason" in boxes) && Array.isArray(strokes) && boxes.length === strokes.length && boxes.every((p) => p.step === undefined && p.spec.primitive === "box"));
const stroked = expand(text({ font: STROKE_FONT }), ctx, nothing);
check("the stroke font by name is one lettering step, as a pen font", !("reason" in stroked) && stroked.length === 1 && stroked[0]!.step?.font === "stroke@1" && stroked[0]!.step?.kind === "lettering");
const lined = expand(text({ font: "line", strokeWidth: 0.7, spacing: 0, text: "Lime" }), ctx, nothing);
check("Line keeps its pen width and a zero gap", !("reason" in lined) && lined[0]!.step?.font === "line@1" && lined[0]!.step?.strokeWidth === 0.7 && lined[0]!.step?.spacing === 0);
check("a pen font has no bold", refusal(text({ font: "stroke", style: "bold" })).includes("one style"));
eq("a pen's width is at most half the height", refusal(text({ font: "stroke", strokeWidth: 4 })), "strokeWidth is above 0 and at most half the height.");
check("a text of 80 characters still expands", !("reason" in expand(text({ text: "I".repeat(40) }), ctx, nothing)));

// --- The card: what it writes, and what a saved step reopens as.
const choices: FeatureChoices = { shape: "rect", from: "centre", pattern: "lines", cell: "rect", along: "u", op: "fuse", fit: "inside", stagger: false, align: "centre", text: "Hi", font: "sans@4.0", style: "bold", way: "around", flip: false };
const read = (id: string) => ({ modelTextHeight: 6, modelTextTrack: 0, modelTextLines: 1.3, modelTextAngle: 0, modelFeatDepth: 1, modelFeatU: 0, modelFeatV: 0, modelTextStroke: 0.9, modelTextSpace: 2 })[id] ?? 0;
const outline = readFeatureSpec("text", read, choices, 1);
eq("an outline font writes its font and style, and no stroke fields", outline, { kind: "text", faceIndex: 1, text: "Hi", height: 6, font: "sans@4.0", style: "bold", depth: 1, at: { u: 0, v: 0 } });
const stroke = readFeatureSpec("text", read, { ...choices, font: STROKE_FONT, align: "right" }, 1);
eq("the stroke font writes its pen: font, width, the gap, the alignment", stroke, { kind: "text", faceIndex: 1, text: "Hi", height: 6, font: "stroke", strokeWidth: 0.9, spacing: 2, align: "right", depth: 1, at: { u: 0, v: 0 } });
const spaced = readFeatureSpec("text", (id) => (id === "modelTextTrack" ? 0.4 : id === "modelTextLines" ? 1.6 : read(id)), { ...choices, align: "right", style: "regular" }, 1);
eq("letter spacing, line spacing and align are written when they are not the default", [spaced.spacing, spaced.lineSpacing, spaced.align, spaced.style], [0.4, 1.6, "right", undefined]);

const old = featurePanel({ kind: "text", text: "Hi", height: 8, depth: 1, faceIndex: 2, spacing: 2.6 });
eq("a text saved before fonts reopens as the stroke font", [old.feature.font, old.fields.modelTextSpace, old.fields.modelTextTrack], [STROKE_FONT, 2.6, 0]);
const fresh = featurePanel({ kind: "text", text: "Hi", height: 8, depth: 1, faceIndex: 2, font: "mono@1", style: "italic", spacing: 0.4, lineSpacing: 1.5, align: "right" });
eq("a text in a font reopens in it", [fresh.feature.font, fresh.feature.style, fresh.feature.align, fresh.fields.modelTextTrack, fresh.fields.modelTextLines], ["mono@1", "italic", "right", 0.4, 1.5]);

if (failed > 0) {
  console.error(`${failed} lettering checks failed`);
  process.exit(1);
}
console.log("lettering: one step per text, the old stroke font unchanged ok");
