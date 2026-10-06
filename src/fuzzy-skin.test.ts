import {
  FUZZY_POINT_DISTANCE,
  FUZZY_THICKNESS,
  fuzzyRequest,
  readFuzzyPointDistance,
  readFuzzyThickness,
  sliceFuzzyFields,
  type FuzzyChoice,
} from "./fuzzy-skin.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

const off: FuzzyChoice = { on: false, thickness: FUZZY_THICKNESS, pointDistance: FUZZY_POINT_DISTANCE };
const defaults: FuzzyChoice = { on: true, thickness: FUZZY_THICKNESS, pointDistance: FUZZY_POINT_DISTANCE };
const tuned: FuzzyChoice = { on: true, thickness: 0.5, pointDistance: 1.2 };

eq("fuzzy skin off is omitted from the request", fuzzyRequest(off), {});
eq("fuzzy skin on at the defaults is an empty object", fuzzyRequest(defaults), { fuzzySkin: {} });
eq("only a changed fuzzy key is kept", fuzzyRequest({ ...defaults, thickness: 0.5 }), { fuzzySkin: { thickness: 0.5 } });
eq("every changed fuzzy key is kept", fuzzyRequest(tuned), { fuzzySkin: { thickness: 0.5, pointDistance: 1.2 } });
eq("the slice sends fuzzy skin at the defaults as an empty object", sliceFuzzyFields(defaults), { fuzzySkin: {} });
eq("the slice sends every changed fuzzy key", sliceFuzzyFields(tuned), { fuzzySkin: { thickness: 0.5, pointDistance: 1.2 } });
eq("a tuned thickness while off is still omitted", sliceFuzzyFields({ ...tuned, on: false }), {});

eq("thickness is clamped", readFuzzyThickness("2"), 1);
eq("a blank thickness falls back", readFuzzyThickness(""), FUZZY_THICKNESS);
eq("point spacing is clamped", readFuzzyPointDistance("0"), 0.1);
eq("a blank point spacing falls back", readFuzzyPointDistance(""), FUZZY_POINT_DISTANCE);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("fuzzy skin: omit and fields ok");
