import { gizmoAtNdc, placeClearGizmo } from "./gizmo-math.ts";

let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${left}`);
}

function check(name: string, ok: boolean): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const span = 160;
const view = { w: 1000, h: 700 };
const small = { x: 460, y: 300, w: 80, h: 90 };
const plate = { x: 8, y: 40, w: 960, h: 620 };

const beside = placeClearGizmo(view.w, view.h, small, span);
check("a small solid keeps the gizmo just to its left", beside.parked === false);
check("the offset seat is left of the solid", beside.ndcX < (small.x / view.w) * 2 - 1);
check("the offset seat stays on the solid's vertical middle", Math.abs(beside.ndcY - (-((small.y + small.h / 2) / view.h) * 2 + 1)) < 0.02);

const parked = placeClearGizmo(view.w, view.h, plate, span);
eq("a solid that fills the view parks on the left", parked.parked, true);
check("the park is left of centre", parked.ndcX < -0.4 && parked.ndcY === 0);

eq("no solid parks", placeClearGizmo(view.w, view.h, null, span).parked, true);

const stuck = placeClearGizmo(view.w, view.h, { x: 190, y: 200, w: 120, h: 100 }, span, true);
eq("a seat that only just fits stays parked once it has parked", stuck.parked, true);
const clear = placeClearGizmo(view.w, view.h, small, span, true);
eq("a clearly clear offset is used again after a park", clear.parked, false);

const right = placeClearGizmo(view.w, view.h, small, span, false, "right");
check("the right seat stays right of the solid", right.parked === false && right.ndcX > ((small.x + small.w) / view.w) * 2 - 1);
const rightPark = placeClearGizmo(view.w, view.h, plate, span, false, "right");
check("a full view parks on the right", rightPark.parked === true && rightPark.ndcX > 0.4);

const [x, y, z] = gizmoAtNdc(beside.ndcX, beside.ndcY, 120, 40, 1.4, 1);
check("an NDC seat sits on the camera-depth plane, left of centre when the seat is", z === -120 && x < 0 && y !== 0);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("gizmo-math: clearance seat ok");
