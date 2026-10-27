import { between, distanceText, endsText, pickedText, pointLabel, readoutLines } from "./measure-points.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

eq("a corner of a named object", pointLabel({ kind: "vertex", object: "Cube" }), "Vertex · Cube");
eq("a corner with no name to give", pointLabel({ kind: "vertex" }), "Vertex");
eq("a point with no feature near it is on the surface", pointLabel({ kind: "surface", object: "Ledge" }), "Surface · Ledge");
eq("a hole's middle", pointLabel({ kind: "circle" }), "Circle centre");

eq("the 3-4-5 distance", between([0, 0, 0], [3, 4, 0]), { distance: 5, delta: [3, 4, 0] });
eq("the change is B minus A", between([10, 10, 10], [4, 12, 10]).delta, [-6, 2, 0]);
eq("the sentence rounds to a hundredth", distanceText([0, 0, 0], [1, 1, 1]), "Distance 1.73 mm. ΔX 1, ΔY 1, ΔZ 1 mm.");
eq("a tiny negative change reads zero, not -0", distanceText([0, 0, 0], [0.001, -0.001, 5]), "Distance 5 mm. ΔX 0, ΔY 0, ΔZ 5 mm.");
eq("the ends are named, A then B", endsText({ at: [0, 0, 0], kind: "vertex", object: "Cube" }, { at: [1, 0, 0], kind: "midpoint", object: "Ledge" }), "A: Vertex · Cube. B: Midpoint · Ledge.");
eq("a typed end is not named", endsText(null, { at: [1, 0, 0], kind: "face" }), "B: Face centre.");
eq("both together", pickedText({ at: [0, 0, 0], kind: "vertex", object: "Cube" }, { at: [30, 10, 0], kind: "vertex", object: "Ledge" }), "Distance 31.62 mm. ΔX 30, ΔY 10, ΔZ 0 mm. A: Vertex · Cube. B: Vertex · Ledge.");

eq("the readout in lines", readoutLines({ at: [0, 0, 0], kind: "vertex", object: "Cube" }, { at: [30, -10, 0], kind: "surface", object: "Ledge" }), [
  "Distance 31.62 mm",
  "ΔX 30 · ΔY -10 · ΔZ 0 mm",
  "A: Vertex · Cube",
  "B: Surface · Ledge",
]);

if (failed > 0) process.exit(1);
console.log("measure-points ok");
