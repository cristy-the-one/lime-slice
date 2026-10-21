import { featureTitle, fitStatus, HINT_LIMIT, STATUS_HINTS, TITLE_LIMIT } from "./hints.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

for (const hint of STATUS_HINTS) {
  const sample = hint.title.replace("{detail}", "360° · New object");
  const limit = hint.feature ? TITLE_LIMIT : HINT_LIMIT;
  check(`${hint.id} title fits the status bar`, sample.length <= limit && sample.length <= HINT_LIMIT);
  check(`${hint.id} has steps`, hint.steps.length > 0 && hint.steps.every((step) => step.length > 0 && step.length <= HINT_LIMIT));
}

check("a long sentence is cut to 80", fitStatus("x".repeat(120)).length === HINT_LIMIT);
check("extrude title stays within 40", featureTitle("extrude", "10 mm · New object").length <= TITLE_LIMIT);
check("revolve title names the turn", featureTitle("revolve", "360° · New object") === "Revolve 360° · New object");
check("loft title stays within 40", featureTitle("loft", "2 sections · Join").length <= TITLE_LIMIT);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("hints ok");
