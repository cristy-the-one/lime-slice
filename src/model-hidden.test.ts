import { hiddenCount, isHidden, isolate, pruneHidden, setHidden, showAll, visibleParts } from "./model-hidden.ts";

let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const parts = [{ id: "a" }, { id: "b" }, { id: "c" }];
const ids = ["a", "b", "c"];

check("nothing hidden keeps every part", visibleParts(parts).length === 3);
setHidden("b", true);
check("a hidden part is left out", visibleParts(parts).map((p) => p.id).join() === "a,c");
check("hidden is per id", isHidden("b") && !isHidden("a"));
setHidden("b", false);
check("showing brings it back", visibleParts(parts).length === 3 && hiddenCount() === 0);

isolate("a", ids);
check("isolate hides the others", visibleParts(parts).map((p) => p.id).join() === "a");
isolate("a", ids);
check("isolating the same object again shows all", hiddenCount() === 0);

setHidden("b", true);
setHidden("gone", true);
check("pruning drops ids that left the plate", pruneHidden(ids, null) && !isHidden("gone") && isHidden("b"));
check("pruning twice changes nothing", !pruneHidden(ids, null));
check("opening a hidden object shows it", pruneHidden(ids, "b") && !isHidden("b"));
setHidden("c", true);
showAll();
check("show all clears", hiddenCount() === 0);

if (failed > 0) process.exit(1);
console.log("model-hidden tests passed");
