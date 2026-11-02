/**
 * The section tool's planes and mesh answers (mcp/sections.ts), and the loops array's lattice (mcp/cells.ts), without
 * an engine: planes framed as faces are, a fan and levels, a mesh ring cut into an outline with its hole, extrude loops
 * that close, the lattice's reach and limit, and a cell's span and draft on each side of the face.
 */
import { axesOf } from "../src/workplane.ts";
import { cellExtent, latticeLoops, MAX_LOOPS } from "./cells.ts";
import { cutPlanes, frameNumbers, meshSection, pointsIn } from "./sections.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${JSON.stringify(detail)}`);
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

// --- Planes.
{
  const level = cutPlanes({ planes: [{ origin: [1, 2, 3], normal: [0, 0, 2] }] });
  check("a level plane is framed with X and Y", !("reason" in level) && near(axesOf(level[0]!.plane)[0][0], 1) && near(axesOf(level[0]!.plane)[1][1], 1) && near(level[0]!.normal[2], 1), level);
  const wall = cutPlanes({ planes: [{ origin: [0, 0, 0], normal: [1, 0, 0] }] });
  check("a standing plane has V up and W along its normal", !("reason" in wall) && near(axesOf(wall[0]!.plane)[1][2], 1) && near(axesOf(wall[0]!.plane)[2][0], 1), wall);
  const numbers = !("reason" in wall) ? frameNumbers(wall[0]!.plane) : [];
  check("frameNumbers is origin, U, V", numbers.length === 9 && near(numbers[8]!, 1), numbers);
  const fan = cutPlanes({ fan: { axisPoint: [0, 0, 0], axisDir: [0, 0, 1], anglesDeg: [0, 45, 90] } });
  check("a fan gives a plane an angle, each holding the axis", !("reason" in fan) && fan.length === 3 && fan.every((cut) => near(cut.normal[2], 0, 1e-12)), fan);
  const levels = cutPlanes({ levels: { axis: "y", values: [5, 10] } });
  check("levels along Y are square to Y", !("reason" in levels) && levels.length === 2 && near(levels[1]!.origin[1], 10) && near(levels[1]!.normal[1], 1), levels);
  check("no planes is refused", "reason" in cutPlanes({}));
  check("two kinds of planes are refused", "reason" in cutPlanes({ planes: [{ origin: [0, 0, 0], normal: [0, 0, 1] }], levels: { axis: "z", values: [1] } }));
  check("a plane with no normal is refused", "reason" in cutPlanes({ planes: [{ origin: [0, 0, 0], normal: [0, 0, 0] }] }));
  check("a plane that is not an object is refused", "reason" in cutPlanes({ planes: [null] }));
  check("a bad level axis is refused", "reason" in cutPlanes({ levels: { axis: "w", values: [1] } }));
}

// --- A square ring cut level: one outline with its hole, as regions and as extrude loops.
{
  const tris: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => tris.push(...a, ...b, ...c, ...a, ...c, ...d);
  // A closed square tube, 20 outside and 10 inside, 10 tall: four outer walls, four inner walls, top and bottom rings.
  const ring = (s: number, inward: boolean) => {
    const p = [[-s, -s], [s, -s], [s, s], [-s, s]];
    for (let i = 0; i < 4; i += 1) {
      const a = p[i]!;
      const b = p[(i + 1) % 4]!;
      if (inward) quad([b[0]!, b[1]!, 0], [a[0]!, a[1]!, 0], [a[0]!, a[1]!, 10], [b[0]!, b[1]!, 10]);
      else quad([a[0]!, a[1]!, 0], [b[0]!, b[1]!, 0], [b[0]!, b[1]!, 10], [a[0]!, a[1]!, 10]);
    }
  };
  ring(10, false);
  ring(5, true);
  const cuts = cutPlanes({ levels: { axis: "z", values: [5] } });
  const answer = "reason" in cuts ? {} : meshSection(new Float32Array(tris), cuts[0]!, {});
  const regions = answer.regions as { outer: number[][]; holes: number[][][] }[] | undefined;
  check("a ring cuts to one outline with one hole", regions?.length === 1 && regions[0]!.holes.length === 1, answer);
  check("its area is the outline less the hole", near(Number(answer.areaMm2), 400 - 100, 1e-6), answer.areaMm2);
  const loops = answer.loops as { start: number[]; segments: { to: number[] }[] }[];
  check("the extrude loops close: outline then hole", loops.length === 2 && loops.every((loop) => {
    const last = loop.segments[loop.segments.length - 1]!.to;
    return near(last[0]!, loop.start[0]!) && near(last[1]!, loop.start[1]!);
  }), loops);
  check("the answer names its frame and turn", Array.isArray(answer.turn) && (answer.frame as { w: number[] }).w[2] === 1, answer.frame);
  check("pointsIn counts regions and loops", pointsIn(answer) === 8 + 8, pointsIn(answer));
}

// --- The loops array's lattice and span.
{
  const square = { start: [-1, -1] as [number, number], segments: [{ kind: "line" as const, to: [1, -1] as [number, number] }, { kind: "line" as const, to: [1, 1] as [number, number] }, { kind: "line" as const, to: [-1, 1] as [number, number] }, { kind: "line" as const, to: [-1, -1] as [number, number] }] };
  const laid = latticeLoops({ cell: [square], extent: { u: [0, 10], v: [0, 10] }, pitch: [5, 5], stagger: false, angleDeg: 0, turnDeg: 0 });
  check("a lattice covers the face's extent and no further than a cell reaches", !("reason" in laid) && laid.length === 9, "reason" in laid ? laid : laid.length);
  const turned = latticeLoops({ cell: [square], extent: { u: [0, 10], v: [0, 10] }, pitch: [5, 5], stagger: false, angleDeg: 0, turnDeg: 45 });
  const corner = !("reason" in turned) ? turned[0]!.start : [0, 0];
  check("turnDeg turns each cell about its centre", near(Math.hypot(corner[0]! - Math.round(corner[0]! / 5) * 5, corner[1]! - Math.round(corner[1]! / 5) * 5), Math.SQRT2, 1e-9), corner);
  const crowded = latticeLoops({ cell: [square], extent: { u: [0, 400], v: [0, 400] }, pitch: [5, 5], stagger: false, angleDeg: 0, turnDeg: 0 });
  check(`more than ${MAX_LOOPS} loops is refused`, "reason" in crowded, crowded);
  const cut = cellExtent("cut", 3, 2);
  const raised = cellExtent("fuse", 3, 2);
  check("a cut cell runs into the face from just outside it, its draft reversed", cut.depth === 1 && cut.depth2 === 3 && cut.draftDeg === -2, cut);
  check("a raised cell sinks into the face and keeps its draft", raised.depth === 3 && raised.depth2 === 0.2 && raised.draftDeg === 2, raised);
  check("no draft sends none", cellExtent("cut", 3, 0).draftDeg === undefined);
}

if (failed) {
  console.error(`sections: ${failed} failed`);
  process.exit(1);
}
console.log("sections: ok");
