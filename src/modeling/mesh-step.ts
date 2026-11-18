/**
 * A mesh that a converter wrote as STEP: surface shells of flat faces with straight edges, and no solid. The slicer
 * reads such a file facet by facet (`faceted_surfaces` in `lime-slice-core/src/step.rs`, which this follows name for
 * name). With open edges it holds no solid for Model to edit, and Open CASCADE takes minutes to say so.
 */

const SOLIDS = new Set(["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "FACETED_BREP", "TESSELLATED_SOLID"]);
const CURVES = new Set([
  "CIRCLE", "ELLIPSE", "HYPERBOLA", "PARABOLA", "POLYLINE", "PCURVE", "TRIMMED_CURVE", "COMPOSITE_CURVE",
  "OFFSET_CURVE_3D", "SURFACE_CURVE", "SEAM_CURVE", "INTERSECTION_CURVE",
]);

const QUOTE = 0x27;
const OPEN = 0x28;
const CLOSE = 0x29;
const HASH = 0x23;
const SPACE = 0x20;
const UNDERSCORE = 0x5f;

const upper = (c: number) => c >= 0x41 && c <= 0x5a;
const digit = (c: number) => c >= 0x30 && c <= 0x39;

const seen = new WeakMap<ArrayBuffer, number | null>();

/**
 * The number of edges only one facet uses, when `bytes` is a mesh written as STEP; null for any other file. One pass
 * over the entity names, outside quoted text, kept per buffer.
 */
export function meshStepOpenEdges(bytes: ArrayBuffer): number | null {
  const known = seen.get(bytes);
  if (known !== undefined) return known;
  const found = scan(new Uint8Array(bytes));
  seen.set(bytes, found);
  return found;
}

/** Whether `bytes` is a mesh written as STEP that does not close: nothing for Model to open. */
export function isOpenMeshStep(bytes: ArrayBuffer): boolean {
  return (meshStepOpenEdges(bytes) ?? 0) > 0;
}

function scan(text: Uint8Array): number | null {
  let shells = false;
  let planes = false;
  const uses = new Map<number, number>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === QUOTE) {
      i += 1;
      while (i < n && text[i] !== QUOTE) i += 1;
      i += 1;
      continue;
    }
    if (!upper(c)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < n && (upper(text[i]!) || digit(text[i]!) || text[i] === UNDERSCORE)) i += 1;
    const end = i;
    while (i < n && text[i] === SPACE) i += 1;
    if (text[i] !== OPEN) continue;
    const name = String.fromCharCode(...text.subarray(start, end));
    if (name === "SHELL_BASED_SURFACE_MODEL") shells = true;
    else if (name === "PLANE") planes = true;
    else if (name === "ORIENTED_EDGE") {
      // ORIENTED_EDGE('',*,*,#edge,.T.): the last reference before the bracket closes is the edge it runs.
      let edge = -1;
      let j = i + 1;
      for (; j < n && text[j] !== CLOSE; j += 1) {
        if (text[j] === QUOTE) {
          j += 1;
          while (j < n && text[j] !== QUOTE) j += 1;
        } else if (text[j] === HASH) {
          let id = 0;
          let k = j + 1;
          for (; k < n && digit(text[k]!); k += 1) id = id * 10 + (text[k]! - 0x30);
          if (k > j + 1) edge = id;
          j = k - 1;
        }
      }
      if (edge >= 0) uses.set(edge, (uses.get(edge) ?? 0) + 1);
      i = j;
    } else if (SOLIDS.has(name) || CURVES.has(name) || name.endsWith("_SURFACE") || name.startsWith("SURFACE_OF_") || name.includes("B_SPLINE") || name.includes("BEZIER")) {
      return null;
    }
  }
  if (!shells || !planes) return null;
  let open = 0;
  for (const count of uses.values()) if (count === 1) open += 1;
  return open;
}
