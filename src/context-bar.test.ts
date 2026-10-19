import {
  actionsFor,
  averagePoint,
  boxesOverlap,
  contextKind,
  CONTEXT_GAP_PX,
  polylineMid,
  registerContextAction,
  registeredContextActions,
  seatContextBar,
  type ContextBox,
} from "./context-bar.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const face = (index: number) => ({ kind: "face" as const, index });
const edge = (index: number) => ({ kind: "edge" as const, index });
const flat = (index: number) => ({ index });
const cylinder = (index: number) => ({ index, surface: "cylinder" as const });

eq("nothing selected", contextKind([], []), null);
eq("one flat face", contextKind([face(1)], [flat(1)]), "flat-face");
eq("a face with no description is flat", contextKind([face(4)], []), "flat-face");
eq("one cylinder", contextKind([face(2)], [flat(0), cylinder(2)]), "cylinder");
eq("a cone is curved", contextKind([face(0)], [{ index: 0, surface: "cone" }]), "curved");
eq("a sphere is curved", contextKind([face(3)], [{ index: 3, surface: "sphere" }]), "curved");
eq("several faces, one of them a cylinder", contextKind([face(0), face(1)], [cylinder(1)]), "faces");
eq("one edge", contextKind([edge(4)], []), "edges");
eq("several edges", contextKind([edge(1), edge(2)], []), "edges");
eq("a face and an edge", contextKind([face(0), edge(1)], [flat(0)]), "mixed");

eq("the middle of a segment", polylineMid([0, 0, 0, 10, 0, 0]), [5, 0, 0]);
eq("no segment", polylineMid([1, 2, 3]), null);
eq("the mean", averagePoint([[0, 0, 0], [6, 3, 9]]), [3, 1.5, 4.5]);
eq("no points", averagePoint([]), null);

const canvas = { width: 800, height: 600 };
const bar = { width: 180, height: 32 };
const pointer = { x: 400, y: 300 };

function boxOf(at: { x: number; y: number }): ContextBox {
  return { ...at, width: bar.width, height: bar.height };
}

const open = seatContextBar({ pointer, bar, bounds: canvas, solid: null, obstacles: [] });
eq("24 px above the pointer, centred", open, { x: pointer.x - bar.width / 2, y: pointer.y - bar.height - CONTEXT_GAP_PX });
check("the open seat does not cover the pointer", !boxesOverlap(boxOf(open), { x: pointer.x - 1, y: pointer.y - 1, width: 2, height: 2 }));

const solid: ContextBox = { x: 200, y: 180, width: 400, height: 260 };
const clearOfSolid = seatContextBar({ pointer, bar, bounds: canvas, solid, obstacles: [] });
check("the bar stays off the solid", !boxesOverlap(boxOf(clearOfSolid), solid));
check("the bar stays off the pointer when the solid owns the preferred seat", !boxesOverlap(boxOf(clearOfSolid), { x: pointer.x - 4, y: pointer.y - 4, width: 8, height: 8 }));
check("a blocked seat prefers above the solid", clearOfSolid.y + bar.height <= solid.y);

const readout: ContextBox = { x: 8, y: 8, width: 760, height: 80 };
const underReadout = seatContextBar({
  pointer: { x: 400, y: 40 },
  bar,
  bounds: canvas,
  solid: null,
  obstacles: [readout],
});
check("the bar is not under the readout", !boxesOverlap(boxOf(underReadout), readout));
check("the bar stays on the canvas", underReadout.x >= 8 && underReadout.y >= 8 && underReadout.x + bar.width <= canvas.width - 8);

const corner = seatContextBar({ pointer: { x: 4, y: 4 }, bar, bounds: canvas, solid: null, obstacles: [] });
check("a corner click does not cover the pointer", corner.y >= 4 + 8 || corner.x >= 4 + 8);

eq(
  "one flat face offers push, hole, and shell",
  actionsFor("flat-face").map((action) => action.id),
  ["push-pull", "hole", "shell-face"],
);
eq("several faces offer move and shell", actionsFor("faces").map((action) => action.id), ["move-faces", "shell-faces"]);
eq("a cylinder offers its diameter", actionsFor("cylinder").map((action) => action.label), ["Change diameter"]);
eq("a curved face still pushes", actionsFor("curved").map((action) => action.id), ["push-pull-curved"]);
eq("edges offer fillet and chamfer", actionsFor("edges").map((action) => action.id), ["fillet", "chamfer"]);
eq("empty space offers a new primitive", actionsFor("empty").map((action) => action.id), ["new-primitive"]);
eq("the primitive menu is the New solid row", actionsFor("empty")[0]?.menu?.map((item) => item.id), ["box", "cylinder", "sphere", "ellipsoid", "cone", "torus", "wedge", "polygon", "tube"]);
eq("a mixed selection has no built-in", actionsFor("mixed"), []);

const later = ["sketch-on-face", "sketch-on-bed", "features", "pattern", "hole-through-axis", "use-as-axis", "paste", "section"];
for (const id of later) check(`${id} is not built in`, registeredContextActions().every((action) => action.id !== id));

const remove = registerContextAction({
  id: "sketch-on-face",
  label: "Sketch on face",
  when: ["flat-face"],
  order: 15,
  toolbar: "#modelToolSketch",
});
eq(
  "a later package inserts itself without editing the bar",
  actionsFor("flat-face").map((action) => action.id),
  ["push-pull", "sketch-on-face", "hole", "shell-face"],
);
remove();
eq("unregister takes the package's button away", actionsFor("flat-face").map((action) => action.id), ["push-pull", "hole", "shell-face"]);

const off = registerContextAction({
  id: "pattern",
  label: "Pattern",
  when: ["faces"],
  order: 50,
  enabled: () => false,
});
eq("an action that is not available yet stays off the bar", actionsFor("faces").map((action) => action.id), ["move-faces", "shell-faces"]);
off();

check("push/pull names its shortcut command", actionsFor("flat-face")[0]?.command === "model-pushpull");
check("new primitive clicks New solid", actionsFor("empty")[0]?.toolbar === "#modelToolNew");

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("context bar: kinds, seating, and the action register ok");
