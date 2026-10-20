/**
 * `.lime` version 4: binary records compressed on disk, byte for byte the same on the way back, and version 3 still open.
 */
import { defaultProfile } from "./profiles.ts";
import { DEFAULT_PRESET } from "./presets.ts";
import { meshRecord, parseProject, serializeProject, PROJECT_VERSION, type LimeProject } from "./project.ts";
import { decodeProject, encodeProject, ENCODING_GZIP, gunzip, gzip } from "./project-codec.ts";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { jumped, newTree, opLabel, withChild, type ModelOp } from "./model-tree.ts";
import { savedTree } from "./model-tree-file.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** A mesh-like buffer: 50-byte triangles whose floats repeat on a lattice, as a dense part's do. */
function lattice(triangles: number): Uint8Array {
  const out = new Uint8Array(84 + triangles * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, triangles, true);
  for (let t = 0; t < triangles; t++) {
    const base = 84 + t * 50;
    for (let v = 0; v < 12; v++) view.setFloat32(base + v * 4, ((t * 7 + v * 3) % 40) * 0.5, true);
  }
  return out;
}

/** A solid-like buffer: a header line then bytes from a fixed generator, so it only half compresses. */
function solid(length: number): Uint8Array {
  const head = new TextEncoder().encode("LIMEBREP 1 7.9.2 1234.5 12\n");
  const out = new Uint8Array(head.length + length);
  out.set(head);
  let x = 12345;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[head.length + i] = i % 3 === 0 ? (x >> 16) & 0xff : i & 0x0f;
  }
  return out;
}

const mesh = lattice(4000);
const brep = solid(60000);
const rootStep = solid(20000);
const toolRoot = solid(5000);
const placement = { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1] as LimeProject["placement"]["orient"], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.05 };
const cut: ModelOp = { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 5], size: [8, 10, 10], radius: 0, height: 0, turn: [0, 0, 0] };
const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
let tree = newTree("part#run1.1", { kind: "step", name: "part.step", bytes: rootStep.buffer.slice(0) as ArrayBuffer }, "part.stl", fp(4000));
tree = { ...withChild(jumped(tree, 0), 0, { id: 1, op: cut, label: opLabel(cut), fingerprint: fp(3200) }), committed: 1 };
const tool = newTree("tool#run1.2", { kind: "step", name: "tool.step", bytes: toolRoot.buffer.slice(0) as ArrayBuffer }, "tool.stl", fp(100));

const project: LimeProject = {
  version: 2,
  mesh: meshRecord("part.stl", mesh),
  placement,
  settings: { ...DEFAULT_PRESET },
  preset: null,
  profile: defaultProfile(),
  level: "simple",
  supportEdits: [],
  objects: [
    {
      id: "part",
      name: "part.stl",
      mesh: meshRecord("part.stl", mesh),
      placement,
      supportEdits: [],
      brep: meshRecord("part.brep", brep),
      modelTree: { ...savedTree(tree, 1, () => undefined), rootStep: meshRecord("part.step", rootStep) },
    },
    { id: "obj-2", name: "second", mesh: meshRecord("second.stl", lattice(300)), placement, supportEdits: [] },
  ],
  modelTools: [{ id: "tool-1", name: "tool", modelTree: { ...savedTree(tool, 0, () => undefined), rootStep: meshRecord("tool.step", toolRoot) } }],
};

// Version 3 text: what the previous app wrote, a plate with every record as base64 text.
const plain = serializeProject(project);
const v3 = JSON.stringify({ ...JSON.parse(plain), version: 3 }, null, 2);

const text = await encodeProject(project);
const wire = JSON.parse(text) as { version: number; objects: { mesh: Record<string, unknown>; brep: Record<string, unknown>; modelTree: { rootStep: Record<string, unknown> } }[]; modelTools: { modelTree: { rootStep: Record<string, unknown> } }[]; settings: unknown };
check("a save is version 4", wire.version === 4 && PROJECT_VERSION === 4);
const records = [wire.objects[0]!.mesh, wire.objects[0]!.brep, wire.objects[0]!.modelTree.rootStep, wire.objects[1]!.mesh, wire.modelTools[0]!.modelTree.rootStep];
check("every binary record names its encoding", records.every((row) => row.encoding === ENCODING_GZIP && typeof row.data === "string" && row.bytesBase64 === undefined));
check("a record keeps its name, length, and hash", wire.objects[0]!.mesh.name === "part.stl" && wire.objects[0]!.mesh.byteLength === mesh.byteLength && wire.objects[0]!.mesh.hash === project.mesh.hash);
check("settings stay readable text", text.includes('"layerHeight"') && JSON.stringify(wire.settings) === JSON.stringify(project.settings));
check("a version 4 file is a fraction of the version 3 file", text.length * 3 < v3.length, `${text.length} vs ${v3.length}`);

const opened = await decodeProject(text);
const reference = parseProject(plain);
check("a version 4 file opens", opened.ok && reference.ok);
if (opened.ok && reference.ok) {
  check("it opens as the plain file does, record for record", JSON.stringify(opened.project) === JSON.stringify(reference.project));
  const objects = opened.project.objects!;
  check("the mesh comes back byte for byte", Buffer.from(base64ToBytes(objects[0]!.mesh.bytesBase64)!).equals(mesh));
  check("the solid comes back byte for byte", Buffer.from(base64ToBytes(objects[0]!.brep!.bytesBase64)!).equals(brep));
  check("a root STEP comes back byte for byte", Buffer.from(base64ToBytes(objects[0]!.modelTree!.rootStep!.bytesBase64!)!).equals(rootStep));
  check("a save of what opened is a save of what the plain file opens", (await encodeProject(opened.project)) === (await encodeProject(reference.project)));
}

// A version 3 file opens through the same door, as before.
const fromV3 = await decodeProject(v3);
check("a version 3 file opens", fromV3.ok && reference.ok && JSON.stringify(fromV3.ok ? fromV3.project : 0) === JSON.stringify(reference.ok ? reference.project : 1));
const v3Direct = parseProject(v3);
check("and through the plain reader", v3Direct.ok && v3Direct.project.objects?.length === 2);

// A one-object project is written as a plate too, and reads back as it was.
const solo: LimeProject = { version: 1, mesh: meshRecord("solo.stl", mesh), placement, settings: { ...DEFAULT_PRESET }, preset: null, profile: defaultProfile(), level: "simple", supportEdits: [] };
const soloText = await encodeProject(solo);
const soloWire = JSON.parse(soloText) as { version: number; objects?: unknown[]; mesh?: unknown };
check("a one-object project is a version 4 plate", soloWire.version === 4 && soloWire.objects?.length === 1 && soloWire.mesh === undefined);
const soloOpened = await decodeProject(soloText);
check("and it opens as the one object it was", soloOpened.ok && soloOpened.project.version === 1 && soloOpened.project.mesh.hash === solo.mesh.hash && soloOpened.project.mesh.bytesBase64 === solo.mesh.bytesBase64);

// Damage and unknown forms say so.
const damagedData = JSON.parse(text) as typeof wire;
damagedData.objects[0]!.mesh.data = bytesToBase64(new Uint8Array([1, 2, 3, 4, 5]));
const damagedMesh = await decodeProject(JSON.stringify(damagedData));
check("a stream that does not unpack is a damaged mesh", !damagedMesh.ok && damagedMesh.message === "The mesh in this project is damaged.", JSON.stringify(damagedMesh));
const damagedSolid = JSON.parse(text) as typeof wire;
damagedSolid.objects[0]!.brep.data = bytesToBase64(new Uint8Array([1, 2, 3, 4, 5]));
const solidResult = await decodeProject(JSON.stringify(damagedSolid));
check("a solid that does not unpack is a damaged solid", !solidResult.ok && solidResult.message === "The solid in this project is damaged.", JSON.stringify(solidResult));
const wrongHash = JSON.parse(text) as typeof wire;
wrongHash.objects[0]!.mesh.hash = "0000000000000000";
const wrongResult = await decodeProject(JSON.stringify(wrongHash));
check("bytes that do not match their hash are a damaged mesh", !wrongResult.ok && wrongResult.message === "The mesh in this project is damaged.");
const alien = JSON.parse(text) as typeof wire;
alien.objects[0]!.mesh.encoding = "zstd+base64";
const alienResult = await decodeProject(JSON.stringify(alien));
check("an unknown encoding is refused by name", !alienResult.ok && alienResult.message.includes("zstd+base64"), JSON.stringify(alienResult));
const uncompressed = JSON.parse(text) as typeof wire;
uncompressed.objects[0]!.mesh = { name: "part.stl", byteLength: mesh.byteLength, hash: project.mesh.hash, encoding: "base64", data: bytesToBase64(mesh) };
const uncompressedResult = await decodeProject(JSON.stringify(uncompressed));
check("the plain base64 encoding opens", uncompressedResult.ok && uncompressedResult.project.mesh.hash === project.mesh.hash);
const gz = await gzip(mesh);
check("gzip is the standard stream", gz[0] === 0x1f && gz[1] === 0x8b && Buffer.from(await gunzip(gz)).equals(mesh));
check("the plain reader leaves a compressed record unread", !parseProject(text).ok);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("project-codec: version 4 round trip, version 3 open, and damage ok");
