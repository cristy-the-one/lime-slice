import { beltSliceField } from "./belt.ts";
import { humanEngineError } from "./engine-wording.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

check("a cartesian slice sends no belt, so the width check cannot run", !("belt" in beltSliceField(null, false)));

const raw = "belt.widthMm 250 is narrower than the part, which is 440.87 mm across the belt";
const human = humanEngineError(raw);
check(
  "the width error is a sentence, not a config key",
  !human.includes("belt.widthMm") && human === "The belt is 250 mm wide, and this plate is 440.87 mm across it.",
  human,
);
check("a second pass leaves that sentence alone", humanEngineError(human) === human);

const length = humanEngineError("belt.maxLengthMm 30 is shorter than the belt run of 56.57 mm");
check(
  "the length error names the belt, not the field",
  length === "The belt's max length is 30 mm, shorter than this run of 56.57 mm.",
  length,
);
check(
  "other belt fields lose the config key",
  humanEngineError("belt.angleDeg 0 is outside 10 to 80") === "Belt angle 0 is outside 10 to 80",
);
check("a message that is not a belt field stays", humanEngineError("walls 0 is outside 1 to 12") === "walls 0 is outside 1 to 12");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("engine-wording: belt errors read as sentences ok");
