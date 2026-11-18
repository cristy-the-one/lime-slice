/**
 * Auto ribs off the UI thread: reading the wall (`ribWall`, 0.5 to 3 s on a real cover) and the print check before and
 * after Apply (overhang and thin walls, as model_check reads them). The caller copies what it sends.
 */
import { ribWall, type NotOnWall, type RibWallOptions, type RibWall } from "./modeling/rib-wall.ts";
import { printCheck, type CheckBelt } from "./modeling/inspect.ts";
import { thinWalls } from "./modeling/thin.ts";
import { OVERHANG_DEG, type Vec3 } from "./model-check.ts";

export type AutoRibsJobBody =
  | { kind: "wall"; positions: Float32Array; faceOf: Uint32Array; options: RibWallOptions }
  | { kind: "check"; positions: Float32Array; minWallMm: number; buildMm: Vec3; belt: CheckBelt | null };
export type AutoRibsJob = AutoRibsJobBody & { id: number };

/** A region a check found, in the frame of the mesh it was given. */
export interface CheckRegion {
  min: Vec3;
  max: Vec3;
  areaMm2: number;
}

export interface AutoRibsCheck {
  overhangMm2: number;
  overhang: CheckRegion[];
  thinMm2: number;
  thin: CheckRegion[];
}

export type AutoRibsReply = { id: number; kind: "wall"; wall: RibWall | { reason: string; missed?: NotOnWall[] } } | { id: number; kind: "check"; check: AutoRibsCheck };

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<AutoRibsJob>) => void) | null;
  postMessage(data: AutoRibsReply): void;
};

scope.onmessage = (ev: MessageEvent<AutoRibsJob>) => {
  const job = ev.data;
  if (job.kind === "wall") {
    let wall: RibWall | { reason: string; missed?: NotOnWall[] };
    try {
      wall = ribWall({ positions: job.positions, faceOf: job.faceOf }, job.options);
    } catch (err) {
      wall = { reason: `The wall could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
    scope.postMessage({ id: job.id, kind: "wall", wall });
    return;
  }
  const checked = printCheck({ positions: job.positions, overhangDeg: OVERHANG_DEG, buildMm: job.buildMm, ...(job.belt ? { belt: job.belt } : {}) });
  const overhang = checked.overhang as { areaMm2: number; regions: { min: Vec3; max: Vec3; areaMm2?: number }[] };
  const thin = thinWalls(job.positions, job.minWallMm);
  scope.postMessage({
    id: job.id,
    kind: "check",
    check: {
      overhangMm2: overhang.areaMm2,
      overhang: overhang.regions.map((row) => ({ min: row.min, max: row.max, areaMm2: row.areaMm2 ?? 0 })),
      thinMm2: thin.areaMm2,
      thin: thin.regions.map((row) => ({ min: row.min, max: row.max, areaMm2: row.areaMm2 })),
    },
  });
};
