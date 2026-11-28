/**
 * Shared pose export encoders (docs/plan-pose-export.md):
 * - E1: Pose sheet (JSON) and STEP assembly metadata;
 * - E2: glTF 2.0 binary (.glb) with Y-up metres root transform, joint-tree nodes, shared meshes, colours, and kept animation;
 * - E3: 3MF assembly (at the pose, not print layout), STL (one file or ZIP per member), and OBJ + MTL.
 *
 * Pure TypeScript, shared by the desktop/web app and the MCP server.
 */
import { zipSync } from "fflate";
import { exportParts, memberPose, rotationQuaternion, type Assembly, type Member } from "./assembly.ts";
import { encodeStl, type Mat3 } from "./mesh-place.ts";
import { IDENTITY_POSE, applyPose, poseScale, relativePose, type Affine } from "./model-space.ts";
import { exportStem, partStem } from "./modeling/partition-export.ts";
import type { AnimationResult } from "./pose-anim.ts";

export type PoseExportFormat = "step" | "glb" | "3mf" | "stl" | "obj" | "pose";

export type PoseExportConfig =
  | { kind: "now" }
  | { kind: "frame"; animation: string; frameIndex: number; timeS: number };

export interface PoseExportPart {
  partKey: string;
  name: string;
  /** Triangle soup in the part's own CAD frame, millimetres. */
  positions: Float32Array;
}

export interface PoseExportMember {
  object: string;
  name: string;
  parent: string | null;
  parentIndex: number;
  partKey: string;
  partIndex: number;
  partName: string;
  member: Member;
  pose: Affine;
  /** Optional `#rrggbb` sRGB colour. */
  color?: string;
  /** See-through, at the same 0.28 opacity Pose draws. Absent is opaque. */
  glass?: true;
}

export interface OrderedPoseExport {
  assemblyName: string;
  parts: PoseExportPart[];
  members: PoseExportMember[];
}

export interface GlbAnimationInput {
  name: string;
  sampled: AnimationResult;
}

const DEFAULT_COLOR = "#b8c0cc";
/** Pose draws a glass part at this opacity (`GLASS_OPACITY` in src/pose-view.ts). */
const GLASS_ALPHA = 0.28;
const GLASS_ALPHA_HEX = Math.round(GLASS_ALPHA * 255).toString(16).padStart(2, "0").toUpperCase();

const MEMBER_PALETTE = [
  "#78a0d8",
  "#d88a68",
  "#78b88a",
  "#c898d8",
  "#d8be68",
  "#68b8c8",
  "#d87898",
  "#a0b868",
] as const;

/** Default distinguishable sRGB `#rrggbb` colour for member `index` when no animation swatch/colour is active. */
export function defaultMemberColor(index: number): string {
  return MEMBER_PALETTE[((index % MEMBER_PALETTE.length) + MEMBER_PALETTE.length) % MEMBER_PALETTE.length]!;
}

/** Human-readable description of the exported configuration (D1). */
export function configLabel(config: PoseExportConfig): string {
  if (config.kind === "now") return "Now";
  return `Frame ${config.frameIndex + 1} of ${config.animation} (${config.timeS.toFixed(2)} s)`;
}

/** Default file name for an exported pose (D5 / D6): `<assembly>-pose.<ext>` or `<assembly>-frame-37.<ext>`. */
export function poseExportFileName(
  assemblyName: string,
  format: PoseExportFormat,
  config: PoseExportConfig,
  stlMode: "one" | "each" = "one",
): string {
  const stem = (exportStem(assemblyName) || "assembly").replace(/\s+/g, "-").toLowerCase();
  const suffix = config.kind === "frame" ? `frame-${config.frameIndex + 1}` : "pose";
  const ext = format === "pose" ? "json" : format === "stl" && stlMode === "each" ? "zip" : format;
  return `${stem}-${suffix}.${ext}`;
}

/**
 * Orders an assembly's members root-first with unique names, resolves parent indexes, and deduplicates distinct parts
 * by `partKeyOf` so two members of the same part share one product/mesh/object (D3).
 */
export function orderExportMembers(
  assembly: Assembly,
  nameOf: (object: string) => string,
  partKeyOf: (object: string) => string,
  positionsOf: (object: string) => Float32Array,
  poseOf: (object: string) => Affine | undefined,
  colorOf?: (object: string) => string | undefined,
  glassOf?: (object: string) => boolean,
): OrderedPoseExport {
  const ordered = exportParts(assembly, (id) => partStem(nameOf(id)));
  const memberById = new Map(assembly.members.map((m) => [m.object, m] as const));
  const indexById = new Map(ordered.map((row, idx) => [row.object, idx] as const));
  const partIndexByKey = new Map<string, number>();
  const parts: PoseExportPart[] = [];
  const members: PoseExportMember[] = [];
  for (const row of ordered) {
    const member = memberById.get(row.object);
    if (!member) continue;
    const partKey = partKeyOf(row.object);
    let partIndex = partIndexByKey.get(partKey);
    if (partIndex === undefined) {
      partIndex = parts.length;
      partIndexByKey.set(partKey, partIndex);
      parts.push({ partKey, name: partStem(nameOf(row.object)) || row.name, positions: positionsOf(row.object) });
    }
    const parentIndex = member.parent !== null ? (indexById.get(member.parent) ?? -1) : -1;
    const color = normalizeHex(colorOf?.(row.object));
    const glass = glassOf?.(row.object) === true;
    members.push({
      object: row.object,
      name: row.name,
      parent: member.parent,
      parentIndex,
      partKey,
      partIndex,
      partName: parts[partIndex]!.name,
      member,
      pose: poseOf(row.object) ?? IDENTITY_POSE,
      ...(color ? { color } : {}),
      ...(glass ? { glass: true as const } : {}),
    });
  }
  return { assemblyName: assembly.name, parts, members };
}

function normalizeHex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const trimmed = color.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : undefined;
}

function hexToSrgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Transforms a triangle soup in its part frame by `pose` into model space. */
export function transformSoup(positions: Float32Array, pose: Affine): Float32Array {
  const out = new Float32Array(positions.length);
  const { m, t } = pose;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    out[i] = m[0] * x + m[1] * y + m[2] * z + t[0];
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z + t[1];
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z + t[2];
  }
  return out;
}

/**
 * Checks whether `pose` is a valid rigid transform plus positive uniform scale (no shear, no mirror/reflection),
 * matching the kernel's STEP placement rule (`crates/lime-model-occt/src/tree/ops.rs`).
 */
export function poseTransformProblem(pose: Affine): string | null {
  const { m, t } = pose;
  for (let i = 0; i < 9; i++) if (!Number.isFinite(m[i])) return "A part's pose must be a turn and a move, with no shear or mirror.";
  for (let i = 0; i < 3; i++) if (!Number.isFinite(t[i])) return "A part's pose must be a turn and a move, with no shear or mirror.";
  const c0 = Math.hypot(m[0], m[3], m[6]);
  const c1 = Math.hypot(m[1], m[4], m[7]);
  const c2 = Math.hypot(m[2], m[5], m[8]);
  if (!(c0 > 1e-9 && c1 > 1e-9 && c2 > 1e-9)) {
    return "A part's pose must be a turn and a move, with no shear or mirror.";
  }
  const tol = 1e-3 * c0;
  if (Math.abs(c1 - c0) > tol || Math.abs(c2 - c0) > tol) {
    return "A part's pose must be a turn and a move, with no shear or mirror.";
  }
  const inv = 1 / c0;
  const r00 = m[0] * inv, r01 = m[1] * inv, r02 = m[2] * inv;
  const r10 = m[3] * inv, r11 = m[4] * inv, r12 = m[5] * inv;
  const r20 = m[6] * inv, r21 = m[7] * inv, r22 = m[8] * inv;
  const d01 = r00 * r01 + r10 * r11 + r20 * r21;
  const d02 = r00 * r02 + r10 * r12 + r20 * r22;
  const d12 = r01 * r02 + r11 * r12 + r21 * r22;
  if (Math.abs(d01) > 1e-3 || Math.abs(d02) > 1e-3 || Math.abs(d12) > 1e-3) {
    return "A part's pose must be a turn and a move, with no shear or mirror.";
  }
  const det =
    r00 * (r11 * r22 - r12 * r21) -
    r01 * (r10 * r22 - r12 * r20) +
    r02 * (r10 * r21 - r11 * r20);
  if (det <= 0) {
    return "A part's pose must be a turn and a move, with no shear or mirror.";
  }
  return null;
}

/** Validates every member's pose (and every sampled animation frame when given) before export. */
export function orderedPoseProblem(ordered: OrderedPoseExport, animation?: GlbAnimationInput): string | null {
  for (const row of ordered.members) {
    const problem = poseTransformProblem(row.pose);
    if (problem) return `${row.name}: ${problem}`;
  }
  if (animation) {
    for (const frame of animation.sampled.frames) {
      for (const row of ordered.members) {
        const pose = frame.poses.get(row.object);
        if (!pose) continue;
        const problem = poseTransformProblem(pose);
        if (problem) return `${row.name}: ${problem}`;
      }
    }
  }
  return null;
}

/** Decomposes an `Affine` (rigid + optional uniform scale) into glTF TRS. */
export function affineToTrs(pose: Affine): { translation: [number, number, number]; rotation: [number, number, number, number]; scale: number } {
  const s = poseScale(pose);
  const rot = (Math.abs(s - 1) > 1e-9 ? pose.m.map((v) => v / s) : pose.m) as Mat3;
  const q = rotationQuaternion(rot);
  return {
    translation: [pose.t[0], pose.t[1], pose.t[2]],
    rotation: [q[0], q[1], q[2], q[3]],
    scale: s,
  };
}

// ============================================================================
// E1: Pose sheet (JSON)
// ============================================================================

export interface PoseSheetMember {
  name: string;
  parent: string | null;
  joint:
    | { kind: "fixed" }
    | { kind: "hinge"; value: number; unit: "deg"; min: number | null; max: number | null; pivot: [number, number, number]; axis: [number, number, number] }
    | { kind: "slide"; value: number; unit: "mm"; min: number | null; max: number | null; pivot: [number, number, number]; axis: [number, number, number] }
    | { kind: "ball"; value: [number, number, number, number]; unit: "quaternion"; cone: number | null; pivot: [number, number, number] };
  placementMm: [[number, number, number, number], [number, number, number, number], [number, number, number, number], [number, number, number, number]];
}

export interface PoseSheet {
  format: "lime-pose";
  version: 1;
  units: "mm";
  assembly: string;
  configuration: { kind: "now" } | { kind: "frame"; animation: string; frame: number; timeS: number };
  members: PoseSheetMember[];
}

export function buildPoseSheet(ordered: OrderedPoseExport, config: PoseExportConfig): PoseSheet {
  const nameById = new Map(ordered.members.map((m) => [m.object, m.name] as const));
  return {
    format: "lime-pose",
    version: 1,
    units: "mm",
    assembly: ordered.assemblyName,
    configuration:
      config.kind === "now"
        ? { kind: "now" }
        : { kind: "frame", animation: config.animation, frame: config.frameIndex + 1, timeS: config.timeS },
    members: ordered.members.map((row) => {
      const j = row.member.joint;
      const joint: PoseSheetMember["joint"] = !j
        ? { kind: "fixed" }
        : j.kind === "hinge"
          ? { kind: "hinge", value: j.angle ?? 0, unit: "deg", min: j.min ?? null, max: j.max ?? null, pivot: [...j.pivot], axis: [...j.axis] }
          : j.kind === "slide"
            ? { kind: "slide", value: j.travel ?? 0, unit: "mm", min: j.min ?? null, max: j.max ?? null, pivot: [...j.pivot], axis: [...j.axis] }
            : { kind: "ball", value: rotationQuaternion(memberPose(row.member).m), unit: "quaternion", cone: j.cone ?? null, pivot: [...j.pivot] };
      const { m, t } = row.pose;
      return {
        name: row.name,
        parent: row.parent !== null ? (nameById.get(row.parent) ?? null) : null,
        joint,
        placementMm: [
          [m[0], m[1], m[2], t[0]],
          [m[3], m[4], m[5], t[1]],
          [m[6], m[7], m[8], t[2]],
          [0, 0, 0, 1],
        ],
      };
    }),
  };
}

export function encodePoseSheet(ordered: OrderedPoseExport, config: PoseExportConfig): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(buildPoseSheet(ordered, config), null, 2)}\n`);
}

// ============================================================================
// E2: glTF 2.0 binary (.glb)
// ============================================================================

function computeFlatNormals(positions: Float32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!;
    const ux = positions[i + 3]! - ax, uy = positions[i + 4]! - ay, uz = positions[i + 5]! - az;
    const vx = positions[i + 6]! - ax, vy = positions[i + 7]! - ay, vz = positions[i + 8]! - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    const inv = len > 1e-12 ? 1 / len : 0;
    const fx = nx * inv, fy = ny * inv, fz = nz * inv;
    normals[i] = fx; normals[i + 1] = fy; normals[i + 2] = fz;
    normals[i + 3] = fx; normals[i + 4] = fy; normals[i + 5] = fz;
    normals[i + 6] = fx; normals[i + 7] = fy; normals[i + 8] = fz;
  }
  return normals;
}

class BinBuilder {
  private chunks: Uint8Array[] = [];
  private offset = 0;

  append(data: ArrayBufferView): { byteOffset: number; byteLength: number } {
    const pad = (4 - (this.offset & 3)) & 3;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.offset += pad;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const byteOffset = this.offset;
    this.chunks.push(bytes);
    this.offset += bytes.byteLength;
    return { byteOffset, byteLength: bytes.byteLength };
  }

  finish(): Uint8Array {
    const pad = (4 - (this.offset & 3)) & 3;
    const total = this.offset + pad;
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

/**
 * Encodes an assembly pose (and optional kept animation, decision 1) as a glTF 2.0 binary (.glb).
 * Root node carries D2's transform: scale 0.001 (mm -> m) and −90° about X (Z-up -> Y-up).
 */
export function encodePoseGlb(ordered: OrderedPoseExport, animation?: GlbAnimationInput): Uint8Array {
  const bin = new BinBuilder();
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];

  const addFloatAccessor = (
    values: Float32Array,
    type: "SCALAR" | "VEC3" | "VEC4",
    target?: number,
    withMinMax = false,
  ): number => {
    const span = bin.append(values);
    const bvIdx = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: span.byteOffset,
      byteLength: span.byteLength,
      ...(target !== undefined ? { target } : {}),
    });
    const components = type === "SCALAR" ? 1 : type === "VEC3" ? 3 : 4;
    const count = values.length / components;
    const acc: Record<string, unknown> = {
      bufferView: bvIdx,
      componentType: 5126, // FLOAT
      count,
      type,
    };
    if (withMinMax && count > 0) {
      const min = new Array<number>(components).fill(Infinity);
      const max = new Array<number>(components).fill(-Infinity);
      for (let i = 0; i < values.length; i += components) {
        for (let k = 0; k < components; k++) {
          const v = values[i + k]!;
          if (v < min[k]!) min[k] = v;
          if (v > max[k]!) max[k] = v;
        }
      }
      acc.min = min;
      acc.max = max;
    }
    const accIdx = accessors.length;
    accessors.push(acc);
    return accIdx;
  };

  // One POSITION + NORMAL accessor pair per distinct part (D3).
  const partAccessors: ({ pos: number; norm: number } | null)[] = ordered.parts.map((part) => {
    if (part.positions.length < 9) return null;
    const pos = addFloatAccessor(part.positions, "VEC3", 34962, true);
    const norm = addFloatAccessor(computeFlatNormals(part.positions), "VEC3", 34962, false);
    return { pos, norm };
  });

  // One material per distinct (colour, glass). Opaque materials stay alpha 1 with no alphaMode.
  const materialByKey = new Map<string, number>();
  const materials: Record<string, unknown>[] = [];
  const materialFor = (hex: string | undefined, glass: boolean): number => {
    const key = hex ?? DEFAULT_COLOR;
    const mapKey = glass ? `${key}|glass` : key;
    const existing = materialByKey.get(mapKey);
    if (existing !== undefined) return existing;
    const [r, g, b] = hexToSrgb(key);
    const idx = materials.length;
    materialByKey.set(mapKey, idx);
    const material: Record<string, unknown> = {
      name: glass ? `color_${key.slice(1)}_glass` : `color_${key.slice(1)}`,
      pbrMetallicRoughness: {
        baseColorFactor: [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), glass ? GLASS_ALPHA : 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.55,
      },
    };
    if (glass) material.alphaMode = "BLEND";
    materials.push(material);
    return idx;
  };

  // One glTF mesh per distinct (partIndex, materialIndex).
  const meshByKey = new Map<string, number>();
  const meshes: Record<string, unknown>[] = [];
  const meshFor = (partIndex: number, color: string | undefined, glass: boolean): number | undefined => {
    const acc = partAccessors[partIndex];
    if (!acc) return undefined;
    const matIdx = materialFor(color, glass);
    const key = `${partIndex}:${matIdx}`;
    const existing = meshByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = meshes.length;
    meshByKey.set(key, idx);
    meshes.push({
      name: ordered.parts[partIndex]!.name,
      primitives: [{ attributes: { POSITION: acc.pos, NORMAL: acc.norm }, material: matIdx }],
    });
    return idx;
  };

  // Nodes: node 0 is the root with D2's mm -> m and Z-up -> Y-up transform; member i is node 1 + i.
  const childrenOf: number[][] = Array.from({ length: ordered.members.length }, () => []);
  const rootChildren: number[] = [];
  for (let i = 0; i < ordered.members.length; i++) {
    const p = ordered.members[i]!.parentIndex;
    if (p >= 0 && p < ordered.members.length && p !== i) childrenOf[p]!.push(i + 1);
    else rootChildren.push(i + 1);
  }

  const nodes: Record<string, unknown>[] = [
    {
      name: ordered.assemblyName,
      rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      scale: [0.001, 0.001, 0.001],
      ...(rootChildren.length ? { children: rootChildren } : {}),
    },
  ];

  for (let i = 0; i < ordered.members.length; i++) {
    const row = ordered.members[i]!;
    const localPose = row.parentIndex >= 0 ? relativePose(ordered.members[row.parentIndex]!.pose, row.pose) : row.pose;
    const trs = affineToTrs(localPose);
    const meshIdx = meshFor(row.partIndex, row.color, row.glass === true);
    const kids = childrenOf[i]!;
    const node: Record<string, unknown> = {
      name: row.name,
      translation: trs.translation,
      rotation: trs.rotation,
      ...(Math.abs(trs.scale - 1) > 1e-6 ? { scale: [trs.scale, trs.scale, trs.scale] } : {}),
      ...(meshIdx !== undefined ? { mesh: meshIdx } : {}),
      ...(kids.length ? { children: kids } : {}),
    };
    nodes.push(node);
  }

  // Optional kept animation (decision 1): linear channels per moving member.
  const animations: Record<string, unknown>[] = [];
  if (animation && animation.sampled.frames.length >= 2) {
    const frames = animation.sampled.frames;
    const frameCount = frames.length;
    const times = new Float32Array(frameCount);
    for (let k = 0; k < frameCount; k++) times[k] = frames[k]!.time;
    const timeAcc = addFloatAccessor(times, "SCALAR", undefined, true);
    const channels: Record<string, unknown>[] = [];
    const samplers: Record<string, unknown>[] = [];

    for (let i = 0; i < ordered.members.length; i++) {
      const row = ordered.members[i]!;
      const tBuf = new Float32Array(frameCount * 3);
      const qBuf = new Float32Array(frameCount * 4);
      let tMoves = false;
      let rMoves = false;
      let t0x = 0, t0y = 0, t0z = 0;
      let prevQ: [number, number, number, number] = [0, 0, 0, 1];
      let q0: [number, number, number, number] = [0, 0, 0, 1];
      for (let k = 0; k < frameCount; k++) {
        const fPoses = frames[k]!.poses;
        const world = fPoses.get(row.object) ?? row.pose;
        const local = row.parentIndex >= 0
          ? relativePose(fPoses.get(ordered.members[row.parentIndex]!.object) ?? ordered.members[row.parentIndex]!.pose, world)
          : world;
        const trs = affineToTrs(local);
        const [tx, ty, tz] = trs.translation;
        let [qx, qy, qz, qw] = trs.rotation;
        if (k === 0) {
          t0x = tx; t0y = ty; t0z = tz;
          q0 = [qx, qy, qz, qw];
        } else {
          // Keep quaternion in the same hemisphere as the previous sample for short-arc interpolation.
          if (prevQ[0] * qx + prevQ[1] * qy + prevQ[2] * qz + prevQ[3] * qw < 0) {
            qx = -qx; qy = -qy; qz = -qz; qw = -qw;
          }
          if (Math.abs(tx - t0x) > 1e-5 || Math.abs(ty - t0y) > 1e-5 || Math.abs(tz - t0z) > 1e-5) tMoves = true;
          const dot0 = Math.abs(q0[0] * qx + q0[1] * qy + q0[2] * qz + q0[3] * qw);
          if (dot0 < 1 - 1e-7) rMoves = true;
        }
        prevQ = [qx, qy, qz, qw];
        tBuf[k * 3] = tx; tBuf[k * 3 + 1] = ty; tBuf[k * 3 + 2] = tz;
        qBuf[k * 4] = qx; qBuf[k * 4 + 1] = qy; qBuf[k * 4 + 2] = qz; qBuf[k * 4 + 3] = qw;
      }
      const nodeIdx = i + 1;
      if (tMoves) {
        const outAcc = addFloatAccessor(tBuf, "VEC3");
        const samplerIdx = samplers.length;
        samplers.push({ input: timeAcc, interpolation: "LINEAR", output: outAcc });
        channels.push({ sampler: samplerIdx, target: { node: nodeIdx, path: "translation" } });
      }
      if (rMoves) {
        const outAcc = addFloatAccessor(qBuf, "VEC4");
        const samplerIdx = samplers.length;
        samplers.push({ input: timeAcc, interpolation: "LINEAR", output: outAcc });
        channels.push({ sampler: samplerIdx, target: { node: nodeIdx, path: "rotation" } });
      }
    }
    if (channels.length > 0) {
      animations.push({ name: animation.name, channels, samplers });
    }
  }

  const binBytes = bin.finish();
  const gltf: Record<string, unknown> = {
    asset: { version: "2.0", generator: "Lime Slice" },
    scene: 0,
    scenes: [{ name: ordered.assemblyName, nodes: [0] }],
    nodes,
    ...(meshes.length ? { meshes } : {}),
    ...(materials.length ? { materials } : {}),
    ...(animations.length ? { animations } : {}),
    ...(accessors.length ? { accessors } : {}),
    ...(bufferViews.length ? { bufferViews } : {}),
    ...(binBytes.byteLength ? { buffers: [{ byteLength: binBytes.byteLength }] } : {}),
  };

  const jsonRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (jsonRaw.byteLength & 3)) & 3;
  const jsonLen = jsonRaw.byteLength + jsonPad;
  const hasBin = binBytes.byteLength > 0;
  const totalLen = 12 + 8 + jsonLen + (hasBin ? 8 + binBytes.byteLength : 0);
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  // Header
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLen, true);
  // JSON chunk
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonRaw, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonRaw.byteLength + i] = 0x20;
  // BIN chunk
  if (hasBin) {
    const binHead = 20 + jsonLen;
    view.setUint32(binHead, binBytes.byteLength, true);
    view.setUint32(binHead + 4, 0x004e4942, true); // "BIN\0"
    out.set(binBytes, binHead + 8);
  }
  return out;
}

// ============================================================================
// E3: 3MF assembly at the pose
// ============================================================================

function xmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function format3mfTransform(pose: Affine): string {
  // 3MF row-vector matrix: [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32]
  // Lime Slice Affine is column-vector row-major m, so transpose 3x3 + translation.
  const { m, t } = pose;
  const vals = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8], t[0], t[1], t[2]];
  return vals.map((v) => (Math.abs(v) < 1e-12 ? "0" : String(v))).join(" ");
}

/**
 * Writes a 3MF assembly at the posed transforms (not print layout): one `<object>` per distinct part/colour in its
 * own frame, `<basematerials>` for colours (a glass part keeps its alpha), and one `<item objectid transform>` per member.
 */
export function encodePose3mf(ordered: OrderedPoseExport): Uint8Array {
  const colorList: { rgb: string; glass: boolean }[] = [];
  const colorIndex = new Map<string, number>();
  const colorIdOf = (hex: string | undefined, glass: boolean): number => {
    const rgb = (hex ?? DEFAULT_COLOR).toUpperCase();
    const key = glass ? `${rgb}|glass` : rgb;
    const existing = colorIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = colorList.length;
    colorIndex.set(key, idx);
    colorList.push({ rgb, glass });
    return idx;
  };

  // Pre-build mesh XML per distinct part once.
  const meshXmlByPart: (string | null)[] = ordered.parts.map((part) => {
    if (part.positions.length < 9) return null;
    const verts: string[] = [];
    const tris: string[] = [];
    const vertIndex = new Map<string, number>();
    const addVert = (x: number, y: number, z: number) => {
      const key = `${x},${y},${z}`;
      const existing = vertIndex.get(key);
      if (existing !== undefined) return existing;
      const idx = verts.length;
      vertIndex.set(key, idx);
      verts.push(`<vertex x="${x}" y="${y}" z="${z}" />`);
      return idx;
    };
    for (let i = 0; i + 8 < part.positions.length; i += 9) {
      const a = addVert(part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!);
      const b = addVert(part.positions[i + 3]!, part.positions[i + 4]!, part.positions[i + 5]!);
      const c = addVert(part.positions[i + 6]!, part.positions[i + 7]!, part.positions[i + 8]!);
      if (a === b || b === c || a === c) continue;
      tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}" />`);
    }
    if (tris.length === 0) return null;
    return `<mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh>`;
  });

  // Resource ID 1 is `<basematerials>`. Objects start at ID 2.
  const objectsXml: string[] = [];
  const itemsXml: string[] = [];
  const objectIdByKey = new Map<string, number>();
  let nextId = 2;

  for (const row of ordered.members) {
    const meshXml = meshXmlByPart[row.partIndex];
    if (!meshXml) continue;
    const cIdx = colorIdOf(row.color, row.glass === true);
    const key = `${row.partIndex}:${cIdx}`;
    let objId = objectIdByKey.get(key);
    if (objId === undefined) {
      objId = nextId++;
      objectIdByKey.set(key, objId);
      objectsXml.push(`<object id="${objId}" name="${xmlAttr(row.partName)}" type="model" pid="1" pindex="${cIdx}">${meshXml}</object>`);
    }
    itemsXml.push(`<item objectid="${objId}" transform="${format3mfTransform(row.pose)}" />`);
  }

  const basesXml = colorList.map((entry, i) => `<base name="color_${i + 1}" displaycolor="${entry.rgb}${entry.glass ? GLASS_ALPHA_HEX : "FF"}" />`).join("");
  const materialsXml = colorList.length ? `<basematerials id="1">${basesXml}</basematerials>` : "";
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${xmlAttr(ordered.assemblyName)}</metadata>
  <resources>${materialsXml}${objectsXml.join("")}</resources>
  <build>${itemsXml.join("")}</build>
</model>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const enc = new TextEncoder();
  return zipSync(
    {
      "[Content_Types].xml": enc.encode(types),
      "_rels/.rels": enc.encode(rels),
      "3D/3dmodel.model": enc.encode(model),
    },
    { level: 6 },
  );
}

// ============================================================================
// E3: STL at the pose (one file or ZIP of one STL per member)
// ============================================================================

export function encodePoseStl(ordered: OrderedPoseExport, mode: "one" | "each" = "one"): Uint8Array {
  if (mode === "each") {
    const files: Record<string, Uint8Array> = {};
    for (const row of ordered.members) {
      const part = ordered.parts[row.partIndex];
      if (!part || part.positions.length < 9) continue;
      const posed = transformSoup(part.positions, row.pose);
      files[`${row.name}.stl`] = new Uint8Array(encodeStl(posed, row.name));
    }
    return zipSync(files, { level: 6 });
  }
  const chunks: Float32Array[] = [];
  let totalFloats = 0;
  for (const row of ordered.members) {
    const part = ordered.parts[row.partIndex];
    if (!part || part.positions.length < 9) continue;
    const posed = transformSoup(part.positions, row.pose);
    chunks.push(posed);
    totalFloats += posed.length;
  }
  const combined = new Float32Array(totalFloats);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new Uint8Array(encodeStl(combined, ordered.assemblyName));
}

// ============================================================================
// E3: OBJ + MTL at the pose
// ============================================================================

function sanitizeObjToken(name: string): string {
  return name.trim().replace(/\s+/g, "_") || "part";
}

export function encodePoseObjMtl(
  ordered: OrderedPoseExport,
  mtlFileName: string,
): { obj: Uint8Array; mtl: Uint8Array; triangles: number } {
  const matByColor = new Map<string, string>();
  const mtlLines: string[] = [`# Materials for ${ordered.assemblyName}`];
  const materialOf = (hex: string | undefined, glass: boolean): string => {
    const key = hex ?? DEFAULT_COLOR;
    const mapKey = glass ? `${key}|glass` : key;
    const existing = matByColor.get(mapKey);
    if (existing) return existing;
    const name = glass ? `mat_${key.slice(1)}_glass` : `mat_${key.slice(1)}`;
    matByColor.set(mapKey, name);
    const [r, g, b] = hexToSrgb(key);
    mtlLines.push(
      `newmtl ${name}`,
      `Ka 0.1 0.1 0.1`,
      `Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`,
      `Ks 0.2 0.2 0.2`,
      `Ns 32`,
      ...(glass ? [`d ${GLASS_ALPHA.toFixed(2)}`, `Tr ${(1 - GLASS_ALPHA).toFixed(2)}`] : []),
      "",
    );
    return name;
  };

  const objLines: string[] = [
    `# Exported from Lime Slice: ${ordered.assemblyName}`,
    `mtllib ${mtlFileName}`,
  ];
  let vertexBase = 1;
  let triangles = 0;

  for (const row of ordered.members) {
    const part = ordered.parts[row.partIndex];
    if (!part || part.positions.length < 9) continue;
    const posed = transformSoup(part.positions, row.pose);
    const mat = materialOf(row.color, row.glass === true);
    objLines.push(`g ${sanitizeObjToken(row.name)}`, `usemtl ${mat}`);
    const vertIndex = new Map<string, number>();
    let localCount = 0;
    const faces: string[] = [];
    const addVert = (x: number, y: number, z: number) => {
      const key = `${x},${y},${z}`;
      const existing = vertIndex.get(key);
      if (existing !== undefined) return existing;
      const idx = vertexBase + localCount++;
      vertIndex.set(key, idx);
      objLines.push(`v ${x} ${y} ${z}`);
      return idx;
    };
    for (let i = 0; i + 8 < posed.length; i += 9) {
      const a = addVert(posed[i]!, posed[i + 1]!, posed[i + 2]!);
      const b = addVert(posed[i + 3]!, posed[i + 4]!, posed[i + 5]!);
      const c = addVert(posed[i + 6]!, posed[i + 7]!, posed[i + 8]!);
      if (a === b || b === c || a === c) continue;
      faces.push(`f ${a} ${b} ${c}`);
      triangles += 1;
    }
    objLines.push(...faces);
    vertexBase += localCount;
  }

  const enc = new TextEncoder();
  return {
    obj: enc.encode(`${objLines.join("\n")}\n`),
    mtl: enc.encode(`${mtlLines.join("\n")}\n`),
    triangles,
  };
}

/**
 * Helper to compute the assembly's posed bounds from `ordered` parts and poses (for verification/tests).
 */
export function orderedPosedBounds(ordered: OrderedPoseExport): { min: [number, number, number]; max: [number, number, number] } | null {
  let min: [number, number, number] | null = null;
  let max: [number, number, number] | null = null;
  for (const row of ordered.members) {
    const part = ordered.parts[row.partIndex];
    if (!part || part.positions.length < 9) continue;
    for (let i = 0; i + 2 < part.positions.length; i += 3) {
      const [x, y, z] = applyPose(row.pose, [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]);
      if (!min || !max) {
        min = [x, y, z];
        max = [x, y, z];
      } else {
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
  }
  return min && max ? { min, max } : null;
}
