import { governsSentence, marginSentence } from "./margin-text.ts";
import type { SlicedMargin } from "./study.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const safety: SlicedMargin = {
  kind: "minSafetyFactor",
  limit: 1,
  value: 2.5,
  margin: 1.5,
  met: true,
  note: "above the band",
  role: "outer",
  governs: "across-layers",
  at: [1, 2, 3],
};

check(
  "a safety margin reads the way the legend speaks",
  marginSentence(safety) === "Safety factor ≥ 1.0: 2.50 (margin 1.50) · met · above the band",
  marginSentence(safety),
);
check(
  "across-layers names orientation",
  governsSentence("across-layers", "outer").includes("workplane_print_up") && governsSentence("interlayer-shear").includes("More walls rarely help."),
);
check(
  "across-bead names walls and the pattern",
  governsSentence("across-bead").includes("settings_set") && governsSentence("across-bead").includes("Wall count"),
);
check(
  "along-bead follows the role",
  governsSentence("along-bead", "sparse").includes("reinforce_add")
    && governsSentence("along-bead", "outer").includes("model_apply")
    && governsSentence("along-bead", "wall").includes("nearestFace"),
);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("margin text: ok");
