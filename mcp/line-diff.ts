/**
 * A unified diff of two texts by line, for a reply that would otherwise repeat a long source whole (recipe_run's
 * fixedSource). Standard `diff -u` hunks with 3 lines of context, so `patch` or a hand edit applies them; the file
 * header lines are left out because the reader holds one file. An edit is found by trimming the lines the texts share
 * at both ends and aligning the middle by longest common subsequence.
 */

/** Context lines around each change. */
export const DIFF_CONTEXT = 3;
/** The middle (after trimming) may not be larger than this many lines on each side, or the diff gives up. */
const MAX_MIDDLE = 1500;

type Edit = { op: " " | "-" | "+"; text: string };

function edits(a: string[], b: string[]): Edit[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > MAX_MIDDLE || midB.length > MAX_MIDDLE) return null;
  const n = midA.length;
  const m = midB.length;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const out: Edit[] = a.slice(0, start).map((text) => ({ op: " ", text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { out.push({ op: " ", text: midA[i]! }); i += 1; j += 1; }
    else if (i < n && (j >= m || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { out.push({ op: "-", text: midA[i]! }); i += 1; }
    else { out.push({ op: "+", text: midB[j]! }); j += 1; }
  }
  for (const text of a.slice(endA)) out.push({ op: " ", text });
  return out;
}

/** The lines of a text that ends with a newline (or none). */
function linesOf(text: string): string[] {
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * The hunks that turn `before` into `after`, as text (empty when they are equal), or null when the texts differ too
 * much to align cheaply. Both texts are taken as LF text that ends with a newline, as a recipe source is.
 */
export function unifiedDiff(before: string, after: string, context = DIFF_CONTEXT): string | null {
  const all = edits(linesOf(before), linesOf(after));
  if (all === null) return null;
  const hunks: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  // Old and new line numbers at each edit's position.
  const pos = all.map((e) => {
    const here = { o: oldLine, n: newLine };
    if (e.op !== "+") oldLine += 1;
    if (e.op !== "-") newLine += 1;
    return here;
  });
  let at = 0;
  while (at < all.length) {
    while (at < all.length && all[at]!.op === " ") at += 1;
    if (at >= all.length) break;
    const from = Math.max(0, at - context);
    // Extend until more than `context * 2` unchanged lines follow the last change.
    let last = at;
    let end = at;
    while (end < all.length) {
      if (all[end]!.op !== " ") last = end;
      else if (end - last > context * 2) break;
      end += 1;
    }
    const to = Math.min(all.length, last + context + 1);
    const slice = all.slice(from, to);
    const oldCount = slice.filter((e) => e.op !== "+").length;
    const newCount = slice.filter((e) => e.op !== "-").length;
    const first = pos[from]!;
    // diff -u names the line before an empty range.
    const oldStart = oldCount === 0 ? first.o - 1 : first.o;
    const newStart = newCount === 0 ? first.n - 1 : first.n;
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${slice.map((e) => `${e.op}${e.text}`).join("\n")}`);
    at = to;
  }
  return hunks.length ? `${hunks.join("\n")}\n` : "";
}

/** Applies hunks from unifiedDiff to `before`; null if a line does not match. For tests and for callers that check. */
export function applyUnifiedDiff(before: string, diff: string): string | null {
  const src = linesOf(before);
  const out: string[] = [];
  let cursor = 0;
  const rows = linesOf(diff);
  for (let r = 0; r < rows.length; r += 1) {
    const head = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(rows[r]!);
    if (!head) return null;
    const oldStart = Number(head[1]);
    const oldCount = Number(head[2]);
    const target = oldCount === 0 ? oldStart : oldStart - 1;
    if (target < cursor) return null;
    out.push(...src.slice(cursor, target));
    cursor = target;
    while (r + 1 < rows.length && !rows[r + 1]!.startsWith("@@ ")) {
      r += 1;
      const row = rows[r]!;
      const text = row.slice(1);
      if (row[0] === "+") out.push(text);
      else if (src[cursor] !== text) return null;
      else { if (row[0] === " ") out.push(text); cursor += 1; }
    }
  }
  out.push(...src.slice(cursor));
  return out.length ? `${out.join("\n")}\n` : "";
}

/** A fix longer than this many lines or bytes comes back as a diff: about 1,000 tokens, where a few fixes are a dozen lines. */
export const FIXED_DIFF_LINES = 60;
export const FIXED_DIFF_BYTES = 4000;

/**
 * What a recipe_run reply says of the text lust built. A short one is fixedSource, whole. A long one is fixedDiff, a
 * unified diff against the submitted source (line numbers, 3 lines of context), unless full is set or the diff does
 * not reproduce the text, in which case it is fixedSource too.
 */
export function fixedReply(source: string, fixedSource: string, fixRounds: number, full: boolean): Record<string, unknown> {
  const long = linesOf(fixedSource).length > FIXED_DIFF_LINES || Buffer.byteLength(fixedSource) > FIXED_DIFF_BYTES;
  if (long && !full) {
    const diff = unifiedDiff(source, fixedSource);
    if (diff && applyUnifiedDiff(source, diff) === (fixedSource.endsWith("\n") ? fixedSource : `${fixedSource}\n`)) return { fixedDiff: diff, fixedDiffAgainst: "the source you sent, LF line ends", fixRounds };
  }
  return { fixedSource, fixRounds };
}
