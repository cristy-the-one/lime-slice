// Text on a cylinder or a cone (docs/plan-text-on-curves-and-fonts.md, milestone 2) expands to one lettering step anchored on the
// face: at the face's middle across from its seam, or at the point given; round the part or up it, flipped or not. A sphere, a torus
// or a freeform face (milestone 3) takes the same, starting along its own U or V, wrapped or projected. The stroke font is turned
// away in a sentence.
import { expand, type ExpandContext } from "./compose.ts";
import { roundMiddle, type FramedSolid } from "./frames.ts";
import { expandFeature, featureExpandContext, featurePanel, groupFromPieces, PICK_ONE_FACE, readFeatureSpec, type FeatureChoices } from "../model-features.ts";
import { toSolidOp, type Affine } from "../model-space.ts";
import type { GroupOp, LetteringOp } from "../model-tree.ts";
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

/**
 * A cylinder R 20, z 0 to 40, about the Z axis, with 48 columns of triangles on its wall and its seam at +X: face 0 the wall (a
 * cylinder, its normal at the middle -X), face 1 the top, face 2 a sphere's patch, face 3 a freeform patch, face 4 a flat patch.
 */
function cylinderSolid() {
  const positions: number[] = [];
  const triangles: number[] = [];
  const sides = 48;
  for (let k = 0; k < sides; k += 1) {
    const a = (k / sides) * Math.PI * 2;
    const b = ((k + 1) / sides) * Math.PI * 2;
    const p = (angle: number, z: number): [number, number, number] => [20 * Math.cos(angle), 20 * Math.sin(angle), z];
    // Counter-clockwise from outside.
    for (const tri of [[p(a, 0), p(b, 0), p(b, 40)], [p(a, 0), p(b, 40), p(a, 40)]] as const) {
      for (const point of tri) positions.push(...point);
      triangles.push(0);
    }
  }
  for (const point of [[0, 0, 40], [5, 0, 40], [0, 5, 40]]) positions.push(...point);
  triangles.push(1);
  for (const point of [[30, 0, 0], [31, 0, 0], [30, 1, 1]]) positions.push(...point);
  triangles.push(2);
  for (const point of [[40, 0, 0], [41, 0, 0], [40, 1, 1], [40, 1, 1], [41, 0, 0], [41, 1, 3]]) positions.push(...point);
  triangles.push(3, 3);
  for (const point of [[50, 0, 0], [51, 0, 0], [50, 1, 0]]) positions.push(...point);
  triangles.push(4);
  const faces = [
    { areaMm2: 5026, normal: [-1, 0, 0], surface: "cylinder" as const, radiusMm: 20, axis: [0, 0, 1], axisPoint: [0, 0, 0] },
    { areaMm2: 1256, normal: [0, 0, 1] },
    { areaMm2: 100, normal: [1, 0, 0], surface: "sphere" as const, radiusMm: 30 },
    { areaMm2: 100 },
    { areaMm2: 0.5, normal: [0, 0, 1] },
  ];
  return { positions, triangles, faces };
}
const solid = cylinderSolid();
const ctx: ExpandContext = featureExpandContext(solid, GLOBAL_WORKPLANE);
const nothing = () => ({ reason: "unused" });
const text = (extra: Record<string, unknown>) => ({ kind: "text", faceIndex: 0, text: "LIME 42", font: "sans", height: 6, depth: 0.8, ...extra });

function step(spec: Record<string, unknown>): LetteringOp {
  const pieces = expand(spec, ctx, nothing);
  if ("reason" in pieces) throw new Error(pieces.reason);
  return pieces[0]!.step as unknown as LetteringOp;
}
function refusal(spec: Record<string, unknown>): string {
  const pieces = expand(spec, ctx, nothing);
  return "reason" in pieces ? pieces.reason : `${pieces.length} pieces`;
}

// --- What a face is for lettering.
const kinds = [0, 1, 2, 3, 4].map((index) => ctx.round?.(index));
check("the wall is a cylinder", kinds[0] !== null && kinds[0] !== undefined && !("reason" in kinds[0]) && kinds[0].surface === "cylinder", kinds[0]);
eq("a flat face is not round", kinds[1], null);
check("a sphere takes text", kinds[2] !== null && kinds[2] !== undefined && !("reason" in kinds[2]) && kinds[2].surface === "sphere", kinds[2]);
check("so does a freeform or torus face (other)", kinds[3] !== null && kinds[3] !== undefined && !("reason" in kinds[3]) && kinds[3].surface === "other", kinds[3]);
eq("a flat patch is flat", kinds[4], null);

// --- The middle: across from the seam (-X), halfway up, on the wall.
const middle = (kinds[0] as { point: [number, number, number] }).point;
check("the middle is across from the seam", Math.hypot(middle[0] + 20, middle[1]) < 1.5 && Math.abs(middle[2] - 20) < 7, middle);
check("and on the wall's mesh, within its chord", Math.abs(Math.hypot(middle[0], middle[1]) - 20) < 0.2, middle);
const faceRow = { index: 0, areaMm2: 5026, centre: [0, 0, 20], normal: solid.faces[0]!.normal, kind: "cylinder", axis: [0, 0, 1], axisPoint: [0, 0, 0] };
const framed: FramedSolid = { positions: solid.positions, triangles: solid.triangles, faces: [faceRow] };
const direct = roundMiddle(framed, 0, faceRow);
check("roundMiddle agrees", direct !== null && direct.every((v, i) => Math.abs(v - middle[i]!) < 1e-6), direct);
// With no normal it still lands on the wall.
const blind = roundMiddle(framed, 0, { ...faceRow, normal: undefined });
check("with no normal the point is still on the wall", blind !== null && Math.abs(Math.hypot(blind[0], blind[1]) - 20) < 0.2, blind);

// --- One lettering step, anchored there.
const made = step(text({}));
eq("the lettering step", made, { kind: "lettering", op: "fuse", origin: middle.map((v) => Math.round(v * 1e6) / 1e6), turn: [0, 0, 0], text: "LIME 42", font: "sans@4.0", height: 6, depth: 0.8 });
const given = step(text({ point: [-20, 0, 12.5], op: "cut", style: "bold", along: "axis", flip: true, angleDeg: 10, align: "left", spacing: 0.4, lineSpacing: 1.5 }));
eq("a point, along the axis, flipped, engraved", given, {
  kind: "lettering", op: "cut", origin: [-20, 0, 12.5], turn: [0, 0, 0], text: "LIME 42", font: "sans@4.0", style: "bold", height: 6, depth: 0.8,
  spacing: 0.4, lineSpacing: 1.5, align: "left", angleDeg: 10, along: "axis", flip: true,
});
eq("around is the default and is not stored", step(text({ along: "around", flip: false })).along, undefined);

// --- A sphere, a torus or a freeform face: the baseline starts along U or V; wrap is the default and project is stored.
const onSphere = step(text({ faceIndex: 2, point: [30, 0.2, 0.2], along: "v", wrap: "project", flip: true, angleDeg: 15 }));
eq("a sphere: along v, projected, flipped, turned", onSphere, {
  kind: "lettering", op: "fuse", origin: [30, 0.2, 0.2], turn: [0, 0, 0], text: "LIME 42", font: "sans@4.0", height: 6, depth: 0.8, angleDeg: 15, along: "v", flip: true, wrap: "project",
});
const onFree = step(text({ faceIndex: 3, point: [40, 1, 1], along: "u", wrap: "wrap" }));
eq("u and wrap are the defaults and are not stored", [onFree.along, onFree.wrap], [undefined, undefined]);
eq("a sphere refuses around", refusal(text({ faceIndex: 2, along: "around" })), "along is u or v on this face. U runs the baseline along the face's U, v along its V.");
eq("a cylinder refuses u", refusal(text({ along: "u" })), "along is around or axis. Around reads round the part; axis runs it up the part.");
eq("a wrap that is not one", refusal(text({ faceIndex: 2, wrap: "squash" })), "wrap is wrap or project. Wrap keeps the letters' size on the surface; project pushes them onto it along the face's normal.");
eq("project is not for a cylinder", refusal(text({ wrap: "project" })), "Project is for a sphere, a torus or a freeform face; a cylinder and a cone wrap at true size.");
// --- Milestone 5: the pen fonts go on every face, as one lettering step.
eq("the stroke font goes on a freeform face too", [step(text({ faceIndex: 3, font: "stroke", point: [40, 1, 1] })).font, step(text({ faceIndex: 3, font: "line", point: [40, 1, 1] })).font], ["stroke@1", "line@1"]);
eq("a pen's width and gap are on the step", [step(text({ font: "stroke", strokeWidth: 0.8, spacing: 0 })).strokeWidth, step(text({ font: "stroke", strokeWidth: 0.8, spacing: 0 })).spacing], [0.8, 0]);
eq("a pen font takes no style", refusal(text({ font: "line", style: "bold" })).includes("one style"), true);

// --- Refusals are sentences.
eq("no font on a curved face is the stroke font as a pen", step(text({ font: undefined })).font, "stroke@1");
eq("a font that is not one", refusal(text({ font: "comic" })), "There is no font called ‘comic’. The fonts are stroke, line, sans, mono, serif, stencil.");
eq("a direction that is not one", refusal(text({ along: "sideways" })), "along is around or axis. Around reads round the part; axis runs it up the part.");
eq("a point that is not a point", refusal(text({ point: [1, 2] })), "point is [x, y, z]: a point on the face.");
eq("a bold the font lacks", refusal(text({ font: "stencil", style: "bold" })), "Allerta Stencil has no bold. Pick Regular, or another font.");
eq("no depth", refusal(text({ depth: 0 })), "Text needs a height (the capitals') and a depth, in millimetres.");
eq("too much text", refusal(text({ text: "A".repeat(401) })), "Text takes at most 400 characters a step; use several.");
eq("no text", refusal(text({ text: " " })), "Text needs text.");
// A flat face of the same part still takes a flat text.
const flat = expand({ kind: "text", faceIndex: 1, text: "TOP", font: "sans", height: 4, depth: 0.5 }, ctx, nothing);
check("the top is flat lettering with a frame", !("reason" in flat) && (flat[0]!.step as unknown as LetteringOp).turn.length === 3 && JSON.stringify((flat[0]!.step as unknown as LetteringOp).origin) !== JSON.stringify(middle));

// --- The card: one face, the preview's step, and a saved step reopens with its direction and its point.
const choices: FeatureChoices = {
  shape: "rect", from: "centre", pattern: "lines", cell: "rect", along: "u", op: "fuse", fit: "inside", stagger: false, align: "centre", text: "LIME 42", font: "sans@4.0", style: "bold", way: "axis", flip: true,
};
const read = (id: string) => ({ modelTextHeight: 6, modelTextTrack: 0, modelTextLines: 1.3, modelTextAngle: 0, modelFeatDepth: 0.8, modelFeatU: 0, modelFeatV: 0 })[id] ?? 0;
const spec = readFeatureSpec("text", read, choices, 0);
check("the card writes no direction itself: the app adds it for a round face", spec.along === undefined && spec.flip === undefined, spec);
const expanded = expandFeature({ ...spec, along: "axis", flip: true, point: [-20, 0, 15] }, solid, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } as Affine, 0);
check("a round face expands with no flat frame", expanded.note === null && expanded.frame === null && expanded.outward === null && expanded.pieces === null, expanded.note);
eq("and its letters are the step", expanded.letters?.origin, [-20, 0, 15]);
eq("it knows it is a cylinder, and where", expanded.round, { surface: "cylinder", point: [-20, 0, 15] });
eq("the group is one lettering step", expanded.group?.steps.map((s) => s.kind), ["lettering"]);
const sphere = expandFeature(spec, solid, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } as Affine, 2);
check("a sphere expands to one step like a cylinder", sphere.note === null && sphere.letters !== null && sphere.round?.surface === "sphere", sphere.note);
const nothingPicked = expandFeature(spec, solid, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } as Affine, null);
eq("with no face, text says to pick one face", nothingPicked.note, PICK_ONE_FACE);
const pocketNothing = expandFeature({ ...spec, kind: "pocket" }, solid, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } as Affine, null);
eq("a pocket still says flat", pocketNothing.note, "Pick one flat face.");
const reopened = featurePanel(expanded.group!.source as Record<string, unknown>);
eq("a saved step reopens with its direction, its flip and its point", [reopened.feature.way, reopened.feature.flip, reopened.feature.point], ["axis", true, [-20, 0, 15]]);

// --- A part posed in model space stores the step in its own frame: the anchor goes through the pose.
const pose: Affine = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [30, 5, 0] };
const stored = toSolidOp(groupFromPieces("Text", { kind: "text" }, expand(text({ point: [-20, 0, 12.5], along: "axis", flip: true }), ctx, nothing) as never) as GroupOp, pose) as GroupOp;
const placed = stored.steps[0] as LetteringOp;
check("the anchor goes through the pose and the direction stays", JSON.stringify(placed.origin) !== JSON.stringify([-20, 0, 12.5]) && placed.along === "axis" && placed.flip === true, placed);

if (failed) {
  console.error(`${failed} lettering-round check(s) failed`);
  process.exit(1);
}
console.log("lettering-round: ok");
