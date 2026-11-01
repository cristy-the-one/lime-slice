/**
 * Pairing a split shell's mesh with the solid it came from: by the box, lifted back off the bed, and by volume when
 * two solids share a box.
 */
import { matchShellSolids, type SolidBounds } from "./shell-solids.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function face(a: number[], b: number[], c: number[], d: number[]): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const p = (x: number, y: number, z: number) => [x, y, z];
  return new Float32Array([
    ...face(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)),
    ...face(p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1), p(x1, y0, z1)),
    ...face(p(x0, y0, z0), p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0)),
    ...face(p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...face(p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)),
    ...face(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0)),
  ]);
}

function lower(pos: Float32Array, seat: number): Float32Array {
  const out = new Float32Array(pos);
  for (let i = 2; i < out.length; i += 3) out[i] = (out[i] ?? 0) - seat;
  return out;
}

interface Named extends SolidBounds {
  id: string;
}

const left: Named = { id: "left", volumeMm3: 1800, bounds: { min: [0, 0, 0], max: [18, 10, 10] } };
const right: Named = { id: "right", volumeMm3: 1800, bounds: { min: [22, 0, 0], max: [40, 10, 10] } };
const shells = [box(22, 0, 0, 40, 10, 10), box(0, 0, 0, 18, 10, 10)];
const matched = matchShellSolids(shells, 0, [left, right]);
check("each shell takes the solid in its box, whatever the order", matched[0]?.id === "right" && matched[1]?.id === "left", JSON.stringify(matched.map((row) => row?.id)));

const raised = [lower(box(0, 0, 12, 10, 10, 22), 4), lower(box(30, 0, 4, 40, 10, 14), 4)];
const floating: Named[] = [
  { id: "low", volumeMm3: 1000, bounds: { min: [30, 0, 4], max: [40, 10, 14] } },
  { id: "high", volumeMm3: 1000, bounds: { min: [0, 0, 12], max: [10, 10, 22] } },
];
const lifted = matchShellSolids(raised, 4, floating);
check("a settled shell is matched in the solid's frame", lifted[0]?.id === "high" && lifted[1]?.id === "low", JSON.stringify(lifted.map((row) => row?.id)));

const outer: Named = { id: "outer", volumeMm3: 8000, bounds: { min: [0, 0, 0], max: [40, 40, 20] } };
const inner: Named = { id: "inner", volumeMm3: 288, bounds: { min: [12, 12, 4], max: [18, 18, 12] } };
const nested = matchShellSolids([box(12, 12, 4, 18, 18, 12), box(0, 0, 0, 40, 40, 20)], 0, [outer, inner]);
check("a shell inside another solid's box stays with its own solid", nested[0]?.id === "inner" && nested[1]?.id === "outer", JSON.stringify(nested.map((row) => row?.id)));

const sameBox: Named[] = [
  { id: "big", volumeMm3: 1000, bounds: { min: [0, 0, 0], max: [10, 10, 10] } },
  { id: "small", volumeMm3: 200, bounds: { min: [0, 0, 0], max: [10, 10, 10] } },
];
const byVolume = matchShellSolids([box(0, 0, 0, 10, 10, 10)], 0, sameBox);
check("two solids in one box are told apart by volume", byVolume[0]?.id === "big", JSON.stringify(byVolume.map((row) => row?.id)));

const stray = matchShellSolids([box(0, 0, 0, 10, 10, 10), box(100, 0, 0, 110, 10, 10)], 0, [left]);
check("a shell with no solid is left unmatched", stray[0] === null && stray[1] === null, JSON.stringify(stray.map((row) => row?.id)));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("shell-solids: ok");
