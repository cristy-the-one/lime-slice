import { formatMm, splitMargin, splitPlaneInside, splitPlaneRange, zExtent } from "./model-plane.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const plate = zExtent([0, 0, 0, 220, 0, 0, 0, 220, 5]);
eq("a 5 mm plate spans 0 to 5", plate, { min: 0, max: 5 });
eq("the margin on a 5 mm plate is 0.25 mm", splitMargin(5), 0.25);

const range = splitPlaneRange(plate);
eq("the plane defaults to mid-height and stays off both faces", range, { min: 0.25, max: 4.75, mid: 2.5 });
check("Z = 5, the top face, is not a legal cut", range != null && !splitPlaneInside(5, range));
check("the middle is a legal cut", range != null && splitPlaneInside(range.mid, range));
check("a sheet thinner than the two margins cannot be split", splitPlaneRange({ min: 0, max: 0.4 }) === null);
check("millimetres drop trailing zeros", formatMm(2.5) === "2.5" && formatMm(0.25) === "0.25");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model-plane: mid default and face clearance ok");
