/** Face and edge selection for Model mode. Pure, so the gestures can be tested without WebGL. */
import { isFeatureTool } from "./model-features.ts";
import { isRepeatTool } from "./model-repeat.ts";

export interface ModelPickRef {
  kind: "face" | "edge";
  index: number;
}


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

/** The faded selection chip: the count, and a caret because it opens the actions. */
export function selectionChipLabel(picks: readonly ModelPickRef[]): string {
  const count = selectionCountLabel(picks);
  return count ? `${count} ▾` : "Selection ▾";
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
  // --- A4. Pattern and mirror wait on the same dry-run. A refusal leaves the group unbuilt, so Apply stays off. ---
  if (isRepeatTool(tool)) return probeOk;
  // --- A2 shell: a closed void needs no face. Apply waits on the dry-run, as a hole does. ---
  if (tool === "shell") return probeOk;
  return (tool === "boolean" || tool === "hole") && probeOk;
}

/** The Shell panel's count of faces that will be removed. A closed shell ignores the picks. */
export function shellFacesLabel(count: number, closed: boolean): string {
  if (closed) return "Closed inside.";
  if (count <= 0) return "No face open.";
  return count === 1 ? "1 face open" : `${count} faces open`;
}

export function mixHex(from: number, to: number, t: number): number {
  const channel = (shift: number) => {
    const a = (from >> shift) & 255;
    const b = (to >> shift) & 255;
    return Math.max(0, Math.min(255, Math.round(a + (b - a) * t)));
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
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

/** The outline of each face of one mesh, as [`faceBoundarySegments`] gives it. */
export interface FaceOutlines {
  get(face: number): number[] | undefined;
}

const outlines = new WeakMap<object, { triangles: ArrayLike<number>; faces: FaceOutlines }>();

const trianglesByFace = new WeakMap<object, Map<number, number[]>>();

/**
 * Each face's triangles, lowest first, read once per `triangles` array (a mesh's is replaced, never written in place)
 * and kept with it: an outline and a hover each want one face's triangles, not a walk over all of them.
 */
export function faceTriangles(triangles: ArrayLike<number>): ReadonlyMap<number, readonly number[]> {
  const key = triangles as unknown as object;
  let ofFace = trianglesByFace.get(key);
  if (ofFace) return ofFace;
  ofFace = new Map();
  for (let tri = 0; tri < triangles.length; tri += 1) {
    const at = triangles[tri] ?? 0;
    const bag = ofFace.get(at);
    if (bag) bag.push(tri);
    else ofFace.set(at, [tri]);
  }
  trianglesByFace.set(key, ofFace);
  return ofFace;
}

/**
 * [`faceBoundarySegments`], one face at a time: a face's outline is worked out when it is first read and kept with
 * the mesh. Only a selected or hovered face is ever read, so a part with thousands of faces no longer pays for all
 * of them each time it is shown, and a mesh shown again (undo, redo, a step of the history) pays nothing.
 */
export function faceOutlines(positions: ArrayLike<number>, triangles: ArrayLike<number>): FaceOutlines {
  const key = positions as unknown as object;
  const kept = outlines.get(key);
  if (kept && kept.triangles === triangles) return kept.faces;
  const done = new Map<number, number[] | undefined>();
  const faces: FaceOutlines = {
    get(face) {
      if (done.has(face)) return done.get(face);
      const tris = faceTriangles(triangles).get(face);
      let flat: number[] | undefined;
      if (tris) {
        // The same walk as `faceBoundarySegments`, over this face's triangles in their order in the mesh.
        const bag = new Map<string, number[]>();
        for (const tri of tris) {
          const base = tri * 9;
          const verts: number[][] = [];
          for (let vertex = 0; vertex < 3; vertex += 1) {
            const offset = base + vertex * 3;
            verts.push([positions[offset] ?? 0, positions[offset + 1] ?? 0, positions[offset + 2] ?? 0]);
          }
          for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
            const edge = edgeKey(verts[i]!, verts[j]!);
            if (bag.has(edge)) bag.delete(edge);
            else bag.set(edge, [...verts[i]!, ...verts[j]!]);
          }
        }
        const out: number[] = [];
        for (const segment of bag.values()) out.push(...segment);
        if (out.length > 0) flat = out;
      }
      done.set(face, flat);
      return flat;
    },
  };
  outlines.set(key, { triangles, faces });
  return faces;
}
