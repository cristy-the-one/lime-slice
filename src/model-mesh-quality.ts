/**
 * Organic surfaces: which kernel mesh a Model request asks for, decided in one place.
 *
 * Contract (kernel PR #823): the top-level request field `meshQuality: "display"` asks for the fine display mesh, with
 * a `normals` field (nine per triangle); absent, the reply is the plate-quality mesh (main's). An older kernel ignores
 * the field. The owner's rule: anything committed to the plate, sliced, exported or saved keeps the plate mesh.
 *
 * The structure (one list, so no path is missed):
 * - Every Model tree call that answers a mesh (`MESH_CALLS`) goes out through `requestFor`, which adds the display field
 *   unless the request is marked `meshPurpose: "plate"` (the mark is stripped before sending). So the view asks for
 *   the fine mesh by default, and a path whose reply goes to the plate opts out by name.
 * - A reply to a display request that carries `normals` (the kernel's display mesh always does) is marked
 *   (`DISPLAY_REPLY` on the body, `displayMesh` on the decoded solid), and the plate boundary never takes a marked
 *   solid: it asks the same node again with `meshPurpose: "plate"` (src/app/model/plate-mesh.ts). A reply without
 *   normals is the default mesh (a kernel that ignores the field), so the plate takes it as it is, with no second ask.
 */

/** What a mesh is for. Only "display" asks for the fine mesh. */
export type MeshPurpose = "display" | "plate";

/** >>> KERNEL WIRE FIELD (kernel PR #823): the request field, and the value that asks for the display mesh. <<< */
export const DISPLAY_MESH_FIELD = ["meshQuality", "display"] as const;

/** The request mark a plate path sets; `requestFor` strips it and sends no display field. */
export const PURPOSE_KEY = "meshPurpose";

/** The client-side mark on a reply body that answered a display request (never sent to the kernel). */
export const DISPLAY_REPLY = "displayMesh";

/** Tree calls whose reply carries a mesh, or per-vertex data that must match the mesh shown (`surfaceInspect`). */
export const MESH_CALLS: ReadonlySet<string> = new Set(["open", "apply", "edit", "goto", "probe", "surfaceInspect"]);

/** The extra request fields for `purpose`: the display field for "display", else none. */
export function meshQualityFor(purpose: MeshPurpose): Record<string, unknown> {
  return purpose === "display" ? { [DISPLAY_MESH_FIELD[0]]: DISPLAY_MESH_FIELD[1] } : {};
}

/** A plate path's request: the mark that keeps the display field off. */
export function plateRequest<T extends Record<string, unknown>>(payload: T): T {
  return { ...payload, [PURPOSE_KEY]: "plate" };
}

/**
 * What goes on the wire for `payload`: a mesh call gets the display field unless it is marked for the plate; the mark
 * itself never goes out. A payload that names the field already keeps it. Returns `payload` itself when nothing changes.
 */
export function requestFor<T extends Record<string, unknown>>(payload: T): T {
  const purpose: MeshPurpose = payload[PURPOSE_KEY] === "plate" ? "plate" : "display";
  let out: Record<string, unknown> = payload;
  if (PURPOSE_KEY in out) {
    const { [PURPOSE_KEY]: _mark, ...rest } = out;
    out = rest;
  }
  if (MESH_CALLS.has(String(out.call)) && !(DISPLAY_MESH_FIELD[0] in out)) out = { ...out, ...meshQualityFor(purpose) };
  return out as T;
}

/** True when the request on the wire asks for the display mesh. */
export function asksDisplay(wire: Record<string, unknown>): boolean {
  return wire[DISPLAY_MESH_FIELD[0]] === DISPLAY_MESH_FIELD[1];
}
