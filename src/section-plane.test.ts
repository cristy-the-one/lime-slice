import { axisNormal, sectionAxis } from "./section-plane.ts";

let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

eq("axis of a unit normal", sectionAxis([0, 0, 1]), "z");
eq("the opposite normal is the same axis", sectionAxis([0, 0, -1]), "z");
eq("a tilt is custom", sectionAxis([0, 0.2, 0.98]), "custom");
eq("choosing Z from +X points +Z", axisNormal("z", [1, 0, 0]), [0, 0, 1]);
eq("choosing Z again keeps the hidden side", axisNormal("z", [0, 0, -1]), [0, 0, -1]);

if (failed) throw new Error(`${failed} section-plane check(s) failed`);
console.log("section-plane: ok");
