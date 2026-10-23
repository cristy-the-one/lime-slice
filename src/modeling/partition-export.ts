/**
 * Split to print, export (docs/plan-split-connectors.md, D12 and section 10): what each piece is called in a file, and
 * the note every export carries. Pure; the MCP server and the card write the files.
 *
 * The pins of a dowelled cut are milestone 5. They become one more name after the last piece, `<source>-pins`, written
 * by the same exports.
 */

/** The export note (section 10): the resin slicer adds supports, and the cut faces carry the fit and the number. */
export const SUPPORT_NOTE = "Keep supports off the cut faces. They carry the fit and the part number.";

/** A file stem from a part's or a file's name: no folder, no extension, nothing a file name cannot hold. */
export function exportStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const bare = base.replace(/\.(stl|3mf|step|stp|obj|lime)$/i, "");
  const safe = bare.replace(/[<>:"|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return safe || "part";
}

/** Each piece's name in assembly order, piece 1 first: `cover-1`, `cover-2`, … */
export function pieceNames(source: string, count: number): string[] {
  const stem = exportStem(source);
  return Array.from({ length: Math.max(0, count) }, (_, at) => `${stem}-${at + 1}`);
}
