/**
 * A hover repaints two faces. The buffer it leaves, and the buffer a card would hold after uploading only the runs it
 * names, are the ones a repaint of every triangle gives.
 */
import { facePaint } from "../model-look.ts";
import { faceTriangles } from "../model-select.ts";
import { colourRuns, fillFace, fillFaces } from "./face-colours.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

let seed = 77;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** The repaint as it was before: every triangle, each corner written from the face's colour. */
function paintAll(triangles: Uint32Array, into: Float32Array, hexOf: (face: number) => number) {
  triangles.forEach((face, triangle) => {
    const hex = hexOf(face);
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = triangle * 9 + vertex * 3;
      into[offset] = ((hex >> 16) & 255) / 255;
      into[offset + 1] = ((hex >> 8) & 255) / 255;
      into[offset + 2] = (hex & 255) / 255;
    }
  });
}

const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((value, i) => value === b[i]);

/** `faces` faces over `count` triangles: mostly runs, as a kernel meshes a face, with some faces in several pieces. */
function mesh(count: number, faces: number): Uint32Array {
  const triangles = new Uint32Array(count);
  let face = 0;
  for (let t = 0; t < count; t += 1) {
    if (rnd() < faces / count) face = Math.floor(rnd() * faces);
    triangles[t] = face;
  }
  return triangles;
}

for (const colourByStep of [false, true]) {
  const triangles = mesh(6000, 300);
  const owners = Array.from({ length: 300 }, (_, face) => (face % 9 === 0 ? null : face % 5));
  const selected = new Set([3, 40, 41]);
  const study = new Map([[7, 0xd9a441], [41, 0x3f8f6b]]);
  const hexOf = (hover: number | null) => (face: number) =>
    facePaint({ index: face, owner: owners[face] ?? null, selected: selected.has(face), pickHover: hover === face, stepHover: owners[face] === 2, colourByStep, accent: 0x9bd13b, study: study.get(face) ?? null }).hex;

  // The whole repaint, new against old.
  const old = new Float32Array(triangles.length * 9);
  const now = new Float32Array(triangles.length * 9);
  paintAll(triangles, old, hexOf(null));
  fillFaces(now, triangles, hexOf(null));
  check(`a whole repaint writes what it wrote (by step ${colourByStep})`, same(old, now));

  // A walk of the pointer: face to face, onto nothing, onto selected and held faces, back onto the same face.
  const byFace = faceTriangles(triangles);
  const card = Float32Array.from(now);
  let hover: number | null = null;
  let uploaded = 0;
  const walk = [5, 6, 6, null, 3, 7, 41, 299, null, null, 150, 9, 0, 298, 5];
  for (let step = 0; step < 400; step += 1) {
    const next = step < walk.length ? walk[step]! : rnd() < 0.1 ? null : Math.floor(rnd() * 300);
    if (next !== hover) {
      for (const face of [hover, next]) {
        const tris = face == null ? undefined : byFace.get(face);
        if (face == null || !tris) continue;
        fillFace(now, tris, hexOf(next)(face));
        const runs = colourRuns(tris);
        for (let i = 0; i < runs.length; i += 2) {
          card.set(now.subarray(runs[i]!, runs[i]! + runs[i + 1]!), runs[i]!);
          uploaded += runs[i + 1]!;
        }
      }
      hover = next;
    }
    paintAll(triangles, old, hexOf(hover));
    if (!same(old, now)) {
      check(`step ${step}: the buffer after a hover on ${hover} is the whole repaint's`, false);
      break;
    }
    if (!same(old, card)) {
      check(`step ${step}: the runs uploaded for a hover on ${hover} leave the card with the whole repaint`, false);
      break;
    }
  }
  check(`the walk uploads a small share of what whole repaints would (${uploaded} of ${400 * now.length})`, uploaded > 0 && uploaded < 400 * now.length * 0.05);
}

// Runs: neighbours join, gaps part, each run is `start, count` in array elements.
check("runs join neighbours", colourRuns([2, 3, 4, 9, 11, 12]).join() === [18, 27, 81, 9, 99, 18].join());
check("no triangles, no runs", colourRuns([]).length === 0);
{
  const triangles = mesh(500, 40);
  const byFace = faceTriangles(triangles);
  check("the same triangles array gives the same map", faceTriangles(triangles) === byFace);
  let count = 0;
  let ok = true;
  for (const [face, tris] of byFace) {
    count += tris.length;
    ok &&= tris.every((t, i) => triangles[t] === face && (i === 0 || tris[i - 1]! < t));
  }
  check("each triangle is listed once, under its own face, lowest first", ok && count === triangles.length);
}

if (failed) process.exit(1);
console.log("face-colours tests passed");
