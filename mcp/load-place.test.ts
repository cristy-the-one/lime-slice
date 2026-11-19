/**
 * ribs_apply verify stores a load with its place and empty faces, then reads that list back.
 * The place has to survive, or the sliced study drops it and loads a sliver at the part's max X.
 */
import { stressMethods } from "./session/stress.ts";

let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}\n  got ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`);
}

const stored = {
  kind: "force" as const,
  faces: [] as number[],
  magnitude: 20,
  direction: [0, 0, -1] as [number, number, number],
  place: { box: { min: [-12, -10, 1.2] as [number, number, number], max: [12, 10, 3.2] as [number, number, number] } },
};
eq("a stored place is still the load", stressMethods.readLoads.call(null as never, [stored]), [stored]);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
