/**
 * A mesh closed ahead of the commit is the mesh the commit would have closed itself.
 */
import { closedReady, keepClosed, takeClosed } from "./closed-ahead.ts";
import { closeCracks, edgeReport } from "./mesh-check.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * A wavy sheet of two strips that share a border, as a kernel meshes two faces: the near strip samples the border at
 * `n` points and the far one at `2n`, so the border is cracked until the near strip's triangles are split.
 */
function cracked(n: number): Float32Array {
  const out: number[] = [];
  const z = (x: number, y: number) => Math.sin(x / 3) * Math.cos(y / 2);
  const p = (x: number, y: number) => [x, y, z(x, y)];
  for (let i = 0; i < n; i += 1) {
    out.push(...p(i, 0), ...p(i + 1, 0), ...p(i + 1, 1), ...p(i, 0), ...p(i + 1, 1), ...p(i, 1));
    for (const h of [0, 0.5]) out.push(...p(i + h, 1), ...p(i + h + 0.5, 1), ...p(i + h + 0.5, 2), ...p(i + h, 1), ...p(i + h + 0.5, 2), ...p(i + h, 2));
  }
  return new Float32Array(out);
}

for (const n of [8, 400]) {
  const positions = cracked(n);
  const now = closeCracks(positions);
  check(`${n}: the sheet has cracks to close, so the comparison means something`, now.length > positions.length);

  // Nothing ahead: worked out on the spot.
  check(`${n}: nothing is ready for a mesh nobody closed ahead`, !closedReady(positions));
  check(`${n}: with nothing ahead the commit closes the cracks itself`, same(takeClosed(positions), now));

  // Ahead, as the worker does it: on a copy of the positions, the result kept under the solid's own array.
  const ahead = closeCracks(new Float32Array(positions));
  keepClosed(positions, ahead);
  check(`${n}: the result is ready`, closedReady(positions));
  const taken = takeClosed(positions);
  check(`${n}: the commit takes the result closed ahead`, taken === ahead);
  check(`${n}: and it is the mesh the commit would have made`, same(taken, now));
  check(`${n}: border left open by neither`, edgeReport(taken).open === edgeReport(now).open);

  // Handed over once: the next caller gets an array of its own, with the same numbers.
  check(`${n}: a result is handed over once`, !closedReady(positions));
  const again = takeClosed(positions);
  check(`${n}: a second commit of the same solid gets its own array`, again !== taken && same(again, now));

  // Another array with the same numbers is another mesh: nothing kept for one is handed out for the other.
  keepClosed(positions, ahead);
  const twin = new Float32Array(positions);
  check(`${n}: a result is kept for its own array only`, !closedReady(twin) && takeClosed(twin) !== ahead);
  takeClosed(positions);
}

if (failed) process.exit(1);
console.log("closed-ahead tests passed");
