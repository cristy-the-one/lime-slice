/**
 * Strict recipe runs (7.4.0), one rule for the MCP (`mcp/session/recipe.ts`) and the window
 * (`./apply.ts`, `./rebuild.ts`, `./app-nested.ts`). A refused queued step the recipe never
 * reads fails the run. `//! strict: false` opts out for this release.
 */

/** One note on a run that opts out of strict. Accepted through 7.4; removed in 7.5.0. */
export const STRICT_OPT_OUT_NOTE = "//! strict: false is accepted through 7.4 and removed in 7.5.0: read or handle each queued step's result instead.";

/**
 * `//! strict: false` on its own line. Whitespace before the marker, and around the colon
 * and the value, is ignored.
 */
export const STRICT_OPT_OUT_RE = /^\s*\/\/!\s*strict:\s*false\s*$/m;

/** True when `source` opts out of strict. `//! strict: true`, and no header, stay strict. */
export function isStrictOptOut(source: string): boolean {
  return STRICT_OPT_OUT_RE.test(source);
}

/** A queued step the recipe never read. `line` is the recipe's line; `tool` is the host's call. */
export interface UnreadQueuedStep {
  line: number;
  tool: string;
  reason: string;
}

/** The sentence a strict run fails with. The same words on the MCP and in the window. */
export function unreadQueuedReason(row: UnreadQueuedStep): string {
  return `A queued step was refused and the recipe never read it: line ${row.line} ${row.tool} (${row.reason}).`;
}

/** The per-step note a window run keeps when it opts out. */
export function unreadQueuedNote(row: Pick<UnreadQueuedStep, "line" | "reason">): string {
  return `line ${row.line}: apply_later was refused (${row.reason}); s.flush(&part) reports these.`;
}

/**
 * Apply the rule to `notes` (mutated, capped at 200 as the hosts cap every note list).
 * An opt-out adds one note, then today's per-step notes, and the run may keep what it built.
 * Otherwise the first unread refusal is the run's failure, and `notes` are left as they were.
 */
export function strictQueueFailure(source: string, dropped: readonly UnreadQueuedStep[], notes: string[]): string | null {
  if (isStrictOptOut(source)) {
    if (!notes.includes(STRICT_OPT_OUT_NOTE) && notes.length < 200) notes.push(STRICT_OPT_OUT_NOTE);
    for (const row of dropped) if (notes.length < 200) notes.push(unreadQueuedNote(row));
    return null;
  }
  return dropped.length ? unreadQueuedReason(dropped[0]!) : null;
}
