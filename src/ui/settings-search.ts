/**
 * Every word in `query` must sit in the label or the keywords.
 * An empty query matches everything. `&` and `and` are the same word, and
 * `%`, `°`, `/`, and unit marks such as `mm/s` stay part of the token.
 */
export function settingMatches(query: string, label: string, keywords = ""): boolean {
  const words = normalizeSearchText(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalizeSearchText(`${label} ${keywords}`);
  return words.every((word) => hay.includes(word));
}

/** Lower case, with `&` / `&amp;` written as `and`, and the spaces collapsed. */
export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}
