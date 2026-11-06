/**
 * Recipe API levels (docs/plan-recipe-plugins.md D12), shared by the MCP server and the app so both refuse a plugin
 * with the same sentence and the same code before anything is built.
 *
 * A host builds against the crate of each major it ships: the current crate, plus the last crate of each earlier major
 * kept beside it (`lime-recipe-<major>/`). A minor only adds, so a plugin builds on its major's crate when that crate's
 * minor is the same or higher. A plugin of a higher major, or of a higher minor than this host's crate of that major,
 * needs a newer Lime Slice; a major this host no longer ships is retired. Browser-safe: no Node.
 */

/** `[major, minor]`. */
export type ApiLevel = readonly [number, number];

/** `major.minor` as numbers, or null. */
export function parseApiLevel(text: string): ApiLevel | null {
  const m = /^(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const apiText = (level: ApiLevel): string => `${level[0]}.${level[1]}`;

/** The refusal codes an API check answers with (mcp/refusals.ts). */
export type ApiRefusalCode = "plugin-unsupported" | "plugin-api-retired" | "plugin-invalid";

export type ApiVerdict = { ok: true; major: number } | { ok: false; code: ApiRefusalCode; reason: string };

/**
 * Whether a plugin recording `wanted` builds on a host whose crates are `crates` (one level per shipped major, in any
 * order; the highest is the current one), and against which major. Nothing is built to find out.
 */
export function apiVerdict(wanted: string, crates: readonly ApiLevel[]): ApiVerdict {
  const level = parseApiLevel(wanted);
  if (!level) return { ok: false, code: "plugin-invalid", reason: `This plugin names recipe API "${wanted}", which is not a level like 1.1.` };
  const current = [...crates].sort((a, b) => b[0] - a[0] || b[1] - a[1])[0] ?? ([1, 0] as ApiLevel);
  const same = crates.find((c) => c[0] === level[0]);
  if (level[0] > current[0] || (same && level[1] > same[1])) {
    return { ok: false, code: "plugin-unsupported", reason: newerApiSentence(level, same ?? current) };
  }
  if (!same) return { ok: false, code: "plugin-api-retired", reason: `This plugin was written for recipe API ${level[0]}.x, which this Lime Slice no longer builds. Its parts are kept as built.` };
  return { ok: true, major: level[0] };
}

/** D12's sentence for a plugin that needs a newer recipe API than `have`. */
export function newerApiSentence(wanted: ApiLevel, have: ApiLevel): string {
  return `This plugin needs recipe API ${apiText(wanted)}; this Lime Slice has ${apiText(have)}. Update Lime Slice to run it. Its parts are kept as built.`;
}

/** The recipe API level a crate's `lib.rs` declares (`pub const API: (u32, u32) = (1, 4);`), or null. */
export function crateApiOf(libRs: string): ApiLevel | null {
  const m = /pub const API: \(u32, u32\) = \((\d+), (\d+)\);/.exec(libRs);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
