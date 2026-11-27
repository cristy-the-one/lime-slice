/**
 * Strict recipe runs (7.4.0), one rule for the MCP (`mcp/session/recipe.ts`) and the window
 * (`./apply.ts`, `./rebuild.ts`, `./app-nested.ts`). A refused queued step the recipe never
 * reads fails the run. `//! strict: false` no longer opts out: a source that carries it runs
 * strict like every other, and the run gets one note saying so.
 */

/** One note on a run of a source that carries `//! strict: false`. The opt-out was removed after 7.5.1. */
export const STRICT_FALSE_REMOVED_NOTE = "//! strict: false was removed after 7.5.1: this run is strict. Read or handle each queued step's result.";

/**
 * `//! strict: false` on its own line. Whitespace before the marker, and around the colon
 * and the value, is ignored.
 */
export const STRICT_FALSE_RE = /^\s*\/\/!\s*strict:\s*false\s*$/m;

/** True when `source` carries the removed `//! strict: false` line. `//! strict: true`, and no header, add no note. */
export function hasStrictFalse(source: string): boolean {
  return STRICT_FALSE_RE.test(source);
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

/**
 * Apply the rule to `notes` (mutated, capped at 200 as the hosts cap every note list).
 * A source that carries `//! strict: false` adds the one removal note, once. Every run is strict:
 * the first unread refusal is the run's failure.
 */
export function strictQueueFailure(source: string, dropped: readonly UnreadQueuedStep[], notes: string[]): string | null {
  if (hasStrictFalse(source) && !notes.includes(STRICT_FALSE_REMOVED_NOTE) && notes.length < 200) notes.push(STRICT_FALSE_REMOVED_NOTE);
  return dropped.length ? unreadQueuedReason(dropped[0]!) : null;
}
