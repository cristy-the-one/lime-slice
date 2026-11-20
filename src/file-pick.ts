/** What File > Open and Add to plate do with several files. Loaded with the pick, not with the app. */
import { isLimeProject } from "./file-drop.ts";

/** What a pick of one or more files does: the file that replaces the plate, the files Add puts beside it, and the projects left out. */
export interface FilePickPlan {
  replace: number | null;
  add: number[];
  skipped: number[];
}

/**
 * `names` is the picker's order. File > Open replaces the plate with one file and adds the rest: a project when one was
 * picked (only the first), else the first mesh. Add on a loaded plate adds every mesh. Add on an empty plate works like
 * Open, so the first mesh becomes the plate. A project is never added, only opened: every other one is skipped.
 */
export function planFilePick(mode: "open" | "add", plateHasMesh: boolean, names: readonly string[]): FilePickPlan | null {
  if (names.length === 0) return null;
  const indexes = names.map((_, index) => index);
  const meshes = indexes.filter((index) => !isLimeProject(names[index]!));
  const projects = indexes.filter((index) => isLimeProject(names[index]!));
  if (mode === "add" && plateHasMesh) return { replace: null, add: meshes, skipped: projects };
  const replace = mode === "open" && projects.length > 0 ? projects[0]! : (meshes[0] ?? null);
  return {
    replace,
    add: meshes.filter((index) => index !== replace),
    skipped: projects.filter((index) => index !== replace),
  };
}
