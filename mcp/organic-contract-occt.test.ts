/**
 * Organic surfaces S1–S5: the TypeScript-to-kernel contract, against real Open CASCADE.
 *
 * Every op here is sent the way a client sends it: model_build / model_apply through the MCP session, so the JSON is
 * what mcp/schema.ts accepts and src/modeling/bake.ts writes, never JSON shaped for the Rust structs. The other tests
 * of these ops (nurbs-sweep, loft-fillet-v2, open-sheets, patch-blend) run against fakeEngine, and the Rust tests write
 * their own JSON, so neither catches a field the two sides spell differently. Each case asserts that the op applied
 * AND one geometric fact that only holds when the field was honoured (a volume against a closed form, a bound that
 * follows the curve, an area against the TS evaluator, a degree read back by model_check {surfaces:true}).
 *
 * Synthetic geometry only. Skips without LIME_OCCT_BRIDGE; fails in CI when it is unset. Runs on the folded-shell job,
 * which has the most headroom of the Open CASCADE jobs.
 *
 * Cases marked KERNEL-PR fail until the kernel fix-round PR (organic-surfaces/fix-kernel: serde aliases so Curve3D
 * spline reads `through` and Curve3D nurbs reads `closed`) is merged. They assert the right thing on purpose; do not
 * skip or loosen them.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { sampleNurbsCurve2D, sampleNurbsCurve3D, type Vec2, type Vec3 } from "../src/modeling/nurbs-eval.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("organic-contract-occt: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("organic-contract-occt: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-organic-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "180";

let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  failures.push(name);
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;
type V3 = [number, number, number];
interface FaceRow { index: number; areaMm2: number; centre: V3 }
interface EdgeRow { index: number; lengthMm: number; start: V3; end: V3; mid: V3 }
interface SolidView {
  volumeMm3: number;
  editable: boolean;
  bounds: { min: V3; max: V3 };
  faces: FaceRow[];
  edges: EdgeRow[];
}

const engine = loadEngineWorker(root);
const session = new Session(engine);
async function call(name: string, args: unknown): Promise<Reply> {
  try {
    return (await session.call(name, args)) as Reply;
  } catch (err) {
    return { ok: false, reason: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}
const solidOf = (object: string): SolidView | undefined =>
  (session as unknown as { find(id: string): { solid?: SolidView } | undefined }).find(object)?.solid;
const why = (reply: Reply) => JSON.stringify(reply.failed?.reason ?? reply.reason ?? reply.error ?? reply).slice(0, 400);

/** One model_build with one base and its ops; the object stays off the plate. */
async function build(name: string, base: Record<string, unknown>, ops: unknown[]): Promise<{ reply: Reply; solid?: SolidView }> {
  const reply = await call("model_build", { name, base, ops, commit: false });
  const solid = reply.ok === true && typeof reply.object === "string" ? solidOf(reply.object) : undefined;
  return { reply, solid };
}
async function apply(object: string, op: unknown): Promise<{ reply: Reply; solid?: SolidView }> {
  const reply = await call("model_apply", { object, op, probe: true });
  return { reply, solid: reply.ok === true ? solidOf(object) : undefined };
}

/** Every case runs alone, so one failure does not hide the next. */
async function testCase(name: string, body: () => Promise<void>) {
  try {
    await body();
  } catch (err) {
    check(name, false, `threw ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

const near = (actual: number | undefined, want: number, tol: number) => actual !== undefined && Number.isFinite(actual) && Math.abs(actual - want) <= tol;
const rel = (actual: number | undefined, want: number, fraction: number) => near(actual, want, Math.abs(want) * fraction);
const totalArea = (solid: SolidView | undefined) => (solid ? solid.faces.reduce((sum, face) => sum + face.areaMm2, 0) : NaN);
const box = (dx: number, dy = dx, dz = dx) => ({ primitive: "box", dx, dy, dz });
/** A 400 mm box: an op with op:"common" inside it leaves the op's own body, so its volume and bounds are the op's. */
const BIG = box(400);
/** A small box at z 0..10 that a sheet is added beside; its six faces total 600 mm². */
const SMALL = box(10);
const SMALL_AREA = 600;

/** Shoelace area of a closed XY polygon. */
function polygonArea(points: readonly (readonly number[])[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twice += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  return Math.abs(twice) / 2;
}
function polylineLength(points: readonly V3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1], points[i]![2] - points[i - 1]![2]);
  return length;
}
const SAMPLES = 400;

/** A closed square polyline at height z, counter-clockwise seen from +Z. */
const square = (half: number, z: number) => ({ kind: "polyline", points: [[-half, -half, z], [half, -half, z], [half, half, z], [-half, half, z]], closed: true });

/**
 * Leaves only the faces above z = 50 of a part that is a small box plus sheets built above it. A sheet op on a part
 * keeps that part's faces beside the sheet (MCP has no way to start a part from a sheet), so the open-sheet cases
 * trim the box away with a planar cutter first. Which side is "above" follows the cutter's normal, so the other side
 * is taken when the first kept the box.
 */
async function isolateAbove(object: string): Promise<SolidView | undefined> {
  const cutter = { mode: "planar", curves: [square(300, 50)] };
  const first = await apply(object, { kind: "trimSplit", sheet: cutter, keep: "above" });
  if (first.reply.ok === true && first.solid && first.solid.bounds.min[2] > 50) return first.solid;
  if (first.reply.ok === true) await call("model_undo", { object });
  const second = await apply(object, { kind: "trimSplit", sheet: cutter, keep: "below" });
  if (second.reply.ok === true && second.solid && second.solid.bounds.min[2] > 50) return second.solid;
  throw new Error(`could not trim the box away: ${why(first.reply)} / ${why(second.reply)}`);
}

/** Edges of a part whose start, mid and end are all at height z. */
function edgesAtZ(solid: SolidView, z: number): EdgeRow[] {
  return solid.edges.filter((edge) => [edge.start, edge.mid, edge.end].every((p) => Math.abs(p[2] - z) < 0.01));
}
const byAngle = (edges: EdgeRow[]) => [...edges].sort((a, b) => Math.atan2(a.mid[1], a.mid[0]) - Math.atan2(b.mid[1], b.mid[0]));

/**
 * A closed polynomial (non-rational) ring at height z: one nurbs segment of a segments chain that ends where it starts,
 * which the kernel builds periodic, through 12 poles on a circle of radius r. One edge, as the Rust blend test's rims.
 * (A closed nurbs curve or spline would say the same, but those need the kernel PR's aliases.)
 */
function ring(r: number, z: number) {
  const poles: V3[] = [];
  for (let i = 1; i < 12; i += 1) poles.push([r * Math.cos((i * Math.PI) / 6), r * Math.sin((i * Math.PI) / 6), z]);
  return { kind: "segments", start: [r, 0, z], segments: [{ kind: "nurbs", poles, degree: 3, to: [r, 0, z] }] };
}

async function surfacesOf(object: string): Promise<Reply> {
  return call("model_check", { object, surfaces: true });
}

try {
  check("Open CASCADE is loaded", (await engine.occt()) === true);

  // ---------------------------------------------------------------- NURBS profile segment (extrude loops)
  // Each extrude is 10 mm on the plane z = 195, op common with the 400 mm box: the volume is the loop's area × 10.
  const extrudeLoop = (segments: unknown[], start: number[]) => ({
    kind: "extrude",
    op: "common",
    origin: [0, 0, 195],
    depth: 10,
    loops: [{ start, segments }],
  });

  await testCase("nurbs segment, open with weights: an exact quarter disc", async () => {
    // Rational quadratic with weights [1, √½, 1] is an exact quarter circle of radius 10: area 25π. Without the weights
    // it is a parabola, area 200/3 + 50 = 116.67, so the volume tells the weights were read.
    const { reply, solid } = await build("nurbs-open-weights", BIG, [extrudeLoop([
      { kind: "line", to: [10, 0] },
      { kind: "nurbs", poles: [[10, 10]], weights: [1, Math.SQRT1_2, 1], degree: 2, to: [0, 10] },
      { kind: "line", to: [0, 0] },
    ], [0, 0])]);
    check("nurbs segment, open with weights: an exact quarter disc", reply.ok === true && rel(solid?.volumeMm3, 250 * Math.PI, 1e-5), `volume ${solid?.volumeMm3} want ${250 * Math.PI}; ${why(reply)}`);
  });

  await testCase("nurbs segment, closed (periodic): a loop of one segment back to its start", async () => {
    // A segment that ends where its loop starts, with interior poles, is one periodic B-spline through the start pole.
    const poles: Vec2[] = [[12, 0], [0, 10], [-12, 0], [0, -10]];
    const area = polygonArea(sampleNurbsCurve2D({ poles, degree: 3, periodic: true }, SAMPLES));
    const clamped = polygonArea(sampleNurbsCurve2D({ poles: [...poles, poles[0]!], degree: 3 }, SAMPLES));
    const { reply, solid } = await build("nurbs-closed", BIG, [extrudeLoop([{ kind: "nurbs", poles: poles.slice(1), to: poles[0] }], poles[0]!)]);
    check(
      "nurbs segment, closed (periodic): a loop of one segment back to its start",
      reply.ok === true && rel(solid?.volumeMm3, area * 10, 1e-4) && Math.abs(area - clamped) > area * 1e-2,
      `volume ${solid?.volumeMm3} want ${area * 10} (clamped would be ${clamped * 10}); ${why(reply)}`,
    );
  });

  await testCase("nurbs segment, custom knots and mults", async () => {
    const poles: Vec2[] = [[0, 0], [6, -4], [12, 0], [12, 6], [12, 12]];
    const knots = [0, 0.25, 1];
    const mults = [4, 1, 4];
    const curve = sampleNurbsCurve2D({ poles, degree: 3, knots, mults }, SAMPLES);
    const area = polygonArea([...curve, [0, 12]]);
    const uniform = polygonArea([...sampleNurbsCurve2D({ poles, degree: 3 }, SAMPLES), [0, 12]]);
    const { reply, solid } = await build("nurbs-knots", BIG, [extrudeLoop([
      { kind: "nurbs", poles: poles.slice(1, -1), degree: 3, knots, mults, to: poles[4] },
      { kind: "line", to: [0, 12] },
      { kind: "line", to: [0, 0] },
    ], poles[0]!)]);
    check(
      "nurbs segment, custom knots and mults",
      // The kernel's volume on CI was 1574.727 against the exact 1575.000 (1.7e-4); uniform knots give 1554.0, 1.3 %
      // off, so 5e-4 still tells the knots were read.
      reply.ok === true && rel(solid?.volumeMm3, area * 10, 5e-4) && Math.abs(area - uniform) > area * 5e-3,
      `volume ${solid?.volumeMm3} want ${area * 10} (uniform knots would be ${uniform * 10}); ${why(reply)}`,
    );
  });

  // ---------------------------------------------------------------- sweep
  // A circle of radius 3 on the plane through the spine's start, normal to it, op common with the 400 mm box.
  const r = 3;
  const startRing = { origin: [0, 0, 180], turn: [0, 0, 0], radius: r };
  const torusQuarter = Math.PI * r * r * (Math.PI / 2) * 20; // Pappus: a quarter circle of radius 20, 90π².
  const sweep = (spine: unknown, extra: Record<string, unknown> = {}, sections: unknown[] = [startRing]) => ({ kind: "sweep", op: "common", sections, spine, ...extra });

  await testCase("sweep along a path (the old sweep)", async () => {
    const { reply, solid } = await build("sweep-path", BIG, [{ kind: "sweep", op: "common", path: [[0, 0, 180], [0, 0, 220]], radius: r }]);
    check("sweep along a path (the old sweep)", reply.ok === true && rel(solid?.volumeMm3, Math.PI * r * r * 40, 1e-3) && near(solid?.bounds.max[2], 220, 0.05), `volume ${solid?.volumeMm3} want ${Math.PI * 360}; ${why(reply)}`);
  });

  await testCase("sweep spine: a line segment", async () => {
    const { reply, solid } = await build("sweep-line", BIG, [sweep({ kind: "segments", start: [0, 0, 180], segments: [{ kind: "line", to: [0, 0, 220] }] })]);
    check("sweep spine: a line segment", reply.ok === true && rel(solid?.volumeMm3, Math.PI * r * r * 40, 1e-5) && near(solid?.bounds.max[2], 220, 0.05), `volume ${solid?.volumeMm3} want ${Math.PI * 360}; ${why(reply)}`);
  });

  const arcSpine = { kind: "segments", start: [0, 0, 180], segments: [{ kind: "arc", through: [20 - 20 * Math.SQRT1_2, 0, 180 + 20 * Math.SQRT1_2], to: [20, 0, 200] }] };
  await testCase("sweep spine: an arc segment (a quarter torus)", async () => {
    const { reply, solid } = await build("sweep-arc", BIG, [sweep(arcSpine)]);
    check(
      "sweep spine: an arc segment (a quarter torus)",
      reply.ok === true && rel(solid?.volumeMm3, torusQuarter, 1e-4) && near(solid?.bounds.max[0], 20, 0.05) && near(solid?.bounds.max[2], 203, 0.05),
      `volume ${solid?.volumeMm3} want ${torusQuarter}; bounds ${JSON.stringify(solid?.bounds)}; ${why(reply)}`,
    );
  });

  await testCase("sweep spine: spline through points [KERNEL-PR]", async () => {
    // KERNEL-PR: Curve3D spline is written {kind:"spline", through} by the schema, the app and .lime files; the kernel
    // reads `points` until the fix-kernel serde alias merges ("missing field `points`" before it).
    const { reply, solid } = await build("sweep-spline", BIG, [sweep({ kind: "spline", through: [[0, 0, 180], [0, 0, 200], [20, 0, 200]] })]);
    check(
      "sweep spine: spline through points [KERNEL-PR]",
      reply.ok === true && (solid?.bounds.max[0] ?? 0) > 19.5 && (solid?.bounds.max[2] ?? 0) > 201 && near(solid?.bounds.min[2], 180, 0.5),
      `bounds ${JSON.stringify(solid?.bounds)}; ${why(reply)}`,
    );
  });

  await testCase("sweep spine: rational nurbs (weights make it a circle)", async () => {
    const { reply, solid } = await build("sweep-nurbs", BIG, [sweep({ kind: "nurbs", poles: [[0, 0, 180], [0, 0, 200], [20, 0, 200]], weights: [1, Math.SQRT1_2, 1], degree: 2 })]);
    check(
      "sweep spine: rational nurbs (weights make it a circle)",
      reply.ok === true && rel(solid?.volumeMm3, torusQuarter, 1e-4) && near(solid?.bounds.max[0], 20, 0.05),
      `volume ${solid?.volumeMm3} want ${torusQuarter}; ${why(reply)}`,
    );
  });

  await testCase("sweep spine: nurbs segment inside a chain, custom knots", async () => {
    // Interior poles between the chain's previous point and `to`, as in a profile segment; a straight control polygon
    // keeps the volume exact whatever the knots, and the knots must be accepted as given.
    const spine = { kind: "segments", start: [0, 0, 180], segments: [{ kind: "nurbs", poles: [[0, 0, 185], [0, 0, 195], [0, 0, 210]], degree: 3, knots: [0, 0.4, 1], mults: [4, 1, 4], to: [0, 0, 220] }] };
    const { reply, solid } = await build("sweep-nurbs-seg", BIG, [sweep(spine)]);
    check("sweep spine: nurbs segment inside a chain, custom knots", reply.ok === true && rel(solid?.volumeMm3, Math.PI * r * r * 40, 1e-5), `volume ${solid?.volumeMm3}; ${why(reply)}`);
  });

  await testCase("sweep spine: an edge chain of the part", async () => {
    // A circle of radius 2 swept along the 40 mm top front edge of a 40 mm box and cut: a quarter cylinder groove, 40π.
    const made = await build("sweep-edge-base", box(40), []);
    const edge = made.solid?.edges.find((row) => [row.start, row.end].every((p) => near(p[1], -20, 1e-6) && near(p[2], 40, 1e-6)));
    if (!made.solid || !edge) throw new Error(`no top front edge: ${why(made.reply)}`);
    const dir = Math.sign(edge.end[0] - edge.start[0]);
    const { reply, solid } = await apply(made.reply.object, { kind: "sweep", op: "cut", sections: [{ origin: edge.start, turn: [0, 90 * dir, 0], radius: 2 }], spine: { kind: "edges", edges: [edge.index] } });
    check("sweep spine: an edge chain of the part", reply.ok === true && near(solid?.volumeMm3, 64000 - 40 * Math.PI, 0.01), `volume ${solid?.volumeMm3} want ${64000 - 40 * Math.PI}; ${why(reply)}`);
  });

  await testCase("sweep corner transitions: right, round, transformed", async () => {
    const elbow = { kind: "segments", start: [0, 0, 180], segments: [{ kind: "line", to: [0, 0, 200] }, { kind: "line", to: [20, 0, 200] }] };
    const right = await build("sweep-right", BIG, [sweep(elbow, { transition: "right" })]);
    const round = await build("sweep-round", BIG, [sweep(elbow, { transition: "round" })]);
    // A transformed corner left a damaged solid at this 90° bend (115 edges where pieces meet along a line): the
    // session's guard took it back, and the kernel (#823) refuses it there. Along a smooth spine it builds.
    const transformedElbow = await build("sweep-transformed-elbow", BIG, [sweep(elbow, { transition: "transformed" })]);
    const transformed = await build("sweep-transformed", BIG, [sweep(arcSpine, { transition: "transformed" })]);
    // A mitred elbow keeps π r² times the centreline length (20 + 20). A round corner is another shape there (on CI
    // 1123.25 against the mitre's 1130.97), so the volumes differ when the transition is read.
    const mitre = Math.PI * r * r * 40;
    check(
      "sweep corner transitions: right, round, transformed",
      right.reply.ok === true && round.reply.ok === true && transformed.reply.ok === true && transformedElbow.reply.ok === false
        && rel(right.solid?.volumeMm3, mitre, 1e-4) && Math.abs((round.solid?.volumeMm3 ?? mitre) - mitre) > 1 && rel(transformed.solid?.volumeMm3, torusQuarter, 1e-4),
      `right ${right.solid?.volumeMm3} want ${mitre}; round ${round.solid?.volumeMm3}; transformed on the arc ${transformed.solid?.volumeMm3} want ${torusQuarter}; on the elbow ${why(transformedElbow.reply)}; ${why(right.reply)} ${why(round.reply)} ${why(transformed.reply)}`,
    );
  });

  const line40 = { kind: "segments", start: [0, 0, 180], segments: [{ kind: "line", to: [0, 0, 220] }] };
  await testCase("sweep scale stations: radius 3 grows to 6", async () => {
    const { reply, solid } = await build("sweep-scale", BIG, [sweep(line40, { scale: [[0, 1], [1, 2]] })]);
    check("sweep scale stations: radius 3 grows to 6", reply.ok === true && near(solid?.bounds.max[0], 6, 0.05) && near(solid?.bounds.max[2], 220, 0.05), `bounds ${JSON.stringify(solid?.bounds)}; ${why(reply)}`);
  });

  const squareSection = { origin: [0, 0, 180], turn: [0, 0, 0], profile: [[-3, -3], [3, -3], [3, 3], [-3, 3]] };
  await testCase("sweep twist: a 6 mm square turned 45° at the end", async () => {
    const { reply, solid } = await build("sweep-twist", BIG, [sweep(line40, { twistDeg: 45 }, [squareSection])]);
    check("sweep twist: a 6 mm square turned 45° at the end", reply.ok === true && (solid?.bounds.max[0] ?? 0) > 4.1, `bounds ${JSON.stringify(solid?.bounds)} (no twist leaves 3); ${why(reply)}`);
  });

  await testCase("sweep mode: frenet along the arc, fixedBinormal along the line", async () => {
    const frenet = await build("sweep-frenet", BIG, [sweep(arcSpine, { mode: { kind: "frenet" } })]);
    const fixed = await build("sweep-fixed", BIG, [sweep(line40, { mode: { kind: "fixedBinormal", dir: [1, 0, 0] } }, [squareSection])]);
    check(
      "sweep mode: frenet along the arc, fixedBinormal along the line",
      frenet.reply.ok === true && rel(frenet.solid?.volumeMm3, torusQuarter, 1e-4) && fixed.reply.ok === true && rel(fixed.solid?.volumeMm3, 36 * 40, 1e-5),
      `frenet ${frenet.solid?.volumeMm3}; fixed ${fixed.solid?.volumeMm3}; ${why(frenet.reply)} ${why(fixed.reply)}`,
    );
  });

  await testCase("sweep mode: auxSpine [KERNEL: no auxSpine mode]", async () => {
    // The schema and bake send mode {kind:"auxSpine", spine}; the kernel's SweepMode has no auxSpine variant (it has a
    // separate aux_spine field), so this fails until the kernel reads it. Reported to the kernel side.
    const aux = { kind: "segments", start: [10, 0, 180], segments: [{ kind: "line", to: [10, 0, 220] }] };
    const { reply, solid } = await build("sweep-aux", BIG, [sweep(line40, { mode: { kind: "auxSpine", spine: aux } }, [squareSection])]);
    check("sweep mode: auxSpine [KERNEL: no auxSpine mode]", reply.ok === true && rel(solid?.volumeMm3, 36 * 40, 1e-4), `volume ${solid?.volumeMm3}; ${why(reply)}`);
  });

  // ---------------------------------------------------------------- loft v2
  await testCase("loft apex: a circle to a point is a cone", async () => {
    const { reply, solid } = await build("loft-apex", BIG, [{ kind: "loft", op: "common", sections: [{ origin: [0, 0, 180], radius: 5 }, { apex: [0, 0, 200] }] }]);
    const cone = (Math.PI * 25 * 20) / 3;
    check("loft apex: a circle to a point is a cone", reply.ok === true && rel(solid?.volumeMm3, cone, 1e-2) && near(solid?.bounds.max[2], 200, 0.05), `volume ${solid?.volumeMm3} want ${cone}; ${why(reply)}`);
  });

  const tube = [{ origin: [0, 0, 180], radius: 5 }, { origin: [0, 0, 220], radius: 5 }];
  await testCase("loft guide: a nurbs rail bulges a 5 mm tube", async () => {
    const { reply, solid } = await build("loft-guide-nurbs", BIG, [{ kind: "loft", op: "common", sections: tube, guides: [{ kind: "nurbs", poles: [[5, 0, 180], [12, 0, 200], [5, 0, 220]], degree: 2 }] }]);
    check("loft guide: a nurbs rail bulges a 5 mm tube", reply.ok === true && (solid?.bounds.max[0] ?? 0) > 7, `bounds ${JSON.stringify(solid?.bounds)} (no guide leaves 5); ${why(reply)}`);
  });

  await testCase("loft guide: a spline rail [KERNEL-PR]", async () => {
    // KERNEL-PR: a spline guide is {kind:"spline", through}; fails with "missing field `points`" until the alias merges.
    const { reply, solid } = await build("loft-guide-spline", BIG, [{ kind: "loft", op: "common", sections: tube, guides: [{ kind: "spline", through: [[5, 0, 180], [8.5, 0, 200], [5, 0, 220]] }] }]);
    check("loft guide: a spline rail [KERNEL-PR]", reply.ok === true && (solid?.bounds.max[0] ?? 0) > 7, `bounds ${JSON.stringify(solid?.bounds)}; ${why(reply)}`);
  });

  await testCase("loft start and end conditions change the frustum", async () => {
    const frustum = [{ origin: [0, 0, 180], radius: 5 }, { origin: [0, 0, 220], radius: 8 }];
    const plain = await build("loft-plain", BIG, [{ kind: "loft", op: "common", sections: frustum }]);
    const normal = await build("loft-normal", BIG, [{ kind: "loft", op: "common", sections: frustum, startCondition: { kind: "normal", tension: 2 }, endCondition: { kind: "tangent", dir: [0, 0, 1], tension: 1.5 } }]);
    const tangent = await build("loft-tangent", BIG, [{ kind: "loft", op: "common", sections: frustum, startCondition: { kind: "tangent", dir: [1, 0, 1], tension: 1 } }]);
    const exact = (Math.PI * 40 * (25 + 40 + 64)) / 3;
    const p = plain.solid?.volumeMm3 ?? NaN;
    check(
      "loft start and end conditions change the frustum",
      plain.reply.ok === true && rel(p, exact, 1e-3) && normal.reply.ok === true && tangent.reply.ok === true
        && Math.abs((normal.solid?.volumeMm3 ?? p) - p) > p * 1e-3 && Math.abs((tangent.solid?.volumeMm3 ?? p) - p) > p * 1e-3,
      `plain ${p} want ${exact}; normal+tangent ${normal.solid?.volumeMm3}; tangent ${tangent.solid?.volumeMm3}; ${why(normal.reply)} ${why(tangent.reply)}`,
    );
  });

  await testCase("loft closed: four rings make a whole torus", async () => {
    // Each ring's plane normal is the circle's tangent: turn [-90, 0, θ] takes W to (-sin θ, cos θ, 0).
    const sections = [0, 90, 180, 270].map((deg) => {
      const a = (deg * Math.PI) / 180;
      return { origin: [20 * Math.cos(a), 20 * Math.sin(a), 200], turn: [-90, 0, deg], radius: 4 };
    });
    const torus = 2 * Math.PI * Math.PI * 20 * 16;
    const { reply, solid } = await build("loft-closed", BIG, [{ kind: "loft", op: "common", sections, closed: true }]);
    check(
      "loft closed: four rings make a whole torus",
      // A periodic ring through four circles bulges past the torus between them (on CI 6808, +7.8 %); an open loft
      // through the same four would span 270° and keep about three quarters. So: within -5 % and +15 % of the torus.
      reply.ok === true && (solid?.volumeMm3 ?? 0) > torus * 0.95 && (solid?.volumeMm3 ?? Infinity) < torus * 1.15 && near(solid?.bounds.min[1], -(solid?.bounds.max[1] ?? NaN), 0.5),
      `volume ${solid?.volumeMm3} want ≈ ${torus} (open would be about 3/4); bounds ${JSON.stringify(solid?.bounds)}; ${why(reply)}`,
    );
  });

  // Four circles along Z: the loft's degree across the sections (V) is 3. The circles' own direction (U) reads 14 on
  // CI, so only V says what maxDegree did.
  const wavy = [180, 190, 200, 210].map((z, i) => ({ origin: [0, 0, z], radius: i % 2 === 0 ? 5 : 7 }));
  const vDegree = async (made: { reply: Reply }) => (made.reply.ok === true ? Number((await surfacesOf(made.reply.object)).surfaceHealth?.maxVDegree) : NaN);
  await testCase("loft maxDegree: the degree across the sections is capped", async () => {
    const plain = await build("loft-deg-plain", BIG, [{ kind: "loft", op: "common", sections: wavy }]);
    const capped = await build("loft-deg-capped", BIG, [{ kind: "loft", op: "common", sections: wavy, maxDegree: 2 }]);
    const p = await vDegree(plain);
    const c = await vDegree(capped);
    check("loft maxDegree: the degree across the sections is capped", capped.reply.ok === true && p >= 3 && c <= 2, `V degree plain ${p}, maxDegree 2 ${c}; ${why(capped.reply)}`);
  });

  await testCase("loft smoothing: builds and keeps the volume within 5 %", async () => {
    const plain = await build("loft-smooth-plain", BIG, [{ kind: "loft", op: "common", sections: wavy }]);
    const smooth = await build("loft-smooth", BIG, [{ kind: "loft", op: "common", sections: wavy, smoothing: true }]);
    check(
      "loft smoothing: builds and keeps the volume within 5 %",
      smooth.reply.ok === true && rel(smooth.solid?.volumeMm3, plain.solid?.volumeMm3 ?? NaN, 0.05),
      `plain ${plain.solid?.volumeMm3}, smoothing ${smooth.solid?.volumeMm3}, V degree ${await vDegree(smooth)}; ${why(smooth.reply)}`,
    );
  });

  // ---------------------------------------------------------------- fillet v2
  const twenty = box(20);
  const removed = (radius: number) => (1 - Math.PI / 4) * radius * radius * 20;
  let topEdge = -1;
  await testCase("fillet: find the top front edge", async () => {
    const made = await build("fillet-base", twenty, []);
    const edge = made.solid?.edges.find((row) => [row.start, row.end].every((p) => near(p[1], -10, 1e-6) && near(p[2], 20, 1e-6)));
    topEdge = edge?.index ?? -1;
    check("fillet: find the top front edge", topEdge >= 0, why(made.reply));
  });
  const fillet = (extra: Record<string, unknown>) => ({ kind: "fillet", edges: [topEdge], size: 2, ...extra });

  await testCase("fillet continuity g1 and g2: model_check reads the seams", async () => {
    const g1 = await build("fillet-g1", twenty, [fillet({ continuity: "g1" })]);
    const g2 = await build("fillet-g2", twenty, [fillet({ continuity: "g2" })]);
    const g1Seams = g1.reply.ok === true ? (await surfacesOf(g1.reply.object)).continuity : undefined;
    const g2Seams = g2.reply.ok === true ? (await surfacesOf(g2.reply.object)).continuity : undefined;
    check(
      "fillet continuity g1 and g2: model_check reads the seams",
      g1.reply.ok === true && near(g1.solid?.volumeMm3, 8000 - removed(2), 1e-3) && (g1Seams?.g1 ?? 0) >= 2
        && g2.reply.ok === true && g2Seams?.g1 === 0 && (g2Seams?.g2 ?? 0) >= 2 && Math.abs((g2.solid?.volumeMm3 ?? 0) - (g1.solid?.volumeMm3 ?? 0)) > 0.05,
      `g1 ${g1.solid?.volumeMm3} want ${8000 - removed(2)} seams ${JSON.stringify(g1Seams && { g0: g1Seams.g0, g1: g1Seams.g1, g2: g1Seams.g2 })}; g2 ${g2.solid?.volumeMm3} seams ${JSON.stringify(g2Seams && { g0: g2Seams.g0, g1: g2Seams.g1, g2: g2Seams.g2 })}; ${why(g1.reply)} ${why(g2.reply)}`,
    );
  });

  await testCase("fillet conic: rho changes the section", async () => {
    const lean = await build("fillet-conic-3", twenty, [fillet({ continuity: "conic", rho: 0.3 })]);
    const full = await build("fillet-conic-8", twenty, [fillet({ continuity: "conic", rho: 0.8 })]);
    check(
      "fillet conic: rho changes the section",
      lean.reply.ok === true && full.reply.ok === true && Math.abs((full.solid?.volumeMm3 ?? 0) - (lean.solid?.volumeMm3 ?? 0)) > 0.05,
      `rho 0.3 ${lean.solid?.volumeMm3}; rho 0.8 ${full.solid?.volumeMm3}; ${why(lean.reply)} ${why(full.reply)}`,
    );
  });

  await testCase("fillet variable: radius 1 to 3 removes between the two constant fillets", async () => {
    const { reply, solid } = await build("fillet-variable", twenty, [{ kind: "fillet", edges: [topEdge], size: 1, variable: [[0, 1], [1, 3]] }]);
    const v = solid?.volumeMm3 ?? NaN;
    check(
      "fillet variable: radius 1 to 3 removes between the two constant fillets",
      reply.ok === true && v < 8000 - removed(1) - 0.5 && v > 8000 - removed(3) + 0.5,
      `volume ${v}, between ${8000 - removed(3)} and ${8000 - removed(1)}; ${why(reply)}`,
    );
  });

  // ---------------------------------------------------------------- open sheets
  await testCase("sheet extrude: a nurbs arch along Y", async () => {
    const arch = { kind: "nurbs", poles: [[-15, -15, 110], [0, -15, 118], [15, -15, 110]], degree: 2 };
    const length = polylineLength(sampleNurbsCurve3D({ poles: arch.poles as Vec3[], degree: 2 }, 2000));
    const { reply, solid } = await build("sheet-extrude", SMALL, [{ kind: "sheet", mode: "extrude", curves: [arch], dir: [0, 1, 0], distance: 30 }]);
    check(
      "sheet extrude: a nurbs arch along Y",
      reply.ok === true && solid?.editable === false && near(solid?.bounds.max[2], 114, 0.05) && near(solid?.bounds.max[1], 15, 0.05)
        && rel(totalArea(solid) - SMALL_AREA, length * 30, 1e-4),
      `area ${totalArea(solid) - SMALL_AREA} want ${length * 30}; bounds ${JSON.stringify(solid?.bounds)}; editable ${solid?.editable}; ${why(reply)}`,
    );
  });

  await testCase("sheet extrude symmetric: both sides of the curve", async () => {
    const line = { kind: "polyline", points: [[-10, -15, 110], [10, -15, 110]] };
    const { reply, solid } = await build("sheet-symmetric", SMALL, [{ kind: "sheet", mode: "extrude", curves: [line], dir: [0, 1, 0], distance: 10, symmetric: true }]);
    check("sheet extrude symmetric: both sides of the curve", reply.ok === true && (solid?.bounds.min[1] ?? 0) < -16 && (solid?.bounds.max[1] ?? -99) > -14, `bounds ${JSON.stringify(solid?.bounds)}; ${why(reply)}`);
  });

  await testCase("sheet revolve: a line about Z, 360° and 180°", async () => {
    const line = { kind: "polyline", points: [[10, 0, 100], [10, 0, 110]] };
    const whole = await build("sheet-revolve", SMALL, [{ kind: "sheet", mode: "revolve", curves: [line], axisOrigin: [0, 0, 0], dir: [0, 0, 1], angleDeg: 360 }]);
    const half = await build("sheet-revolve-half", SMALL, [{ kind: "sheet", mode: "revolve", curves: [line], axisOrigin: [0, 0, 0], dir: [0, 0, 1], angleDeg: 180 }]);
    check(
      "sheet revolve: a line about Z, 360° and 180°",
      whole.reply.ok === true && rel(totalArea(whole.solid) - SMALL_AREA, 200 * Math.PI, 1e-4) && half.reply.ok === true && rel(totalArea(half.solid) - SMALL_AREA, 100 * Math.PI, 1e-4),
      `360° ${totalArea(whole.solid) - SMALL_AREA} 180° ${totalArea(half.solid) - SMALL_AREA}; ${why(whole.reply)} ${why(half.reply)}`,
    );
  });

  await testCase("sheet loft: two lines, ruled", async () => {
    const curves = [{ kind: "polyline", points: [[-10, -10, 100], [10, -10, 100]] }, { kind: "polyline", points: [[-10, 10, 100], [10, 10, 100]] }];
    const { reply, solid } = await build("sheet-loft", SMALL, [{ kind: "sheet", mode: "loft", curves, ruled: true }]);
    check("sheet loft: two lines, ruled", reply.ok === true && rel(totalArea(solid) - SMALL_AREA, 400, 1e-6), `area ${totalArea(solid) - SMALL_AREA}; ${why(reply)}`);
  });

  await testCase("sheet planar: a closed polyline and a chain with a rational nurbs segment", async () => {
    const polygon = await build("sheet-planar", SMALL, [{ kind: "sheet", mode: "planar", curves: [square(10, 100)] }]);
    const quarter = {
      kind: "segments",
      start: [10, 0, 100],
      segments: [{ kind: "nurbs", poles: [[10, 10, 100]], weights: [1, Math.SQRT1_2, 1], degree: 2, to: [0, 10, 100] }, { kind: "line", to: [0, 0, 100] }, { kind: "line", to: [10, 0, 100] }],
    };
    const disc = await build("sheet-planar-quarter", SMALL, [{ kind: "sheet", mode: "planar", curves: [quarter] }]);
    check(
      "sheet planar: a closed polyline and a chain with a rational nurbs segment",
      polygon.reply.ok === true && rel(totalArea(polygon.solid) - SMALL_AREA, 400, 1e-6) && disc.reply.ok === true && rel(totalArea(disc.solid) - SMALL_AREA, 25 * Math.PI, 1e-5),
      `square ${totalArea(polygon.solid) - SMALL_AREA}; quarter disc ${totalArea(disc.solid) - SMALL_AREA} want ${25 * Math.PI}; ${why(polygon.reply)} ${why(disc.reply)}`,
    );
  });

  await testCase("sheet planar: a closed (periodic) nurbs curve [KERNEL-PR]", async () => {
    // KERNEL-PR: `closed` on a Curve3D nurbs is read as `periodic` by the kernel and dropped until the fix-kernel alias
    // merges; an open curve cannot bound a planar face, so this is refused before it.
    const poles: Vec3[] = [0, 60, 120, 180, 240, 300].map((deg) => [10 * Math.cos((deg * Math.PI) / 180), 10 * Math.sin((deg * Math.PI) / 180), 100]);
    const area = polygonArea(sampleNurbsCurve3D({ poles, degree: 3, periodic: true }, SAMPLES));
    const { reply, solid } = await build("sheet-closed-nurbs", SMALL, [{ kind: "sheet", mode: "planar", curves: [{ kind: "nurbs", poles, degree: 3, closed: true }] }]);
    check("sheet planar: a closed (periodic) nurbs curve [KERNEL-PR]", reply.ok === true && rel(totalArea(solid) - SMALL_AREA, area, 1e-4), `area ${totalArea(solid) - SMALL_AREA} want ${area}; ${why(reply)}`);
  });

  // An open square tube 20 × 20, z 100..110, with the small box trimmed away: four walls and two open rims.
  async function openTube(name: string): Promise<{ object: string; solid: SolidView }> {
    const made = await build(name, SMALL, [{ kind: "sheet", mode: "extrude", curves: [square(10, 100)], dir: [0, 0, 1], distance: 10 }]);
    if (made.reply.ok !== true) throw new Error(`tube: ${why(made.reply)}`);
    const object = made.reply.object as string;
    const solid = await isolateAbove(object);
    if (!solid) throw new Error("tube: no solid");
    return { object, solid };
  }

  await testCase("trimSplit of a sheet keeps the cut piece; sew caps a tube into a 4000 mm³ box", async () => {
    const tube = await openTube("sew-tube");
    const walls = tube.solid.faces.length;
    const { reply, solid } = await apply(tube.object, { kind: "sew", tolerance: 0.01, capPlanar: true, makeSolid: true });
    check(
      "trimSplit of a sheet keeps the cut piece; sew caps a tube into a 4000 mm³ box",
      walls === 4 && tube.solid.editable === false && reply.ok === true && solid?.editable === true && rel(solid?.volumeMm3, 4000, 1e-6),
      `walls ${walls}; sewn ${solid?.volumeMm3} editable ${solid?.editable}; ${why(reply)}`,
    );
  });

  await testCase("an open sheet on the plate refuses slice; thickened, it slices", async () => {
    // The kernel's reply marks the committed sheet (mcp/session/sheet.ts); thicken and a new commit clear the mark.
    const made = await build("slice-sheet", SMALL, [{ kind: "sheet", mode: "planar", curves: [square(10, 100)] }]);
    if (made.reply.ok !== true) throw new Error(why(made.reply));
    const object = made.reply.object as string;
    await isolateAbove(object);
    const committed = await call("model_commit", { object });
    await call("object_select", { object });
    const refused = await call("slice_start", { wait: true });
    const thick = await apply(object, { kind: "thicken", thickness: 2, direction: "normal" });
    const recommitted = await call("model_commit", { object });
    const sliced = await call("slice_start", { wait: true });
    check(
      "an open sheet on the plate refuses slice; thickened, it slices",
      committed.ok === true && refused.ok === false && refused.code === "open-sheet" && refused.object === object
        && thick.reply.ok === true && recommitted.ok === true && sliced.ok === true && sliced.status === "done",
      `commit ${why(committed)}; first slice ${JSON.stringify({ ok: refused.ok, code: refused.code, reason: refused.reason })}; thicken ${why(thick.reply)}; recommit ${why(recommitted)}; slice ${JSON.stringify({ ok: sliced.ok, status: sliced.status, reason: sliced.reason })}`,
    );
  });

  await testCase("the other half of a NURBS sheet's trimSplit is a sheet: slice refuses it with open-sheet", async () => {
    // A 4 x 4 dome cut across by a sheet, keep both: the other half is a new object, a sheet by the kernel's verdict.
    const dome = [-15, -5, 5, 15].map((x, i) => [-15, -5, 5, 15].map((y, j) => [x, y, (i === 1 || i === 2) && (j === 1 || j === 2) ? 6 : 0]));
    const made = await call("solid_new", { feature: { kind: "nurbsSurface", poles: dome } });
    if (made.ok !== true) throw new Error(why(made));
    const object = made.object as string;
    const cutter = { mode: "extrude", curves: [{ kind: "polyline", points: [[0, -20, -5], [0, 20, -5]] }], dir: [0, 0, 1], distance: 20 };
    const cut = await call("model_apply", { object, op: { kind: "trimSplit", sheet: cutter, keep: "both" } });
    const other = typeof cut.other === "string" ? cut.other : null;
    if (other) await call("object_select", { object: other });
    const refused = other ? await call("slice_start", { scope: "object", wait: true }) : null;
    check(
      "the other half of a NURBS sheet's trimSplit is a sheet: slice refuses it with open-sheet",
      cut.ok === true && other !== null && refused?.ok === false && refused.code === "open-sheet" && refused.object === other,
      `cut ${why(cut)} other ${other}; slice ${JSON.stringify(refused && { ok: refused.ok, code: refused.code, reason: refused.reason })}`,
    );
  });

  await testCase("thicken: a 20 mm square, normal 2 and both 3", async () => {
    const one = await build("thicken-normal", SMALL, [{ kind: "sheet", mode: "planar", curves: [square(10, 100)] }]);
    if (one.reply.ok !== true) throw new Error(why(one.reply));
    await isolateAbove(one.reply.object);
    const normal = await apply(one.reply.object, { kind: "thicken", thickness: 2, direction: "normal", tolerance: 0.001 });
    const two = await build("thicken-both", SMALL, [{ kind: "sheet", mode: "planar", curves: [square(10, 100)] }]);
    if (two.reply.ok !== true) throw new Error(why(two.reply));
    await isolateAbove(two.reply.object);
    const both = await apply(two.reply.object, { kind: "thicken", thickness: 3, direction: "both" });
    check(
      "thicken: a 20 mm square, normal 2 and both 3",
      normal.reply.ok === true && normal.solid?.editable === true && rel(normal.solid?.volumeMm3, 800, 1e-6)
        && both.reply.ok === true && rel(both.solid?.volumeMm3, 1200, 1e-6) && near(both.solid?.bounds.min[2], 98.5, 0.01) && near(both.solid?.bounds.max[2], 101.5, 0.01),
      `normal ${normal.solid?.volumeMm3}; both ${both.solid?.volumeMm3} bounds ${JSON.stringify(both.solid?.bounds)}; ${why(normal.reply)} ${why(both.reply)}`,
    );
  });

  await testCase("trimSplit of a solid: keep above, below and both", async () => {
    const cutter = { mode: "planar", curves: [square(50, 5)] };
    const above = await build("trim-above", twenty, [{ kind: "trimSplit", sheet: cutter, keep: "above" }]);
    const below = await build("trim-below", twenty, [{ kind: "trimSplit", sheet: cutter, keep: "below" }]);
    const base = await build("trim-both", twenty, []);
    const both = base.reply.ok === true ? await apply(base.reply.object, { kind: "trimSplit", sheet: cutter, keep: "both" }) : { reply: base.reply, solid: undefined };
    const kept = [above.solid?.volumeMm3 ?? 0, below.solid?.volumeMm3 ?? 0].sort((a, b) => a - b);
    const bothKept = both.solid?.volumeMm3 ?? 0;
    const other = typeof both.reply.other === "string" ? solidOf(both.reply.other)?.volumeMm3 ?? 0 : 0;
    check(
      "trimSplit of a solid: keep above, below and both",
      above.reply.ok === true && below.reply.ok === true && both.reply.ok === true && rel(kept[0], 2000, 1e-6) && rel(kept[1], 6000, 1e-6)
        && rel(bothKept + other, 8000, 1e-6) && Math.min(bothKept, other) > 1000,
      `above ${above.solid?.volumeMm3} below ${below.solid?.volumeMm3} both ${bothKept} + other ${other}; ${why(above.reply)} ${why(both.reply)}`,
    );
  });

  await testCase("replaceFace: the top of a 20 mm box moved to a sheet at z 25", async () => {
    const roof = { mode: "loft", curves: [{ kind: "polyline", points: [[-15, -15, 25], [15, -15, 25]] }, { kind: "polyline", points: [[-15, 15, 25], [15, 15, 25]] }], ruled: true };
    const bySelector = await build("replace-selector", twenty, [{ kind: "replaceFace", face: { normal: [0, 0, 1], nearPoint: [0, 0, 20] }, sheet: roof }]);
    const base = await build("replace-index-base", twenty, []);
    const topFace = base.solid?.faces.find((face) => near(face.centre[2], 20, 1e-6))?.index;
    const byIndex = base.reply.ok === true && topFace !== undefined
      ? await apply(base.reply.object, { kind: "replaceFace", face: topFace, sheet: roof })
      : { reply: { ok: false, reason: `no top face: ${why(base.reply)}` } as Reply, solid: undefined };
    check(
      "replaceFace: the top of a 20 mm box moved to a sheet at z 25",
      bySelector.reply.ok === true && rel(bySelector.solid?.volumeMm3, 10000, 1e-6) && near(bySelector.solid?.bounds.max[2], 25, 0.01)
        && byIndex.reply.ok === true && rel(byIndex.solid?.volumeMm3, 10000, 1e-6),
      `selector ${bySelector.solid?.volumeMm3}; index ${byIndex.solid?.volumeMm3}; ${why(bySelector.reply)} ${why(byIndex.reply)}`,
    );
  });

  await testCase("splitFace: a line imprinted on the top splits it, volume kept", async () => {
    const curve = { kind: "polyline", points: [[-15, 0, 25], [15, 0, 25]] };
    const { reply, solid } = await build("split-face", twenty, [{ kind: "splitFace", faces: [{ normal: [0, 0, 1], nearPoint: [0, 0, 20] }], curve, direction: [0, 0, -1] }]);
    check("splitFace: a line imprinted on the top splits it, volume kept", reply.ok === true && solid?.faces.length === 7 && rel(solid?.volumeMm3, 8000, 1e-9), `faces ${solid?.faces.length} volume ${solid?.volumeMm3}; ${why(reply)}`);
  });

  // ---------------------------------------------------------------- patch and blend
  await testCase("patch G0 quad of four free curves: a flat 400 mm² square", async () => {
    const made = await build("patch-free", SMALL, [{ kind: "sheet", mode: "planar", curves: [square(5, 100)] }]);
    if (made.reply.ok !== true) throw new Error(why(made.reply));
    const before = totalArea(made.solid);
    const z = 150;
    const side = (a: number[], b: number[]) => ({ curve: { kind: "polyline", points: [[...a, z], [...b, z]] }, continuity: "g0" });
    const { reply, solid } = await apply(made.reply.object, { kind: "patch", boundaries: [side([-10, -10], [10, -10]), side([10, -10], [10, 10]), side([10, 10], [-10, 10]), side([-10, 10], [-10, -10])] });
    check("patch G0 quad of four free curves: a flat 400 mm² square", reply.ok === true && rel(totalArea(solid) - before, 400, 1e-5) && near(solid?.bounds.max[2], z, 0.01), `added ${totalArea(solid) - before}; ${why(reply)}`);
  });

  await testCase("patch G0 quad on the tube's rim, then sewn into a 4000 mm³ box", async () => {
    const tube = await openTube("patch-g0");
    const rim = byAngle(edgesAtZ(tube.solid, 110));
    const before = totalArea(tube.solid);
    const { reply, solid } = await apply(tube.object, { kind: "patch", boundaries: rim.map((edge) => ({ edges: [edge.index], continuity: "g0" })) });
    const sewn = reply.ok === true ? await apply(tube.object, { kind: "sew", tolerance: 0.01, capPlanar: true }) : undefined;
    check(
      "patch G0 quad on the tube's rim, then sewn into a 4000 mm³ box",
      rim.length === 4 && reply.ok === true && rel(totalArea(solid) - before, 400, 1e-5) && sewn?.reply.ok === true && rel(sewn.solid?.volumeMm3, 4000, 1e-5),
      `rim ${rim.length}; added ${totalArea(solid) - before}; sewn ${sewn?.solid?.volumeMm3}; ${why(reply)} ${sewn ? why(sewn.reply) : ""}`,
    );
  });

  await testCase("patch G1 with a guide point rises above the rim", async () => {
    const tube = await openTube("patch-g1");
    const rim = byAngle(edgesAtZ(tube.solid, 110));
    const { reply, solid } = await apply(tube.object, { kind: "patch", boundaries: rim.map((edge) => ({ edges: [edge.index], continuity: "g1" })), points: [[0, 0, 114]] });
    const sewn = reply.ok === true ? await apply(tube.object, { kind: "sew", tolerance: 0.01, capPlanar: true }) : undefined;
    check(
      "patch G1 with a guide point rises above the rim",
      rim.length === 4 && reply.ok === true && (solid?.bounds.max[2] ?? 0) > 110.5 && sewn?.reply.ok === true && sewn.solid?.editable === true && (sewn.solid?.volumeMm3 ?? 0) > 4000 + 1,
      `rim ${rim.length}; top ${solid?.bounds.max[2]}; sewn ${sewn?.solid?.volumeMm3} editable ${sewn?.solid?.editable}; ${why(reply)} ${sewn ? why(sewn.reply) : ""}`,
    );
  });

  /** Two open coaxial tubes, radius 18 and 10, z 100..116, made of polynomial quarters; returns both top rims. */
  async function twoTubes(name: string) {
    const made = await build(name, SMALL, [{ kind: "sheet", mode: "extrude", curves: [ring(18, 100)], dir: [0, 0, 1], distance: 16 }]);
    if (made.reply.ok !== true) throw new Error(`outer tube: ${why(made.reply)}`);
    const object = made.reply.object as string;
    await isolateAbove(object);
    const inner = await apply(object, { kind: "sheet", mode: "extrude", curves: [ring(10, 100)], dir: [0, 0, 1], distance: 16 });
    if (inner.reply.ok !== true || !inner.solid) throw new Error(`inner tube: ${why(inner.reply)}`);
    const top = edgesAtZ(inner.solid, 116);
    const radius = (edge: EdgeRow) => Math.hypot(edge.mid[0], edge.mid[1]);
    return { object, outer: byAngle(top.filter((edge) => radius(edge) > 14)), inner: byAngle(top.filter((edge) => radius(edge) < 14)) };
  }
  const blend = (outer: EdgeRow[], inner: EdgeRow[], continuity: string, tension: number) => ({
    kind: "blendSurface",
    a: { edges: outer.map((edge) => edge.index), continuity },
    b: { edges: inner.map((edge) => edge.index), continuity },
    continuity,
    tensionA: tension,
    tensionB: tension,
  });

  await testCase("blendSurface G1 and G2, tensions 1 and 2", async () => {
    const g1 = await twoTubes("blend-g1");
    const g1Made = await apply(g1.object, blend(g1.outer, g1.inner, "g1", 1));
    const tense = await twoTubes("blend-g1-tense");
    const tenseMade = await apply(tense.object, blend(tense.outer, tense.inner, "g1", 2));
    const g2 = await twoTubes("blend-g2");
    const g2Made = await apply(g2.object, blend(g2.outer, g2.inner, "g2", 1));
    const g1Health = g1Made.reply.ok === true ? (await surfacesOf(g1.object)).surfaceHealth : undefined;
    const g2Health = g2Made.reply.ok === true ? (await surfacesOf(g2.object)).surfaceHealth : undefined;
    const degree = (health: Reply | undefined) => Math.max(health?.maxUDegree ?? NaN, health?.maxVDegree ?? NaN);
    const top = (made: { solid?: SolidView }) => made.solid?.bounds.max[2] ?? 0;
    check(
      "blendSurface G1 and G2, tensions 1 and 2",
      g1.outer.length === 1 && g1.inner.length === 1 && g1Made.reply.ok === true && tenseMade.reply.ok === true && g2Made.reply.ok === true
        && top(g1Made) > 116.5 && top(tenseMade) > top(g1Made) + 0.1 && degree(g2Health) >= 5 && degree(g1Health) < 5,
      `rims ${g1.outer.length}/${g1.inner.length}; top g1 ${top(g1Made)} tension 2 ${top(tenseMade)}; degree g1 ${degree(g1Health)} g2 ${degree(g2Health)}; ${why(g1Made.reply)} ${why(tenseMade.reply)} ${why(g2Made.reply)}`,
    );
  });

  // ---------------------------------------------------------------- model_check {surfaces:true}
  await testCase("model_check surfaces: continuity and health on a G2 fillet", async () => {
    const made = await build("check-surfaces", twenty, [fillet({ continuity: "g2" })]);
    const plain = made.reply.ok === true ? await call("model_check", { object: made.reply.object }) : {};
    const asked = made.reply.ok === true ? await surfacesOf(made.reply.object) : {};
    const edges = asked.continuity?.edges as unknown[] | undefined;
    const sampled = ["g0", "g1", "g2", "gaps"].reduce((sum, key) => sum + Number(asked.continuity?.[key] ?? 0), 0);
    check(
      "model_check surfaces: continuity and health on a G2 fillet",
      asked.ok === true && plain.continuity === undefined && Array.isArray(edges) && edges.length === sampled && sampled > 0
        && asked.continuity.edgesTotal === undefined && (asked.continuity.g2 ?? 0) >= 2 && (asked.surfaceHealth?.maxUDegree ?? 0) >= 5,
      `continuity ${JSON.stringify(asked.continuity)?.slice(0, 300)}; health ${JSON.stringify(asked.surfaceHealth)}; ${why(asked)}`,
    );
  });
} catch (error) {
  failed += 1;
  console.error(`FAIL organic-contract threw ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
if (failed > 0) {
  console.error(`organic-contract-occt: ${failed} failed: ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("organic-contract-occt: ok");
process.exit(0);
