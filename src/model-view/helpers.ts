/** Pure helpers lifted out of the view: they read nothing from the view's state. */
import * as THREE from "three";
import type { Bounds } from "../mesh-place";
import { CUT_TRACE_GLSL, type CutTrace, TRACE_BOUNDS, TRACE_POINTS } from "../cut-trace";
import type { EdgeKnobEvent, StressDraw } from "./types";
import type { HandleAspect } from "../handle-emphasis";
import type { PrimitiveSpec } from "../model-primitive";
import type { Vec3 } from "../model-drag";
import { hexToThree } from "../theme";


export function readAccent(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return hexToThree(raw || "#a3e635");
}

export function failedGhostMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xd64545,
    roughness: 0.55,
    metalness: 0.05,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
// --- end A3 ---

/** A solid outline broken into short dashes, in millimetres along each segment, so it reads as removed. */
export function dashSegments(positions: number[]): number[] {
  const dash = 1.8;
  const gap = 1.1;
  const period = dash + gap;
  const out: number[] = [];
  for (let i = 0; i + 5 < positions.length; i += 6) {
    const ax = positions[i]!;
    const ay = positions[i + 1]!;
    const az = positions[i + 2]!;
    const bx = positions[i + 3]!;
    const by = positions[i + 4]!;
    const bz = positions[i + 5]!;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 1e-6)) continue;
    for (let t = 0; t < length - 1e-6; t += period) {
      const end = Math.min(t + dash, length);
      const u0 = t / length;
      const u1 = end / length;
      out.push(ax + dx * u0, ay + dy * u0, az + dz * u0, ax + dx * u1, ay + dy * u1, az + dz * u1);
    }
  }
  return out;
}

/** --- A7 model check --- Twelve edges of a box, in model space. */
export function boxEdges(box: Bounds): number[] {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const positions: number[] = [];
  for (const [a, b] of edges) positions.push(...corners[a]!, ...corners[b]!);
  return positions;
}

export function boxList(boxes: Bounds[]): string {
  return boxes.map((box) => [...box.min, ...box.max].map((value) => value.toFixed(2)).join(",")).join(" ");
}

/** Axis scale from the built mesh, when the new primitive is that mesh grown from its own origin. */
export function primitiveScale(built: PrimitiveSpec, next: PrimitiveSpec): [number, number, number] | null {
  if (built.primitive !== next.primitive) return null;
  const ratio = (from: number, to: number) => (Math.abs(from) > 1e-9 ? to / from : null);
  if (next.primitive === "box" || next.primitive === "ellipsoid") {
    const x = ratio(built.size[0], next.size[0]);
    const y = ratio(built.size[1], next.size[1]);
    const z = ratio(built.size[2], next.size[2]);
    return x == null || y == null || z == null ? null : [x, y, z];
  }
  if (next.primitive === "sphere") {
    const s = ratio(built.radius, next.radius);
    return s == null ? null : [s, s, s];
  }
  if (next.primitive === "cylinder" || next.primitive === "tube") {
    const s = ratio(built.radius, next.radius);
    const z = ratio(built.height, next.height);
    if (s == null || z == null) return null;
    if (next.primitive === "tube") {
      const inner = ratio(built.innerRadius ?? 0, next.innerRadius ?? 0);
      if (inner == null || Math.abs(inner - s) > 1e-4) return null;
    }
    return [s, s, z];
  }
  if (next.primitive === "wedge") {
    const x = ratio(built.size[0], next.size[0]);
    const y = ratio(built.size[1], next.size[1]);
    const z = ratio(built.size[2], next.size[2]);
    if (x == null || y == null || z == null) return null;
    const top = (built.topX ?? built.size[0]) * x;
    if (Math.abs(top - (next.topX ?? next.size[0])) > 1e-3) return null;
    return [x, y, z];
  }
  return null;
}

export function writePositions(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, source: ArrayLike<number>) {
  (attr.array as Float32Array).set(source);
  attr.needsUpdate = true;
}

/**
 * A piece bounded by a shaped cut keeps only the fragments on its side of that cut's profile: the shader reads the
 * profile as `traceAt` does, so the tints part where the path is drawn. The count of such cuts is a define, so a new
 * count compiles once and new numbers are only uniforms.
 */
export function traceShader(material: THREE.MeshStandardMaterial) {
  const vec3s = () => Array.from({ length: TRACE_BOUNDS }, () => new THREE.Vector3());
  const uniforms = {
    cutTraceOrigin: { value: vec3s() },
    cutTraceAcross: { value: vec3s() },
    cutTraceW: { value: vec3s() },
    cutTracePeriod: { value: new Array<number>(TRACE_BOUNDS).fill(0) },
    cutTraceSide: { value: new Array<number>(TRACE_BOUNDS).fill(1) },
    cutTraceCount: { value: new Array<number>(TRACE_BOUNDS).fill(0) },
    cutTracePoints: { value: Array.from({ length: TRACE_BOUNDS * TRACE_POINTS }, () => new THREE.Vector2()) },
  };
  material.userData.cutTrace = uniforms;
  // The standard material keeps its own STANDARD define: the count goes beside it.
  const defined = material as THREE.MeshStandardMaterial & { defines: Record<string, unknown> };
  defined.defines = { ...defined.defines, CUT_TRACES: 0 };
  material.customProgramCacheKey = () => `cut-trace-${String(defined.defines.CUT_TRACES)}`;
  material.onBeforeCompile = (shader) => {
    if (!(Number(defined.defines.CUT_TRACES) > 0)) return;
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", ["#include <common>", "varying vec3 vCutTraceAt;"].join("\n"))
      .replace("#include <begin_vertex>", ["#include <begin_vertex>", "vCutTraceAt = (modelMatrix * vec4(transformed, 1.0)).xyz;"].join("\n"));
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", ["#include <common>", CUT_TRACE_GLSL].join("\n"))
      .replace(
        "#include <clipping_planes_fragment>",
        [
          "#include <clipping_planes_fragment>",
          "for (int i = 0; i < CUT_TRACES; i++) {",
          "  vec3 cutRel = vCutTraceAt - cutTraceOrigin[i];",
          "  if (cutTraceSide[i] * (dot(cutRel, cutTraceW[i]) - cutTraceAt(i, dot(cutRel, cutTraceAcross[i]))) < 0.0) discard;",
          "}",
        ].join("\n"),
      );
  };
}

/** The shaped cuts that bound a piece, each with the side of its profile the piece keeps; a new count recompiles. */
export function setPieceTraces(material: THREE.MeshStandardMaterial, bounds: { trace: CutTrace; side: number }[]) {
  const uniforms = material.userData.cutTrace as {
    cutTraceOrigin: { value: THREE.Vector3[] };
    cutTraceAcross: { value: THREE.Vector3[] };
    cutTraceW: { value: THREE.Vector3[] };
    cutTracePeriod: { value: number[] };
    cutTraceSide: { value: number[] };
    cutTraceCount: { value: number[] };
    cutTracePoints: { value: THREE.Vector2[] };
  };
  bounds.forEach(({ trace, side }, i) => {
    uniforms.cutTraceOrigin.value[i]!.set(...trace.origin);
    uniforms.cutTraceAcross.value[i]!.set(...trace.across);
    uniforms.cutTraceW.value[i]!.set(...trace.w);
    uniforms.cutTracePeriod.value[i] = trace.period;
    uniforms.cutTraceSide.value[i] = side;
    uniforms.cutTraceCount.value[i] = Math.min(trace.points.length, TRACE_POINTS);
    trace.points.slice(0, TRACE_POINTS).forEach(([a, w], k) => uniforms.cutTracePoints.value[i * TRACE_POINTS + k]!.set(a, w));
  });
  const defined = material as THREE.MeshStandardMaterial & { defines: Record<string, unknown> };
  if (Number(defined.defines.CUT_TRACES) !== bounds.length) {
    defined.defines = { ...defined.defines, CUT_TRACES: bounds.length };
    material.needsUpdate = true;
  }
}

/** `at`, moved as the drawn surface's nearest corner moves when the deformed shape is on. */
export function displacedAt(draw: StressDraw, at: Vec3): Vec3 {
  if (draw.scale === 0 || draw.displacement.length !== draw.positions.length) return at;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < draw.positions.length; i += 3) {
    const d = (draw.positions[i]! - at[0]) ** 2 + (draw.positions[i + 1]! - at[1]) ** 2 + (draw.positions[i + 2]! - at[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return at;
  return [
    at[0] + draw.displacement[best]! * draw.scale,
    at[1] + draw.displacement[best + 1]! * draw.scale,
    at[2] + draw.displacement[best + 2]! * draw.scale,
  ];
}

export function polylinePairs(xyz: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 5 < xyz.length; i += 3) out.push(xyz[i]!, xyz[i + 1]!, xyz[i + 2]!, xyz[i + 3]!, xyz[i + 4]!, xyz[i + 5]!);
  return out;
}

export function knobEvent(ev: PointerEvent, phase: EdgeKnobEvent["phase"]): EdgeKnobEvent {
  return { phase, x: ev.clientX, y: ev.clientY, alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey };
}

export function aspectDescription(aspect: HandleAspect): string {
  const axis = aspect.color === "x" ? "X" : aspect.color === "y" ? "Y" : aspect.color === "z" ? "Z" : "";
  const named = aspect.tip.replace(/ mm$/, " millimetres").replace(/°$/, " degrees").replace(/×$/, " times");
  const sentence = named.replace(/(\s)(\d)/, ", $2");
  const along = axis ? `lights the edges along ${axis}` : "lights the matching part";
  return `${sentence}, ${along}`;
}

export function writeAspectDescription(aspect: HandleAspect | null) {
  let node = document.getElementById("modelAspectDesc");
  if (!node) {
    node = document.createElement("span");
    node.id = "modelAspectDesc";
    node.className = "sr-only";
    document.getElementById("modelPanel")?.append(node);
  }
  node.textContent = aspect ? aspectDescription(aspect) : "";
}

export function darkenHex(color: number, factor: number): number {
  const scale = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * factor)));
  return (scale((color >> 16) & 255) << 16) | (scale((color >> 8) & 255) << 8) | scale(color & 255);
}

export function fieldOf(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLInputElement) {
    const id = target.id || target.dataset.field || "";
    return id || null;
  }
  return target.dataset.field || null;
}

export function holeOf(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLElement) || target.dataset.holeIndex == null || target.dataset.holeIndex === "") return null;
  const index = Number(target.dataset.holeIndex);
  return Number.isInteger(index) ? index : null;
}

export function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)}`;
}


/** R = Rz·Ry·Rx for degrees, the order the kernel turns a primitive. */
export function turnQuaternion(turn: Vec3 | undefined): THREE.Quaternion {
  if (!turn) return new THREE.Quaternion();
  const rad = Math.PI / 180;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(turn[0] * rad, turn[1] * rad, turn[2] * rad, "ZYX"));
}
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const abx = bx - ax;
  const aby = by - ay;
  const length2 = abx * abx + aby * aby;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / length2));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
