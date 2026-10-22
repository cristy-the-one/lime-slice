/**
 * SR-20. Each pattern patch is a toughness on the slice request. The layer
 * note names the pattern that toughness sliced as.
 */
import { fileURLToPath } from "node:url";

import { bytesToBase64 } from "../src/base64.ts";
import { encodeStl } from "../src/mesh-place.ts";
import { patternBlend, PATTERN_TOUGHNESS, type PatternName } from "../src/sim/pattern-patch.ts";

import { loadNativeEngine } from "./engine.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function syncText(value: string | Promise<string>): string {
  if (typeof value !== "string") throw new Error("the engine answered asynchronously");
  return value;
}

/** A closed box, outward, sitting on Z = 0. */
function boxPositions(min: number[], max: number[]): Float32Array {
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

function patternToken(note: string): string | null {
  const matched = /infill=\d+% (\S+)/.exec(note);
  return matched?.[1] ?? null;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const engine = loadNativeEngine(root);
const dataB64 = bytesToBase64(new Uint8Array(encodeStl(boxPositions([-5, -5, 0], [5, 5, 2]), "pattern-box")));
const names = Object.keys(PATTERN_TOUGHNESS) as PatternName[];

check(
  "the patch toughness sits on the mix thresholds",
  PATTERN_TOUGHNESS.lightning === 0 && PATTERN_TOUGHNESS.lines === 0.3 && PATTERN_TOUGHNESS.grid === 0.6 && PATTERN_TOUGHNESS.gyroid === 0.9,
);

for (const pattern of names) {
  const blend = patternBlend(pattern);
  const body = {
    filename: "pattern-box.stl",
    dataB64,
    blend,
    printer: {
      name: "Generic Marlin 0.4 mm PLA",
      nozzleDiameter: 0.4,
      filamentDiameter: 1.75,
      nozzleTemp: 200,
      bedTemp: 60,
      bedX: 220,
      bedY: 220,
    },
    supports: false,
    baseline: false,
    includeGcode: false,
    includePreview: true,
  };
  const started = JSON.parse(syncText(engine.sliceStart(JSON.stringify(body)))) as { id?: number; error?: string };
  if (typeof started.id !== "number") {
    check(`${pattern} slices`, false, started.error ?? "no id");
    continue;
  }
  let note = "";
  let error = "";
  for (let i = 0; i < 200 && !note && !error; i += 1) {
    const poll = JSON.parse(syncText(engine.slicePoll(String(started.id)))) as {
      status?: string;
      result?: string;
      error?: string;
    };
    if (poll.status === "done" && poll.result) {
      const wire = JSON.parse(poll.result) as { layers?: { note?: string }[]; error?: string };
      note = wire.layers?.[0]?.note ?? "";
      if (!note) error = `no layer note in ${Object.keys(wire).join(",")}`;
    } else if (poll.status === "error" || poll.error) {
      error = poll.error ?? poll.status ?? "error";
    } else {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  const token = patternToken(note);
  // mix turns gyroid's 3D flag on, so the note says gyroid3d.
  const want = pattern === "gyroid" ? token === "gyroid" || token === "gyroid3d" : token === pattern;
  check(
    `${pattern} slices as ${pattern}`,
    !error && want,
    error || `note ${JSON.stringify(note)} token ${token ?? "none"}`,
  );
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("pattern slice: ok");
