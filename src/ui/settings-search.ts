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
