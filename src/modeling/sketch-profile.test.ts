/**
 * --- Split to print, milestone 10: a sketched cut's chain. Reading it, the refusals (a chain that does not cross the
 * section, one that crosses itself, one that leaves a wall under the floor), Joint down's flat, and the chain to and from
 * the sketch the sketcher edits.
 */
import { CHAIN_MISSES, CHAIN_NEEDED, CROSSES_ITSELF, ONE_CHAIN, chainFromSketch, chainPoints, chainRefusal, chainSummary, crossesItself, longestLine, readChain, sketchFromChain, thinnestWall, type Chain, type ProfileSlice } from "./sketch-profile.ts";
import type { SketchData } from "../sketch/model.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);

/** A step up 6 mm at U = −5, a half circle of radius 5 on the upper flat, then on past the side. */
const stepAndArc: Chain = {
  start: [-40, 0],
  chain: [
    { kind: "line", to: [-5, 0] },
    { kind: "line", to: [-5, 6] },
    { kind: "arc", through: [0, 11], to: [5, 6] },
    { kind: "line", to: [40, 6] },
  ],
};
/** The 60 mm wide section of a bar 500 mm long along W, cut in the middle: its span along U and its slice across the cut. */
const span = { u0: -30, u1: 30 };
const slice: ProfileSlice = { outer: [[-30, -250], [30, -250], [30, 250], [-30, 250]] };
const FLOOR = 0.8;

// --- Reading what a client sends.
eq("a chain reads as it was typed", readChain(stepAndArc), stepAndArc);
eq("a sketch with no chain says to draw it", readChain({}), { reason: CHAIN_NEEDED });
eq("a start that is not a point", readChain({ start: [1], chain: [] }), { reason: "A sketch profile needs start, [u, w] in millimetres from the cut's origin." });
eq("an empty chain", readChain({ start: [0, 0], chain: [] }), { reason: "A sketch profile needs chain, a list of lines and arcs." });
eq("an arc needs its through point", readChain({ start: [0, 0], chain: [{ kind: "arc", to: [1, 0] }] }), { reason: "An arc of a sketch profile has through: [u, w]." });
eq("a spline is not taken", readChain({ start: [0, 0], chain: [{ kind: "spline", to: [1, 0] }] }), { reason: "A sketch profile is lines and arcs." });
eq("a segment with no kind is a line", readChain({ start: [0, 0], chain: [{ to: [1, 2] }] }), { start: [0, 0], chain: [{ kind: "line", to: [1, 2] }] });

// --- The polyline: the arc's points lie on its circle, and it ends where the chain does.
const points = chainPoints(stepAndArc);
const onArc = points.filter((p) => p[0] > -5 && p[0] < 5);
check("the arc's points are 5 mm from its centre (0, 6) and above the flat", onArc.length > 4 && onArc.every((p) => Math.abs(Math.hypot(p[0], p[1] - 6) - 5) < 1e-9 && p[1] > 6), JSON.stringify(onArc.slice(0, 3)));
eq("the polyline ends at the chain's end", points.at(-1), [40, 6]);

// --- Refusals, each with its sentence.
eq("the step and the arc cross the section and leave no thin wall", chainRefusal(stepAndArc, span, slice, FLOOR), null);
check("a chain that turns back over itself crosses itself", crossesItself(chainPoints({ start: [-40, 0], chain: [{ kind: "line", to: [5, 0] }, { kind: "line", to: [5, 8] }, { kind: "line", to: [-5, 8] }, { kind: "line", to: [-5, -8] }, { kind: "line", to: [40, -8] }] })));
eq("and is refused with the plan's sentence", chainRefusal({ start: [-40, 0], chain: [{ kind: "line", to: [5, 0] }, { kind: "line", to: [5, 8] }, { kind: "line", to: [-5, 8] }, { kind: "line", to: [-5, -8] }, { kind: "line", to: [40, -8] }] }, span, slice, FLOOR), CROSSES_ITSELF);
eq("a chain that stops inside the section does not cross it", chainRefusal({ start: [-40, 0], chain: [{ kind: "line", to: [10, 0] }] }, span, slice, FLOOR), CHAIN_MISSES);
eq("one that starts inside it neither", chainRefusal({ start: [-20, 0], chain: [{ kind: "line", to: [40, 0] }] }, span, slice, FLOOR), CHAIN_MISSES);
eq("drawn from right to left it crosses as well", chainRefusal({ start: [40, 3], chain: [{ kind: "line", to: [-40, 3] }] }, span, slice, FLOOR), null);
const narrowTooth: Chain = { start: [-40, 0], chain: [{ kind: "line", to: [-0.25, 0] }, { kind: "line", to: [-0.25, 5] }, { kind: "line", to: [0.25, 5] }, { kind: "line", to: [0.25, 0] }, { kind: "line", to: [40, 0] }] };
eq("a tooth 0.5 mm wide and 5 mm tall leaves a wall under the floor", chainRefusal(narrowTooth, span, slice, FLOOR), "The sketch leaves a wall 0.5 mm thick, under the 0.8 mm wall floor. Move the chain away from the edge, or widen the feature.");
eq("a tooth 2 mm wide does not", chainRefusal({ start: [-40, 0], chain: [{ kind: "line", to: [-1, 0] }, { kind: "line", to: [-1, 5] }, { kind: "line", to: [1, 5] }, { kind: "line", to: [1, 0] }, { kind: "line", to: [40, 0] }] }, span, slice, FLOOR), null);
const besideTheSide: Chain = { start: [-40, 0], chain: [{ kind: "line", to: [-29.6, 0] }, { kind: "line", to: [-29.6, 20] }, { kind: "line", to: [40, 20] }] };
const wall = thinnestWall(besideTheSide, FLOOR, slice);
check("a run 0.4 mm inside the part's side leaves a 0.4 mm wall", wall !== null && Math.abs(wall - 0.4) < 1e-9, String(wall));
eq("so it is refused", chainRefusal(besideTheSide, span, slice, FLOOR), "The sketch leaves a wall 0.4 mm thick, under the 0.8 mm wall floor. Move the chain away from the edge, or widen the feature.");
eq("a chain that crosses the side square to it leaves no thin wall at the crossing", thinnestWall({ start: [-40, 3], chain: [{ kind: "line", to: [40, 3] }] }, FLOOR, slice), null);
eq("a narrow tooth outside the part is not the part's wall", thinnestWall({ start: [-40, 0], chain: [{ kind: "line", to: [-35.25, 0] }, { kind: "line", to: [-35.25, 5] }, { kind: "line", to: [-34.75, 5] }, { kind: "line", to: [-34.75, 0] }, { kind: "line", to: [40, 0] }] }, FLOOR, slice), null);

// --- Joint down's flat: the longest straight segment.
eq("the longest straight segment, the first of two of 35 mm", longestLine(stepAndArc), { from: [-40, 0], to: [-5, 0] });
eq("a longer run past the arc wins", longestLine({ ...stepAndArc, chain: [...stepAndArc.chain.slice(0, 3), { kind: "line", to: [45, 6] }] }), { from: [5, 6], to: [45, 6] });
eq("an arc alone has none", longestLine({ start: [-40, 0], chain: [{ kind: "arc", through: [0, 20], to: [40, 0] }] }), null);
eq("the card names the segments", chainSummary(stepAndArc), "3 lines and 1 arc");

// --- The chain and the sketch. The sketch's plane is the cut's, so its points are the chain's numbers.
const plane = { origin: [250, 30, 10] as [number, number, number], turn: [90, 0, 90] as [number, number, number] };
const drawn = sketchFromChain(stepAndArc, plane);
eq("a chain becomes a sketch of four entities between five points, on the cut's plane", [drawn.points.length, drawn.entities.map((entity) => entity.kind), drawn.plane], [5, ["line", "line", "arc", "line"], plane]);
eq("and the sketch gives the chain back", chainFromSketch(drawn), stepAndArc);
const backwards: SketchData = { ...drawn, entities: [...drawn.entities].reverse().map((entity) => (entity.kind === "line" || entity.kind === "arc" ? { ...entity, a: entity.b, b: entity.a } : entity)) };
eq("drawn the other way round it starts from its lower U all the same", chainFromSketch(backwards), stepAndArc);
const dimensioned: SketchData = { ...drawn, dims: [{ id: 1, kind: "distance", a: 2, b: 3, value: 6, text: "step" }] };
eq("dimensions and constraints stay on the sketch, not in the chain", chainFromSketch(dimensioned), stepAndArc);
const withConstruction: SketchData = { ...drawn, points: [...drawn.points, { id: 9, at: [0, -30] }, { id: 10, at: [0, 30] }], entities: [...drawn.entities, { id: 9, kind: "line", a: 9, b: 10, construction: true }] };
eq("a construction line is not part of the chain", chainFromSketch(withConstruction), stepAndArc);
eq("a circle is not a chain", chainFromSketch({ ...drawn, entities: [...drawn.entities, { id: 9, kind: "circle", centre: 1, radius: 2 }] }), { reason: ONE_CHAIN });
eq("two chains are not one", chainFromSketch({ ...drawn, points: [...drawn.points, { id: 9, at: [0, -30] }, { id: 10, at: [0, 30] }], entities: [...drawn.entities, { id: 9, kind: "line", a: 9, b: 10 }] }), { reason: ONE_CHAIN });
eq("a branch is not a chain", chainFromSketch({ ...drawn, points: [...drawn.points, { id: 9, at: [-5, -10] }], entities: [...drawn.entities, { id: 9, kind: "line", a: 2, b: 9 }] }), { reason: ONE_CHAIN });
eq("a closed loop is not open", chainFromSketch({ ...drawn, entities: [...drawn.entities, { id: 9, kind: "line", a: 5, b: 1 }] }), { reason: ONE_CHAIN });
eq("an empty sketch says to draw it", chainFromSketch({ ...drawn, points: [], entities: [] }), { reason: CHAIN_NEEDED });

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sketch profile: ok");
