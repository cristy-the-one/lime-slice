/**
 * A print turn scored from the faces, before any slice. A ceiling (a face born in one nozzle
 * plane, the unheld path) is read the same way model_check reads one: its normal points back
 * along the plate's build direction. On a 45° belt that is not "face down"; yaw decides it.
 */
import { meshVolume } from "./interference.ts";
import { printCheck } from "./modeling/inspect.ts";
import { printFrame } from "./model-check.ts";
import { eulerOrient, type Mat3 } from "./mesh-place.ts";

export interface OrientTurn {
  rotX: number;
  rotY: number;
  rotZ: number;
}

export interface OrientPrinter {
  kind: string;
  bedX: number;
  bedY: number;
  bedZ: number;
  maxVolumetricMm3S: number;
  belt: { angleDeg: number; maxLengthMm?: number | null };
}

export interface OrientScore extends OrientTurn {
  orient: Mat3;
  unheldLengthMm: number;
  unheldAreaMm2: number;
  overhangAreaMm2: number;
  seconds: number;
  grams: number;
}

/** Every 90° of yaw on a belt, the six faces down on a flat bed. Angles are what object_place takes. */
export function defaultTurns(belt: boolean): OrientTurn[] {
  if (belt) {
    return [
      { rotX: 0, rotY: 0, rotZ: 0 },
      { rotX: 0, rotY: 0, rotZ: 90 },
      { rotX: 0, rotY: 0, rotZ: 180 },
      { rotX: 0, rotY: 0, rotZ: -90 },
    ];
  }
  return [
    { rotX: 0, rotY: 0, rotZ: 0 },
    { rotX: 180, rotY: 0, rotZ: 0 },
    { rotX: -90, rotY: 0, rotZ: 0 },
    { rotX: 90, rotY: 0, rotZ: 0 },
    { rotX: 0, rotY: 90, rotZ: 0 },
    { rotX: 0, rotY: -90, rotZ: 0 },
  ];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Least unheld path, then least overhang, then least time, then least grams.
 * A tie stays with the earlier turn, so a sliced row with the same numbers does not steal the mark.
 */
export function better(a: OrientScore, b: OrientScore): number {
  return a.unheldLengthMm - b.unheldLengthMm
    || a.overhangAreaMm2 - b.overhangAreaMm2
    || a.seconds - b.seconds
    || a.grams - b.grams;
}

/**
 * Score one absolute turn. Unheld length is the ceiling area divided by a line width, the path a
 * slicer would lay in one nozzle plane. Time is the volume at the printer's flow plus a small
 * cost per layer, so a taller turn estimates longer; grams follow the volume and do not.
 */
export function scoreTurn(
  positions: Float32Array,
  scale: number,
  turn: OrientTurn,
  printer: OrientPrinter,
  layerHeight: number,
  nozzleMm: number,
  densityGCm3: number,
): OrientScore {
  const orient = eulerOrient(turn.rotX, turn.rotY, turn.rotZ);
  const printed = printFrame(positions, orient, scale > 0 ? scale : 1);
  const pos = printed.positions;
  const belt = printer.kind === "belt";
  const checked = printCheck({
    positions: pos,
    overhangDeg: 45,
    buildMm: [printer.bedX, printer.bedY, printer.bedZ],
    belt: belt ? { angleDeg: printer.belt.angleDeg, widthMm: printer.bedX, maxLengthMm: printer.belt.maxLengthMm } : null,
  });
  const overhang = checked.overhang as { areaMm2?: number };
  // The printed mesh is already in the plate frame, so the build direction is the plate's: straight up, or
  // (0, −sin α, cos α) on a belt. buildDirection() is the same vector in the part's frame, which these normals are not.
  const angle = belt ? (Math.min(80, Math.max(10, printer.belt.angleDeg)) * Math.PI) / 180 : 0;
  const build = belt ? [0, -Math.sin(angle), Math.cos(angle)] : [0, 0, 1];
  let unheld = 0;
  let minS = Infinity;
  let maxS = -Infinity;
  for (let tri = 0; tri * 9 + 8 < pos.length; tri += 1) {
    const b = tri * 9;
    const ax = pos[b]!, ay = pos[b + 1]!, az = pos[b + 2]!;
    const bx = pos[b + 3]!, by = pos[b + 4]!, bz = pos[b + 5]!;
    const cx = pos[b + 6]!, cy = pos[b + 7]!, cz = pos[b + 8]!;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const twice = Math.hypot(nx, ny, nz);
    for (const s of [ay * build[1] + az * build[2], by * build[1] + bz * build[2], cy * build[1] + cz * build[2]]) {
      minS = Math.min(minS, s);
      maxS = Math.max(maxS, s);
    }
    if (!(twice > 0)) continue;
    const along = (nx * build[0] + ny * build[1] + nz * build[2]) / twice;
    // On the bed a downward face is held by the bed. Above it, the same face is a ceiling.
    if (along < -0.99 && Math.max(az, bz, cz) > 0.02) unheld += twice / 2;
  }
  const nozzle = nozzleMm > 0 ? nozzleMm : 0.4;
  const lineWidth = Math.min(1.2, Math.max(0.2, nozzle * 1.125));
  const volume = meshVolume(positions) * (scale > 0 ? scale : 1) ** 3;
  const height = layerHeight > 0 ? layerHeight : 0.2;
  const span = Number.isFinite(minS) ? Math.max(0, maxS - minS) : 0;
  const layers = Math.max(1, span / height);
  const flow = printer.maxVolumetricMm3S > 0 ? printer.maxVolumetricMm3S : 12;
  return {
    ...turn,
    orient,
    unheldLengthMm: round1(unheld / lineWidth),
    unheldAreaMm2: round1(unheld),
    overhangAreaMm2: typeof overhang.areaMm2 === "number" ? overhang.areaMm2 : 0,
    seconds: Math.round(volume / flow + layers * 0.4),
    grams: Math.round((volume / 1000) * densityGCm3 * 100) / 100,
  };
}
