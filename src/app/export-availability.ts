/**
 * Whether Export can run right now. The File menu, the palette and the key all ask here,
 * and a command that cannot run stays on screen with this reason.
 */
import { assemblyOf, readAssemblies } from "../assembly.ts";
import { exportCommandReason, type ExportCommandId } from "../export-scope.ts";
import { session, state } from "./state.ts";

export function plateExportFacts() {
  const assemblies = session.assemblies.length === 0 ? session.assemblies : readAssemblies(session.assemblies, state.plate.objects);
  const selectedId = state.plate.selectedId;
  const memberOf = selectedId ? assemblyOf(assemblies, selectedId)?.id ?? null : null;
  return { objects: state.plate.objects.length, selectedId, assemblies: assemblies.length, memberOf };
}

export function modelExportReason(id: string): string | null {
  if (id !== "export-model" && id !== "export-part" && id !== "export-assembly" && id !== "export-plate") return null;
  return exportCommandReason(id as ExportCommandId, plateExportFacts());
}
