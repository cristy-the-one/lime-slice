// A feature typed in the panel expands into the same pieces as the same feature typed over MCP.
import { expand } from "./modeling/compose.ts";
import { expandContextFromSolid, levelFrame, type FrameFace } from "./modeling/frames.ts";
import { facesMatching } from "../mcp/selectors.ts";
import { standRegion } from "../mcp/plane-region.ts";
import { faceRows, type FaceRow } from "../mcp/solid-geometry.ts";
import { closeCracks } from "./mesh-check.ts";
import { facePlane } from "./model-plane.ts";
import { editPanel } from "./model-edit.ts";
import { IDENTITY_POSE } from "./model-space.ts";
import { GLOBAL_WORKPLANE } from "./workplane.ts";
import {
  expandFeature,
  featureExpandContext,
  featureLabel,
  featurePanel,
  groupFromPieces,
  piecesOutlineOnly,
  readFeatureSpec,
  type FeatureChoices,
} from "./model-features.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

/** A 20 × 20 × 10 box. Face 1 is the top. */
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
  const faces = quads.map((_, index) => ({ areaMm2: index < 2 ? 400 : 200, normal: normals[index]! }));
  return { positions, triangles, faces };
}

const choices: FeatureChoices = {
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
const read = (id: string) => ({ modelFeatW: 10, modelFeatH: 10, modelFeatDepth: 2, modelFeatU: 0, modelFeatV: 0, modelFeatBarsV: 2, modelFeatBarsH: 0, modelFeatBarW: 1 })[id] ?? 0;
const spec = readFeatureSpec("pocket", read, choices, 1);
const solid = boxSolid();
const deps = {
  matchFaces: (faces: readonly FrameFace[], input: Record<string, unknown>) => facesMatching(faces as readonly FaceRow[], input),
  stand: (positions: ArrayLike<number>, frame: Parameters<typeof standRegion>[1], depth: number, overlap: number) => standRegion(positions as Float32Array, frame, depth, overlap),
  closeCracks,
};
const rows = faceRows(solid.positions, solid.triangles, solid.faces);
const appPieces = expand(spec, featureExpandContext(solid, GLOBAL_WORKPLANE), () => ({ reason: "unused" }));
const mcpPieces = expand(spec, expandContextFromSolid({ positions: solid.positions, triangles: solid.triangles, faces: rows as FrameFace[] }, GLOBAL_WORKPLANE, deps), () => ({ reason: "unused" }));

check("the app context and the MCP context expand a barred pocket into the same pieces", !("reason" in appPieces) && JSON.stringify(appPieces) === JSON.stringify(mcpPieces));
check("a barred pocket is one cut and two bars", !("reason" in appPieces) && appPieces.length === 3 && appPieces[0]!.op === "cut" && appPieces[1]!.op === "fuse" && appPieces[2]!.op === "fuse");
eq("the history row names the pocket and its bars", featureLabel(spec), "Pocket 10 × 10, 2 bars");

const flat = facePlane(solid.positions, solid.triangles, 1, [0, 0, 1]);
const framed = featureExpandContext(solid, GLOBAL_WORKPLANE).face(1);
check("the face frame is the level frame of the face plane", !!flat && !("reason" in framed) && JSON.stringify(framed.plane) === JSON.stringify(levelFrame(flat!)));

const expanded = expandFeature(spec, solid, IDENTITY_POSE, 1);
check("expandFeature on the same solid agrees", !!expanded.pieces && JSON.stringify(expanded.pieces) === JSON.stringify(appPieces));
eq("no face yet says to pick one", expandFeature(spec, solid, IDENTITY_POSE, null).note, "Pick one flat face.");
check("two faces is not one face", expandFeature(spec, solid, IDENTITY_POSE, null).group == null);

if (expanded.group) {
  const panel = editPanel(expanded.group, IDENTITY_POSE, [10, 10, 5]);
  eq("editing the group reopens Pocket", panel.tool, "pocket");
  eq("the width comes back", panel.fields.modelFeatW, 10);
  eq("the face comes back", panel.feature?.face, 1);
  eq("the bars come back", panel.fields.modelFeatBarsV, 2);
}
let threw = false;
try {
  editPanel({ kind: "group", label: "Edges", steps: [] }, IDENTITY_POSE, [0, 0, 0]);
} catch {
  threw = true;
}
check("a group that is not a feature still has no panel", threw);

const round = featurePanel({ kind: "text", text: "Hi", height: 8, depth: 1, faceIndex: 2 });
eq("an omitted stroke opens at height × 0.15", round.fields.modelTextStroke, 1.2);
eq("text reopens on its face", round.feature.face, 2);

eq("a ghost past 2000 pieces is outlines only", piecesOutlineOnly(2001), true);
eq("a pocket's ghost is shaded", piecesOutlineOnly(3), false);

const group = expanded.group ?? groupFromPieces("Pocket", spec, []);
check("the group keeps the spec that was typed", (group.source as { kind?: string }).kind === "pocket" && group.steps.length === 3);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model-features: pocket matches, panel reopens, ghost cap ok");
