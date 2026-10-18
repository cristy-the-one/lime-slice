/**
 * Optional preview fields on a version 3 `.lime` file. The rules live in
 * `docs/lime-explorer-preview.md`. A bad thumbnail is ignored; it never fails an open.
 */
import { bytesToBase64, base64ToBytes } from "./base64.ts";
import { plateFileIsVersion2 } from "./plate.ts";
import { fnv1aHex } from "./slice-action.ts";

export const THUMB_MAX_EDGE = 512;
export const THUMB_MAX_BYTES = 128 * 1024;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface ProjectThumbnail {
  format: "png";
  width: number;
  height: number;
  /** Base64 of the PNG, no line breaks. */
  data: string;
  /** FNV-1a 64 of the geometry preimage. 16 lowercase hex digits. */
  meshHash: string;
  generatedBy?: string;
  createdAt?: string;
}

export interface ProjectSummary {
  name?: string;
  printer?: string;
  objectCount?: number;
  layerHeight?: number;
  slicedSeconds?: number;
  grams?: number;
}

interface PlacementLike {
  orient: readonly number[];
  scale: number;
  centered: boolean;
  offset: { x: number; y: number; z: number };
  stepTolerance: number;
}

/** The fields the geometry hash reads. A plate is hashed from `objects` only when the file will contain them. */
export interface GeometrySource {
  version: 1 | 2;
  mesh: { hash: string; name?: string };
  placement: PlacementLike;
  objects?: {
    id: string;
    name?: string;
    mesh: { name?: string; hash: string };
    brep?: { hash: string } | null;
    placement: PlacementLike;
    settings?: unknown;
    supportPaint?: readonly unknown[];
    seamPaint?: readonly unknown[];
    reinforcement?: readonly unknown[];
    modelTree?: unknown;
    modelPose?: unknown;
    workplane?: unknown;
  }[];
  settings?: { layerHeight?: number };
  profile?: { name?: string };
}

interface HashRow {
  id: string;
  meshHash: string;
  brepHash: string;
  placement: PlacementLike;
}

/** UTF-8 text hashed into `meshHash`. One block per object, a newline after every line. */
export function geometryPreimage(project: GeometrySource): string {
  const lines: string[] = [];
  for (const row of hashRows(project)) {
    lines.push(row.id, row.meshHash, row.brepHash);
    lines.push(JSON.stringify(row.placement.scale));
    lines.push(row.placement.centered ? "true" : "false");
    lines.push(JSON.stringify(row.placement.stepTolerance));
    for (const value of row.placement.orient) lines.push(JSON.stringify(value));
    lines.push(JSON.stringify(row.placement.offset.x));
    lines.push(JSON.stringify(row.placement.offset.y));
    lines.push(JSON.stringify(row.placement.offset.z));
  }
  return `${lines.join("\n")}\n`;
}

export function geometryHash(project: GeometrySource): string {
  return fnv1aHex(new TextEncoder().encode(geometryPreimage(project)));
}

function hashRows(project: GeometrySource): HashRow[] {
  if (project.version === 2 && project.objects && project.objects.length > 0 && plateFileIsVersion2(project.objects as Parameters<typeof plateFileIsVersion2>[0])) {
    return project.objects.map((obj) => ({
      id: obj.id,
      meshHash: obj.mesh.hash,
      brepHash: obj.brep?.hash ?? "",
      placement: obj.placement,
    }));
  }
  return [{ id: "part", meshHash: project.mesh.hash, brepHash: "", placement: project.placement }];
}

/** A summary for the file, from the plate. Time and grams are included only when the caller has a fresh slice. */
export function projectSummary(
  project: GeometrySource,
  estimate?: { seconds?: number; grams?: number },
): ProjectSummary {
  const plate = project.version === 2 && project.objects && project.objects.length > 0 && plateFileIsVersion2(project.objects as Parameters<typeof plateFileIsVersion2>[0]);
  const summary: ProjectSummary = {};
  const name = plate ? project.objects?.[0]?.name : project.mesh.name;
  const printer = project.profile?.name;
  if (typeof name === "string" && name.trim()) summary.name = name.trim().slice(0, 240);
  if (typeof printer === "string" && printer.trim()) summary.printer = printer.trim().slice(0, 240);
  summary.objectCount = plate ? project.objects!.length : 1;
  const layer = project.settings?.layerHeight;
  if (typeof layer === "number" && Number.isFinite(layer) && layer > 0 && layer <= 100) summary.layerHeight = layer;
  if (estimate && typeof estimate.seconds === "number" && Number.isFinite(estimate.seconds) && estimate.seconds >= 0 && estimate.seconds <= 1e9) {
    summary.slicedSeconds = estimate.seconds;
  }
  if (estimate && typeof estimate.grams === "number" && Number.isFinite(estimate.grams) && estimate.grams >= 0 && estimate.grams <= 1e9) {
    summary.grams = estimate.grams;
  }
  return summary;
}

/**
 * A PNG the caller just drew, or undefined when it is not a thumbnail we will store.
 * `meshHash` is the geometry hash of the plate the picture was drawn from.
 */
export function thumbnailFromPng(png: Uint8Array, meshHash: string, generatedBy: string, createdAt = new Date().toISOString()): ProjectThumbnail | undefined {
  const info = pngInfo(png);
  if (!info || info.colorType !== 6 && info.colorType !== 2) return undefined;
  if (png.byteLength > THUMB_MAX_BYTES) return undefined;
  if (!/^[0-9a-f]{16}$/.test(meshHash)) return undefined;
  const thumb: ProjectThumbnail = {
    format: "png",
    width: info.width,
    height: info.height,
    data: bytesToBase64(png),
    meshHash,
  };
  if (generatedByOk(generatedBy)) thumb.generatedBy = generatedBy;
  if (createdAtOk(createdAt)) thumb.createdAt = createdAt;
  return thumb;
}

/** The thumbnail to write, or undefined when it is missing, damaged, or drawn from different geometry. */
export function thumbnailForWire(project: GeometrySource & { thumbnail?: ProjectThumbnail }): Record<string, unknown> | undefined {
  const thumb = project.thumbnail;
  if (!thumb || thumb.meshHash !== geometryHash(project)) return undefined;
  const checked = readThumbnail(thumb);
  if (!checked) return undefined;
  const wire: Record<string, unknown> = {
    format: "png",
    width: checked.width,
    height: checked.height,
    data: checked.data,
    meshHash: checked.meshHash,
  };
  if (checked.generatedBy) wire.generatedBy = checked.generatedBy;
  if (checked.createdAt) wire.createdAt = checked.createdAt;
  return wire;
}

export function summaryForWire(summary: ProjectSummary | undefined): Record<string, unknown> | undefined {
  const read = readSummary(summary);
  if (!read) return undefined;
  const wire: Record<string, unknown> = {};
  if (read.name) wire.name = read.name;
  if (read.printer) wire.printer = read.printer;
  if (read.objectCount !== undefined) wire.objectCount = read.objectCount;
  if (read.layerHeight !== undefined) wire.layerHeight = read.layerHeight;
  if (read.slicedSeconds !== undefined) wire.slicedSeconds = read.slicedSeconds;
  if (read.grams !== undefined) wire.grams = read.grams;
  return Object.keys(wire).length > 0 ? wire : undefined;
}

/** Undefined when the value is absent or not a thumbnail. Never throws. */
export function readThumbnail(value: unknown): ProjectThumbnail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.format !== "png") return undefined;
  if (!integerIn(row.width, 1, THUMB_MAX_EDGE) || !integerIn(row.height, 1, THUMB_MAX_EDGE)) return undefined;
  if (Math.max(row.width as number, row.height as number) > THUMB_MAX_EDGE) return undefined;
  if (typeof row.data !== "string" || row.data.length === 0 || row.data.length > Math.ceil(THUMB_MAX_BYTES / 3) * 4 + 8) return undefined;
  if (typeof row.meshHash !== "string" || !/^[0-9a-f]{16}$/.test(row.meshHash)) return undefined;
  const png = base64ToBytes(row.data);
  if (!png || png.byteLength > THUMB_MAX_BYTES) return undefined;
  const info = pngInfo(png);
  if (!info || info.width !== row.width || info.height !== row.height) return undefined;
  const thumb: ProjectThumbnail = {
    format: "png",
    width: info.width,
    height: info.height,
    data: row.data,
    meshHash: row.meshHash,
  };
  if (typeof row.generatedBy === "string" && generatedByOk(row.generatedBy)) thumb.generatedBy = row.generatedBy;
  if (typeof row.createdAt === "string" && createdAtOk(row.createdAt)) thumb.createdAt = row.createdAt;
  return thumb;
}

/** Undefined when nothing in the object is usable. */
export function readSummary(value: unknown): ProjectSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const summary: ProjectSummary = {};
  if (typeof row.name === "string" && row.name.trim()) summary.name = row.name.trim().slice(0, 240);
  if (typeof row.printer === "string" && row.printer.trim()) summary.printer = row.printer.trim().slice(0, 240);
  if (integerIn(row.objectCount, 1, 100_000)) summary.objectCount = row.objectCount as number;
  if (typeof row.layerHeight === "number" && Number.isFinite(row.layerHeight) && row.layerHeight > 0 && row.layerHeight <= 100) summary.layerHeight = row.layerHeight;
  if (typeof row.slicedSeconds === "number" && Number.isFinite(row.slicedSeconds) && row.slicedSeconds >= 0 && row.slicedSeconds <= 1e9) summary.slicedSeconds = row.slicedSeconds;
  if (typeof row.grams === "number" && Number.isFinite(row.grams) && row.grams >= 0 && row.grams <= 1e9) summary.grams = row.grams;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function generatedByOk(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[\x20-\x7e]+$/.test(value);
}

function createdAtOk(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value);
}

/** IHDR of a non-interlaced 8-bit RGB or RGBA PNG, or null. Does not inflate the image. */
export function pngInfo(png: Uint8Array): { width: number; height: number; colorType: number } | null {
  if (png.length < 33) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) if (png[i] !== PNG_SIGNATURE[i]) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const length = view.getUint32(8);
  if (length !== 13) return null;
  if (png[12] !== 73 || png[13] !== 72 || png[14] !== 68 || png[15] !== 82) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = png[24];
  const colorType = png[25];
  const compression = png[26];
  const filter = png[27];
  const interlace = png[28];
  if (depth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) return null;
  if (colorType !== 2 && colorType !== 6) return null;
  if (width < 1 || height < 1 || width > THUMB_MAX_EDGE || height > THUMB_MAX_EDGE) return null;
  return { width, height, colorType };
}
