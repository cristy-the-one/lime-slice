/**
 * --- Recipe data a plugin carries (docs/plan-recipe-plugins.md, "Plugins carry the recipe data they read"). A recipe
 * reads workspace data with `data {name}` (R-A); a kept plugin carries what its run read inside its one file (O2), the
 * way it carries its ingredients (I11), so it runs the same from the library, in the window, and on another machine.
 *
 * The data sits at the end of the body, after the code (and after its `mod ingredients`), under one fence line, one
 * plain `//` comment line per name:
 *
 *     // --- recipe data: Lime Slice answers data {name} from the lines below; edit the workspace file, not these ---
 *     // data: skull/outline sha256:<64 hex> bytes:<n> <the value as one line of JSON>
 *
 * Plain comments keep the file a valid main.rs. They are part of the body, so the body's hash (the plugin's
 * `source-sha256`, the project's key for its copy, the stamp on a step) covers the data too: the same code with other
 * data is another version. The host builds only the code above the fence. `sha256` and `bytes` are the workspace file's
 * as the run read it (a CSV keeps its own hash; the line holds the parsed value). Browser-safe: no file system.
 */
import type { AppRunEnv } from "./app-calls.ts";

/** The fence line between a plugin's code and the data it carries. */
export const DATA_FENCE = "// --- recipe data: Lime Slice answers data {name} from the lines below; edit the workspace file, not these ---";

/** The most one name's data line may hold, as kept: the workspace file limit of `data {name}` (4 MB). */
export const CARRIED_DATA_MAX_BYTES = 4 * 1024 * 1024;
/** The most all of a plugin's data lines may hold together: the app lists library files up to 16 MB (`plugins.rs`). */
export const CARRIED_DATA_TOTAL_MAX_BYTES = 12 * 1024 * 1024;

const LINE = /^\/\/ data: (\S+) sha256:([0-9a-f]{64}) bytes:(\d+) (.*)$/;

/** Recipe data as a run read it: the parsed value, and its file's size and SHA-256. */
export interface CarriedData {
  sha256: string;
  bytes: number;
  value: unknown;
}

/** One carried name without its value: what `nugget get` and the panel's plugin page list. */
export interface CarriedDataRow {
  name: string;
  sha256: string;
  bytes: number;
}

function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Where the data block starts: the index of the last fence line's first character, or -1. */
function fenceAt(text: string): number {
  const at = text.lastIndexOf(`\n${DATA_FENCE}\n`);
  if (at >= 0) return at + 1;
  if (text.startsWith(`${DATA_FENCE}\n`)) return 0;
  return text.endsWith(`\n${DATA_FENCE}`) ? text.length - DATA_FENCE.length : -1;
}

/**
 * A plugin body split into the code the host builds and the data it carries. A body with no fence is all code. A data
 * line that does not read (hand-edited) is a `problem` sentence, and its name is left out.
 */
export function splitPluginData(body: string): { code: string; data: Record<string, CarriedData>; problem?: string } {
  const text = lf(body);
  const at = fenceAt(text);
  if (at < 0) return { code: text, data: {} };
  const code = text.slice(0, at).replace(/\n+$/, "\n");
  const data: Record<string, CarriedData> = {};
  let problem: string | undefined;
  for (const line of text.slice(at + DATA_FENCE.length).split("\n")) {
    if (line.trim() === "") continue;
    const m = LINE.exec(line);
    let value: unknown;
    try {
      value = m ? JSON.parse(m[4]!) : undefined;
    } catch {
      value = undefined;
    }
    if (!m || value === undefined) {
      problem ??= `A line of this plugin's recipe data does not read: ${line.slice(0, 60)}… Keep the plugin again over MCP to write its data afresh.`;
      continue;
    }
    data[m[1]!] = { sha256: m[2]!, bytes: Number(m[3]), value };
  }
  return { code: code === "\n" ? "" : code, data, ...(problem ? { problem } : {}) };
}

/** The names a body carries, with size and hash, read without parsing the values (a cheap listing). */
export function carriedData(body: string): CarriedDataRow[] {
  const text = lf(body);
  const at = fenceAt(text);
  if (at < 0) return [];
  const out: CarriedDataRow[] = [];
  for (const line of text.slice(at + DATA_FENCE.length).split("\n")) {
    const m = /^\/\/ data: (\S+) sha256:([0-9a-f]{64}) bytes:(\d+) /.exec(line);
    if (m) out.push({ name: m[1]!, sha256: m[2]!, bytes: Number(m[3]) });
  }
  return out;
}

/** The one line a name is kept as. */
function dataLine(name: string, row: CarriedData): string {
  return `// data: ${name} sha256:${row.sha256} bytes:${Math.max(0, Math.floor(row.bytes))} ${JSON.stringify(row.value)}`;
}

/**
 * The refusal for data a plugin cannot carry: a name that is not one token, a value with no JSON form, or a line over
 * CARRIED_DATA_MAX_BYTES. Null when all of it fits.
 */
export function carriedDataProblem(data: Record<string, CarriedData>): string | null {
  let total = 0;
  for (const [name, row] of Object.entries(data)) {
    if (!name || /\s/.test(name)) return `The recipe data name "${name}" has a space in it, so a plugin cannot carry it.`;
    const json = JSON.stringify(row.value);
    if (json === undefined) return `The recipe data ${name} has no JSON form, so a plugin cannot carry it.`;
    const size = new TextEncoder().encode(json).byteLength;
    if (size > CARRIED_DATA_MAX_BYTES) {
      return `The recipe data ${name} is ${(size / (1024 * 1024)).toFixed(1)} MB as kept, over the ${CARRIED_DATA_MAX_BYTES / (1024 * 1024)} MB a plugin carries per name; keep a smaller file (fewer points, a larger chordMm, or resample), then keep the plugin again.`;
    }
    total += size;
  }
  if (total > CARRIED_DATA_TOTAL_MAX_BYTES) {
    return `The recipe data this plugin reads is ${(total / (1024 * 1024)).toFixed(1)} MB together, over the ${CARRIED_DATA_TOTAL_MAX_BYTES / (1024 * 1024)} MB a plugin carries; read fewer or smaller files, then keep it again.`;
  }
  return null;
}

/**
 * The body with `data` carried after the code, names in order; any data the body carried before is replaced. With no
 * data the code comes back as it is, so a plugin that reads none keeps the hash it always had.
 */
export function withPluginData(body: string, data: Record<string, CarriedData>): string {
  const { code } = splitPluginData(body);
  const names = Object.keys(data).sort();
  if (names.length === 0) return code;
  const head = code.replace(/\n+$/, "");
  return `${head ? `${head}\n\n` : ""}${DATA_FENCE}\n${names.map((name) => dataLine(name, data[name]!)).join("\n")}\n`;
}

/** The text to show a person: each carried value replaced by its size, so a source view stays readable. */
export function elideData(text: string): string {
  const lfText = lf(text);
  const at = fenceAt(lfText);
  if (at < 0) return lfText;
  const rest = lfText.slice(at + DATA_FENCE.length).replace(/^(\/\/ data: \S+ sha256:[0-9a-f]{64} bytes:(\d+)) .*$/gm, (_all, head: string) => `${head} (value not shown)`);
  return `${lfText.slice(0, at)}${DATA_FENCE}${rest}`;
}

/** `skull/outline (12 KB)`: a carried name and its size for a sentence. */
export function dataSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The run's window with a kept plugin's carried data (version 1 and up; a draft, version 0, carries none and keeps the
 * draft's refusal). The step's own kept data (`env.data`) is still read first.
 */
export function carriedEnv(env: AppRunEnv, version: number, data: Record<string, CarriedData>): AppRunEnv {
  if (version <= 0) return env;
  return { ...env, carried: { ...data, ...(env.carried ?? {}) } };
}

/** The window's refusal for a name neither the step nor the plugin carries. */
export function dataMissingInApp(name: string): string {
  return `This plugin reads recipe data ${name || "(no name)"}, which was not kept with it. Over MCP, carry it from the workspace with nugget {action:"save", kind:"plugin", id, data:["${name}"]}, or run it once with keep.`;
}
