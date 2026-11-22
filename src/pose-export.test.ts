/**
 * Unit tests for shared pose export encoders (docs/plan-pose-export.md §7):
 * - Pose sheet (JSON): member values, limits, parent names, and 4x4 placements in mm;
 * - GLB: header, chunks, node count & nesting, root D2 transform, world matrices, posed bounds, shared part meshes,
 *   and glTF animation playback checking frame k node matrices against the player's sampled frame k (decision 1);
 * - 3MF: unzip and parse, one build item per member with 3MF transform, shared objects, posed bounds;
 * - STL: one file and ZIP of one STL per member, triangle counts and posed bounds;
 * - OBJ + MTL: one group per member, material per colour, triangle counts and posed bounds.
 */
import { unzipSync } from "fflate";
import { quaternionRotation, solveAssembly, type Assembly } from "./assembly.ts";
import { applyPose, type Affine } from "./model-space.ts";

function parseBinaryStl(bytes: Uint8Array): { count: number; positions: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const positions = new Float32Array(count * 9);
  let at = 84;
  for (let i = 0; i < count; i++) {
    at += 12; // normal
    for (let v = 0; v < 9; v++) {
      positions[i * 9 + v] = view.getFloat32(at, true);
      at += 4;
    }
    at += 2; // attr
  }
  return { count, positions };
}
import { sampleAnimation, type AnimationPart, type PoseAnimation } from "./pose-anim.ts";
import {
  buildPoseSheet,
  configLabel,
  encodePose3mf,
  encodePoseGlb,
  encodePoseObjMtl,
  encodePoseSheet,
  encodePoseStl,
  orderExportMembers,
  orderedPosedBounds,
  poseExportFileName,
  type OrderedPoseExport,
} from "./pose-export.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function boxMesh(dx: number, dy: number, dz: number): Float32Array {
  const x0 = -dx / 2, x1 = dx / 2, y0 = -dy / 2, y1 = dy / 2, z0 = 0, z1 = dz;
  const quad = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  return new Float32Array([
    ...quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]),
    ...quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    ...quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
    ...quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]),
    ...quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]),
    ...quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ]);
}

// 4-member assembly: base -> arm -> tip1 & tip2 (tip1 and tip2 share one distinct part geometry!).
const baseMesh = boxMesh(40, 30, 10);
const armMesh = boxMesh(10, 6, 30);
const tipMesh = boxMesh(8, 8, 4);

const assembly: Assembly = {
  id: "asm_1",
  name: "Robot Arm",
  members: [
    { object: "base", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    {
      object: "arm",
      parent: "base",
      offset: [0, 0, 10],
      turn: [0, 0, 0],
      joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, 1, 0], angle: 0, min: -90, max: 90 },
    },
    {
      object: "tip1",
      parent: "arm",
      offset: [0, 0, 30],
      turn: [0, 0, 0],
      joint: { kind: "hinge", pivot: [0, 0, 0], axis: [1, 0, 0], angle: 0, min: -60, max: 60 },
    },
    {
      object: "tip2",
      parent: "arm",
      offset: [5, 0, 20],
      turn: [0, 0, 90],
    },
  ],
};

const names: Record<string, string> = { base: "Base", arm: "Arm", tip1: "Tip", tip2: "Tip" };
const partKeys: Record<string, string> = { base: "p_base", arm: "p_arm", tip1: "p_tip", tip2: "p_tip" };
const meshes: Record<string, Float32Array> = { base: baseMesh, arm: armMesh, tip1: tipMesh, tip2: tipMesh };
const colors: Record<string, string> = { base: "#4080c0", arm: "#e07040", tip1: "#50a060", tip2: "#50a060" };
const rootPose: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [10, -5, 0] };

// Sample an animation so we have both a rest pose, a posed frame k, and a full animation for GLB.
const animSpec: PoseAnimation = {
  fps: 10,
  keys: [
    { t: 0, set: { Arm: 0, Tip: 0 } },
    { t: 0.5, set: { Arm: 45, Tip: -30 } },
  ],
};
const animParts: AnimationPart[] = assembly.members.map((m) => ({
  object: m.object,
  name: names[m.object]!,
  positions: meshes[m.object]!,
}));
const sampled = sampleAnimation(animSpec, assembly, (id) => (id === "base" ? rootPose : undefined), animParts, { interference: false });
if ("issues" in sampled) throw new Error(`sampleAnimation failed: ${JSON.stringify(sampled.issues)}`);
const lastFrame = sampled.frames[sampled.frames.length - 1]!;

// Build OrderedPoseExport at the last frame (arm at 45°, tip at -30°).
const frameConfig = { kind: "frame" as const, animation: "Wave", frameIndex: sampled.frames.length - 1, timeS: lastFrame.time };
const ordered: OrderedPoseExport = orderExportMembers(
  lastFrame.assembly,
  (id) => names[id]!,
  (id) => partKeys[id]!,
  (id) => meshes[id]!,
  (id) => lastFrame.poses.get(id),
  (id) => colors[id],
);

check("distinct part deduplication shares tip1 and tip2", ordered.parts.length === 3 && ordered.members.length === 4);
check("file naming for Now", poseExportFileName("Robot Arm", "step", { kind: "now" }) === "robot-arm-pose.step");
check("file naming for frame", poseExportFileName("Robot Arm", "glb", frameConfig) === `robot-arm-frame-${sampled.frames.length}.glb`);
check("file naming for STL each", poseExportFileName("Robot Arm", "stl", { kind: "now" }, "each") === "robot-arm-pose.zip");
check("config label for frame", configLabel(frameConfig).startsWith(`Frame ${sampled.frames.length} of Wave`));

const wantBounds = orderedPosedBounds(ordered)!;
const near = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol;
const sameBox = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }, tol = 1e-3) =>
  [...a.min, ...a.max].every((v, i) => near(v, [...b.min, ...b.max][i]!, tol));

// --- 1. Pose Sheet (JSON) ---
{
  const bytes = encodePoseSheet(ordered, frameConfig);
  const sheet = JSON.parse(new TextDecoder().decode(bytes)) as ReturnType<typeof buildPoseSheet>;
  check("pose sheet format & units", sheet.format === "lime-slice-pose" && sheet.units === "mm" && sheet.assembly === "Robot Arm");
  check("pose sheet configuration matches frame", sheet.configuration.kind === "frame" && sheet.configuration.frame === sampled.frames.length);
  check("pose sheet has 4 members", sheet.members.length === 4);
  const armRow = sheet.members.find((m) => m.name === "Arm")!;
  check("pose sheet Arm joint value is 45 deg", armRow.joint.kind === "hinge" && near(armRow.joint.value, 45, 1e-6) && armRow.joint.min === -90 && armRow.joint.max === 90);
  const armPose = lastFrame.poses.get("arm")!;
  check(
    "pose sheet Arm 4x4 placement equals rig pose",
    near(armRow.placementMm[0][3], armPose.t[0], 1e-6) &&
      near(armRow.placementMm[1][3], armPose.t[1], 1e-6) &&
      near(armRow.placementMm[2][3], armPose.t[2], 1e-6) &&
      near(armRow.placementMm[0][0], armPose.m[0], 1e-6),
  );
}

// --- 2. GLB parse, node hierarchy, world matrices, posed bounds, and animation playback ---
function mul4(a: number[], b: number[]): number[] {
  // Row-major 4x4 multiplication.
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]! + a[r * 4 + 3]! * b[12 + c]!;
    }
  }
  return out;
}

function trsToMat4(t?: number[], q?: number[], s?: number[]): number[] {
  const [tx, ty, tz] = t ?? [0, 0, 0];
  const [sx, sy, sz] = s ?? [1, 1, 1];
  const m = q ? quaternionRotation([q[0]!, q[1]!, q[2]!, q[3]!]) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [
    m[0]! * sx, m[1]! * sy, m[2]! * sz, tx!,
    m[3]! * sx, m[4]! * sy, m[5]! * sz, ty!,
    m[6]! * sx, m[7]! * sy, m[8]! * sz, tz!,
    0, 0, 0, 1,
  ];
}

function parseGlb(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("bad glTF magic");
  if (view.getUint32(4, true) !== 2) throw new Error("bad glTF version");
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error("bad glTF total length");
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error("bad JSON chunk");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  let bin: Uint8Array = new Uint8Array(0);
  if (20 + jsonLen + 8 <= bytes.byteLength) {
    const binLen = view.getUint32(20 + jsonLen, true);
    if (view.getUint32(20 + jsonLen + 4, true) !== 0x004e4942) throw new Error("bad BIN chunk");
    bin = bytes.subarray(20 + jsonLen + 8, 20 + jsonLen + 8 + binLen);
  }
  const readAccessor = (accIndex: number): Float32Array => {
    const acc = json.accessors[accIndex];
    const bv = json.bufferViews[acc.bufferView];
    const comps = acc.type === "SCALAR" ? 1 : acc.type === "VEC3" ? 3 : 4;
    return new Float32Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), acc.count * comps);
  };
  return { json, bin, readAccessor };
}

{
  // Export GLB with kept animation (rest pose at frame 0, animated to frame k).
  const restOrdered = orderExportMembers(
    sampled.frames[0]!.assembly,
    (id) => names[id]!,
    (id) => partKeys[id]!,
    (id) => meshes[id]!,
    (id) => sampled.frames[0]!.poses.get(id),
    (id) => colors[id],
  );
  const glbBytes = encodePoseGlb(ordered, { name: "Wave", sampled });
  const { json, readAccessor } = parseGlb(glbBytes);
  check("GLB has 5 nodes (root + 4 members)", json.nodes.length === 5, `got ${json.nodes.length}`);
  check("GLB root node has D2 scale 0.001 and -90 deg X", near(json.nodes[0].scale[0], 0.001, 1e-9) && near(json.nodes[0].rotation[0], -Math.SQRT1_2, 1e-6));
  check("GLB node nesting follows joint tree (root -> Base -> Arm -> Tip, Tip-2)",
    JSON.stringify(json.nodes[0].children) === "[1]" &&
    JSON.stringify(json.nodes[1].children) === "[2]" &&
    JSON.stringify(json.nodes[2].children) === "[3,4]",
    JSON.stringify(json.nodes.map((n: { children?: number[] }) => n.children)),
  );
  check("GLB shares one mesh for tip1 and tip2 (same part & colour)", json.meshes.length === 3 && json.nodes[3].mesh === json.nodes[4].mesh);

  // Compute world matrices of member nodes WITHOUT the D2 root node (i.e. in model mm space).
  const parentOf = new Map<number, number>();
  for (let i = 0; i < json.nodes.length; i++) {
    for (const child of json.nodes[i].children ?? []) parentOf.set(child, i);
  }
  const worldInModel = (nodeIdx: number, overrides?: Map<number, { t?: number[]; q?: number[] }>): number[] => {
    const node = json.nodes[nodeIdx];
    const ov = overrides?.get(nodeIdx);
    const local = trsToMat4(ov?.t ?? node.translation, ov?.q ?? node.rotation, node.scale);
    const p = parentOf.get(nodeIdx);
    if (p === undefined || p === 0) return local;
    return mul4(worldInModel(p, overrides), local);
  };

  let glbMin = [Infinity, Infinity, Infinity];
  let glbMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < ordered.members.length; i++) {
    const mat = worldInModel(i + 1);
    const want = ordered.members[i]!.pose;
    const okMat =
      near(mat[0]!, want.m[0], 1e-5) && near(mat[1]!, want.m[1], 1e-5) && near(mat[2]!, want.m[2], 1e-5) && near(mat[3]!, want.t[0], 1e-4) &&
      near(mat[4]!, want.m[3], 1e-5) && near(mat[5]!, want.m[4], 1e-5) && near(mat[6]!, want.m[5], 1e-5) && near(mat[7]!, want.t[1], 1e-4) &&
      near(mat[8]!, want.m[6], 1e-5) && near(mat[9]!, want.m[7], 1e-5) && near(mat[10]!, want.m[8], 1e-5) && near(mat[11]!, want.t[2], 1e-4);
    check(`GLB node ${ordered.members[i]!.name} world matrix matches pose`, okMat);
    const mesh = json.meshes[json.nodes[i + 1].mesh];
    const pos = readAccessor(mesh.primitives[0].attributes.POSITION);
    for (let v = 0; v + 2 < pos.length; v += 3) {
      const x = pos[v]!, y = pos[v + 1]!, z = pos[v + 2]!;
      const wx = mat[0]! * x + mat[1]! * y + mat[2]! * z + mat[3]!;
      const wy = mat[4]! * x + mat[5]! * y + mat[6]! * z + mat[7]!;
      const wz = mat[8]! * x + mat[9]! * y + mat[10]! * z + mat[11]!;
      glbMin[0] = Math.min(glbMin[0]!, wx); glbMin[1] = Math.min(glbMin[1]!, wy); glbMin[2] = Math.min(glbMin[2]!, wz);
      glbMax[0] = Math.max(glbMax[0]!, wx); glbMax[1] = Math.max(glbMax[1]!, wy); glbMax[2] = Math.max(glbMax[2]!, wz);
    }
  }
  check("GLB posed bounds equal assembly posed bounds", sameBox({ min: glbMin, max: glbMax }, wantBounds, 1e-3));

  // Animation playback check (Decision 1): check every sampled frame k against player's frame k!
  check("GLB carries 1 animation named Wave", json.animations?.length === 1 && json.animations[0].name === "Wave");
  const anim = json.animations[0];
  // Base and Tip-2 do not move relative to their parents; Arm and Tip move!
  const animatedNodes = new Set(anim.channels.map((ch: { target: { node: number } }) => ch.target.node));
  check("GLB animation only channels moving members (Arm=2, Tip=3)", animatedNodes.has(2) && animatedNodes.has(3) && !animatedNodes.has(1) && !animatedNodes.has(4), JSON.stringify([...animatedNodes]));
  for (let k = 0; k < sampled.frames.length; k++) {
    const overrides = new Map<number, { t?: number[]; q?: number[] }>();
    for (const ch of anim.channels) {
      const sampler = anim.samplers[ch.sampler];
      const values = readAccessor(sampler.output);
      const entry = overrides.get(ch.target.node) ?? {};
      if (ch.target.path === "translation") entry.t = [values[k * 3]!, values[k * 3 + 1]!, values[k * 3 + 2]!];
      if (ch.target.path === "rotation") entry.q = [values[k * 4]!, values[k * 4 + 1]!, values[k * 4 + 2]!, values[k * 4 + 3]!];
      overrides.set(ch.target.node, entry);
    }
    const frame = sampled.frames[k]!;
    for (let i = 0; i < restOrdered.members.length; i++) {
      const mat = worldInModel(i + 1, overrides);
      const want = frame.poses.get(restOrdered.members[i]!.object)!;
      const okMat =
        near(mat[0]!, want.m[0], 1e-4) && near(mat[4]!, want.m[3], 1e-4) && near(mat[8]!, want.m[6], 1e-4) &&
        near(mat[3]!, want.t[0], 1e-3) && near(mat[7]!, want.t[1], 1e-3) && near(mat[11]!, want.t[2], 1e-3);
      check(`GLB animation frame ${k} node ${restOrdered.members[i]!.name} matches player frame`, okMat);
    }
  }
}

// --- 3. 3MF assembly: unzip and parse, one build item per member with transform, posed bounds ---
{
  const zipBytes = encodePose3mf(ordered);
  const unzipped = unzipSync(zipBytes);
  const xml = new TextDecoder().decode(unzipped["3D/3dmodel.model"]!);
  const objects = new Map<string, [number, number, number][]>();
  for (const match of xml.matchAll(/<object id="(\d+)"[^>]*>.*?<vertices>(.*?)<\/vertices>.*?<\/object>/g)) {
    const verts: [number, number, number][] = [];
    for (const v of match[2]!.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)" \/>/g)) {
      verts.push([Number(v[1]), Number(v[2]), Number(v[3])]);
    }
    objects.set(match[1]!, verts);
  }
  const items = [...xml.matchAll(/<item objectid="(\d+)" transform="([^"]+)" \/>/g)];
  check("3MF has 3 distinct objects (tip1 & tip2 shared) and 4 build items", objects.size === 3 && items.length === 4, `objects=${objects.size} items=${items.length}`);
  check("3MF carries basematerials colours", xml.includes("<basematerials") && xml.includes("#4080C0FF") && xml.includes("#E07040FF"));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const item of items) {
    const verts = objects.get(item[1]!)!;
    const m = item[2]!.split(" ").map(Number);
    for (const [x, y, z] of verts) {
      // 3MF row-vector transform: [x y z 1] * M
      const wx = x * m[0]! + y * m[3]! + z * m[6]! + m[9]!;
      const wy = x * m[1]! + y * m[4]! + z * m[7]! + m[10]!;
      const wz = x * m[2]! + y * m[5]! + z * m[8]! + m[11]!;
      min[0] = Math.min(min[0]!, wx); min[1] = Math.min(min[1]!, wy); min[2] = Math.min(min[2]!, wz);
      max[0] = Math.max(max[0]!, wx); max[1] = Math.max(max[1]!, wy); max[2] = Math.max(max[2]!, wz);
    }
  }
  check("3MF posed bounds match assembly posed bounds", sameBox({ min, max }, wantBounds, 1e-3), JSON.stringify({ min, max, wantBounds }));
}

// --- 4. STL: one file and ZIP of one per member ---
{
  const expectedTris = 4 * 12; // 4 boxes × 12 triangles each
  const oneStl = encodePoseStl(ordered, "one");
  const parsed = parseBinaryStl(oneStl);
  check("STL one file triangle count", parsed.count === expectedTris, `got ${parsed.count}`);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < parsed.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, parsed.positions[i + a]!);
      max[a] = Math.max(max[a]!, parsed.positions[i + a]!);
    }
  }
  check("STL one file posed bounds match", sameBox({ min, max }, wantBounds, 1e-3));

  const zipStl = encodePoseStl(ordered, "each");
  const unzipped = unzipSync(zipStl);
  const namesInZip = Object.keys(unzipped).sort();
  check("STL each ZIP has 4 files named after members", namesInZip.length === 4 && namesInZip.includes("Base.stl") && namesInZip.includes("Arm.stl") && namesInZip.includes("Tip.stl") && namesInZip.includes("Tip-2.stl"), JSON.stringify(namesInZip));
}

// --- 5. OBJ + MTL: one group per member, material per colour, triangle count & posed bounds ---
{
  const { obj, mtl, triangles } = encodePoseObjMtl(ordered, "robot-arm-pose.mtl");
  const objText = new TextDecoder().decode(obj);
  const mtlText = new TextDecoder().decode(mtl);
  const groups = [...objText.matchAll(/^g (.+)$/gm)].map((m) => m[1]);
  check("OBJ has one group per member", JSON.stringify(groups) === JSON.stringify(["Base", "Arm", "Tip", "Tip-2"]), JSON.stringify(groups));
  check("OBJ triangle count matches", triangles === 48, `got ${triangles}`);
  check("MTL has 3 distinct materials", [...mtlText.matchAll(/^newmtl /gm)].length === 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const v of objText.matchAll(/^v ([^ ]+) ([^ ]+) ([^ ]+)$/gm)) {
    const pt = [Number(v[1]), Number(v[2]), Number(v[3])];
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, pt[a]!);
      max[a] = Math.max(max[a]!, pt[a]!);
    }
  }
  check("OBJ posed bounds match assembly posed bounds", sameBox({ min, max }, wantBounds, 1e-3));
}

// --- 6. Exporting a frame does not mutate the original assembly ---
{
  const restPoses = solveAssembly(assembly, (id) => (id === "base" ? rootPose : undefined)).poses;
  check("original assembly Arm angle stays 0", assembly.members[1]!.joint?.kind === "hinge" && assembly.members[1]!.joint.angle === 0);
  const restTip = applyPose(restPoses.get("tip1")!, [0, 0, 4]);
  const frameTip = applyPose(lastFrame.poses.get("tip1")!, [0, 0, 4]);
  check("exported frame pose differs from rest pose", Math.hypot(restTip[0] - frameTip[0], restTip[1] - frameTip[1], restTip[2] - frameTip[2]) > 5);
}

if (failed > 0) {
  console.error(`pose-export: ${failed} failed`);
  process.exit(1);
}
console.log("pose-export: ok");
