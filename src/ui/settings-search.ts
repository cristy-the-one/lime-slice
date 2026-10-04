/** Extra words for the settings filter. The visible label is matched on its own. */
export const SETTING_KEYWORDS: Record<string, string> = {
  lh: "quality resolution thickness",
  adaptive: "variable layer height",
  amin: "variable layer",
  amax: "variable layer",
  seam: "rear aligned nearest start",
  scarf: "seam joint",
  scarflen: "seam",
  scarfsteps: "seam",
  supports: "overhang brace",
  sstyle: "tree grid organic",
  sangle: "overhang",
  gyroid3d: "infill lattice",
  partScale: "placement size percent",
  nozzle: "printer line width",
  bedx: "printer volume",
  bedy: "printer volume",
  bedz: "printer volume",
  feeds: "speed feature",
  zhop: "travel lift",
};

/**
 * Every word in `query` must sit in the label or the keywords.
 * An empty query matches everything.
 */
export function settingMatches(query: string, label: string, keywords = ""): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${label} ${keywords}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}
