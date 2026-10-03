import { ID_MATRIX, type Mat3, type MeshShift, type PlacedPart } from "../mesh-place";
import { loadProfile } from "../profiles";
import type { ColorMode } from "../colors";
import type { PathColumns } from "../preview-wire";
import type { PreviewPatch } from "../preview-patch";
import type { Vec3 } from "../section-plane";
import type { RibbonBuffers } from "../view3d";
import type { CoverageGap, EditOutcome, SupportSkeleton } from "../support-edits";
import type { EditEntry } from "../support-edit-list";

export type { CoverageGap, EditOutcome, SupportSkeleton };

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
  /** With supports off, what prints over air. Missing with supports on. */
  inAir?: { islands: number; overhangs: number };
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
    /** The part's layers came from memory; its clocks read zero. */
    objectReused?: boolean;
    /** The unedited supports came from memory; supportMs reads zero. */
    supportBaseReused?: boolean;
    /** Leading support edits whose result was already in memory. */
    editsReused?: number;
    editApplyMs?: number;
    editRefreshMs?: number;
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
  /** One per requested support edit, in request order. Absent when none were sent. */
  supportEdits?: EditOutcome[];
  /** The grown trees after every edit. Only when the request set `includeSkeleton`. */
  skeleton?: SupportSkeleton;
  /** Names this preview. Sent back as `previewBase` so the next reply can be a patch on it. */
  previewToken?: string;
  /** Set instead of `layers` when the request's `previewBase` was what the engine last drew. */
  previewPatch?: PreviewPatch;
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
  placed: null as PlacedPart | null,
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
  /** Kept across setting and pose changes; the engine replays them and flags the ones that no longer match. */
  supportEdits: [] as EditEntry[],
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
  /** Support edits the request behind `state.result` carried. */
  slicedEdits: [] as readonly EditEntry[],
  supportUi: null as {
    refresh(): void;
    landed(ok: boolean): void;
    reset(): void;
  } | null,
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
