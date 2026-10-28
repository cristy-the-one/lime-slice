/**
 * Split to print, export (docs/plan-split-connectors.md, D12 and section 10): what each piece is called in a file, and
 * the note every export carries. Pure; the MCP server and the card write the files.
 *
 * The pins of a dowelled cut (milestone 5) are one more name after the last piece, `<source>-pins`, written by the same
 * exports.
 */

/** The export note (section 10): the resin slicer adds supports, and the cut faces carry the fit and the part number. */
export const SUPPORT_NOTE = "Keep supports off the cut faces. They carry the fit and the part number.";

/** A file stem from a part's or a file's name: no folder, no extension, nothing a file name cannot hold. */
export function exportStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const bare = base.replace(/\.(stl|3mf|step|stp|obj|lime)$/i, "");
  const safe = bare.replace(/[<>:"|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return safe || "part";
}

/**
 * --- Assemblies M9. A plate object's name as a solid's name: its stem, with the number the plate gives a second
 * object of one file kept and the extension before it dropped, so `hook.step 2` is `hook 2`.
 */
export function partStem(name: string): string {
  return exportStem(name.replace(/\.(stl|3mf|step|stp|obj|lime)( \d+)$/i, "$2"));
}

/** Each piece's name in assembly order, piece 1 first: `cover-1`, `cover-2`, …, and `cover-pins` last with `pins`. */
export function pieceNames(source: string, count: number, pins = false): string[] {
  const stem = exportStem(source);
  const names = Array.from({ length: Math.max(0, count) }, (_, at) => `${stem}-${at + 1}`);
  return pins ? [...names, pinsName(source)] : names;
}

/** The pins' name in every export: `<source>-pins`. */
export function pinsName(source: string): string {
  return `${exportStem(source)}-pins`;
}
