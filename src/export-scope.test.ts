/**
 * One Export (docs/plan-export-and-linking.md D1, D2): the scope the dialog opens on,
 * the formats each scope offers, and a free part's place in the loose plate assembly.
 */
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
import { orderExportMembers } from "./pose-export.ts";
import {
  defaultScope,
  exportCommandReason,
  formatFor,
  formatsFor,
  plateAssembled,
  rememberFormat,
  resetFormatMemory,
  type ExportScope,
} from "./export-scope.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const pose: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [12, -4, 7] };

check("nothing selected opens on the assembled plate", defaultScope({ selectedId: null, memberOf: null }) === "plate-assembled");
check("a free part opens on that part", defaultScope({ selectedId: "cube", memberOf: null }) === "part");
check("a member opens on its assembly", defaultScope({ selectedId: "arm", memberOf: "asm_1" }) === "assembly");

const expected: Record<ExportScope, string> = {
  part: "step,stl,3mf,obj,glb",
  assembly: "step,glb,3mf,stl,obj,pose",
  "plate-assembled": "step,glb,3mf,stl,obj,pose",
  "plate-print": "3mf,stl",
};
for (const scope of Object.keys(expected) as ExportScope[]) {
  check(`${scope} offers ${expected[scope]}`, formatsFor(scope).join(",") === expected[scope]);
}

resetFormatMemory();
check("a scope starts on its first format", formatFor("part") === "step" && formatFor("plate-print") === "3mf");
rememberFormat("part", "obj");
rememberFormat("plate-print", "stl");
check("the last format is remembered per scope", formatFor("part") === "obj" && formatFor("plate-print") === "stl" && formatFor("assembly") === "step");
resetFormatMemory();

const built = plateAssembled(
  [
    { id: "body", modelPose: IDENTITY_POSE },
    { id: "free", modelPose: pose },
  ],
  [{
    id: "asm_1",
    name: "Body",
    members: [{ object: "body", parent: null, offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 0, 1] } }],
  }],
);
const free = built.assembly.members.find((member) => member.object === "free");
const ordered = orderExportMembers(
  built.assembly,
  (id) => id,
  (id) => id,
  () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  (id) => built.poses.get(id),
);
const placed = ordered.members.find((member) => member.object === "free");
check("a free part is a top-level member with no joint", !!free && free.parent === null && free.joint === undefined);
check("a free part's placement equals its modelPose", !!placed && placed.pose.t[0] === pose.t[0] && placed.pose.t[1] === pose.t[1] && placed.pose.t[2] === pose.t[2] && placed.pose.m.every((value, index) => value === pose.m[index]));
check("an assembled part stays in its sub-tree", built.assembly.members.some((member) => member.object === "body" && member.joint?.kind === "hinge"));

check("an empty plate disables Export", exportCommandReason("export-model", { objects: 0, selectedId: null, assemblies: 0 }) === "The plate is empty.");
check("Export part… asks for a part", exportCommandReason("export-part", { objects: 2, selectedId: null, assemblies: 0 }) === "Select a part to export.");
check("Export assembly… asks for an assembly", exportCommandReason("export-assembly", { objects: 2, selectedId: "cube", assemblies: 0 }) === "There is no assembly to export.");
check("Export… runs when the plate has a part", exportCommandReason("export-model", { objects: 1, selectedId: "cube", assemblies: 0 }) === null);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("export-scope: ok");
