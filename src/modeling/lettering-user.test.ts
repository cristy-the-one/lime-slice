// Text in a font of the person's (docs/plan-text-on-curves-and-fonts.md, milestone 4): the typed op names the font by id, a
// variable font takes a weight, the step and its weight survive the file, and the card writes and reopens both.
import { expand, type ExpandContext, type Piece } from "./compose.ts";
import { setUserFontLookup, type UserFontView } from "./text-fonts.ts";
import { featureExpandContext, featurePanel, groupFromPieces, readFeatureSpec, type FeatureChoices } from "../model-features.ts";
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

const ID = "user:0123456789abcdef";
const VARIABLE = "user:fedcba9876543210";
const views: Record<string, UserFontView> = {
  [ID]: { id: ID, name: "Fake Sans Regular", family: "Fake Sans", bold: false, italic: false, weight: null, restricted: false, pack: false },
  [VARIABLE]: { id: VARIABLE, name: "Fake Variable", family: "Fake Variable", bold: false, italic: false, weight: { min: 300, default: 400, max: 800 }, restricted: true, pack: false },
};
setUserFontLookup((id) => views[id]);

// --- A font of the person's is named by its id, and the step stores it so.
const own = one(text({ font: ID, style: "italic" })).step as unknown as LetteringOp;
eq("the step names the font by id", [own.kind, own.font, own.style], ["lettering", ID, "italic"]);
check("a bold the file may lack is the engine's to refuse, not the expansion's", !("reason" in expand(text({ font: ID, style: "bold" }), ctx, nothing)));
const weighted = one(text({ font: VARIABLE, weight: 650 })).step as unknown as LetteringOp;
eq("a weight is written to the step", weighted.weight, 650);
eq("and only when given", "weight" in (own as object), false);
eq("a weight outside 100 to 900", refusal(text({ font: VARIABLE, weight: 1200 })), "weight is a number from 100 to 900.");
eq("a weight that is not a number", refusal(text({ font: VARIABLE, weight: "heavy" })), "weight is a number from 100 to 900.");
eq("a font name that is neither bundled nor an id is still refused here", refusal(text({ font: "Avenir Next" })), "There is no font called ‘Avenir Next’. The fonts are stroke, sans, mono, serif, stencil.");

// --- The step and its weight survive the file.
const typed = text({ font: VARIABLE, weight: 650, style: "italic" });
const pieces = expand(typed, ctx, nothing);
const group: GroupOp = groupFromPieces("Text LIME", typed, "reason" in pieces ? [] : pieces);
const solid = { primitive: "box" as const, origin: [0, 0, 0] as [number, number, number], size: [40, 20, 10] as [number, number, number], radius: 0, height: 0, turn: [0, 0, 0] as [number, number, number] };
const block = newTree("block", { kind: "primitive", solid }, "Box", null);
const lettered = withChild(block, 0, { id: 1, op: group, label: opLabel(group), fingerprint: { volumeMm3: 8050, faces: 90, edges: 280 } });
const file = JSON.parse(JSON.stringify({ ...savedTree(lettered, lettered.committed, () => undefined), rootPrimitive: solid })) as { nodes: { id: number; op?: { steps?: Record<string, unknown>[] } }[] };
const reopened = loadedTree(file as never, "block#1", lettered.root, "Box", null, () => undefined);
eq("a saved group keeps the font id and the weight", (reopened.nodes.get(1)?.op as GroupOp).steps, group.steps);
const garbled = JSON.parse(JSON.stringify(file)) as typeof file;
garbled.nodes.find((node) => node.id === 1)!.op!.steps![0]!.weight = "heavy";
check("a weight the file garbled drops the tree, as any garbled step does", readSavedTree(file) !== null && readSavedTree(garbled) === null);

// --- The card: a variable font writes the weight and only its italic as a style; a plain one writes its style as ever.
const choices: FeatureChoices = { shape: "rect", from: "centre", pattern: "lines", cell: "rect", along: "u", op: "fuse", fit: "inside", stagger: false, align: "centre", text: "Hi", font: VARIABLE, style: "bold" };
const read = (id: string) => ({ modelTextHeight: 6, modelTextTrack: 0, modelTextLines: 1.3, modelTextAngle: 0, modelFeatDepth: 1, modelFeatU: 0, modelFeatV: 0, modelTextWeight: 520 })[id] ?? 0;
eq("a variable font writes its weight, and its bold is the weight", readFeatureSpec("text", read, choices, 1), { kind: "text", faceIndex: 1, text: "Hi", height: 6, font: VARIABLE, weight: 520, depth: 1, at: { u: 0, v: 0 } });
eq("an italic stays a style", readFeatureSpec("text", read, { ...choices, style: "bold-italic" }, 1).style, "italic");
const plainSpec = readFeatureSpec("text", read, { ...choices, font: ID }, 1);
eq("a font with no weight axis writes its style and no weight", [plainSpec.font, plainSpec.style, plainSpec.weight], [ID, "bold", undefined]);
const panel = featurePanel({ kind: "text", text: "Hi", height: 8, depth: 1, faceIndex: 2, font: VARIABLE, weight: 650 });
eq("a saved step reopens in its font at its weight", [panel.feature.font, panel.fields.modelTextWeight], [VARIABLE, 650]);
eq("with no weight saved the axis default is shown", featurePanel({ kind: "text", text: "Hi", height: 8, depth: 1, faceIndex: 2, font: VARIABLE }).fields.modelTextWeight, 400);

if (failed > 0) {
  console.error(`${failed} lettering (own fonts) checks failed`);
  process.exit(1);
}
console.log("lettering: a font of the person's is one step with its weight, in the file and the card ok");
