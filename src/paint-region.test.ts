/**
 * Disk coverage against a hand brush. The brush here is a separate raster:
 * rows one radius apart, dabs every half radius, first dab of a row always kept.
 * It starts a quarter step later than the library, so the counts are not the same loop.
 */
import { readFileSync } from "node:fs";

import { coverRegion, selectTriangles, type SurfaceDisk } from "./paint-region.ts";
import { STROKE_STEP_R, type Vec3 } from "./support-paint.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

function readStl(path: string): Float32Array {
  const buf = readFileSync(path);
  const count = buf.readUInt32LE(80);
  const pos = new Float32Array(count * 9);
  for (let i = 0; i < count; i += 1) {
    const base = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k += 1) pos[i * 9 + k] = buf.readFloatLE(base + k * 4);
  }
  return pos;
}

function tri(positions: Float32Array, index: number): [Vec3, Vec3, Vec3] {
  const base = index * 9;
  const at = (offset: number): Vec3 => [positions[base + offset] ?? 0, positions[base + offset + 1] ?? 0, positions[base + offset + 2] ?? 0];
  return [at(0), at(3), at(6)];
}

function baryHit(p: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(area) < 1e-8) return false;
  const w0 = ((b[0] - p[0]) * (c[1] - p[1]) - (c[0] - p[0]) * (b[1] - p[1])) / area;
  const w1 = ((c[0] - p[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (c[1] - p[1])) / area;
  const w2 = 1 - w0 - w1;
  return w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4;
}

/** A person painting the underside: one stroke per row, phase shifted along the stroke. */
function handBrush(positions: Float32Array, tris: readonly number[], radius: number): SurfaceDisk[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const index of tris) {
    for (const p of tri(positions, index)) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const along = STROKE_STEP_R * radius;
  const phase = along / 4;
  const disks: SurfaceDisk[] = [];
  for (let y = minY; y <= maxY + 1e-6; y += radius) {
    let last: Vec3 | null = null;
    for (let x = minX + phase; x <= maxX + 1e-6; x += along) {
      let hit = false;
      for (const index of tris) {
        const [a, b, c] = tri(positions, index);
        if (!baryHit([x, y, 0], a, b, c)) continue;
        hit = true;
        break;
      }
      if (!hit) continue;
      const p: Vec3 = [x, y, 0];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < along - 1e-6) continue;
      disks.push({ p, n: [0, 0, -1], r: radius });
      last = p;
    }
  }
  return disks;
}

const ledge = readStl(new URL("../samples/overhang_ledge.stl", import.meta.url).pathname);
const region = { overhangBelowDeg: 50 };
const radius = 3;
const covered = coverRegion(ledge, region, radius);
const picked = selectTriangles(ledge, region);
check("the ledge underside is selected", "disks" in covered && picked.length > 0 && covered.triangles === picked.length, JSON.stringify(covered));

if ("disks" in covered) {
  const hand = handBrush(ledge, picked, radius);
  const ratio = covered.disks.length / Math.max(1, hand.length);
  check("disk count stays within 10% of a hand brush", ratio > 0.9 && ratio < 1.1, `${covered.disks.length} vs ${hand.length}`);
  let coveredCentres = 0;
  for (const index of picked) {
    const [a, b, c] = tri(ledge, index);
    const centre: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const near = covered.disks.some((disk) => Math.hypot(disk.p[0] - centre[0], disk.p[1] - centre[1]) <= radius + 0.05);
    if (near) coveredCentres += 1;
  }
  check("every underside triangle centre is inside a brush disk", coveredCentres === picked.length, `${coveredCentres}/${picked.length}`);
}

const miss = coverRegion(ledge, { box: { min: [500, 500, 500], max: [510, 510, 510] } }, 3);
check("an empty box is a sentence", "reason" in miss && miss.reason === "No surface is inside that box.", JSON.stringify(miss));

const wide = new Float32Array([
  0, 0, 0, 0, 400, 0, 400, 0, 0,
  400, 0, 0, 0, 400, 0, 400, 400, 0,
]);
const huge = coverRegion(wide, { overhangBelowDeg: 50 }, 0.5);
check("a brush that would pass the cap is refused", "reason" in huge && huge.reason.includes("20 000") && huge.reason.includes("larger radius"), JSON.stringify(huge));

const plane = new Float32Array([
  0, 0, 0, 10, 0, 0, 10, 10, 0,
  0, 0, 0, 10, 10, 0, 0, 10, 0,
]);
const face = coverRegion(plane, { faces: [0] }, 3);
const both = coverRegion(plane, { faces: [0, 1] }, 3);
check("one face of a split quad paints that triangle", "disks" in face && "disks" in both && face.disks.length < both.disks.length, JSON.stringify({ face, both }));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("paint-region: ok");
