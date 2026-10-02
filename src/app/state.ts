import { ID_MATRIX, type Mat3, type MeshShift } from "../mesh-place";
import { loadProfile } from "../profiles";
import type { ColorMode } from "../colors";
import type { PathColumns } from "../preview-wire";
import type { Vec3 } from "../section-plane";
import type { RibbonBuffers } from "../view3d";

export type StrategyId = "speed" | "toughness";
export type BlendMode = "single" | "weight" | "byLayer" | "byRegion";
export type CardId = "speed" | "efficiency" | "toughness" | "layer" | "region";

export interface PreviewLayer {
  index: number;
  z: number;
  height: number;
  note: string;
  seconds?: number;
  speedWalls: number;
  toughnessWalls: number;
  supportPaths: number;
  paths: PathColumns;
}
export interface FeatureRow {
  kind: string;
  seconds: number;
  filamentMm: number;
  filamentG: number;
}
/** Demanded support interface the finished supports do not print, over adjacent layers. */
export interface CoverageGap {
  /** `z` of its lowest and highest layer. */
  z: [number, number];
  /** Largest unheld area on one of its layers. */
  areaMm2: number;
  min: [number, number];
  max: [number, number];
  /** The unheld region on its highest layer. */
  outline: [number, number][][];
}
export interface SliceResponse {
  coreMs: number;
  baselineMs: number;
  blend: string;
  /** Set when the engine loaded this slice from its cache instead of planning it. */
  fromCache?: boolean;
  slicedAtMs?: number;
  mesh: {
    triangles: number;
    sourceTriangles?: number;
    /** Each layer's outline stays within this of the true cut. `0` when off. */
    outlineToleranceMm?: number;
    min: number[];
    max: number[];
  };
  sanity: { ok: boolean; notes: string[]; layers: number; finalE: number; extrusionLengthMm: number };
  /** Largest first. Missing from replies an older engine cached. */
  coverage?: CoverageGap[];
  stages?: {
    contourMs: number;
    supportMs: number;
    toolpathMs: number;
    /** Serial travel order: island tour, seams, and scarf. */
    orderMs: number;
    /** Parallel combing and z-hop after the order is set. */
    combMs: number;
    emitMs: number;
    indexMs?: number;
    /** Sum of per-layer cut time. Parallel, so it can exceed contourMs. */
    cutCpuMs?: number;
    /** Sum of per-layer outline simplify time. */
    simplifyCpuMs?: number;
    roofMs?: number;
    /** Sum of per-layer wall time inside toolpathMs. */
    wallCpuMs?: number;
    /** Sum of per-layer infill time inside toolpathMs. */
    infillCpuMs?: number;
  };
  estimate?: {
    seconds: number;
    filamentMm: number;
    filamentG: number;
    arcMoves: number;
    travelMm?: number;
    retracts?: number;
    scarfedLoops?: number;
    byFeature?: FeatureRow[];
  };
  compare?: { label: string; seconds: number; filamentG: number }[];
  gcode: string;
  gcodeToken?: string;
  layers: PreviewLayer[];
  score?: { toughness: number };
  error?: string;
}

export interface ParetoPoint {
  label: string;
  toughness: number;
  seconds: number;
  filamentG: number;
  score: number;
}

export const state = {
  mesh: null as { name: string; bytes: ArrayBuffer } | null,
  result: null as SliceResponse | null,
  slicedHash: "",
  layer: 0,
  rangeLow: 0,
  showTravel: false,
  hidden: new Set<string>(),
  colorMode: "feature" as ColorMode,
  busy: false,
  progress: 0,
  error: "",
  notice: "",
  engine: "",
  blendKind: "single" as BlendMode,
  strategy: "speed" as StrategyId,
  toughness: 0.5,
  bottomMm: 4,
  transitionMm: 6,
  axis: "x" as "x" | "y",
  atMm: 10,
  layerHeight: 0.2,
  adaptive: false,
  adaptiveMin: 0.08,
  adaptiveMax: 0.2,
  supports: false,
  supportAngle: 45,
  supportStyle: "tree" as "grid" | "tree",
  branchAngle: 40,
  tipDiameter: 0.8,
  trunkDiameter: 4.2,
  supportHeightMult: 1,
  infillCombine: true,
  combing: true,
  featureSpeeds: true,
  pressureAdvance: 0,
  linearAdvance: 0,
  variableWidth: true,
  arcFit: true,
  travelOpt: true,
  overhangControl: true,
  scarfSeam: "blend" as "blend" | "off" | "outer" | "all",
  scarfLength: 10,
  scarfSteps: 8,
  gyroid3d: "blend" as "blend" | "off" | "on",
  zHop: "blend" as "off" | "blend" | "always" | "smart",
  zHopHeight: 0.4,
  zHopMinTravel: 2,
  paFirmware: "klipper" as "klipper" | "marlin",
  paStart: 0,
  paEnd: 0.08,
  paStep: 0.005,
  paBands: [] as { index: number; k: number; z0: number; z1: number }[],
  paGcode: "",
  pricePerKg: 20,
  autoSlice: false,
  simplify: true,
  simplifyError: 0,
  viewMode: "split" as "flat" | "split" | "solid",
  query: "",
  move: 0,
  stage: "preview" as "prepare" | "preview" | "gcode",
  playing: false,
  profile: loadProfile(),
  sourcePos: null as Float32Array | null,
  placed: null as Float32Array | null,
  orient: ID_MATRIX as Mat3,
  partScale: 1,
  stepTolerance: 0.1,
  centered: true,
  offset: { x: 0, y: 0, z: 0 } as MeshShift,
  pareto: [] as ParetoPoint[],
  help: false,
  splitCustom: false,
  poseHud: "",
  /** 0 hides the build plate, 1 is the solid plate. Preview only. */
  bedOpacity: 0.4,
  sectionOn: false,
  sectionNormal: [0, 0, 1] as Vec3,
  sectionOffset: 0,
  sectionHud: "",
};

export const session = {
  job: 0,
  autoTimer: 0,
  stepTimer: 0,
  /** Slice currently drawn. Geometry buffers carry the same id as `resultJob`. */
  shown: null as SliceResponse | null,
  /** Slice job that produced state.result; geometry buffers carry the same id. */
  resultJob: 0,
  /** Counts loaded meshes. The preview camera reframes only for another mesh or scale. */
  meshEpoch: 0,
  /** `meshEpoch` and scale that state.result was sliced from. */
  resultFrame: "",
  /** Heights the layer sliders were last moved to, kept across results of one mesh. */
  chosenZ: null as { high: number; low: number } | null,
  /** Recipe key of `state.result`, once a slice has landed. */
  shownRecipe: null as string | null,
  fingerSource: null as ArrayBuffer | Float32Array | null,
  fingerScale: Number.NaN,
  finger: "",
  engineChecked: false,
  announcedDown: "",
  busySince: 0,
  busyPhase: "",
  /** True while the in-flight request will plan, false while it loads a saved slice. */
  busyRecompute: true,
  lastToastText: "",
  lastToastAt: 0,
  playTimer: 0,
  drag2d: false,
  geomReady: null as { id: number; data: Omit<RibbonBuffers, "span" | "midZ" | "centerX" | "centerY"> } | null,
};

/** Recipes finished this session. A configured SliceCache stores each one. */
export const cachedRecipes = new Set<string>();

export const worker = new Worker(new URL("../slice-worker.ts", import.meta.url), { type: "module" });
export const geomWorker = new Worker(new URL("../geom-worker.ts", import.meta.url), { type: "module" });
const geomChannel = new MessageChannel();
worker.postMessage({ geomPort: geomChannel.port1 }, [geomChannel.port1]);
geomWorker.postMessage({ slicePort: geomChannel.port2 }, [geomChannel.port2]);
