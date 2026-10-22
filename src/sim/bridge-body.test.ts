/**
 * The bridge body keeps face winding, and a reply becomes corners the view can draw.
 */
import { provisionalCards } from "./cards.ts";
import { buildStudyBody, faceTriangles, surfaceResult } from "./bridge-body.ts";
import { emptyStudy, vertexColours } from "./study.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1];
const triangles = [4, 4];
const faces = faceTriangles(positions, triangles, [4]);
check("a face keeps both triangles and their winding", faces.length === 2 && faces[0]![0]![0] === 0 && faces[0]![1]![0] === 1 && faces[0]![2]![1] === 1);
check("another face is left out", faceTriangles(positions, triangles, [1]).length === 0);

const study = emptyStudy();
study.holds = [{ kind: "bed", faces: [] }];
study.edgeMm = 2;
const body = buildStudyBody({
  request: { filename: "box.stl" },
  study,
  card: provisionalCards()[1]!,
  triangles: (indexes) => faceTriangles(positions, triangles, indexes),
  bounds: { min: [0, 0, 0], max: [10, 4, 2] },
  checkResolution: false,
});
if (typeof body !== "string") {
  check("a bed and a load build a body", false, body.reason);
} else {
  const parsed = JSON.parse(body) as { study: { holds: { kind: string }[]; loads: { kind: string; force: number[]; region: { kind: string } }[]; checkResolution: boolean; hXy: number } };
  check("Bed is a bed hold", parsed.study.holds[0]?.kind === "bed");
  check("a load with no face is the +X slab", parsed.study.loads[0]?.region.kind === "box" && parsed.study.loads[0]?.force[2] === -10);
  check("the edge length is hXy and the second size can be skipped", parsed.study.hXy === 2 && parsed.study.checkResolution === false);
}

const plane = emptyStudy();
plane.holds = [{ kind: "plane", faces: [], normal: [0, 0, 1], origin: [0, 0, 0] }];
const refused = buildStudyBody({
  request: {},
  study: plane,
  card: provisionalCards()[0]!,
  triangles: () => [],
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
});
check("a plane hold is refused", typeof refused !== "string" && refused.reason.startsWith("A plane hold"));

function b64(values: number[]): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

const reply = JSON.stringify({
  ok: true,
  report: {
    representation: "sliced",
    trust: "usable",
    notes: ["Solved at one cell size."],
    margins: [{ kind: "minSafetyFactor", value: 2.5, margin: 1.5, met: true, hotSpot: { at: [1, 2, 3] } }],
    maxDisplacementMm: 0.01,
    minSafetyFactor: 2.5,
    massG: 1.2,
  },
  surface: {
    triangles: 1,
    positionsB64: b64([0, 0, 0, 4, 0, 0, 0, 4, 0]),
    displacementB64: b64([0, 0, 0, 0, 0, 0, 0, 0, -0.1]),
    vonMisesB64: b64([1, 4, 9]),
    safetyB64: b64([3, 2, 1]),
  },
});
const drawn = surfaceResult(reply, "vonMises");
if ("error" in drawn) {
  check("a reply draws", false, drawn.error);
} else {
  check("three corners are drawn", drawn.nodes.length === 3 && drawn.triangles.length === 3);
  check("the field is the corner's von Mises", drawn.nodes[2]!.vonMises === 9);
  check("the hot spot is kept", drawn.margins?.[0]?.at[0] === 1 && drawn.margins[0].at[2] === 3);
  check("the note and the trust word come back", drawn.trust === "usable" && drawn.notes?.[0] === "Solved at one cell size.");
  check("it is marked as sliced", drawn.representation === "sliced");
  const safety = surfaceResult(reply, "safety");
  if ("error" in safety) check("safety colours", false, safety.error);
  else {
    const colours = vertexColours(safety);
    check("safety paints the low value hotter", (colours[6] ?? 0) > (colours[0] ?? 1));
  }
}

const bad = surfaceResult(JSON.stringify({ ok: false, reason: "The slice has no beads that carry load." }), "vonMises");
check("a refusal is the bridge's sentence", "error" in bad && bad.error === "The slice has no beads that carry load.");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("bridge body: ok");
