/**
 * Folded walls (docs/plan-folded-shell.md §6), off by default. The one-wall request for the synthetic cover is
 * recorded in rib-wall-cover-one.json and must stay byte for byte while `folded` is left off. With `folded`, thin
 * faces join across a sharp edge, a thick reading stays a patch, and a crease vertex sits on the miter.
 *
 * The cover is the study's butt-joined solid: floor 80 × 48 × 2, walls 12 mm, rim 6 mm, volume 16992 mm³.
 * RECORD_COVER=1 writes the one-wall snapshot from the extractor as it stands.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ribWall, type RibWall, type RibWallSolid } from "./rib-wall.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

class Builder {
  pos: number[] = [];
  face: number[] = [];
  tri(f: number, a: V3, b: V3, c: V3, want: V3) {
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, want) < 0) [b, c] = [c, b];
    this.pos.push(...a, ...b, ...c);
    this.face.push(f);
  }
  quad(f: number, a: V3, b: V3, c: V3, d: V3, want: V3) {
    this.tri(f, a, b, c, want);
    this.tri(f, a, c, d, want);
  }
  solid(): RibWallSolid {
    return { positions: Float32Array.from(this.pos), faceOf: Uint32Array.from(this.face) };
  }
}

/** The study cover, faces wound out of the material. `belly` is the inner floor. */
function studyCover(): { solid: RibWallSolid; belly: number; walls: number[]; tops: number[] } {
  const b = new Builder();
  let next = 0;
  const q = (n: V3, a: V3, bb: V3, c: V3, d: V3) => {
    const face = next;
    next += 1;
    b.quad(face, a, bb, c, d, n);
    return face;
  };
  // Floor slab. The top under the walls is internal; only the cavity opening is a face.
  q([0, 0, -1], [0, 0, 0], [80, 0, 0], [80, 48, 0], [0, 48, 0]);
  q([-1, 0, 0], [0, 0, 0], [0, 0, 2], [0, 48, 2], [0, 48, 0]);
  q([1, 0, 0], [80, 0, 0], [80, 48, 0], [80, 48, 2], [80, 0, 2]);
  q([0, -1, 0], [0, 0, 0], [80, 0, 0], [80, 0, 2], [0, 0, 2]);
  q([0, 1, 0], [0, 48, 0], [0, 48, 2], [80, 48, 2], [80, 48, 0]);
  const belly = q([0, 0, 1], [2, 2, 2], [78, 2, 2], [78, 46, 2], [2, 46, 2]);
  // Outer walls up to the rim (z 12). Side walls own the corners.
  q([-1, 0, 0], [0, 0, 2], [0, 0, 12], [0, 48, 12], [0, 48, 2]);
  q([1, 0, 0], [80, 0, 2], [80, 48, 2], [80, 48, 12], [80, 0, 12]);
  q([0, -1, 0], [2, 0, 2], [78, 0, 2], [78, 0, 12], [2, 0, 12]);
  q([0, 1, 0], [2, 48, 2], [2, 48, 12], [78, 48, 12], [78, 48, 2]);
  q([0, -1, 0], [0, 0, 2], [2, 0, 2], [2, 0, 12], [0, 0, 12]);
  q([0, 1, 0], [0, 48, 2], [0, 48, 12], [2, 48, 12], [2, 48, 2]);
  q([0, -1, 0], [78, 0, 2], [80, 0, 2], [80, 0, 12], [78, 0, 12]);
  q([0, 1, 0], [78, 48, 2], [78, 48, 12], [80, 48, 12], [80, 48, 2]);
  // Inner walls, the cavity side, up to the top of the wall.
  const left = q([1, 0, 0], [2, 2, 2], [2, 2, 14], [2, 46, 14], [2, 46, 2]);
  const right = q([-1, 0, 0], [78, 2, 2], [78, 46, 2], [78, 46, 14], [78, 2, 14]);
  const front = q([0, 1, 0], [2, 2, 2], [78, 2, 2], [78, 2, 14], [2, 2, 14]);
  const back = q([0, -1, 0], [2, 46, 2], [2, 46, 14], [78, 46, 14], [78, 46, 2]);
  // Wall tops: the end of a tall wall, so a ray straight in reads thick.
  const topL = q([0, 0, 1], [0, 0, 14], [2, 0, 14], [2, 48, 14], [0, 48, 14]);
  const topR = q([0, 0, 1], [78, 0, 14], [80, 0, 14], [80, 48, 14], [78, 48, 14]);
  const topF = q([0, 0, 1], [2, 0, 14], [78, 0, 14], [78, 2, 14], [2, 2, 14]);
  const topB = q([0, 0, 1], [2, 46, 14], [2, 48, 14], [78, 48, 14], [78, 46, 14]);
  // Rim, 6 mm out, z 12..14. Faces that meet another block are left out.
  q([-1, 0, 0], [-6, -6, 12], [-6, -6, 14], [-6, 54, 14], [-6, 54, 12]);
  q([0, 0, 1], [-6, -6, 14], [0, -6, 14], [0, 54, 14], [-6, 54, 14]);
  q([0, 0, -1], [-6, -6, 12], [-6, 54, 12], [0, 54, 12], [0, -6, 12]);
  q([0, -1, 0], [-6, -6, 12], [0, -6, 12], [0, -6, 14], [-6, -6, 14]);
  q([0, 1, 0], [-6, 54, 12], [-6, 54, 14], [0, 54, 14], [0, 54, 12]);
  q([1, 0, 0], [86, -6, 12], [86, 54, 12], [86, 54, 14], [86, -6, 14]);
  q([0, 0, 1], [80, -6, 14], [80, 54, 14], [86, 54, 14], [86, -6, 14]);
  q([0, 0, -1], [80, -6, 12], [86, -6, 12], [86, 54, 12], [80, 54, 12]);
  q([0, -1, 0], [80, -6, 12], [80, -6, 14], [86, -6, 14], [86, -6, 12]);
  q([0, 1, 0], [80, 54, 12], [86, 54, 12], [86, 54, 14], [80, 54, 14]);
  q([0, -1, 0], [0, -6, 12], [80, -6, 12], [80, -6, 14], [0, -6, 14]);
  q([0, 0, 1], [0, -6, 14], [80, -6, 14], [80, 0, 14], [0, 0, 14]);
  q([0, 0, -1], [0, -6, 12], [0, 0, 12], [80, 0, 12], [80, -6, 12]);
  q([0, 1, 0], [0, 54, 12], [0, 54, 14], [80, 54, 14], [80, 54, 12]);
  q([0, 0, 1], [0, 48, 14], [0, 54, 14], [80, 54, 14], [80, 48, 14]);
  q([0, 0, -1], [0, 48, 12], [80, 48, 12], [80, 54, 12], [0, 54, 12]);
  return { solid: b.solid(), belly, walls: [left, right, front, back], tops: [topL, topR, topF, topB] };
}

const wallOf = (solid: RibWallSolid, options: Parameters<typeof ribWall>[1]): RibWall => {
  const out = ribWall(solid, options);
  if ("reason" in out) throw new Error(out.reason);
  return out;
};

const cover = studyCover();
const snapPath = fileURLToPath(new URL("./rib-wall-cover-one.json", import.meta.url));
{
  const w = wallOf(cover.solid, { picked: [cover.belly] });
  console.log(`  one wall: faces ${JSON.stringify(w.faces)} stops ${w.report.faces.stops.length} area ${w.report.areaMm2} thickness ${w.report.thickness.medianMm} triangles ${w.report.triangles}`);
  const text = JSON.stringify(w.request);
  if (process.env.RECORD_COVER === "1") {
    writeFileSync(snapPath, text);
    console.log(`recorded ${text.length} bytes`);
  } else {
    const want = readFileSync(snapPath, "utf8");
    check("one-wall cover request matches the bytes recorded before folded growth", text === want, `${text.length} bytes against ${want.length}`);
  }
  check("one wall: the belly only, about 76 × 44", JSON.stringify(w.faces) === `[${cover.belly}]` && near(w.report.areaMm2, 76 * 44, 1), JSON.stringify({ faces: w.faces, area: w.report.areaMm2 }));
  check("one wall: thickness 2", near(w.report.thickness.medianMm, 2, 0.05), String(w.report.thickness.medianMm));
  check("one wall: the report does not carry a folded list", w.report.faces.folded === undefined);
}

{
  const w = wallOf(cover.solid, { picked: [cover.belly], folded: true });
  const taken = new Set(w.faces);
  console.log(`  folded: faces ${JSON.stringify(w.faces)} folded ${JSON.stringify(w.report.faces.folded)} stops ${JSON.stringify(w.report.faces.stops)} loops ${JSON.stringify(w.report.loops)} area ${w.report.areaMm2} thickness ${w.report.thickness.minMm}/${w.report.thickness.medianMm}/${w.report.thickness.maxMm}`);
  check("folded: the four inner walls join the belly", cover.walls.every((f) => taken.has(f)) && taken.has(cover.belly), JSON.stringify(w.faces));
  check("folded: those walls are listed as taken across folds", JSON.stringify(w.report.faces.folded) === JSON.stringify([...cover.walls].sort((a, b) => a - b)), JSON.stringify(w.report.faces.folded));
  check("folded: the wall tops stay stops, because they read thick", cover.tops.every((f) => w.report.faces.stops.some((s) => s.face === f && s.why === "thick")), JSON.stringify(w.report.faces.stops));
  check("folded: the belly-wall crease is not a border", w.report.faces.stops.every((s) => !cover.walls.includes(s.face)));
  const joined = w.loops.filter((l) => l.class === "joined" || l.class === "mixed");
  check("folded: an edge into the thick top stays a joined border", joined.length > 0 && w.request.holds.holds.length > 0, JSON.stringify(w.report.loops));
}

if (failed) {
  console.error(`rib-wall-folded: ${failed} failed`);
  process.exit(1);
}
console.log("rib-wall-folded: ok");
