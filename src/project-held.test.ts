/**
 * Split to print, D12: the pieces and the pins a cut for an export target holds off the plate, kept in `.lime` (`heldPieces`), back
 * byte for byte; a file 3.8.0 wrote, with the cut and not its pieces, reads with them to cut again; and the new key is
 * the only change an older reader could see.
 */
import { defaultProfile } from "./profiles.ts";
import { DEFAULT_PRESET } from "./presets.ts";
import { meshRecord, piecesToCut, type HeldPiece, type LimeProject } from "./project.ts";
import { decodeProject, encodeProject, plainDocument } from "./project-codec.ts";
import { base64ToBytes } from "./base64.ts";
import { jumped, newTree, opLabel, withChild, type PartitionModelOp } from "./model-tree.ts";
import { savedTree } from "./model-tree-file.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** An STL-like buffer of `triangles` facets, their floats from `seed`, so each piece's bytes are its own. */
function stl(triangles: number, seed: number): Uint8Array {
  const out = new Uint8Array(84 + triangles * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, triangles, true);
  for (let t = 0; t < triangles; t++) for (let v = 0; v < 12; v++) view.setFloat32(84 + t * 50 + v * 4, ((t * 7 + v * 3 + seed) % 40) * 0.5, true);
  return out;
}

const solid = (seed: number) => new TextEncoder().encode(`LIMEBREP 1 7.9.2 ${seed}\n${"face ".repeat(200 + seed)}`);

const cut = (z: number): PartitionModelOp["cuts"][number] => ({ origin: [10, 10, z], normal: [0, 0, 1], u: [1, 0, 0], profile: { kind: "straight" }, connectors: { on: false } });
const op: PartitionModelOp = { kind: "partition", cuts: [cut(133), cut(266)], target: { printer: "formlabs-form-4", process: "resin", volumeMm: [200, 125, 210] }, arrange: false, orient: "keep" };
const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
const rootStep = solid(0);
let tree = newTree("part#run1.1", { kind: "step", name: "column.step", bytes: rootStep.buffer.slice(0) as ArrayBuffer }, "column.step", fp(160000));
tree = withChild(jumped(tree, 0), 0, { id: 1, op, label: opLabel(op, 3), fingerprint: fp(53200), pieces: ["part-part#run1.2", "part-part#run1.3"], pins: "part-pins#run1.4" });
const placement = { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1] as LimeProject["placement"]["orient"], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.05 };
const own = stl(400, 1);
const meshes = [stl(300, 2), stl(320, 3), stl(40, 4)];
const solids = [solid(2), solid(3), solid(4)];
const pieceRows: HeldPiece[] = meshes.slice(0, 2).map((mesh, at) => ({
  object: "part",
  node: 1,
  index: at + 2,
  mesh: meshRecord(`column part ${at + 2}.stl`, mesh),
  brep: meshRecord(`column part ${at + 2}.brep`, solids[at]!),
  meshSeatMm: 133 * (at + 1),
}));
// Milestone 5: a dowelled cut's pins, one more row, keyed by `pins` in place of a part number.
const held: HeldPiece[] = [...pieceRows, { object: "part", node: 1, pins: true, mesh: meshRecord("column pins.stl", meshes[2]!), brep: meshRecord("column pins.brep", solids[2]!) }];

const older: LimeProject = {
  version: 2,
  mesh: meshRecord("column.stl", own),
  placement,
  settings: { ...DEFAULT_PRESET },
  preset: null,
  profile: defaultProfile(),
  level: "simple",
  supportEdits: [],
  objects: [
    {
      id: "part",
      name: "column.step",
      mesh: meshRecord("column.stl", own),
      placement,
      supportEdits: [],
      modelTree: { ...savedTree(tree, 0, () => undefined), rootStep: meshRecord("column.step", rootStep) },
    },
  ],
};
const project: LimeProject = { ...older, heldPieces: held };

// The round trip: three pieces, the part's own and the two it holds, every mesh and solid back by its bytes.
const text = await encodeProject(project);
const opened = await decodeProject(text);
check("a project with held pieces opens", opened.ok);
if (opened.ok) {
  const back = opened.project;
  const pieces = [back.objects![0]!.mesh, ...(back.heldPieces ?? []).map((piece) => piece.mesh)];
  check("three pieces and the pins come back", pieces.length === 4, String(pieces.length));
  check("with the same mesh hashes", JSON.stringify(pieces.map((mesh) => mesh.hash)) === JSON.stringify([own, ...meshes].map((bytes) => meshRecord("x", bytes).hash)));
  check("each held mesh byte for byte", (back.heldPieces ?? []).every((piece, at) => Buffer.from(base64ToBytes(piece.mesh.bytesBase64)!).equals(meshes[at]!)));
  check("each held solid byte for byte", (back.heldPieces ?? []).every((piece, at) => Buffer.from(base64ToBytes(piece.brep!.bytesBase64)!).equals(solids[at]!)));
  check("by object, cut step, and part number or pins, with the seat", JSON.stringify((back.heldPieces ?? []).map((piece) => [piece.object, piece.node, piece.index ?? null, piece.pins ?? null, piece.meshSeatMm ?? null])) === JSON.stringify([["part", 1, 2, null, 133], ["part", 1, 3, null, 266], ["part", 1, null, true, null]]));
  check("the cut still names no piece and no pins, as written before", JSON.stringify([back.objects![0]!.modelTree!.nodes[1]!.pieces, back.objects![0]!.modelTree!.nodes[1]!.pins]) === JSON.stringify([[null, null], null]));
  check("and nothing is left to cut", piecesToCut(back).length === 0);
}
const wire = JSON.parse(text) as { heldPieces: { mesh: Record<string, unknown>; brep: Record<string, unknown> }[] };
check("held meshes and solids are stored compressed", wire.heldPieces.every((piece) => piece.mesh.encoding === "gzip+base64" && piece.brep.encoding === "gzip+base64" && piece.mesh.bytesBase64 === undefined));

// A file 3.8.0 wrote: the cut, and no pieces. It opens, and says which pieces to cut again.
const olderText = await encodeProject(older);
const olderOpened = await decodeProject(olderText);
check("a file without held pieces opens", olderOpened.ok && olderOpened.project.heldPieces === undefined);
if (olderOpened.ok) check("and reports its pieces to cut again", JSON.stringify(piecesToCut(olderOpened.project)) === JSON.stringify([{ object: "part", node: 1, indexes: [2, 3], pins: true }]), JSON.stringify(piecesToCut(olderOpened.project)));
const one = await decodeProject(await encodeProject({ ...older, heldPieces: [held[0]!] }));
if (one.ok) check("a file with one of two pieces cuts the other and the pins", JSON.stringify(piecesToCut(one.project)) === JSON.stringify([{ object: "part", node: 1, indexes: [3], pins: true }]));
const noPins = await decodeProject(await encodeProject({ ...older, heldPieces: pieceRows }));
if (noPins.ok) check("a file with the pieces and not the pins makes the pins again", JSON.stringify(piecesToCut(noPins.project)) === JSON.stringify([{ object: "part", node: 1, indexes: [], pins: true }]));

// The old reader's rule: it reads only the keys it knows. Every one of them is exactly what 3.8.0 writes for this
// project; `heldPieces` is the one key more, so a reader that skips it opens the file 3.8.0 would have written.
const newDoc = await plainDocument(text);
const oldDoc = await plainDocument(olderText);
check("the new data is one key more", JSON.stringify(Object.keys(newDoc).filter((key) => !(key in oldDoc))) === JSON.stringify(["heldPieces"]));
delete newDoc.heldPieces;
check("and every other key is the file 3.8.0 writes", JSON.stringify(newDoc) === JSON.stringify(oldDoc));

// A damaged row, or one that names no cut for an export target, is left out: that piece is cut again.
const odd = JSON.parse(text) as { heldPieces: Record<string, unknown>[] };
odd.heldPieces[0]!.node = 0;
odd.heldPieces.push({ ...odd.heldPieces[1]!, index: 9 }, { object: "part" }, "nope" as unknown as Record<string, unknown>);
const oddOpened = await decodeProject(JSON.stringify(odd));
check("a file with odd rows opens", oddOpened.ok);
if (oddOpened.ok) {
  check("keeping only the rows that name a held piece", JSON.stringify(oddOpened.project.heldPieces?.map((piece) => piece.index ?? "pins")) === JSON.stringify([3, "pins"]));
  check("and the rest is cut again", JSON.stringify(piecesToCut(oddOpened.project)) === JSON.stringify([{ object: "part", node: 1, indexes: [2] }]));
}

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("project-held: held pieces and pins round trip, a 3.8.0 file to cut again, and the old reader's view ok");
