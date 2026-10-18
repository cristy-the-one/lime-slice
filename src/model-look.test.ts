import { facePaint, idleLook, offsetAfterDrag, sectionPlane, stepHex } from "./model-look.ts";

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

const centre: [number, number, number] = [10, 20, 30];
eq("section off", sectionPlane(idleLook(), centre), null);
eq(
  "an axis plane through the centre, offset along it",
  sectionPlane({ ...idleLook(), section: true, axis: "z", offset: 4 }, centre),
  { origin: [10, 20, 34], normal: [0, 0, 1] },
);
eq(
  "flip swaps the cut side and leaves the plane where the offset put it",
  sectionPlane({ ...idleLook(), section: true, axis: "x", offset: 2, flip: true }, centre),
  { origin: [12, 20, 30], normal: [-1, 0, 0] },
);
eq(
  "a face plane uses the picked face",
  sectionPlane(
    { ...idleLook(), section: true, axis: "face", offset: 1, face: { origin: [1, 2, 3], normal: [0, 1, 0] } },
    centre,
  ),
  { origin: [1, 3, 3], normal: [0, 1, 0] },
);
eq("a face axis with no face", sectionPlane({ ...idleLook(), section: true, axis: "face" }, centre), null);
eq("a drag along the cut normal", offsetAfterDrag(4, 1.5, false), 5.5);
eq("a flipped drag still moves the plane with the arrow", offsetAfterDrag(4, 1.5, true), 2.5);

const a = stepHex(0);
const b = stepHex(1);
check("two steps get two colours", a !== b && /^#[0-9a-f]{6}$/.test(a) && /^#[0-9a-f]{6}$/.test(b));
eq("a step keeps its colour", stepHex(4), stepHex(4));

const accent = 0x2255aa;
const painted = facePaint({ index: 0, owner: 1, selected: false, pickHover: false, stepHover: false, colourByStep: true, accent });
eq("a face takes its step's colour", painted.stepHex, b);
const selected = facePaint({ index: 0, owner: 1, selected: true, pickHover: false, stepHover: true, colourByStep: true, accent });
eq("a selected face stays the accent", selected.hex, accent);
const hinted = facePaint({ index: 2, owner: 3, selected: false, pickHover: false, stepHover: true, colourByStep: false, accent });
check("a hovered step tints its faces while colour is off", hinted.stepHex === stepHex(3) && hinted.hex !== accent);

if (failed) throw new Error(`${failed} model look checks failed`);
console.log("model-look: ok");
