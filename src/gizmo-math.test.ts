import { DOCK_KNOB_REACH, HANDLE_ARROW_TIP, HANDLE_KNOB_PICK, HANDLE_RING_RADIUS, dockNdc, dockSpanPx } from "./gizmo-math.ts";

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

eq("the dock is vertically centred", dockNdc(1440, 92).ndcY, 0);
eq("the dock is on the right half", dockNdc(1440, 92).ndcX > 0.5, true);
eq("the dock is the same every time for a view", dockNdc(1440, 92), dockNdc(1440, 92));
eq("the dock span is the knob reach plus its grab radius, in pixels", Math.round(dockSpanPx(100)), 147);

for (const width of [900, 1100, 1440, 1920]) {
  const { ndcX } = dockNdc(width, 92);
  const centre = (ndcX * 0.5 + 0.5) * width;
  check(`the farthest knob stays on a ${width}px canvas`, centre + dockSpanPx(92) <= width);
}
check("a wider canvas parks the dock nearer the edge in pixels, not in NDC", dockNdc(1920, 92).ndcX > dockNdc(1100, 92).ndcX);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("gizmo-math: dock layout ok");
