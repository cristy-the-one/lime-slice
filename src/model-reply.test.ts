import { bytesToBase64 } from "./base64.ts";
import { DAMAGED, MISMATCHED, SOLID_FORMAT, decodeSolid, encodeSolid, type ParsedSolid } from "./model-reply.ts";

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

if (failed) throw new Error(`${failed} model reply checks failed`);
console.log("model-reply: ok");
