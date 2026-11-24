/**
 * Organic surfaces: the Model view asks the kernel for its fine display mesh, in the same reply as the plate mesh.
 *
 * Contract: a tree request with the top-level field `meshQuality: "display"` gets the reply it always got, its
 * `positions` and all the data describing that mesh exactly main's plate-quality mesh, plus a `display` object with the
 * fine mesh for drawing (src/model-reply.ts decodes it). Without the field there is no `display`. An older kernel
 * ignores the field.
 *
 * So the plate, slices, exports, saves, Stress, Auto ribs and every check read `positions`, as before; only the viewport
 * draws `display`. The field is added where a request is built for the view (`viewRequest`); a request whose reply only
 * feeds the plate or an export is built without it.
 */

/** >>> KERNEL WIRE FIELD: the request field, and the value that asks for the display mesh. <<< */
export const DISPLAY_MESH_FIELD = ["meshQuality", "display"] as const;

/** Tree calls whose reply carries a mesh, or per-vertex data that must match the mesh drawn (`surfaceInspect`). */
export const MESH_CALLS: ReadonlySet<string> = new Set(["open", "apply", "edit", "goto", "probe", "surfaceInspect"]);

/** A request built for the Model view: a mesh call asks for the display mesh too. Any other call is sent as it is. */
export function viewRequest<T extends Record<string, unknown>>(payload: T): T {
  if (!MESH_CALLS.has(String(payload.call)) || DISPLAY_MESH_FIELD[0] in payload) return payload;
  return { ...payload, [DISPLAY_MESH_FIELD[0]]: DISPLAY_MESH_FIELD[1] };
}

/** True when a request asks for the display mesh. */
export function asksDisplay(request: Record<string, unknown>): boolean {
  return request[DISPLAY_MESH_FIELD[0]] === DISPLAY_MESH_FIELD[1];
}
