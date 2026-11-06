/**
 * A solid as a project file names it: Open CASCADE's binary format (`brep`), told by its first bytes, or STEP. Kept apart
 * from ./model-request.ts (which re-exports it) so saving a project, which loads with the app, does not load Model's requests.
 */

/** The first bytes of a solid the engine wrote in `brep`. A STEP file starts with `ISO-10303-21`. */
const BREP_MAGIC = [0x4c, 0x49, 0x4d, 0x45, 0x42, 0x52, 0x45, 0x50, 0x20]; // "LIMEBREP "

/**
 * Whether `bytes` are a solid the engine wrote in Open CASCADE's binary format, rather than a STEP file: such a solid
 * reads back as the step it was written from exactly, so an edit can build on it at once.
 */
export function isBrep(bytes: ArrayBuffer | Uint8Array | undefined | null): boolean {
  if (!bytes) return false;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.byteLength > BREP_MAGIC.length && BREP_MAGIC.every((byte, i) => view[i] === byte);
}

/** The name a project gives an object's solid: its file's stem, `.brep` for the binary format, else `.step`. */
export function solidFileName(name: string, bytes: ArrayBuffer | Uint8Array): string {
  const stem = name.replace(/\.(step|stp|stl|3mf|brep)$/i, "");
  return `${stem || "solid"}.${isBrep(bytes) ? "brep" : "step"}`;
}
