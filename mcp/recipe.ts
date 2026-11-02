/**
 * recipe_run's host (docs/plan-recipes.md): builds a recipe with lust and runs it over protocol v1.
 *
 * A recipe is a short Rust program written against crates/lime-recipe. The host writes it into a warm slot (a crate
 * directory whose session the lust daemon keeps), builds it with `lust build --sandbox --json`, applies lust's `auto`
 * fix edits when asked and builds again, then runs the program: one start line on stdin, then one call per line from
 * the recipe and one reply per line back, until `done`. The calls themselves are the caller's (`RecipeCall`): the
 * session sends each through the same path as the MCP tool of that name.
 *
 * Nothing here knows the plate. Rollback and commit belong to the caller, which sees every call.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { workspaceRoot } from "./workspace.ts";

/**
 * The MCP tools a recipe may call (S4). Each goes to the function its tool uses. `log` and `data` (recipe data by name,
 * R-A) are the host's own.
 */
export const RECIPE_TOOLS: ReadonlySet<string> = new Set([
  "solid_new", "model_describe", "faces_find", "edges_find", "surface_at", "model_probe", "model_apply", "model_apply_batch",
  "model_check", "model_history", "measure", "model_place", "object_place", "log", "data",
]);

export interface RecipeLimits {
  /** Wall time for the run, kernel time included. */
  timeoutS: number;
  maxCalls: number;
  /** Longest line the recipe may write, in bytes. */
  maxLineBytes: number;
}

export const DEFAULT_LIMITS: RecipeLimits = { timeoutS: 30, maxCalls: 2000, maxLineBytes: 1 << 20 };

/** One lust diagnostic, as `lust build --json` writes it, with the span's line in the recipe. */
export interface RecipeDiagnostic {
  code: string;
  message: string;
  line: number;
  col: number;
  fix: string;
  /** Byte edits in the recipe source; `auto` ones are safe to apply without review. */
  edits: { start: number; end: number; replacement: string; auto: boolean }[];
  /** True when the diagnostic is in lime-recipe, not the recipe. */
  inCrate?: boolean;
}

export interface BuildResult {
  ok: boolean;
  diagnostics: RecipeDiagnostic[];
  /** The source that was built: the input with every applied `auto` edit. */
  source: string;
  /** How many rounds of `auto` edits were applied. */
  fixRounds: number;
  exe?: string;
  ms: number;
  reason?: string;
}

/** A call the recipe made, as the caller sees it. */
export interface RecipeCallSite {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  line: number;
}

/**
 * The caller's answer: the tool's result, or a refusal sentence (with any hint fields to pass on). `halt` ends the run
 * after this call without a failure (a partial dry run's step limit, I23): the recipe gets no reply and is stopped.
 */
export type RecipeReply = { ok: true; result: unknown; halt?: string } | { ok: false; error: string; extra?: Record<string, unknown> };

export type RecipeCall = (call: RecipeCallSite) => Promise<RecipeReply>;

export interface RunOutcome {
  ok: boolean;
  /** `done` was reached: the object the recipe named and its metrics. */
  done?: { object: string; metrics: Record<string, unknown> };
  calls: number;
  /** The refused calls, with the recipe line of each. */
  refused: { id: number; tool: string; line: number; reason: string }[];
  /** Why the run failed, when it did. */
  reason?: string;
  /** The recipe line the failure points at: a panic's, or the last refused call's. */
  line?: number;
  /** The caller halted the run after a call (RecipeReply.halt): why, and that call's id and recipe line. */
  halted?: { reason: string; id: number; line: number };
  exitCode?: number | null;
  stderr: string;
  ms: number;
}

const SLOTS = 4;
const MAX_FIX_ROUNDS = 3;
/** A build that runs longer than this is stuck: a cold one takes about half a second. */
const BUILD_LIMIT_MS = 120_000;

/**
 * Where lust is looked for, in order: LIME_LUST, the copy the installers ship beside the server (`lust/bin/lust` next
 * to server.mjs, tools/lust/stage.sh; it finds its tcc and library from its own path), then `lust` on PATH.
 */
export function lustCandidates(moduleUrl?: string): string[] {
  const bundled = moduleUrl ? join(fileURLToPath(new URL("./lust/bin/", moduleUrl)), process.platform === "win32" ? "lust.exe" : "lust") : undefined;
  return [process.env.LIME_LUST, bundled && existsSync(bundled) ? bundled : undefined, "lust"].filter((c): c is string => typeof c === "string" && c !== "");
}

/** The first of `lustCandidates` that answers `--version`, or null. */
export function findLust(moduleUrl?: string): string | null {
  for (const c of lustCandidates(moduleUrl)) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0) return c;
  }
  return null;
}

/** The text with CRLF and lone CR line ends made LF. */
export function lfOnly(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** A panic line, rustc's form: `thread 'main' (123) panicked at path:line:col:` then the message. */
function panicOf(stderr: string): { line: number; message: string } | null {
  // Windows writes `src\\main.rs` and CRLF line ends.
  const m = /panicked at ([^\r\n]*?):(\d+):(\d+):\r?\n([^\r\n]*)/.exec(stderr);
  return m ? { line: Number(m[2]), message: m[4]! } : null;
}

/**
 * The lime-recipe crate: LIME_RECIPE_CRATE, else the copy beside the installed bundle (`lime-recipe/` next to
 * server.mjs, which tools/mcp/bundle.mjs writes), else the repo's `crates/lime-recipe`.
 */
export function recipeCrateDir(moduleUrl: string): string {
  const named = process.env.LIME_RECIPE_CRATE;
  if (named) return named;
  const beside = fileURLToPath(new URL("./lime-recipe/", moduleUrl));
  if (existsSync(join(beside, "src", "lib.rs"))) return beside;
  return join(fileURLToPath(new URL("..", moduleUrl)), "crates", "lime-recipe");
}

export class RecipeHost {
  readonly root: string;
  private readonly crateDir: string;
  private lust: string | null | undefined;
  private readonly moduleUrl: string | undefined;
  /** Recipe names in use order, most recent last, and the slot each holds. */
  private slotOrder: string[] = [];
  private readonly slotOf = new Map<string, number>();

  /** `moduleUrl` is the server's own URL, where the bundled lust is looked for (`findLust`). */
  constructor(opts: { crateDir: string; root?: string; lust?: string | null; moduleUrl?: string }) {
    this.crateDir = opts.crateDir;
    this.root = opts.root ?? join(tmpdir(), `lime-recipes-${process.pid}`);
    this.lust = opts.lust;
    this.moduleUrl = opts.moduleUrl;
  }

  /** Whether recipes can run here, and why not. */
  available(): { ok: true; lust: string } | { ok: false; reason: string } {
    if (this.lust === undefined) this.lust = findLust(this.moduleUrl);
    if (this.lust === null) {
      const why = process.platform === "darwin" ? " lust does not build on macOS yet, so the macOS app does not ship it." : "";
      return { ok: false, reason: `Recipes need lust, which is not installed here.${why} Set LIME_LUST to the lust binary, or put lust on PATH.` };
    }
    if (!existsSync(join(this.crateDir, "src", "lib.rs"))) return { ok: false, reason: `The lime-recipe crate is missing (${this.crateDir}).` };
    return { ok: true, lust: this.lust };
  }

  /**
   * The crate's copy beside the slots, with a manifest of only name, version, and edition: lust reads that shape
   * without `cargo metadata`, and the copy keeps the repo's workspace out of the slot's.
   */
  private crateCopy(): string {
    const dir = join(this.root, "lime-recipe");
    const lib = readFileSync(join(this.crateDir, "src", "lib.rs"), "utf8");
    mkdirSync(join(dir, "src"), { recursive: true });
    const libPath = join(dir, "src", "lib.rs");
    if (!existsSync(libPath) || readFileSync(libPath, "utf8") !== lib) writeFileSync(libPath, lib);
    const manifest = '[package]\nname = "lime-recipe"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\n\n[workspace]\n';
    const manPath = join(dir, "Cargo.toml");
    if (!existsSync(manPath) || readFileSync(manPath, "utf8") !== manifest) writeFileSync(manPath, manifest);
    return dir;
  }

  /**
   * The slot a recipe name builds in: the one it had while it is among the last SLOTS names used, else the least
   * recently used one. A slot keeps its warm lust session, so a recipe built again, or a new one in a reused slot,
   * compiles only itself.
   */
  private slotFor(name: string): string {
    let index = this.slotOf.get(name);
    if (index === undefined) {
      const taken = new Set(this.slotOf.values());
      index = [...Array(SLOTS).keys()].find((i) => !taken.has(i));
      if (index === undefined) {
        const oldest = this.slotOrder.shift()!;
        index = this.slotOf.get(oldest)!;
        this.slotOf.delete(oldest);
      }
      this.slotOf.set(name, index);
    }
    this.slotOrder = this.slotOrder.filter((n) => n !== name).concat(name);
    const dir = join(this.root, `slot-${index}`);
    mkdirSync(join(dir, "src"), { recursive: true });
    const manifest = `[package]\nname = "recipe-slot-${index}"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nlime-recipe = { path = "../lime-recipe" }\n\n[workspace]\n`;
    const manPath = join(dir, "Cargo.toml");
    if (!existsSync(manPath) || readFileSync(manPath, "utf8") !== manifest) writeFileSync(manPath, manifest);
    return dir;
  }

  private lustEnv(): NodeJS.ProcessEnv {
    // One daemon for every slot: its socket path is fixed under the root, not the current directory.
    return { ...process.env, LUST_DAEMON_SOCKET: join(this.root, "lust.sock"), LUST_CACHE_DIR: join(this.root, "cache") };
  }

  /** Builds `source` in its slot. With `autofix`, applies lust's `auto` edits and builds again, up to three rounds. */
  async build(name: string, source: string, autofix: boolean): Promise<BuildResult> {
    const started = Date.now();
    // lust's fix edits are byte offsets in LF text: a CRLF recipe (a Windows checkout, a pasted file) would take them
    // at the wrong place.
    source = lfOnly(source);
    const avail = this.available();
    if (!avail.ok) return { ok: false, diagnostics: [], source, fixRounds: 0, ms: 0, reason: avail.reason };
    mkdirSync(this.root, { recursive: true });
    this.crateCopy();
    const slot = this.slotFor(name);
    const main = join(slot, "src", "main.rs");
    const exe = join(slot, process.platform === "win32" ? "recipe.exe" : "recipe");
    let current = source;
    for (let round = 0; ; round += 1) {
      writeFileSync(main, current);
      const r = await run(avail.lust, ["build", "--sandbox", "--json", main, "--manifest-path", join(slot, "Cargo.toml"), "-o", exe], this.lustEnv());
      const diagnostics = parseDiagnostics(r.stdout, main);
      if (r.code === 0) return { ok: true, diagnostics, source: current, fixRounds: round, exe, ms: Date.now() - started };
      if (diagnostics.length === 0) {
        return { ok: false, diagnostics, source: current, fixRounds: round, ms: Date.now() - started, reason: `lust failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}` };
      }
      const fixed = autofix && round < MAX_FIX_ROUNDS ? applyAutoEdits(current, diagnostics) : null;
      if (fixed === null || fixed === current) return { ok: false, diagnostics, source: current, fixRounds: round, ms: Date.now() - started };
      current = fixed;
    }
  }

  /**
   * Runs a built recipe: the start line, then each call through `call`, until `done`, an exit, or a limit. The
   * program runs with an empty environment (SystemRoot only on Windows, which a process needs to start).
   */
  run(exe: string, start: Record<string, unknown>, call: RecipeCall, limits: RecipeLimits = DEFAULT_LIMITS, signal?: AbortSignal): Promise<RunOutcome> {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(exe, [], { cwd: this.root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const refused: RunOutcome["refused"] = [];
    let calls = 0;
    let stderr = "";
    let buffer = "";
    let failure: { reason: string; line?: number } | null = null;
    let halted: RunOutcome["halted"];
    let done: RunOutcome["done"];
    let queue: Promise<void> = Promise.resolve();
    return new Promise((resolve) => {
      const finish = (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const panic = panicOf(stderr);
        const lastRefused = refused[refused.length - 1];
        let reason = failure?.reason ?? halted?.reason;
        let line = failure?.line ?? halted?.line;
        if (!reason && !done) {
          if (panic) {
            reason = `The recipe panicked at line ${panic.line}: ${panic.message}`;
            line = panic.line;
          } else if (/error\[L0532\]/.test(stderr)) {
            reason = stderr.trim().split("\n").find((l) => l.includes("L0532")) ?? "The sandbox stopped the recipe.";
          } else {
            reason = `The recipe ended without done (exit ${code}).`;
          }
          if (line === undefined && lastRefused) line = lastRefused.line;
        }
        resolve({ ok: !reason && !!done, ...(done ? { done } : {}), calls, refused, ...(reason ? { reason } : {}), ...(line !== undefined ? { line } : {}), ...(halted && !failure ? { halted } : {}), exitCode: code, stderr: stderr.slice(-4000), ms: Date.now() - started });
      };
      const stop = (reason: string, line?: number) => {
        if (!failure) failure = { reason, ...(line !== undefined ? { line } : {}) };
        child.kill();
      };
      const timer = setTimeout(() => stop(`The recipe ran past its ${limits.timeoutS} s limit and was stopped.`), limits.timeoutS * 1000);
      const onAbort = () => stop("The recipe was cancelled.");
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => stop(`The recipe could not start: ${err.message}`));
      child.on("close", (code) => void queue.then(() => finish(code)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 64_000) stderr += chunk;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > limits.maxLineBytes && !buffer.includes("\n")) stop(`A recipe line passed ${limits.maxLineBytes} bytes.`);
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          queue = queue.then(() => handle(line));
        }
      });
      const reply = (text: string) => {
        if (!child.stdin.destroyed) child.stdin.write(`${text}\n`);
      };
      const handle = async (line: string): Promise<void> => {
        if (failure || halted || done || line.trim() === "") return;
        if (Buffer.byteLength(line) > limits.maxLineBytes) return stop(`A recipe line passed ${limits.maxLineBytes} bytes.`);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return stop(`The recipe wrote a line that is not JSON: ${line.slice(0, 120)}`);
        }
        if (msg.done && typeof msg.done === "object") {
          const d = msg.done as Record<string, unknown>;
          done = { object: typeof d.object === "string" ? d.object : "", metrics: (d.metrics && typeof d.metrics === "object" ? d.metrics : {}) as Record<string, unknown> };
          child.stdin.end();
          return;
        }
        const id = typeof msg.id === "number" ? msg.id : -1;
        const tool = typeof msg.call === "string" ? msg.call : "";
        const at = (msg.at && typeof msg.at === "object" ? msg.at : {}) as { line?: unknown };
        const site: RecipeCallSite = { id, tool, args: (msg.args && typeof msg.args === "object" ? msg.args : {}) as Record<string, unknown>, line: typeof at.line === "number" ? at.line : 0 };
        calls += 1;
        if (calls > limits.maxCalls) return stop(`The recipe made more than ${limits.maxCalls} calls and was stopped.`, site.line);
        let answer: RecipeReply;
        if (!RECIPE_TOOLS.has(tool)) {
          answer = { ok: false, error: `${tool || "(no call)"} is not a recipe call. A recipe may call: ${[...RECIPE_TOOLS].join(", ")}.` };
        } else {
          try {
            answer = await call(site);
          } catch (err) {
            answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        if (failure) return;
        if (answer.ok && answer.halt) {
          halted = { reason: answer.halt, id, line: site.line };
          child.kill();
          return;
        }
        if (answer.ok) {
          reply(JSON.stringify({ id, ok: true, result: answer.result ?? null }));
        } else {
          refused.push({ id, tool, line: site.line, reason: answer.error });
          reply(JSON.stringify({ ...(answer.extra ?? {}), id, ok: false, error: answer.error }));
        }
      };
      child.stdin.on("error", () => {});
      reply(JSON.stringify({ v: 1, ...start }));
    });
  }

  /** The slot directories that exist, for tests. */
  slots(): string[] {
    return existsSync(this.root) ? readdirSync(this.root).filter((n) => n.startsWith("slot-")) : [];
  }
}

/**
 * One lust command. It ends at the process's exit, not when its pipes close: on Windows the daemon lust starts can
 * inherit them and keep them open. Output still in flight gets a moment to arrive. A command past `limitMs` is killed.
 */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, limitMs = BUILD_LIMIT_MS): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null, note = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, stdout, stderr: stderr + note });
    };
    const limit = setTimeout(() => {
      child.kill();
      finish(null, `\nlust ${args[0] ?? ""} did not finish within ${limitMs / 1000} s and was stopped.`);
    }, limitMs);
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", (err) => finish(-1, err.message));
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => setTimeout(() => finish(code), 200));
  });
}

/** Recipe data as a run read it: the parsed value, its file's size and SHA-256. */
export interface RecipeData {
  sha256: string;
  bytes: number;
  value: unknown;
}

/** The largest recipe source or data file read from the workspace. */
const RECIPE_FILE_MAX_BYTES = 4 * 1024 * 1024;
const DATA_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/** A regular file under `root`, by its real path, or null when it is missing or leaves the root. */
function fileUnder(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return null;
  }
  const back = relative(root, real);
  if (back === "" || back.startsWith("..") || isAbsolute(back)) return null;
  return statSync(real).isFile() ? real : null;
}

/** --- R-A. A recipe's source from a `.rs` file in the MCP workspace, so a rerun after an edit sends only the path. */
export function recipeSourceFile(path: string): { text: string; stem: string; path: string } | { reason: string } {
  const root = workspaceRoot();
  if (!root) return { reason: "path reads a .rs file in LIME_MCP_WORKSPACE, which this server does not have. Pass source instead." };
  if (!path.toLowerCase().endsWith(".rs") || path.includes("\0")) return { reason: "path names a .rs file in the workspace." };
  const real = fileUnder(root, path);
  if (!real) return { reason: `There is no ${path} in the workspace (${root}).` };
  if (statSync(real).size > RECIPE_FILE_MAX_BYTES) return { reason: `${path} is larger than ${RECIPE_FILE_MAX_BYTES / (1024 * 1024)} MB.` };
  return { text: readFileSync(real, "utf8"), stem: basename(real, extname(real)), path };
}

/** A CSV as rows of cells: numbers where a cell reads as one, else text. A file of one column is one list. */
export function parseCsv(text: string): unknown[] {
  const rows = lfOnly(text).split("\n").filter((line) => line.trim() !== "").map((line) => line.split(",").map((cell) => {
    const trimmed = cell.trim();
    const n = Number(trimmed);
    return trimmed !== "" && Number.isFinite(n) ? n : trimmed;
  }));
  return rows.every((row) => row.length === 1) ? rows.map((row) => row[0]) : rows;
}

/**
 * --- R-A. Recipe data by name: `<name>.json` or `<name>.csv` (or the name with its extension) in the MCP workspace.
 * The host reads it, so the recipe stays without files (S13). Null when there is no such file.
 */
export function recipeDataFile(name: string): RecipeData | { reason: string } | null {
  if (!DATA_NAME.test(name) || name.split("/").includes("..")) return { reason: `${name || "(no name)"} is not a data name: letters, digits, _ . - and / between parts.` };
  const root = workspaceRoot();
  if (!root) return { reason: "Recipe data is read from LIME_MCP_WORKSPACE, which this server does not have." };
  const lower = name.toLowerCase();
  const tries = lower.endsWith(".json") || lower.endsWith(".csv") ? [name] : [`${name}.json`, `${name}.csv`];
  for (const rel of tries) {
    const real = fileUnder(root, rel);
    if (!real) continue;
    const bytes = readFileSync(real);
    if (bytes.byteLength > RECIPE_FILE_MAX_BYTES) return { reason: `${rel} is larger than ${RECIPE_FILE_MAX_BYTES / (1024 * 1024)} MB.` };
    const text = bytes.toString("utf8");
    let value: unknown;
    if (rel.toLowerCase().endsWith(".csv")) value = parseCsv(text);
    else {
      try {
        value = JSON.parse(text);
      } catch (err) {
        return { reason: `${rel} is not JSON: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, value };
  }
  return null;
}

/** The refusal for a data name with no file: the names the workspace has, at most 20. */
export function recipeDataMissing(name: string): string {
  const root = workspaceRoot();
  const names: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (names.length >= 20) return;
      if (entry.isDirectory() && depth < 2) walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
      else if (entry.isFile() && /\.(json|csv)$/i.test(entry.name) && !/\.lime(machine|profile)\.json$/i.test(entry.name)) names.push(`${prefix}${entry.name.replace(/\.(json|csv)$/i, "")}`);
    }
  };
  if (root) walk(root, "", 0);
  return `No recipe data is named ${name}: write ${name}.json or ${name}.csv into the workspace${root ? ` (${root})` : ""}.${names.length ? ` It has: ${names.join(", ")}.` : ""}`;
}

/** lust's `--json` lines, the diagnostics of the recipe file first. */
export function parseDiagnostics(stdout: string, mainPath: string): RecipeDiagnostic[] {
  const out: RecipeDiagnostic[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.kind !== "diagnostic" || d.severity !== "error") continue;
    const span = (d.span ?? {}) as Record<string, number>;
    const inCrate = typeof d.file === "string" && d.file !== mainPath && !d.file.endsWith("main.rs");
    out.push({
      code: String(d.code ?? ""),
      message: String(d.message ?? ""),
      line: span.line ?? 0,
      col: span.col ?? 0,
      fix: String(d.fix ?? ""),
      edits: inCrate ? [] : ((d.edits ?? []) as RecipeDiagnostic["edits"]),
      ...(inCrate ? { inCrate: true } : {}),
    });
  }
  return out.sort((a, b) => Number(!!a.inCrate) - Number(!!b.inCrate));
}

/** `source` with every `auto` edit applied (byte offsets, last first, each span once). Null when there are none. */
export function applyAutoEdits(source: string, diagnostics: RecipeDiagnostic[]): string | null {
  const edits = diagnostics.flatMap((d) => d.edits.filter((e) => e.auto));
  if (edits.length === 0) return null;
  const seen = new Set<string>();
  const unique = edits.filter((e) => {
    const key = `${e.start}:${e.end}:${e.replacement}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.start - a.start || b.end - a.end);
  let bytes = Buffer.from(source, "utf8");
  for (const e of unique) {
    if (e.start < 0 || e.end > bytes.length || e.start > e.end) return null;
    bytes = Buffer.concat([bytes.subarray(0, e.start), Buffer.from(e.replacement, "utf8"), bytes.subarray(e.end)]);
  }
  return bytes.toString("utf8");
}
