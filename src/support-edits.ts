/**
 * Support edits on the slice request, and what the engine reports back.
 * Mirrors `crates/lime-slice-core/src/slice/wire.rs` and
 * `crates/lime-slice-core/src/support/skeleton.rs`.
 */

/**
 * Demanded support interface the finished supports do not print, over adjacent layers.
 * `z`, `min`, `max`, and `outline` are what a regrow sends back, in the frame the engine grows in.
 * On a flat bed that is the frame the preview is drawn in. On a belt it is the slice frame, where the
 * part lies flat for the nozzle, and `tilted` says where the preview draws the gap.
 */
export interface CoverageGap {
  /** `z` of its lowest and highest layer. On a belt, the nozzle plane's height, which no preview layer carries. */
  z: [number, number];
  /** Largest unheld area on one of its layers. */
  areaMm2: number;
  min: [number, number];
  max: [number, number];
  /** The unheld region on its highest layer. */
  outline: [number, number][][];
  /** Belt only: the gap in the reply frame. Absent on a flat bed. */
  tilted?: TiltedGap;
}

/** A belt gap as the preview draws it. */
export interface TiltedGap {
  /** `PreviewLayer.z` of its lowest and highest layer: their belt positions, which the layer slider cuts by. */
  ls: [number, number];
  /** `outline` as `[x, y, z]` in the reply frame, point for point. */
  outline: [number, number, number][][];
}

/**
 * A belt's copies are one planned part, printed again after a shift along the belt. The skeleton and the gaps
 * are the first copy's. Copy `c` is the same geometry with `c * shiftMm` added to y and to every belt position
 * (`PreviewLayer.z`, `skeleton.ls`, `tilted.ls`). Only on a belt reply with more than one copy.
 */
export interface BeltCopies {
  count: number;
  /** From one copy to the next, signed by the belt's direction. */
  shiftMm: number;
}

/** A birth site: xy in mm at the exact `siteZ` the skeleton reported. */
export interface SiteSpec {
  xy: [number, number];
  z: number;
}

/** Remove the limbs born at `sites`. */
export interface PruneEdit {
  kind: "prune";
  sites: SiteSpec[];
}

/** Grow fresh limbs for the unheld demand inside `region`, on the layers whose z lies within `z`, low then high. */
export interface RegrowEdit {
  kind: "regrow";
  region: [number, number][][];
  z: [number, number];
}

export type SupportEdit = PruneEdit | RegrowEdit;

/**
 * Fields a slice request adds for support edits. Leave `supportEdits` unset when there are none
 * and `includeSkeleton` unset when false, so the recipe key stays what it was without them.
 */
export interface SupportEditRequest {
  supportEdits?: SupportEdit[];
  includeSkeleton?: true;
}

/** How one edit's targets matched. */
export type EditStatus =
  | { status: "applied" }
  /** Every site matched, the farthest one `movedMm` away. */
  | { status: "rebound"; movedMm: number }
  /** `missed` targets matched nothing. The rest still applied. */
  | { status: "stale"; missed: number };

export type EditOutcome = EditStatus & {
  /** Layers whose printed support changed. */
  changedLayers: number;
  /** Lowest and highest changed layer, as `PreviewLayer.index` numbers them. Absent when none changed. */
  changedSpan?: [number, number];
  /** Coverage area after the edit less the area before it, mm². */
  newlyFloatingMm2: number;
  /** Coverage gaps the edit leaves, specks included. */
  floating: CoverageGap[];
};

/**
 * Every limb that still prints, as parallel columns in ascending limb id.
 * `start[k]..start[k + 1]` are limb `k`'s knots in `xs`, `ys`, `zs`, `rs`, top to bottom.
 * A branch is a limb plus every limb whose `into` chain reaches it.
 * A tree is every limb with the same `tree`.
 * A site is `[siteX[k], siteY[k]]` at `siteZ[k]`, sent back exactly.
 * On a belt reply the knots are in the reply frame and `ls` is, per knot, the `z` of the
 * preview layer it prints on. Site ids stay in the slice frame: send them back, never draw them.
 */
export interface SupportSkeleton {
  id: number[];
  /** Id of the root limb of each limb's tree. */
  tree: number[];
  /** Id of the limb each one merged into, 0 for a root. */
  into: number[];
  /** 1 while the limb's own tip prints, 0 once pruned down to a merge. */
  live: number[];
  siteX: number[];
  siteY: number[];
  siteZ: number[];
  start: number[];
  xs: number[];
  ys: number[];
  zs: number[];
  rs: number[];
  /** Belt only: preview layer `z` of each knot. Absent on a cartesian reply. */
  ls?: number[];
}
