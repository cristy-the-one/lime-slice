/** A saved loft's `drawing`, read from a project file. Apart from ./loft.ts so a project reads without the loft's code. */
import type { LoftDrawing, Vec3 } from "../model-tree.ts";
import { readSketch, type SketchData } from "./model.ts";

/**
 * Optional `drawing` on a saved loft. Undefined when it is absent or unreadable, so the loft
 * still opens and an older file is unchanged.
 */
export function readLoftDrawing(value: unknown): LoftDrawing | undefined {
  if (!isRecord(value)) return undefined;
  const drawing: LoftDrawing = {};
  if (value.sketches !== undefined) {
    if (!Array.isArray(value.sketches)) return undefined;
    const sketches: (SketchData | null)[] = [];
    for (const raw of value.sketches) {
      if (raw === null) {
        sketches.push(null);
        continue;
      }
      const sketch = readSketch(raw);
      if (!sketch) return undefined;
      sketches.push(sketch);
    }
    drawing.sketches = sketches;
  }
  if (value.sweep !== undefined) {
    if (!isRecord(value.sweep)) return undefined;
    const profile = readSketch(value.sweep.profile);
    const pathSketch = value.sweep.pathSketch === undefined ? undefined : readSketch(value.sweep.pathSketch);
    if (!profile || (value.sweep.pathSketch !== undefined && !pathSketch)) return undefined;
    if (!Array.isArray(value.sweep.path) || value.sweep.path.length < 2) return undefined;
    const path: Vec3[] = [];
    for (const raw of value.sweep.path) {
      const point = vec(raw);
      if (!point) return undefined;
      path.push(point);
    }
    const scale = readScale(value.sweep.scale, path.length);
    if (!scale) return undefined;
    let edges: number[] | undefined;
    if (value.sweep.edges !== undefined) {
      if (!Array.isArray(value.sweep.edges) || value.sweep.edges.some((edge) => typeof edge !== "number" || !Number.isInteger(edge) || edge < 0)) return undefined;
      edges = [...value.sweep.edges];
    }
    drawing.sweep = { profile, path, scale, ...(value.sweep.scaleAtEnd === true ? { scaleAtEnd: true as const } : {}), ...(pathSketch ? { pathSketch } : {}), ...(edges && edges.length > 0 ? { edges } : {}) };
  }
  if (!drawing.sketches && !drawing.sweep) return undefined;
  return drawing;
}

function readScale(value: unknown, count: number): number | number[] | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (!Array.isArray(value) || value.length !== count) return null;
  if (!value.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)) return null;
  return [...value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function vec(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = value[0];
  const y = value[1];
  const z = value[2];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}
