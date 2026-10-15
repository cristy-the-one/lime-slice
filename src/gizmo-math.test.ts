import { DOCK_KNOB_REACH, DOCK_MIN_PX, DOCK_REACH, HANDLE_ARROW_TIP, HANDLE_KNOB_PICK, HANDLE_RING_RADIUS, MODEL_DOCK_CLEAR, dockOutline, dockSeat } from "./gizmo-math.ts";

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

check("a size knob sits past the arrow tip, with its pick clear of the tip", DOCK_KNOB_REACH - HANDLE_KNOB_PICK > HANDLE_ARROW_TIP);
check("a size knob sits outside the ring, with its pick clear of the rim", DOCK_KNOB_REACH - HANDLE_KNOB_PICK > HANDLE_RING_RADIUS);

check("the dock's reach covers its knobs, rings, and arrows", DOCK_REACH >= DOCK_KNOB_REACH + HANDLE_KNOB_PICK && DOCK_REACH > HANDLE_RING_RADIUS + 0.09 && DOCK_REACH > HANDLE_ARROW_TIP);
eq("the dock is the same every time for a canvas", dockSeat(1100, 820, 40, 92), dockSeat(1100, 820, 40, 92));
eq("a roomy canvas keeps the full handle size", dockSeat(1100, 820, 40, 92).handlePx, 92);

// The whole dock, seen in perspective, stays 24 px off the right edge and clear of the overlays above and below it.
for (const [width, height] of [[1100, 820], [940, 650], [700, 680], [1500, 900], [500, 420]]) {
  const seat = dockSeat(width, height, 40, 92);
  const outline = dockOutline(width, height, 40, seat.handlePx, seat.ndcX, seat.ndcY);
  const px = { right: ((1 - outline.right) / 2) * width, top: ((1 - outline.top) / 2) * height, bottom: ((1 + outline.bottom) / 2) * height };
  check(`${width}×${height}: the dock keeps ${MODEL_DOCK_CLEAR.right} px off the right edge (${px.right.toFixed(1)})`, px.right >= MODEL_DOCK_CLEAR.right - 0.5);
  check(`${width}×${height}: and clears the toolbar (${px.top.toFixed(1)})`, seat.handlePx === DOCK_MIN_PX || px.top >= MODEL_DOCK_CLEAR.top - 0.5);
  check(`${width}×${height}: and the view cube (${px.bottom.toFixed(1)})`, seat.handlePx === DOCK_MIN_PX || px.bottom >= MODEL_DOCK_CLEAR.bottom - 0.5);
  check(`${width}×${height}: on the right side of the canvas`, seat.ndcX >= 0.42 || seat.handlePx === DOCK_MIN_PX);
}
const tight = dockSeat(560, 520, 40, 92);
check("a small canvas shrinks the dock instead of cutting it", tight.handlePx < 92 && tight.handlePx >= DOCK_MIN_PX);
// Perspective: the ball's near side stands out, so the dock sits further in than its flat radius alone would put it.
const flat = 1 - (2 * (MODEL_DOCK_CLEAR.right + DOCK_REACH * 92)) / 1100;
check("the seat leaves room for the near side of the dock", dockSeat(1100, 820, 40, 92).ndcX < flat);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("gizmo-math: dock layout ok");
