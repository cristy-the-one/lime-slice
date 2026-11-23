/**
 * Organic surfaces: which kernel mesh quality a request asks for, decided in one place.
 *
 * The kernel is making a finer tessellation angle and analytic normals opt-in for the Model DISPLAY mesh only; its
 * default stays main's old mesh. The owner's rule: anything committed to the plate, sliced or exported keeps the old
 * (default) mesh. So only the Model view's display asks for the fine one, and every other purpose sends nothing.
 *
 * The wire field's name is not known yet. Until the kernel PR lands, DISPLAY_MESH_FIELD is null and no request
 * changes. Turning it on is one edit here (the field and its value), plus the commit-time default-quality request
 * described at `displayMeshIsPlateMesh`.
 */

/** What a mesh is for. Only "display" may ask for the fine mesh. */
export type MeshPurpose = "display" | "plate" | "export" | "slice";

/**
 * >>> KERNEL WIRE FIELD: the request field that asks the kernel for the fine display mesh, and its value. <<<
 * null: not wired yet, nothing is sent. Set both when the kernel PR names them (e.g. `["meshQuality", "display"]`).
 */
export const DISPLAY_MESH_FIELD: readonly [name: string, value: unknown] | null = null;

/** Tree calls whose reply carries a mesh. */
const MESH_CALLS: ReadonlySet<string> = new Set(["open", "apply", "edit", "goto", "probe"]);

/** The extra request fields for a mesh made for `purpose`: the display field for "display" once wired, else none. */
export function meshQualityFor(purpose: MeshPurpose, field: readonly [string, unknown] | null = DISPLAY_MESH_FIELD): Record<string, unknown> {
  if (purpose !== "display" || !field) return {};
  return { [field[0]]: field[1] };
}

/**
 * `payload` with the mesh quality for `purpose` when it is a call that answers a mesh. A payload that already names
 * the field keeps its own value. Returns `payload` itself when nothing is added.
 */
export function withMeshQuality<T extends Record<string, unknown>>(payload: T, purpose: MeshPurpose, field: readonly [string, unknown] | null = DISPLAY_MESH_FIELD): T {
  if (!MESH_CALLS.has(String(payload.call)) || !field || field[0] in payload) return payload;
  const extra = meshQualityFor(purpose, field);
  return Object.keys(extra).length === 0 ? payload : { ...payload, ...extra };
}

/**
 * True while the display mesh IS the plate mesh (the field is not wired): Model's commit may then put the shown
 * solid's mesh on the plate, as it always has (`meshOf` in src/app/model/commit.ts). Once the field is wired this is
 * false, and the commit must take the node's mesh from a request without the field (a `goto` of that node at the
 * plate's chord, purpose "plate"), never the shown solid's positions.
 */
export function displayMeshIsPlateMesh(field: readonly [string, unknown] | null = DISPLAY_MESH_FIELD): boolean {
  return field === null;
}
