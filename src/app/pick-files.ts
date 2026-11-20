/** Several picked files at once. Imported when files are picked, so the app's first chunk does not carry it. */
import { planFilePick } from "../file-pick.ts";
import { pushToast } from "../ui/toasts.ts";
import { addMeshBytes, plateHasMesh } from "./files.ts";
import { openPickedFile } from "./project-io.ts";
import { state } from "./state.ts";

/**
 * Several files from File > Open or Add to plate, in the picker's order (`planFilePick`). One replaces the plate, the
 * rest go through Add one at a time. When the replace is cancelled at the unsaved-changes prompt or its file cannot be
 * read, nothing is added: the adds were meant for the new plate.
 */
export async function openPickedFiles(files: readonly File[], mode: "open" | "add") {
  const plan = planFilePick(mode, plateHasMesh(), files.map((file) => file.name));
  if (!plan) return;
  const skipped = plan.skipped.map((index) => files[index]!.name);
  if (skipped.length > 0) {
    const said = skipped.join(", ");
    pushToast(mode === "add" ? `${said} is a project: open it from the File menu.` : `One project opens at a time, so ${said} was left out.`, "info");
  }
  if (plan.replace != null) {
    const before = state.plate;
    await openPickedFile(files[plan.replace]!);
    if (state.plate === before || !plateHasMesh()) return;
  }
  for (const index of plan.add) {
    const file = files[index]!;
    await addMeshBytes(file.name, await file.arrayBuffer());
  }
}
