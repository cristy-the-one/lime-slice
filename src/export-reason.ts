/**
 * Why an Export command cannot run. Kept separate from the scope and writers so the File menu,
 * the palette and the key can show the reason without loading the dialog.
 */
export type ExportCommandId = "export-model" | "export-part" | "export-assembly" | "export-plate";

export interface ExportAvailability {
  objects: number;
  selectedId: string | null;
  assemblies: number;
}

/** The reason an Export command cannot run, or null when it can. The entry stays visible either way. */
export function exportCommandReason(id: ExportCommandId, plate: ExportAvailability): string | null {
  if (plate.objects === 0) return "The plate is empty.";
  if (id === "export-part" && !plate.selectedId) return "Select a part to export.";
  if (id === "export-assembly" && plate.assemblies === 0) return "There is no assembly to export.";
  return null;
}
