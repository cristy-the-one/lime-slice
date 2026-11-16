/**
 * model_check on a belt printer: overhangs and down faces are read against the direction the belt's layers stack in
 * ((0, −sin α, cos α) in the plate frame, as crates/lime-slice-core/src/belt.rs slices), contact and floating pieces
 * against the belt, and the fit against the belt's width and the printer's height. Overhangs and ceilings name their
 * B-rep faces, and a thin-wall region says how far its two faces turn from facing each other. A flat bed reads as before.
 */
import assert from "node:assert/strict";
import { assembleCheck, partBox } from "./model-check.ts";
import { printCheck } from "./modeling/inspect.ts";
import { checkReply } from "./modeling/part-reads.ts";
import { thinWalls } from "./modeling/thin.ts";

type P = [number, number, number];
type Mesh = { positions: Float32Array; faceOf: Uint32Array };

/**
 * A prism `width` mm across X from a convex profile in (y, z), each triangle wound away from the profile's centre and
 * named by its face: 0 the cap at X = 0, 1 the cap at X = width, then 2 + k the side from profile corner k to k + 1.
 */
function prism(profile: [number, number][], width: number): Mesh {
  const centre: P = [width / 2, profile.reduce((s, p) => s + p[0], 0) / profile.length, profile.reduce((s, p) => s + p[1], 0) / profile.length];
  const out: number[] = [];
  const faces: number[] = [];
  const add = (a: P, b: P, c: P, face: number) => {
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    const away = [0, 1, 2].map((i) => (a[i]! + b[i]! + c[i]!) / 3 - centre[i]!);
    if (n[0]! * away[0]! + n[1]! * away[1]! + n[2]! * away[2]! < 0) [b, c] = [c, b];
    out.push(...a, ...b, ...c);
    faces.push(face);
  };
  const at = (x: number, k: number): P => [x, profile[k % profile.length]![0], profile[k % profile.length]![1]];
  for (let k = 1; k + 1 < profile.length; k += 1) {
    add(at(0, 0), at(0, k), at(0, k + 1), 0);
    add(at(width, 0), at(width, k), at(width, k + 1), 1);
  }
  for (let k = 0; k < profile.length; k += 1) {
    add(at(0, k), at(width, k), at(width, k + 1), 2 + k);
    add(at(0, k), at(width, k + 1), at(0, k + 1), 2 + k);
  }
  return { positions: new Float32Array(out), faceOf: new Uint32Array(faces) };
}

const IR3 = { angleDeg: 45, widthMm: 250, maxLengthMm: null };
const build: P = [250, 250, 250];
const area = (checked: Record<string, unknown>) => (checked.overhang as { areaMm2: number }).areaMm2;
const regions = (checked: Record<string, unknown>) => (checked.overhang as { regions: { faces?: number[]; areaMm2: number }[] }).regions;
const ceilings = (checked: Record<string, unknown>) => checked.ceilings as { zMm: number; layerMm?: number; areaMm2: number; faces?: number[] }[];

// --- A wall on the +Y end that leans out 30° from vertical (side 1, from (20, 0) up to (31.5, 20)). A bed prints it
// clean: 30° is under 45°. On a belt the +Y end prints first and layers stack toward −Y, so that wall hangs 75° off
// the build direction.
const undercut = prism([[0, 0], [20, 0], [20 + 20 * Math.tan(Math.PI / 6), 20], [0, 20]], 10);
const flatUndercut = printCheck({ positions: undercut.positions, overhangDeg: 45, buildMm: build });
assert.equal(area(flatUndercut), 0, "a wall leaning 30° prints clean on a bed");
const beltUndercut = printCheck({ positions: undercut.positions, overhangDeg: 45, buildMm: build, belt: IR3, faceOf: undercut.faceOf });
assert.ok(Math.abs(area(beltUndercut) - 230.9) < 0.2, `on a belt the leaning +Y wall overhangs: ${area(beltUndercut)}`);
assert.deepEqual(regions(beltUndercut).map((row) => row.faces), [[3]], "the overhang names the leaning wall's face");
assert.ok((beltUndercut.warnings as string[]).some((line) => line.endsWith("overhangs more than 45° from the belt's build direction.")), JSON.stringify(beltUndercut.warnings));
assert.ok((beltUndercut.bedContact as { areaMm2: number }).areaMm2 > 199, "contact is read on the belt");
const said = beltUndercut.build as { belt: boolean; angleDeg: number; direction: number[]; text: string };
assert.deepEqual(said.direction, [0, -0.707, 0.707], "the build direction in the plate frame");
assert.ok(said.text.startsWith("Layers stack at 45° to the belt: the belt carries the part toward the plate's +Y, so the +Y end prints first"), said.text);

// --- The reverse: an underside facing −Y, 60° off vertical (side 3). A bed needs support under it; on a belt it sits
// 15° off the build direction. The +Y end, square to the belt, is exactly 45° off it and is not counted.
const ramp = prism([[0, 0], [20, 0], [20, 20], [-20 * Math.tan(Math.PI / 3), 20]], 10);
const flatRamp = printCheck({ positions: ramp.positions, overhangDeg: 45, buildMm: build, faceOf: ramp.faceOf });
assert.ok(area(flatRamp) > 399, `a bed reads the underside as an overhang: ${area(flatRamp)}`);
assert.deepEqual(regions(flatRamp).map((row) => row.faces), [[5]], "on a bed too, the overhang names its face");
const beltRamp = printCheck({ positions: ramp.positions, overhangDeg: 45, buildMm: build, belt: IR3 });
assert.equal(area(beltRamp), 0, "a belt prints the underside facing −Y without support");
assert.ok(!(beltRamp.warnings as string[]).some((line) => line.includes("overhang")), JSON.stringify(beltRamp.warnings));

// A table: its top's underside is a ceiling on a bed, and 45° off the build direction on a belt.
const join = (...meshes: Mesh[]) => {
  const positions = new Float32Array(meshes.reduce((n, m) => n + m.positions.length, 0));
  let at = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, at);
    at += mesh.positions.length;
  }
  return positions;
};
const slab = (y0: number, y1: number, z0: number, z1: number, width: number) => prism([[y0, z0], [y1, z0], [y1, z1], [y0, z1]], width);
const table = join(slab(0, 40, 10, 14, 40), slab(0, 6, 0, 10, 6));
assert.equal(ceilings(printCheck({ positions: table, overhangDeg: 45, buildMm: build })).length, 1, "a bed reads the table top as a ceiling");
const beltTable = printCheck({ positions: table, overhangDeg: 45, buildMm: build, belt: IR3 });
assert.equal(ceilings(beltTable).length, 0, "a belt does not");
assert.equal(area(beltTable), 0, "nor any overhang");

// A belt's ceiling: a face square to the build direction, facing back against it (side 2, from (20, 5) to (35, 20)).
const chamfer = prism([[0, 0], [20, 0], [20, 5], [35, 20], [0, 20]], 10);
const beltChamfer = printCheck({ positions: chamfer.positions, overhangDeg: 45, buildMm: build, belt: IR3, faceOf: chamfer.faceOf });
const rows = ceilings(beltChamfer);
assert.equal(rows.length, 1, JSON.stringify(rows));
assert.equal(rows[0]!.layerMm, 3.5, "named by its distance from the first layer: 5 mm up at 45°");
assert.equal(rows[0]!.zMm, 12.5, "and its height");
assert.deepEqual(rows[0]!.faces, [4]);
assert.ok((beltChamfer.warnings as string[]).some((line) => line === "Faces flat to the layers point back against the build direction at 3.5 mm from the first layer; they need support or a bridge."), JSON.stringify(beltChamfer.warnings));

// The fit: a belt does not limit the length along it, but does the width across it.
const long = slab(0, 400, 0, 10, 100);
const flatLong = printCheck({ positions: long.positions, overhangDeg: 45, buildMm: build });
assert.deepEqual((flatLong.fit as { over: string[] }).over, ["y"]);
const beltLong = printCheck({ positions: long.positions, overhangDeg: 45, buildMm: build, belt: IR3 });
const fit = beltLong.fit as { fits: boolean; over: string[]; buildVolumeMm: unknown[]; note: string };
assert.equal(fit.fits, true, "400 mm along the belt fits");
assert.deepEqual(fit.buildVolumeMm, [250, null, 250]);
assert.ok(fit.note.startsWith("On a belt the length along it (Y) has no limit in this check"), fit.note);
const wide = slab(0, 50, 0, 10, 300);
const beltWide = printCheck({ positions: wide.positions, overhangDeg: 45, buildMm: build, belt: { ...IR3, maxLengthMm: 1000 } });
assert.deepEqual((beltWide.fit as { over: string[] }).over, ["x"]);
assert.ok((beltWide.warnings as string[]).includes("The part is wider than the belt: 300 mm across it (X) against 250 mm."), JSON.stringify(beltWide.warnings));
assert.ok((beltWide.fit as { note: string }).note.endsWith("The belt's max length of 1000 mm is checked when it slices."));
const panel = assembleCheck(beltLong, { regions: [], areaMm2: 0 }, partBox(long.positions)!);
assert.ok(panel.rows.at(-1)!.text.startsWith("Fits the belt's width and the printer's height"), panel.rows.at(-1)!.text);
assert.ok(panel.note.startsWith("Nothing in this check needs a change. Layers stack at 45° to the belt"), panel.note);

// A flat bed is as before: no belt is the same record, and naming faces only adds them.
const strip = (checked: Record<string, unknown>) => JSON.parse(JSON.stringify(checked, (key, value) => (key === "faces" ? undefined : value)));
for (const mesh of [undercut, ramp, chamfer, long]) {
  const plain = printCheck({ positions: mesh.positions, overhangDeg: 45, buildMm: build });
  assert.deepEqual(printCheck({ positions: mesh.positions, overhangDeg: 45, buildMm: build, belt: null }), plain);
  assert.deepEqual(strip(printCheck({ positions: mesh.positions, overhangDeg: 45, buildMm: build, faceOf: mesh.faceOf })), strip(plain));
  assert.equal("build" in plain, false);
}

// --- model_check's reply (MCP and the app's recipe calls): the plate's turn decides which end prints first.
const printer = { name: "Ideaformer IR3 V2", bedMm: build, nozzleMm: 0.4, belt: IR3 };
const asPlaced = checkReply(ramp.positions, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1, printer, {}, ramp.faceOf);
assert.equal(area(asPlaced), 0, "the ramp as placed prints clean on the belt");
assert.deepEqual((asPlaced.build as { direction: number[] }).direction, [0, -0.707, 0.707]);
const turned = checkReply(ramp.positions, [-1, 0, 0, 0, -1, 0, 0, 0, 1], 1, printer, {}, ramp.faceOf);
assert.ok(area(turned) > 399, `turned 180° on the plate, its underside faces +Y and overhangs: ${area(turned)}`);
assert.deepEqual((turned.build as { direction: number[] }).direction, [0, 0.707, 0.707], "the build direction in the solid's frame");
assert.deepEqual(regions(turned).map((row) => row.faces), [[5]], "the faces are the solid's");
assert.equal(turned.printer, "Ideaformer IR3 V2");
const onBed = checkReply(ramp.positions, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1, { ...printer, belt: null }, { overhangDeg: 70 });
assert.equal(area(onBed), 0, "overhangDeg still sets the angle: 60° is under 70°");
assert.equal("build" in onBed, false);

// --- Thin walls say how far the far face turns from facing the near one: a sheet's sides face each other.
const sheet = slab(0, 20, 0, 0.4, 20);
const thin = thinWalls(sheet.positions, 0.8);
assert.ok(thin.regions.length > 0 && thin.regions.every((row) => row.facingDeg === 0), JSON.stringify(thin.regions));
// A 30° wedge: the faces meet at 30°, so the far one turns 30° from facing straight back.
const wedge = prism([[0, 0], [10, 0], [0, 10 * Math.tan(Math.PI / 6)]], 10);
const edge = thinWalls(wedge.positions, 0.8).regions;
assert.ok(edge.length > 0 && edge.some((row) => Math.abs(row.facingDeg! - 30) < 0.5), JSON.stringify(edge));

console.log("model-check-belt: overhangs read against the belt's build direction, faces named, flat bed unchanged");
