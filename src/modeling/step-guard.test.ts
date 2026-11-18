/**
 * The step guard on synthetic meshes: it judges what a step changed, not what the part already had, and it catches a
 * result Open CASCADE built wrong whatever kind of step made it (an extrude-cut as well as a box Boolean).
 */
import { stepGuard } from "./model-calls.ts";
import { newTouchingEdges } from "./step-guard.ts";
import { IDENTITY_POSE } from "../model-space.ts";
import type { ModelOp } from "../model-tree.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type V = [number, number, number];

/** The volume a closed soup holds. */
function soupVolume(p: readonly number[]): number {
  let sum = 0;
  for (let t = 0; t + 8 < p.length; t += 9) {
    sum += p[t]! * (p[t + 4]! * p[t + 8]! - p[t + 5]! * p[t + 7]!) - p[t + 1]! * (p[t + 3]! * p[t + 8]! - p[t + 5]! * p[t + 6]!) + p[t + 2]! * (p[t + 3]! * p[t + 7]! - p[t + 4]! * p[t + 6]!);
  }
  return sum / 6;
}

/** A closed box as 12 outward triangles; `splitZ` splits its four side faces at that height. */
function box(min: V, max: V, splitZ?: number): number[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const quad = (a: V, b: V, c: V, d: V) => [...a, ...b, ...c, ...a, ...c, ...d];
  const side = (a: V, b: V, c: V, d: V) => {
    // a, b on the bottom, c, d on the top, counter-clockwise from outside.
    if (splitZ === undefined) return quad(a, b, c, d);
    const m = (p: V): V => [p[0], p[1], splitZ];
    return [...quad(a, b, m(b), m(a)), ...quad(m(a), m(b), c, d)];
  };
  return [
    ...quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]),
    ...quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    ...side([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
    ...side([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    ...side([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]),
    ...side([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]),
  ];
}

/** A solid as the guard reads it: its volume and its mesh. */
const solid = (soup: number[], volumeMm3 = Math.abs(soupVolume(soup))) => ({ volumeMm3, positions: Float32Array.from(soup) }) as unknown as NonNullable<Parameters<typeof stepGuard>[1]>;

/**
 * A floor 100 × 60 × 2 with ribs 0.8 wide and 1.5 tall on it, as closed boxes, and, at the wall end (x 100), two
 * blocks of the part that meet only along a vertical edge: an imported part brings edges like that with it.
 */
const ribs = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let x = 4; x < 100; x += 4) if (x + 0.8 <= from || x >= to) out.push(...box([x, 0, 2], [x + 0.8, 60, 3.5]));
  return out;
};
const floor = box([0, 0, 0], [100, 60, 2]);
const ownEdge = (splitZ?: number) => [...box([100, 0, 0], [110, 30, 10], splitZ), ...box([110, 30, 0], [120, 60, 10], splitZ)];
const before = solid([...floor, ...ribs(0, 0), ...ownEdge()]);

// 1. A sound cut over the ribs to the wall end, where the part already touches itself. The mesher splits that old
// edge at a new point, as Open CASCADE does when a face beside it is cut: it is the same edge in two pieces.
{
  const cut: ModelOp = { kind: "boolean", op: "cut", primitive: "box", origin: [40, 0, 2], size: [70.2, 60, 2], turn: [0, 0, 0] } as ModelOp;
  const after = solid([...floor, ...ribs(40, 110.2), ...ownEdge(3)]);
  const verdict = stepGuard(cut, before, after, IDENTITY_POSE);
  check("a sound cut beside edges the part already had passes", verdict === null, JSON.stringify(verdict));
  check("the part's own touching edges are not new", newTouchingEdges(before.positions, after.positions).count === 0);
}

// 2. Open CASCADE got the cut wrong: the tool's faces stand in the air where the ribs were, each rib top meeting them
// along a line (on the real part: the whole tool's volume removed, hundreds of such edges).
const damaged = (): number[] => {
  const out = [...floor, ...ribs(0, 0), ...ownEdge()];
  for (let x = 4; x < 100; x += 4) out.push(...box([x + 0.8, 0, 3.5], [x + 4, 60, 5]));
  return out;
};
{
  const cut: ModelOp = { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 1.5], size: [100, 60, 3.5], turn: [0, 0, 0] } as ModelOp;
  const verdict = stepGuard(cut, before, solid(damaged()), IDENTITY_POSE);
  check(
    "a box cut whose result is damaged is refused as damaged, not as a tool to move",
    verdict?.damaged === true && verdict.touching === undefined && /^Open CASCADE returned a damaged solid for this step: \d+ new edges where pieces meet only along a line, the first at \(/.test(verdict.reason),
    JSON.stringify(verdict),
  );
}

// 3. The same damage from a shaped extrude-cut: the guard read only box Booleans, so this was accepted.
{
  const cut: ModelOp = { kind: "extrude", op: "cut", origin: [0, 0, 2], turn: [0, 0, 0], profile: [[0, 0], [100, 0], [100, 60], [0, 60]], depth: 1.8 } as unknown as ModelOp;
  const verdict = stepGuard(cut, before, solid(damaged()), IDENTITY_POSE);
  check("an extrude-cut whose result is damaged is refused", verdict?.damaged === true, JSON.stringify(verdict));
}

// 4b. The real part's other variant: the solid reported +0.68 mm³, inside the slack, while its mesh grew by a quarter.
{
  const cut: ModelOp = { kind: "extrude", op: "cut", origin: [0, 0, 2], turn: [0, 0, 0], profile: [[0, 0], [100, 0], [100, 60], [0, 60]], depth: 1.8 } as unknown as ModelOp;
  const grown = [...floor, ...ribs(0, 0), ...ownEdge(), ...box([20, 70, 0], [70, 120, 2])];
  const verdict = stepGuard(cut, before, solid(grown, before.volumeMm3 + 0.68), IDENTITY_POSE);
  check("a cut whose mesh grew while its solid barely changed is refused", verdict?.damaged === true && /its mesh holds/.test(verdict.reason), JSON.stringify(verdict));
}

// 5. A mesh that holds far more than the solid it shows.
{
  const fuse: ModelOp = { kind: "extrude", op: "fuse", origin: [0, 0, 2], turn: [0, 0, 0], profile: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: 1 } as unknown as ModelOp;
  const grown = [...floor, ...ribs(0, 0), ...ownEdge(), ...box([20, 70, 0], [80, 120, 10])];
  const verdict = stepGuard(fuse, before, solid(grown, before.volumeMm3 + 100), IDENTITY_POSE);
  check("a mesh whose volume is not the solid's is refused", verdict?.damaged === true && /its mesh holds/.test(verdict.reason), JSON.stringify(verdict));
}

// 5b. A result that carries the solid before's own mesh (a host that did not mesh this step) is not judged by it.
{
  const cut: ModelOp = { kind: "extrude", op: "cut", origin: [0, 0, 2], turn: [0, 0, 0], profile: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: -1 } as unknown as ModelOp;
  const verdict = stepGuard(cut, before, solid(Array.from(before.positions), before.volumeMm3 * 0.8), IDENTITY_POSE);
  check("a result with the mesh from before is not read by its mesh", verdict === null, JSON.stringify(verdict));
}

// 6. A box placed against the part along one edge keeps the wording that says to move it, and stays shortenable.
{
  const fuse: ModelOp = { kind: "boolean", op: "fuse", primitive: "box", origin: [-10, -10, 0], size: [10, 10, 2], turn: [0, 0, 0] } as ModelOp;
  const after = solid([...floor, ...ribs(0, 0), ...ownEdge(), ...box([-10, -10, 0], [0, 0, 2])]);
  const verdict = stepGuard(fuse, before, after, IDENTITY_POSE);
  check("a tool against the part along an edge is a touching refusal", verdict?.touching === true && verdict.reason.startsWith("This step would leave pieces that meet only along an edge at (0, 0, 1)"), JSON.stringify(verdict));
}

// 7. A step built without its mesh yet is judged by its volume alone.
{
  const cut: ModelOp = { kind: "boolean", op: "cut", primitive: "box", origin: [40, 0, 2], size: [20, 60, 2], turn: [0, 0, 0] } as ModelOp;
  const verdict = stepGuard(cut, before, solid([], before.volumeMm3 - 100), IDENTITY_POSE);
  check("a step with no mesh yet is read by its volume", verdict === null, JSON.stringify(verdict));
}

if (failed > 0) {
  console.error(`${failed} step guard check(s) failed`);
  process.exit(1);
}
