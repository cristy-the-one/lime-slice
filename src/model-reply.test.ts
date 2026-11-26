import { bytesToBase64 } from "./base64.ts";
import { DAMAGED, MISMATCHED, SOLID_FORMAT, decodeSolid, decodeSurfaceInspect, encodeSolid, unpackModelReply, type ParsedSolid } from "./model-reply.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const solid = (body: Record<string, unknown>): ParsedSolid => {
  const decoded = decodeSolid(body);
  if (typeof decoded === "string") throw new Error(`not a solid: ${decoded}`);
  return decoded;
};

// Two triangles on two faces; an edge of two points and one of three.
const sent = {
  volumeMm3: 12.5,
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0.1, -2.5, 3e6, 1, 1, 1, -0, 0, 1],
  triangles: [1, 0],
  faces: [{ areaMm2: 0.5, normal: [0, 0, 1] as [number, number, number] }, { areaMm2: 0.25 }],
  edges: [
    { lengthMm: 1, points: [0, 0, 0, 1, 0, 0] },
    { lengthMm: 2.5, points: [0, 0, 0, 0, 1, 0, 0, 1, 1] },
  ],
};
const body = { id: 7, ...encodeSolid(sent), fingerprint: { volumeMm3: 12.5, faces: 2, edges: 2 } };
const back = solid(body);
eq("the format is named", body.format, SOLID_FORMAT);
eq("scalars and ids", [back.id, back.volumeMm3, back.editable, back.fingerprint], [7, 12.5, true, { volumeMm3: 12.5, faces: 2, edges: 2 }]);
check("positions are f32", back.positions instanceof Float32Array);
eq("positions round-trip within f32", Array.from(back.positions), sent.positions.map(Math.fround));
check("face ids are u32", back.triangles instanceof Uint32Array);
eq("face ids round-trip", Array.from(back.triangles), [1, 0]);
eq("faces by index, the normal only where sent", back.faces, [{ id: 0, areaMm2: 0.5, normal: [0, 0, 1] }, { id: 1, areaMm2: 0.25 }]);
const curved = solid({
  ...encodeSolid({
    ...sent,
    faces: [{ areaMm2: 1, surface: "cylinder", radiusMm: 10, axisPoint: [0, 0, 0], axis: [0, 0, 1] }, { areaMm2: 0.25 }],
  }),
});
eq("a cylinder face keeps its radius", curved.faces[0], { id: 0, areaMm2: 1, surface: "cylinder", radiusMm: 10, axisPoint: [0, 0, 0], axis: [0, 0, 1] });
const whole = solid({
  ...encodeSolid({
    ...sent,
    faces: [{ areaMm2: 1, normal: [-1, 0, 0], closed: true, inMaxMm: 0.5 }, { areaMm2: 0.25, closed: true, inMaxMm: 4, outMaxMm: 6 }],
  }),
});
eq("a closed face keeps how far it folds", whole.faces, [
  { id: 0, areaMm2: 1, normal: [-1, 0, 0], closed: true, inMaxMm: 0.5 },
  { id: 1, areaMm2: 0.25, closed: true, inMaxMm: 4, outMaxMm: 6 },
]);
eq("edges by index", back.edges.map((edge) => [edge.id, edge.lengthMm, Array.from(edge.points)]), [
  [0, 1, [0, 0, 0, 1, 0, 0]],
  [1, 2.5, [0, 0, 0, 0, 1, 0, 0, 1, 1]],
]);
check("edge polylines view one buffer, not copies", back.edges[0]!.points.buffer === back.edges[1]!.points.buffer);
eq("surfaces only", solid({ ...encodeSolid({ ...sent, solid: false }) }).editable, false);
eq("no fingerprint reads as none", solid(encodeSolid(sent)).fingerprint, null);
const empty = solid(encodeSolid({ volumeMm3: 0, positions: [], triangles: [], faces: [], edges: [] }));
eq("an empty mesh", [empty.positions.length, empty.triangles.length, empty.edges.length], [0, 0, 0]);

// The words are little-endian: 1.5, -2, and 0.1 as f32, then six zeros; face 0; no edges.
const pinned = solid({
  format: SOLID_FORMAT,
  volumeMm3: 1,
  faces: [{ areaMm2: 1 }],
  edgeLengths: [],
  positions: "AADAPwAAAMDNzMw9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  triangles: "AAAAAA==",
  edgePoints: "",
  edgeOffsets: "AAAAAA==",
});
eq("little-endian f32 on the wire", Array.from(pinned.positions.subarray(0, 3)), [1.5, -2, Math.fround(0.1)]);

eq("the engine's error passes through", decodeSolid({ error: "The hole missed this solid" }), "The hole missed this solid");
const { format: _format, ...unnamed } = body;
eq("no format is refused", decodeSolid(unnamed), MISMATCHED);
eq("another format is refused", decodeSolid({ ...body, format: "lime-solid-1" }), MISMATCHED);
eq("JSON number arrays are refused", decodeSolid({ id: 0, volumeMm3: 1, positions: sent.positions, triangles: [1, 0], faces: [], edges: [] }), MISMATCHED);

const words = (values: number[], kind: "f32" | "u32") => {
  const array = kind === "f32" ? Float32Array.from(values) : Uint32Array.from(values);
  return bytesToBase64(new Uint8Array(array.buffer));
};
eq("a short positions buffer", decodeSolid({ ...body, positions: words(sent.positions.slice(0, 17), "f32") }), DAMAGED);
eq("positions for a third triangle", decodeSolid({ ...body, positions: words([...sent.positions, 0, 0, 0, 0, 0, 0, 0, 0, 0], "f32") }), DAMAGED);
eq("a face id past the faces", decodeSolid({ ...body, triangles: words([2, 0], "u32") }), DAMAGED);
eq("an odd byte count", decodeSolid({ ...body, triangles: bytesToBase64(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0])) }), DAMAGED);
eq("not base64", decodeSolid({ ...body, positions: "@@@@" }), DAMAGED);
eq("a missing array", decodeSolid({ ...body, edgePoints: undefined }), DAMAGED);
eq("an edge past the points", decodeSolid({ ...body, edgeOffsets: words([0, 2, 6], "u32") }), DAMAGED);
eq("points no edge covers", decodeSolid({ ...body, edgeOffsets: words([0, 2, 4], "u32") }), DAMAGED);
eq("offsets that run backwards", decodeSolid({ ...body, edgeOffsets: words([0, 3, 2], "u32") }), DAMAGED);
eq("one offset short", decodeSolid({ ...body, edgeOffsets: words([0, 2], "u32") }), DAMAGED);
eq("a face with no area", decodeSolid({ ...body, faces: [{ areaMm2: 0.5 }, {}] }), DAMAGED);

const coloured = solid({ ...body, stepFaces: [0, null] });
eq("step faces round-trip when they match", coloured.stepFaces, [0, null]);
eq("step faces are written only when sent", "stepFaces" in encodeSolid(sent), false);
eq("a short step face list is ignored", solid({ ...body, stepFaces: [0] }).stepFaces, undefined);
eq("a step face that is not a node is ignored", solid({ ...body, stepFaces: [0, "nope"] }).stepFaces, undefined);

// --- Organic surfaces S1: analytic normals & lazy surfaceInspect decoding ---
const withNormals = encodeSolid({ ...sent, normals: sent.positions.map((_, i) => (i % 3 === 2 ? 1 : 0)) });
const decodedNormals = solid(withNormals);
check("normals round-trip when matching positions length", !!decodedNormals.normals && decodedNormals.normals.length === sent.positions.length && decodedNormals.normals[2] === 1);
eq("mismatched normals buffer is ignored cleanly", solid({ ...body, normals: words([0, 0, 1], "f32") }).normals, undefined);

const inspected = decodeSurfaceInspect({
  id: 3,
  minRadiusMm: words([2.5, 1e9], "f32"),
  gaussian: words([0.16, 0], "f32"),
  mean: words([-0.4, 0], "f32"),
  isoPoints: words([0, 0, 0, 1, 0, 0], "f32"),
  continuity: { sharedEdges: 2, g2: 0, g1: 2, g0: 0, gaps: 0, maxGapMm: 0, worstSmoothAngleDeg: 0.05, worstCurvatureJump: 0.33, notable: [] },
  surfaceHealth: { faces: 2, kinds: { plane: 1, cylinder: 1, cone: 0, sphere: 0, torus: 0, bspline: 0, bezier: 0, other: 0 }, maxUDegree: 0, maxVDegree: 0, maxPoles: 0, rationalFaces: 0, highDegreeFaces: 0, heavyFaces: 0, minRadiusMm: 2.5, tightestFace: 1, tightestAt: [0, 0, 0] },
});
check("surfaceInspect decodes buffers and summaries", typeof inspected !== "string" && inspected.minRadiusMm?.[0] === 2.5 && inspected.isoPoints?.length === 6 && inspected.continuity.g1 === 2);
eq("surfaceInspect error passes through", decodeSurfaceInspect({ error: "missing" }), "missing");

// --- LMB1 binary IPC framing (zero-Base64 zero-copy ArrayBuffer views) ---
function packLmb1(header: Record<string, unknown>, blobs: Uint8Array[]): ArrayBuffer {
  let blobBytes = 0;
  for (const b of blobs) blobBytes = ((blobBytes + 3) & ~3) + b.byteLength;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(header));
  const blobBase = (12 + jsonBytes.byteLength + 3) & ~3;
  const buf = new ArrayBuffer(blobBase + blobBytes);
  const out = new Uint8Array(buf);
  out.set([0x4c, 0x4d, 0x42, 0x31], 0); // "LMB1"
  const view = new DataView(buf);
  view.setUint32(4, jsonBytes.byteLength, true);
  view.setUint32(8, 0, true);
  out.set(jsonBytes, 12);
  let cursor = blobBase;
  for (const b of blobs) {
    cursor = (cursor + 3) & ~3;
    out.set(b, cursor);
    cursor += b.byteLength;
  }
  return buf;
}

{
  const posArr = Float32Array.from(sent.positions);
  const triArr = Uint32Array.from(sent.triangles);
  const epArr = Float32Array.from([...sent.edges[0]!.points, ...sent.edges[1]!.points]);
  const eoArr = Uint32Array.from([0, 2, 5]);
  const dispPos = Float32Array.from(sent.positions);
  const dispNorm = Float32Array.from(sent.positions.map((_, i) => (i % 3 === 2 ? 1 : 0)));
  const dispTri = Uint32Array.from(sent.triangles);
  const blobs = [posArr, triArr, epArr, eoArr, dispPos, dispNorm, dispTri].map(
    (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
  );
  const refs: [number, number][] = [];
  let off = 0;
  for (const b of blobs) {
    off = (off + 3) & ~3;
    refs.push([off, b.byteLength]);
    off += b.byteLength;
  }
  const frame = packLmb1(
    {
      id: 7,
      format: SOLID_FORMAT,
      volumeMm3: sent.volumeMm3,
      solid: true,
      faces: sent.faces,
      edgeLengths: sent.edges.map((e) => e.lengthMm),
      fingerprint: { volumeMm3: 12.5, faces: 2, edges: 2 },
      positions: { $bin: refs[0] },
      triangles: { $bin: refs[1] },
      edgePoints: { $bin: refs[2] },
      edgeOffsets: { $bin: refs[3] },
      display: {
        positions: { $bin: refs[4] },
        normals: { $bin: refs[5] },
        triangles: { $bin: refs[6] },
      },
    },
    blobs,
  );
  const unpacked = unpackModelReply(frame);
  const binSolid = solid(unpacked);
  eq("LMB1 solid positions match base64 round-trip", Array.from(binSolid.positions), Array.from(back.positions));
  eq("LMB1 solid triangles match base64 round-trip", Array.from(binSolid.triangles), Array.from(back.triangles));
  eq("LMB1 edge points match", binSolid.edges.map((e) => Array.from(e.points)), back.edges.map((e) => Array.from(e.points)));
  check("LMB1 positions view the incoming ArrayBuffer with zero copy", binSolid.positions.buffer === frame);
  check("LMB1 triangles view the incoming ArrayBuffer with zero copy", binSolid.triangles.buffer === frame);
  check("LMB1 display positions & normals view the incoming ArrayBuffer with zero copy",
    !!binSolid.display && binSolid.display.positions.buffer === frame && binSolid.display.normals?.buffer === frame);

  // Plain UTF-8 JSON bytes and JSON strings pass through unpackModelReply cleanly.
  const plainBytes = new TextEncoder().encode(JSON.stringify({ ok: true, id: 4 })).buffer;
  eq("plain UTF-8 JSON ArrayBuffer unpacks cleanly", unpackModelReply(plainBytes), { ok: true, id: 4 });
  eq("JSON string unpacks cleanly", unpackModelReply(JSON.stringify({ error: "nope" })), { error: "nope" });

  // Corrupt LMB1 frames (bad flags, out-of-bounds $bin) are rejected.
  let threw = false;
  try {
    unpackModelReply(packLmb1({ positions: { $bin: [0, 9999] } }, []));
  } catch {
    threw = true;
  }
  check("out-of-bounds LMB1 $bin descriptor throws", threw);
}

if (failed) throw new Error(`${failed} model reply checks failed`);
console.log("model-reply: ok");
