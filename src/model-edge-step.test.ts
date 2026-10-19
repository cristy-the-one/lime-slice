/**
 * A fillet or chamfer of the edges a step made: the panel's sentence, the stored pick, and the id the engine
 * uses while a saved solid stands in for a step.
 */
import { edgeOfText, isEdgeFilter, remapBlendFromNode, storedEdgeStep } from "./model-edge-step.ts";
import { stepEdges, stepEdgesRequest } from "./model-request.ts";
import type { ModelOp } from "./model-tree.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

eq("the panel names the row and the filter", edgeOfText("Roof", "convex"), "Edges of: Roof (convex)");
eq("all is said the same way", edgeOfText("plate.step", "all"), "Edges of: plate.step (all)");
eq("a filter is one of the three", [isEdgeFilter("convex"), isEdgeFilter("all"), isEdgeFilter("round"), isEdgeFilter(1)], [true, true, false, false]);

const convex = stepEdges(2, "convex");
eq("one step pick is that step", storedEdgeStep([convex]), { fromNode: 2, filter: "convex" });
eq("all is the filter when none was stored", storedEdgeStep([stepEdges(4)]), { fromNode: 4, filter: "all" });
eq("a picked edge is not a step", storedEdgeStep([3, convex]), null);
eq("two steps are not the one the panel edits", storedEdgeStep([convex, stepEdges(5, "convex")]), null);
eq("the same step twice is one pick", storedEdgeStep([convex, stepEdges(2, "convex")]), { fromNode: 2, filter: "convex" });
eq("a step-edge query omits an all filter", stepEdgesRequest("k", 2, "all"), { call: "stepEdges", key: "k", node: 2 });
eq("a step-edge query sends a narrow filter", stepEdgesRequest("k", 2, "convex"), { call: "stepEdges", key: "k", node: 2, filter: "convex" });

const fillet: ModelOp = { kind: "fillet", edges: [convex, 7], size: 1 };
const local = (id: number) => (id === 2 ? 0 : id);
eq("a saved solid renames only the step it stands for", remapBlendFromNode(fillet, local), { kind: "fillet", edges: [{ fromNode: 0, filter: "convex" }, 7], size: 1 });
const plain: ModelOp = { kind: "chamfer", edges: [3], size: 0.5 };
eq("an op with no step pick is returned as given", remapBlendFromNode(plain, local) === plain, true);
const group: ModelOp = { kind: "group", label: "Edges", steps: [fillet, plain] };
eq("a group renames a blend inside it and keeps the rest", remapBlendFromNode(group, local), {
  kind: "group",
  label: "Edges",
  steps: [remapBlendFromNode(fillet, local), plain],
});
const scale: ModelOp = { kind: "scale", factor: 2 };
eq("a scale is the same op", remapBlendFromNode(scale, local) === scale, true);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model edge step: panel line, stored pick, engine id ok");
