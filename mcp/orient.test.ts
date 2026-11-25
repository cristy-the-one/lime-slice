/**
 * E4: orient_compare scores print turns from the faces and leaves the plate alone.
 * The stand-in is a foot plus three slabs, each lying in a 45° belt's layer plane
 * at one yaw (0, 90, 180) and not at rotZ −90, so that yaw has the least unheld path.
 * Synthetic geometry only: no part from outside this test.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { align, encodeStl, eulerOrient, type Mat3 } from "../src/mesh-place.ts";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-orient-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.error(`FAIL ${name}${text ? ` ${text}` : ""}`);
}

type Row = {
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  unheldLengthMm?: number;
  unheldAreaMm2?: number;
  overhangAreaMm2?: number;
  seconds?: number;
  grams?: number;
  from?: string;
  best?: boolean;
};

function box(min: number[], max: number[]): Float32Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [4, 5, 6, 7],
    [0, 3, 2, 1],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
    [3, 7, 6, 2],
    [0, 1, 5, 4],
  ];
  const positions = new Float32Array(quads.length * 18);
  quads.forEach((quad, face) => {
    const corner = (index: number) => c[quad[index]!]!;
    const write = (tri: number, a: number[], b: number[], d: number[]) => {
      positions.set([...a, ...b, ...d], (face * 2 + tri) * 9);
    };
    write(0, corner(0), corner(1), corner(2));
    write(1, corner(0), corner(2), corner(3));
  });
  return positions;
}

function apply(positions: Float32Array, matrix: Mat3): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    out[i] = matrix[0] * x + matrix[1] * y + matrix[2] * z;
    out[i + 1] = matrix[3] * x + matrix[4] * y + matrix[5] * z;
    out[i + 2] = matrix[6] * x + matrix[7] * y + matrix[8] * z;
  }
  return out;
}

function lift(positions: Float32Array, dx: number, dy: number, z0: number): Float32Array {
  let minZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) minZ = Math.min(minZ, positions[i]!);
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    out[i] = positions[i]! + dx;
    out[i + 1] = positions[i + 1]! + dy;
    out[i + 2] = positions[i + 2]! - minZ + z0;
  }
  return out;
}

/** A thin slab whose +Z face, after an in-plane turn, points along `normal`. */
function slab(normal: [number, number, number], spinDeg: number, size: [number, number], at: [number, number]): Float32Array {
  const [w, h] = size;
  const local = box([-w / 2, -h / 2, 0], [w / 2, h / 2, 1.2]);
  const aimed = apply(apply(local, eulerOrient(0, 0, spinDeg)), align([0, 0, 1], normal));
  return lift(aimed, at[0], at[1], 14);
}

const s2 = Math.SQRT1_2;
const parts = [
  box([0, 0, 0], [18, 18, 6]),
  slab([0, s2, -s2], 17, [40, 26], [0, 48]),
  slab([s2, 0, -s2], 31, [34, 22], [52, 0]),
  slab([0, -s2, -s2], 53, [30, 20], [0, -46]),
];
const count = parts.reduce((sum, part) => sum + part.length, 0);
const standIn = new Float32Array(count);
let cursor = 0;
for (const part of parts) {
  standIn.set(part, cursor);
  cursor += part.length;
}

const file = join(workspace, "stand-in.stl");
writeFileSync(file, Buffer.from(encodeStl(standIn, "stand-in")));

const engine = fakeEngine();
const session = new Session(engine);
const call = (name: string, args: unknown = {}) => session.call(name, args);

const imported = await call("mesh_import", { path: file });
const id = String(imported.object);
const plate = () => call("plate_list", {});
const boxOf = async () => JSON.stringify(((await plate()).objects as { bboxMm: unknown }[])[0]?.bboxMm);
const flat = await call("orient_compare", { object: id }).catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
const flatRows = (flat.rotations ?? []) as Row[];
const flatKeys = flatRows.map((row) => `${row.rotX},${row.rotY},${row.rotZ}`).sort();
check(
  "a flat bed scores the six faces down and slices none",
  flat.ok === true && flatKeys.join("|") === ["-90,0,0", "0,-90,0", "0,0,0", "0,90,0", "180,0,0", "90,0,0"].sort().join("|")
    && flatRows.every((row) => row.from === "estimate" && typeof row.unheldLengthMm === "number" && typeof row.unheldAreaMm2 === "number" && typeof row.overhangAreaMm2 === "number" && typeof row.seconds === "number" && typeof row.grams === "number")
    && flatRows.filter((row) => row.best === true).length === 1,
  flat,
);

const selected = await call("machine_select", { printerId: "generic-belt-45", filamentId: "lime-pla" });
const onBelt = await boxOf();
const compared = await call("orient_compare", { object: id }).catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
const rows = (compared.rotations ?? []) as Row[];
const yaws = rows.map((row) => row.rotZ);
const best = rows.find((row) => row.best === true);
const others = rows.filter((row) => row !== best);
const least = best && others.every((row) => typeof row.unheldLengthMm === "number" && typeof best.unheldLengthMm === "number" && row.unheldLengthMm > best.unheldLengthMm * 3 + 1);
check(
  "on a belt the four yaws are scored and rotZ −90 has the least unheld path",
  selected.ok === true && compared.ok === true && JSON.stringify(yaws) === JSON.stringify([0, 90, 180, -90])
    && rows.filter((row) => row.best === true).length === 1 && best?.rotZ === -90 && best.rotX === 0 && best.rotY === 0 && least === true
    && rows.every((row) => row.from === "estimate"),
  { compared, rows },
);
console.log(`belt yaws: ${rows.map((row) => `rotZ ${row.rotZ} unheld ${row.unheldLengthMm} mm (${row.unheldAreaMm2} mm²) overhang ${row.overhangAreaMm2} mm² ${row.seconds}s ${row.grams}g${row.best ? " best" : ""}`).join("; ")}`);

const afterEstimate = await boxOf();
const undo = await call("plate_undo", {});
check(
  "scoring changes nothing on the plate",
  afterEstimate === onBelt && undo.ok === false && undo.code === "nothing-to-undo",
  { onBelt, afterEstimate, undo },
);

const beforeSlice = await boxOf();
const sliced = await call("orient_compare", { object: id, slice: true });
const slicedRows = (sliced.rotations ?? []) as Row[];
const slicedBest = slicedRows.find((row) => row.best === true);
const slicedOnly = slicedRows.filter((row) => row.from === "sliced");
check(
  "slice true slices only the two best and still marks rotZ −90",
  sliced.ok === true && slicedOnly.length === 2 && slicedBest?.rotZ === -90
    && slicedOnly.some((row) => row.rotZ === -90)
    && slicedRows.filter((row) => row.from === "estimate").length === slicedRows.length - 2
    && slicedRows.every((row) => typeof row.seconds === "number" && typeof row.grams === "number" && typeof row.unheldLengthMm === "number"),
  slicedRows,
);

const all = await call("orient_compare", { object: id, slice: "all" });
const allRows = (all.rotations ?? []) as Row[];
check(
  "slice all slices every yaw",
  all.ok === true && allRows.length === 4 && allRows.every((row) => row.from === "sliced") && allRows.filter((row) => row.best === true).length === 1,
  allRows,
);
const afterSlice = await boxOf();
check("slicing a comparison changes nothing on the plate", afterSlice === beforeSlice, { beforeSlice, afterSlice });

const placed = await call("object_place", { object: id, rotX: best?.rotX, rotY: best?.rotY, rotZ: best?.rotZ });
const turned = await boxOf();
check(
  "object_place applies the rotation the comparison marked",
  placed.ok === true && turned !== onBelt,
  { placed, onBelt, turned },
);

const oneSlice = await call("slice_start", { cancelRunning: true });
check(
  "slice_start without scope names the object and says scope plate slices them all",
  oneSlice.ok === true && JSON.stringify(oneSlice.sliced) === JSON.stringify([id])
    && oneSlice.note === 'scope:"plate" slices them all.',
  oneSlice,
);

const cube = file;
const second = await call("mesh_import", { path: cube });
const otherId = String(second.object);
await call("object_select", { object: otherId });
const picked = await call("slice_start", { cancelRunning: true });
check(
  "with two objects, the omitted scope still names only the selection and points at scope plate",
  picked.ok === true && picked.object === otherId && JSON.stringify(picked.sliced) === JSON.stringify([otherId])
    && picked.note === 'scope:"plate" slices them all.',
  picked,
);

const guide = await call("guide", { tool: "orient_compare" });
const examples = guide.examples as string[] | undefined;
check(
  "guide {tool:orient_compare} has an example",
  guide.ok === true && Array.isArray(examples) && examples.some((line) => line.includes('tool:"orient_compare"') && line.includes("rotZ")),
  guide,
);

if (failed) console.error(`orient: ${failed} failed`);
else console.log("orient: ok");
process.exit(failed ? 1 : 0);
