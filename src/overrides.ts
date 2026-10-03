/**
 * Height ranges and modifier volumes the UI stores.
 *
 * ADAPTER: `SliceRequest` in `crates/lime-slice-core/src/slice.rs` has no
 * `heightRanges` or `modifierVolumes`. By-layer and by-region blends are one
 * band and one plane (`BlendMode` in `crates/lime-slice-core/src/strategy.rs`),
 * not these lists. `sliceOverrideFields` returns nothing so the slice body,
 * the recipe key, and the G-code stay the bytes of a slice without them.
 * Layer height is not an override: the request has one `layerHeight`.
 */

export const OVERRIDE_VERSION = 1;

export const OVERRIDES_STORED_TOAST = "Overrides are stored but not yet sliced.";

export type VolumeKind = "box" | "cylinder" | "sphere";
export type AxisName = "x" | "y" | "z";

/** Absent keys mean the strategy. Fractions and counts, not layer height. */
export interface SettingOverride {
  /** Sparse infill, 0 to 1. */
  infill?: number;
  /** Perimeter count. */
  walls?: number;
  /** Millimetres per second. */
  speed?: number;
}

export interface HeightRange {
  id: string;
  zFrom: number;
  zTo: number;
  override: SettingOverride;
}

export interface ModifierVolume {
  id: string;
  kind: VolumeKind;
  /** Center in print millimetres. */
  x: number;
  y: number;
  z: number;
  /** Full size along each print axis, millimetres. */
  sx: number;
  sy: number;
  sz: number;
  override: SettingOverride;
}

export interface OverrideDocument {
  version: 1;
  ranges: HeightRange[];
  volumes: ModifierVolume[];
}

const MIN_SIZE = 0.2;

export function emptyOverrides(): OverrideDocument {
  return { version: 1, ranges: [], volumes: [] };
}

export function hasOverrides(doc: OverrideDocument): boolean {
  return doc.ranges.length > 0 || doc.volumes.length > 0;
}

/** Omit from a `.lime` file when the user has not added anything. */
export function projectOverrides(doc: OverrideDocument): OverrideDocument | undefined {
  return hasOverrides(doc) ? doc : undefined;
}

/**
 * Fields added to a slice request. Always empty until the engine grows
 * `heightRanges` and `modifierVolumes` and this adapter is removed.
 */
export function sliceOverrideFields(_doc: OverrideDocument): Record<string, never> {
  return {};
}

let seq = 0;

export function freshOverrideId(prefix: "range" | "volume"): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function addRange(doc: OverrideDocument, range: HeightRange): OverrideDocument {
  return { ...doc, ranges: [...doc.ranges, range] };
}

export function addVolume(doc: OverrideDocument, volume: ModifierVolume): OverrideDocument {
  return { ...doc, volumes: [...doc.volumes, volume] };
}

export function defaultRange(id = freshOverrideId("range")): HeightRange {
  return { id, zFrom: 0, zTo: 4, override: { infill: 0.4, walls: 4, speed: 40 } };
}

export function defaultVolume(kind: VolumeKind, bedX: number, bedY: number, id = freshOverrideId("volume")): ModifierVolume {
  const size = kind === "sphere" ? 24 : kind === "cylinder" ? 24 : 30;
  const sz = kind === "box" ? 20 : size;
  return {
    id,
    kind,
    x: Math.round(bedX / 2),
    y: Math.round(bedY / 2),
    z: sz / 2,
    sx: size,
    sy: size,
    sz,
    override: { infill: 0.6, walls: 3 },
  };
}

export function removeRange(doc: OverrideDocument, id: string): OverrideDocument {
  return { ...doc, ranges: doc.ranges.filter((range) => range.id !== id) };
}

export function removeVolume(doc: OverrideDocument, id: string): OverrideDocument {
  return { ...doc, volumes: doc.volumes.filter((volume) => volume.id !== id) };
}

export function replaceRange(doc: OverrideDocument, range: HeightRange): OverrideDocument {
  return { ...doc, ranges: doc.ranges.map((item) => item.id === range.id ? range : item) };
}

export function replaceVolume(doc: OverrideDocument, volume: ModifierVolume): OverrideDocument {
  return { ...doc, volumes: doc.volumes.map((item) => item.id === volume.id ? volume : item) };
}

export function moveVolume(volume: ModifierVolume, axis: AxisName, deltaMm: number): ModifierVolume {
  const next = { ...volume };
  if (axis === "x") next.x = round3(volume.x + deltaMm);
  else if (axis === "y") next.y = round3(volume.y + deltaMm);
  else next.z = round3(volume.z + deltaMm);
  return next;
}

/** `deltaMm` is the change in full size. The center stays put. */
export function scaleVolume(volume: ModifierVolume, axis: AxisName, deltaMm: number): ModifierVolume {
  const next = { ...volume };
  if (axis === "x") next.sx = round3(Math.max(MIN_SIZE, volume.sx + deltaMm));
  else if (axis === "y") next.sy = round3(Math.max(MIN_SIZE, volume.sy + deltaMm));
  else next.sz = round3(Math.max(MIN_SIZE, volume.sz + deltaMm));
  return next;
}

export function orderRange(range: HeightRange): HeightRange {
  if (range.zFrom <= range.zTo) return range;
  return { ...range, zFrom: range.zTo, zTo: range.zFrom };
}

/** Fraction down the slider. High Z is the top. */
export function bandFractions(zFrom: number, zTo: number, z0: number, z1: number): { top: number; height: number } {
  const low = Math.min(zFrom, zTo);
  const high = Math.max(zFrom, zTo);
  const span = Math.max(1e-6, z1 - z0);
  const top = 1 - clamp01((high - z0) / span);
  const bot = 1 - clamp01((low - z0) / span);
  return { top, height: Math.max(0.02, bot - top) };
}

export function parseOverrides(value: unknown): { ok: true; doc: OverrideDocument } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "This project file is incomplete." };
  }
  const row = value as Record<string, unknown>;
  if (row.version !== OVERRIDE_VERSION) {
    if (typeof row.version === "number" && row.version > OVERRIDE_VERSION) {
      return { ok: false, message: `This project's overrides are version ${row.version}. This app opens overrides version ${OVERRIDE_VERSION}.` };
    }
    return { ok: false, message: "This project file is incomplete." };
  }
  if (!Array.isArray(row.ranges) || !Array.isArray(row.volumes)) {
    return { ok: false, message: "This project file is incomplete." };
  }
  const ranges: HeightRange[] = [];
  const seen = new Set<string>();
  for (const item of row.ranges) {
    const range = readRange(item);
    if (typeof range === "string") return { ok: false, message: range };
    if (seen.has(range.id)) return { ok: false, message: "This project file is incomplete." };
    seen.add(range.id);
    ranges.push(range);
  }
  const volumes: ModifierVolume[] = [];
  for (const item of row.volumes) {
    const volume = readVolume(item);
    if (typeof volume === "string") return { ok: false, message: volume };
    if (seen.has(volume.id)) return { ok: false, message: "This project file is incomplete." };
    seen.add(volume.id);
    volumes.push(volume);
  }
  return { ok: true, doc: { version: 1, ranges, volumes } };
}

function readRange(value: unknown): HeightRange | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return "This project file is incomplete.";
  if (!finite(row.zFrom) || !finite(row.zTo)) return "This project file is incomplete.";
  const override = readOverride(row.override);
  if (typeof override === "string") return override;
  return { id: row.id, zFrom: row.zFrom, zTo: row.zTo, override };
}

function readVolume(value: unknown): ModifierVolume | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return "This project file is incomplete.";
  if (row.kind !== "box" && row.kind !== "cylinder" && row.kind !== "sphere") return "This project file is incomplete.";
  if (!finite(row.x) || !finite(row.y) || !finite(row.z)) return "This project file is incomplete.";
  if (!finite(row.sx) || !finite(row.sy) || !finite(row.sz) || row.sx < MIN_SIZE || row.sy < MIN_SIZE || row.sz < MIN_SIZE) {
    return "This project file is incomplete.";
  }
  const override = readOverride(row.override);
  if (typeof override === "string") return override;
  return { id: row.id, kind: row.kind, x: row.x, y: row.y, z: row.z, sx: row.sx, sy: row.sy, sz: row.sz, override };
}

function readOverride(value: unknown): SettingOverride | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "This project file is incomplete.";
  const row = value as Record<string, unknown>;
  if ("layerHeight" in row) return "Layer height is not an override. The slice has one layer height.";
  const override: SettingOverride = {};
  if (row.infill !== undefined) {
    if (!finite(row.infill) || row.infill < 0 || row.infill > 1) return "This project file is incomplete.";
    override.infill = row.infill;
  }
  if (row.walls !== undefined) {
    if (!finite(row.walls) || row.walls < 0 || row.walls > 20 || !Number.isInteger(row.walls)) return "This project file is incomplete.";
    override.walls = row.walls;
  }
  if (row.speed !== undefined) {
    if (!finite(row.speed) || row.speed <= 0 || row.speed > 1000) return "This project file is incomplete.";
    override.speed = row.speed;
  }
  return override;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
