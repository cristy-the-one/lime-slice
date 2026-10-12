/**
 * What a drop on the window does. See docs/plate-distinct-objects.md, "Drop, separate change".
 * A plain drop replaces the plate with the first file. Shift adds every file, in order, only when a mesh is already there.
 */

export type FileDropPlan =
  | { kind: "replace"; index: number }
  | { kind: "add"; indexes: number[] };

/** A `.lime` project is not a mesh object. Open owns it. */
export function isLimeProject(name: string): boolean {
  return /\.lime$/i.test(name);
}

/**
 * `names` is the drop order. An empty plate ignores Shift and still replaces with the first file.
 * Shift on a loaded plate hands every name to Add, which refuses a `.lime`.
 */
export function planFileDrop(shiftKey: boolean, plateHasMesh: boolean, names: readonly string[]): FileDropPlan | null {
  if (names.length === 0) return null;
  if (shiftKey && plateHasMesh) return { kind: "add", indexes: names.map((_, index) => index) };
  return { kind: "replace", index: 0 };
}
