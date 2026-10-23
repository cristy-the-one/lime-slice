/**
 * The bridge body keeps face winding, and a reply becomes corners the view can draw.
 */
import { provisionalCards } from "./cards.ts";
import { buildStudyBody, faceTriangles, inSolidFrame, resolutionMove, surfaceResult } from "./bridge-body.ts";
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
study.loads[0]!.faces = [4];
study.edgeMm = 2;
const body = buildStudyBody({
  request: { filename: "box.stl" },
  study,
  card: provisionalCards()[1]!,
  triangles: (indexes) => faceTriangles(positions, triangles, indexes),
  checkResolution: false,
});
if (typeof body !== "string") {
  check("a bed and a load build a body", false, body.reason);
} else {
  const parsed = JSON.parse(body) as {
    study: {
      holds: { kind: string }[];
      loads: { kind: string; force: number[]; region: { kind: string; triangles: number[][][] } }[];
      checkResolution: boolean;
      hXy: number;
      constraints: { kind: string; value: number }[];
    };
  };
  check("Bed is a bed hold", parsed.study.holds[0]?.kind === "bed");
  check("the card goes with its bead section", (parsed.study as unknown as { card: { beads?: { EAlongBeadMPa: number } } }).card.beads?.EAlongBeadMPa === 1800);
  check("a load on a face sends that face's triangles", parsed.study.loads[0]?.region.kind === "faces" && parsed.study.loads[0]?.region.triangles.length === 2 && parsed.study.loads[0]?.force[2] === -10);
  check("the edge length is hXy and the second size can be skipped", parsed.study.hXy === 2 && parsed.study.checkResolution === false);
  check("no target typed sends a safety factor of 1", parsed.study.constraints.length === 1 && parsed.study.constraints[0]?.kind === "minSafetyFactor" && parsed.study.constraints[0]?.value === 1);
}

const targeted = buildStudyBody({
  request: { filename: "box.stl" },
  study,
  card: provisionalCards()[1]!,
  triangles: (indexes) => faceTriangles(positions, triangles, indexes),
  constraints: [{ kind: "minSafetyFactor", value: 2 }, { kind: "maxDeflectionMm", value: 1.5 }],
});
if (typeof targeted !== "string") {
  check("typed targets build a body", false, targeted.reason);
} else {
  const parsed = JSON.parse(targeted) as { study: { constraints: { kind: string; value: number }[] } };
  const kinds = parsed.study.constraints.map((row) => `${row.kind}:${row.value}`);
  check("the body carries the typed targets", kinds.join(",") === "minSafetyFactor:2,maxDeflectionMm:1.5", kinds.join(","));
}

const plane = emptyStudy();
plane.holds = [{ kind: "plane", faces: [], normal: [0, 0, 1], origin: [0, 0, 0] }];
const refused = buildStudyBody({
  request: {},
  study: plane,
  card: provisionalCards()[0]!,
  triangles: () => [],
});
check("a plane hold is refused", typeof refused !== "string" && refused.reason.startsWith("A plane hold"));

const unloaded = emptyStudy();
unloaded.holds = [{ kind: "bed", faces: [] }];
const noFace = buildStudyBody({
  request: {},
  study: unloaded,
  card: provisionalCards()[0]!,
  triangles: (indexes) => faceTriangles(positions, triangles, indexes),
});
check("a load with no face is refused, not put on +X", typeof noFace !== "string" && noFace.reason === "Pick the faces the load pushes on.");

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
    margins: [{ kind: "minSafetyFactor", limit: 1, value: 2.5, margin: 1.5, met: true, hotSpot: { at: [1, 2, 3], role: "outer", governs: "across-layers" } }],
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
  check(
    "the limit, the role, and governs come back",
    drawn.margins?.[0]?.limit === 1 && drawn.margins[0].role === "outer" && drawn.margins[0].governs === "across-layers",
  );
  check("the note and the trust word come back", drawn.trust === "usable" && drawn.notes?.[0] === "Solved at one cell size.");
  check("it is marked as sliced", drawn.representation === "sliced");
  const safety = surfaceResult(reply, "safety");
  if ("error" in safety) check("safety colours", false, safety.error);
  else {
    const colours = vertexColours(safety);
    check("safety paints the low value hotter", (colours[6] ?? 0) > (colours[0] ?? 1));
  }
}

const unknownTrust = JSON.parse(reply) as { report: { trust: string } };
unknownTrust.report.trust = "nope";
const rough = surfaceResult(JSON.stringify(unknownTrust), "vonMises");
check("an unknown trust is rough", !("error" in rough) && rough.trust === "rough", "error" in rough ? rough.error : rough.trust);

const bad = surfaceResult(JSON.stringify({ ok: false, reason: "The slice has no beads that carry load." }), "vonMises");
check("a refusal is the bridge's sentence", "error" in bad && bad.error === "The slice has no beads that carry load.");

check("the move between sizes is read as the solver reads it", Math.abs((resolutionMove([{ governingValue: 1 }, { governingValue: 0.66 }]) ?? 0) - 0.34) < 1e-12);
check("one cell size has no move", resolutionMove([{ governingValue: 1 }]) === null);
{
  // The plate mesh sits 10 mm lower than the solid on screen: the colours follow the solid.
  const shifted = inSolidFrame(
    {
      label: "In-house estimate", field: "vonMises", scale: 1, peak: 0, unit: "", trust: "rough", trustSentence: "", diagonal: 1,
      triangles: [0], nodes: [{ at: [1, 2, 0], u: [0, 0, -0.5], vonMises: 3, displacement: 0.5, safety: 2 }],
      margins: [{ kind: "minSafetyFactor", value: 2, margin: 1, met: true, at: [0, 0, 0] }],
    },
    (at) => [at[0], at[1], at[2] + 10],
  );
  check("a node moves into the solid's frame", JSON.stringify(shifted.nodes[0]?.at) === "[1,2,10]" && JSON.stringify(shifted.nodes[0]?.u) === "[0,0,-0.5]", JSON.stringify(shifted.nodes[0]));
  check("a hot spot moves with it", JSON.stringify(shifted.margins?.[0]?.at) === "[0,0,10]");
}
{
  const body = JSON.parse(buildStudyBody({
    request: { dataB64: "AA==" },
    study: { ...emptyStudy(), holds: [{ kind: "bed", faces: [] }], loads: [{ kind: "force", faces: [0], magnitude: 1, direction: [0, 0, -1] }] },
    card: provisionalCards()[0]!,
    triangles: () => [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]],
    paint: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  }) as string) as { paint?: string };
  check("the part's corners go to the bridge as little-endian floats", body.paint === Buffer.from(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString("base64"));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("bridge body: ok");
