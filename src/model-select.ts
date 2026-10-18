/** Face and edge selection for Model mode. Pure, so the gestures can be tested without WebGL. */
import { isFeatureTool } from "./model-features.ts";

export interface ModelPickRef {
  kind: "face" | "edge";
  index: number;
}

const IDLE = 0x5c6750;
const IDLE_LIFT = 0x7d8870;

export function samePick(a: ModelPickRef, b: ModelPickRef): boolean {
  return a.kind === b.kind && a.index === b.index;
}

/** A click replaces the selection. Shift-click toggles one entity. A miss clears. */
export function nextModelPicks(picks: readonly ModelPickRef[], hit: ModelPickRef | null, shift: boolean): ModelPickRef[] {
  if (!hit) return [];
  const at = picks.findIndex((pick) => samePick(pick, hit));
  if (!shift) return [hit];
  if (at >= 0) return picks.filter((_, index) => index !== at);
  return [...picks, hit];
}

export function selectionCountLabel(picks: readonly ModelPickRef[]): string {
  let faces = 0;
  let edges = 0;
  for (const pick of picks) {
    if (pick.kind === "face") faces += 1;
    else edges += 1;
  }
  const parts: string[] = [];
  if (faces) parts.push(faces === 1 ? "1 face" : `${faces} faces`);
  if (edges) parts.push(edges === 1 ? "1 edge" : `${edges} edges`);
  return parts.join(" · ");
}

/** The last selected edge. The blend size handle sits on this one; Apply still uses every edge. */
export function lastEdge(picks: readonly ModelPickRef[]): number | null {
  for (let i = picks.length - 1; i >= 0; i -= 1) {
    const pick = picks[i];
    if (pick?.kind === "edge") return pick.index;
  }
  return null;
}

export function modelApplyReady(
  tool: string,
  picks: readonly ModelPickRef[],
  scale: number,
  splitOk = true,
  probeOk = true,
): boolean {
  if (tool === "fillet" || tool === "chamfer") return lastEdge(picks) != null && probeOk;
  if (tool === "scale") return scale > 0 && Math.abs(scale - 1) > 1e-9;
  if (tool === "split") return splitOk;
  if (tool === "create") return true;
  // --- A3 composite features: Apply waits on the same dry-run as a hole. ---
  if (isFeatureTool(tool)) return probeOk;
  // --- end A3 ---
  return (tool === "boolean" || tool === "hole") && probeOk;
}

export function mixHex(from: number, to: number, t: number): number {
  const channel = (shift: number) => {
    const a = (from >> shift) & 255;
    const b = (to >> shift) & 255;
    return Math.max(0, Math.min(255, Math.round(a + (b - a) * t)));
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/** Selected faces are the accent. Hover is a light mix of that accent. The rest stay a dim neutral. */
export function faceColor(index: number, selected: boolean, hovered: boolean, accent: number): number {
  if (selected) return accent;
  const wobble = (Math.abs(index) * 17) % 7;
  const idle = mixHex(IDLE, IDLE_LIFT, wobble / 6);
  return hovered ? mixHex(idle, accent, 0.4) : idle;
}

/**
 * Boundary segments of each face, as x,y,z pairs. A triangle edge used twice inside one face is the
 * diagonal of the tessellation, so it is left out of the outline.
 */
export function faceBoundarySegments(positions: ArrayLike<number>, triangles: ArrayLike<number>): Map<number, number[]> {
  const pending = new Map<number, Map<string, number[]>>();
  for (let tri = 0; tri < triangles.length; tri += 1) {
    const face = triangles[tri] ?? 0;
    let bag = pending.get(face);
    if (!bag) {
      bag = new Map();
      pending.set(face, bag);
    }
    const base = tri * 9;
    const verts: number[][] = [];
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = base + vertex * 3;
      verts.push([positions[offset] ?? 0, positions[offset + 1] ?? 0, positions[offset + 2] ?? 0]);
    }
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
      const key = edgeKey(verts[i]!, verts[j]!);
      if (bag.has(key)) bag.delete(key);
      else bag.set(key, [...verts[i]!, ...verts[j]!]);
    }
  }
  const out = new Map<number, number[]>();
  for (const [face, bag] of pending) {
    const flat: number[] = [];
    for (const segment of bag.values()) flat.push(...segment);
    if (flat.length > 0) out.set(face, flat);
  }
  return out;
}

function edgeKey(a: number[], b: number[]): string {
  const left = `${q(a[0]!)},${q(a[1]!)},${q(a[2]!)}`;
  const right = `${q(b[0]!)},${q(b[1]!)},${q(b[2]!)}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function q(value: number): number {
  return Math.round(value * 1e3) / 1e3;
}
