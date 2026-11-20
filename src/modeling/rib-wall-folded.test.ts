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

/**
 * The study cover, faces wound out of the material. `belly` is the inner floor. With `boss`, a 16 × 16 × 6 pad on the
 * outside of the belly (the ray reads 8 mm) replaces that part of the bottom.
 */
function studyCover(boss = false): { solid: RibWallSolid; belly: number; walls: number[]; tops: number[] } {
  const b = new Builder();
  let next = 0;
  const q = (n: V3, a: V3, bb: V3, c: V3, d: V3) => {
    const face = next;
    next += 1;
    b.quad(face, a, bb, c, d, n);
    return face;
  };
  // Floor slab. The top under the walls is internal; only the cavity opening is a face.
  if (!boss) q([0, 0, -1], [0, 0, 0], [80, 0, 0], [80, 48, 0], [0, 48, 0]);
  else {
    q([0, 0, -1], [0, 0, 0], [80, 0, 0], [80, 16, 0], [0, 16, 0]);
    q([0, 0, -1], [0, 32, 0], [80, 32, 0], [80, 48, 0], [0, 48, 0]);
    q([0, 0, -1], [0, 16, 0], [32, 16, 0], [32, 32, 0], [0, 32, 0]);
    q([0, 0, -1], [48, 16, 0], [80, 16, 0], [80, 32, 0], [48, 32, 0]);
    q([0, 0, -1], [32, 16, -6], [48, 16, -6], [48, 32, -6], [32, 32, -6]);
    q([-1, 0, 0], [32, 16, -6], [32, 16, 0], [32, 32, 0], [32, 32, -6]);
    q([1, 0, 0], [48, 16, -6], [48, 32, -6], [48, 32, 0], [48, 16, 0]);
    q([0, -1, 0], [32, 16, -6], [48, 16, -6], [48, 16, 0], [32, 16, 0]);
    q([0, 1, 0], [32, 32, -6], [32, 32, 0], [48, 32, 0], [48, 32, -6]);
  }
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

{
  const part = studyCover(true);
  const over = (w: RibWall) => {
    const ids: number[] = [];
    w.skin.forEach((p, v) => {
      if (p[0] > 36 && p[0] < 44 && p[1] > 20 && p[1] < 28) ids.push(v);
    });
    return ids.map((v) => w.request.mesh.thickness[v]!);
  };
  const folded = wallOf(part.solid, { picked: [part.belly], folded: true });
  const capped = wallOf(part.solid, { picked: [part.belly], features: false });
  const dropped = wallOf(part.solid, { picked: [part.belly] });
  const showTh = (name: string, xs: number[]) => console.log(`  ${name}: ${xs.length} vertices, ${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)} mm, patches ${JSON.stringify(folded.report.patches)}`);
  const foldTh = over(folded);
  const capTh = over(capped);
  const dropTh = over(dropped);
  showTh("boss folded", foldTh);
  console.log(`  boss capped: ${capTh.length} vertices, ${Math.min(...capTh).toFixed(2)}..${Math.max(...capTh).toFixed(2)} mm`);
  console.log(`  boss dropped: ${dropTh.length} vertices, ${Math.min(...dropTh).toFixed(2)}..${Math.max(...dropTh).toFixed(2)} mm`);
  check("boss: folded keeps the real 8 mm, not the 6 mm cap", foldTh.length > 4 && foldTh.every((x) => near(x, 8, 0.4)), foldTh.map((x) => x.toFixed(2)).join(","));
  check("boss: without folded, features off, the old cap is 6 mm", capTh.length > 4 && capTh.every((x) => near(x, 6, 0.4)) && capped.report.patches === undefined, capTh.map((x) => x.toFixed(2)).join(","));
  check("boss: the default fills the pad in from the wall, about 2 mm", dropTh.length > 4 && dropTh.every((x) => near(x, 2, 0.4)), dropTh.map((x) => x.toFixed(2)).join(","));
  const patch = folded.report.patches?.find((p) => p.thicknessMm > 7);
  check("boss: the report lists a plate patch at the real thickness, not a rigid lump", !!patch && patch.rigid === false && /plate/.test(patch.rule), JSON.stringify(folded.report.patches));
}

{
  // A 20 mm cube on a 2 mm plate. The ray reads 22 mm, past 10× the wall and past the cube's own radius.
  const b = new Builder();
  let n = 0;
  const q = (normal: V3, a: V3, bb: V3, c: V3, d: V3) => {
    b.quad(n, a, bb, c, d, normal);
    n += 1;
  };
  const belly = n;
  q([0, 0, 1], [0, 0, 2], [40, 0, 2], [40, 40, 2], [0, 40, 2]);
  q([0, 0, -1], [0, 0, 0], [40, 0, 0], [40, 10, 0], [0, 10, 0]);
  q([0, 0, -1], [0, 30, 0], [40, 30, 0], [40, 40, 0], [0, 40, 0]);
  q([0, 0, -1], [0, 10, 0], [10, 10, 0], [10, 30, 0], [0, 30, 0]);
  q([0, 0, -1], [30, 10, 0], [40, 10, 0], [40, 30, 0], [30, 30, 0]);
  q([0, 0, -1], [10, 10, -20], [30, 10, -20], [30, 30, -20], [10, 30, -20]);
  q([-1, 0, 0], [10, 10, -20], [10, 10, 0], [10, 30, 0], [10, 30, -20]);
  q([1, 0, 0], [30, 10, -20], [30, 30, -20], [30, 30, 0], [30, 10, 0]);
  q([0, -1, 0], [10, 10, -20], [30, 10, -20], [30, 10, 0], [10, 10, 0]);
  q([0, 1, 0], [10, 30, -20], [10, 30, 0], [30, 30, 0], [30, 30, -20]);
  q([-1, 0, 0], [0, 0, 0], [0, 0, 2], [0, 40, 2], [0, 40, 0]);
  q([1, 0, 0], [40, 0, 0], [40, 40, 0], [40, 40, 2], [40, 0, 2]);
  q([0, -1, 0], [0, 0, 0], [40, 0, 0], [40, 0, 2], [0, 0, 2]);
  q([0, 1, 0], [0, 40, 0], [0, 40, 2], [40, 40, 2], [40, 40, 0]);
  const w = wallOf(b.solid(), { picked: [belly], folded: true });
  const over = w.request.mesh.thickness.filter((_, v) => w.skin[v]![0] > 14 && w.skin[v]![0] < 26 && w.skin[v]![1] > 14 && w.skin[v]![1] < 26);
  console.log(`  lump: ${over.length} vertices, ${Math.min(...over).toFixed(2)}..${Math.max(...over).toFixed(2)} mm, ${JSON.stringify(w.report.patches)}`);
  const rigid = w.report.patches?.find((p) => p.rigid);
  check("lump: the real reading is about 22 mm, and the patch is rigid", over.length >= 1 && over.every((x) => x > 20) && !!rigid && rigid.thicknessMm > 20 && /solver/.test(rigid.rule), JSON.stringify(w.report.patches));
}

{
  const w = wallOf(cover.solid, { picked: [cover.belly], folded: true });
  const crease = w.skin.flatMap((p, v) => (near(p[0], 2, 0.4) && near(p[2], 2, 0.4) && p[1] > 8 && p[1] < 40 ? [v] : []));
  const off = crease.filter((v) => {
    const h = w.request.mesh.thickness[v]! / 2;
    const mid = w.request.mesh.vertices[v]!;
    const skin = w.skin[v]!;
    const bisector = h / Math.SQRT2;
    return !(near(mid[0], skin[0] - h, 0.15) && near(mid[2], skin[2] - h, 0.15) && Math.abs(mid[0] - (skin[0] - bisector)) > 0.12);
  });
  console.log(`  miter: ${crease.length} crease vertices, ${off.length} off the face-normal intersection`);
  check("miter: a floor-wall vertex meets the two mid-planes, not the bisector", crease.length > 3 && off.length === 0);
  const flat = w.skin.flatMap((p, v) => (p[0] > 20 && p[0] < 60 && p[1] > 16 && p[1] < 32 && near(p[2], 2, 0.05) ? [v] : []));
  check("miter: a vertex in the middle of the belly only moves through the thickness", flat.length > 3 && flat.every((v) => near(w.request.mesh.vertices[v]![0], w.skin[v]![0], 0.05) && near(w.request.mesh.vertices[v]![2], 1, 0.2)));
}

function flipFace(solid: RibWallSolid, face: number): RibWallSolid {
  const pos = new Float32Array(solid.positions);
  for (let t = 0; t < solid.faceOf.length; t += 1) {
    if (solid.faceOf[t] !== face) continue;
    for (let k = 0; k < 3; k += 1) {
      const i = t * 9 + 3 + k;
      const j = t * 9 + 6 + k;
      const tmp = pos[i]!;
      pos[i] = pos[j]!;
      pos[j] = tmp;
    }
  }
  return { positions: pos, faceOf: solid.faceOf };
}
{
  const flipped = wallOf(flipFace(cover.solid, cover.belly), { picked: [cover.belly], folded: true });
  const triN = (w: RibWall, t: number): V3 => {
    const [a, b, c] = w.request.mesh.triangles[t]!;
    const n = cross(sub(w.skin[b]!, w.skin[a]!), sub(w.skin[c]!, w.skin[a]!));
    const l = Math.hypot(...n);
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  let belly = 0;
  let bellyBad = 0;
  let wall = 0;
  let wallBad = 0;
  flipped.request.mesh.triangles.forEach((_, t) => {
    const [a, b, c] = flipped.request.mesh.triangles[t]!;
    const p = flipped.skin[a]!;
    const q = flipped.skin[b]!;
    const r = flipped.skin[c]!;
    const c0: V3 = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3];
    const n = triN(flipped, t);
    if (c0[0] > 8 && c0[0] < 72 && c0[1] > 8 && c0[1] < 40 && c0[2] < 3) {
      belly += 1;
      if (n[2] < 0.9) bellyBad += 1;
    }
    if (c0[0] < 3 && c0[2] > 4 && c0[2] < 12) {
      wall += 1;
      if (n[0] < 0.9) wallBad += 1;
    }
  });
  const used = new Map<string, number>();
  flipped.request.mesh.triangles.forEach(([a, b, c]) => {
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const key = x < y ? `${x},${y}` : `${y},${x}`;
      used.set(key, (used.get(key) ?? 0) + 1);
    }
  });
  let both = 0;
  let one = 0;
  for (const n of used.values()) if (n === 2) both += 1; else if (n === 1) one += 1;
  console.log(`  flipped belly: input.flipped ${flipped.report.input.flipped}, belly ${belly - bellyBad}/${belly} up, wall ${wall - wallBad}/${wall} inward, edges both ways ${both}, boundary ${one}`);
  check("flipped face: the belly still points into the cavity", belly > 10 && bellyBad === 0, `${bellyBad} of ${belly}`);
  check("flipped face: the wall across the fold points into the cavity too", wall > 4 && wallBad === 0, `${wallBad} of ${wall}`);
  check("flipped face: every shared edge is used both ways", both > 0 && [...used.values()].every((n) => n <= 2));
}

if (failed) {
  console.error(`rib-wall-folded: ${failed} failed`);
  process.exit(1);
}
console.log("rib-wall-folded: ok");
