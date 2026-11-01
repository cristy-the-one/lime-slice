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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The MCP tools a recipe may call (S4). Each goes to the function its tool uses. `log` is the host's own. */
export const RECIPE_TOOLS: ReadonlySet<string> = new Set([
  "solid_new", "model_describe", "faces_find", "edges_find", "surface_at", "model_probe", "model_apply", "model_apply_batch",
  "model_check", "model_history", "measure", "log",
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

/** The caller's answer: the tool's result, or a refusal sentence (with any hint fields to pass on). */
export type RecipeReply = { ok: true; result: unknown } | { ok: false; error: string; extra?: Record<string, unknown> };

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
  exitCode?: number | null;
  stderr: string;
  ms: number;
}

const SLOTS = 4;
const MAX_FIX_ROUNDS = 3;

/** The lust binary: LIME_LUST, else `lust` on PATH. Null when neither answers `--version`. */
export function findLust(): string | null {
  const candidates = [process.env.LIME_LUST, "lust"].filter((c): c is string => typeof c === "string" && c !== "");
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0) return c;
  }
  return null;
}

/** A panic line, rustc's form: `thread 'main' (123) panicked at path:line:col:` then the message. */
function panicOf(stderr: string): { line: number; message: string } | null {
  const m = /panicked at ([^\n]*?):(\d+):(\d+):\n([^\n]*)/.exec(stderr);
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
  /** Recipe names in use order, most recent last, and the slot each holds. */
  private slotOrder: string[] = [];
  private readonly slotOf = new Map<string, number>();

  constructor(opts: { crateDir: string; root?: string; lust?: string | null }) {
    this.crateDir = opts.crateDir;
    this.root = opts.root ?? join(tmpdir(), `lime-recipes-${process.pid}`);
    this.lust = opts.lust;
  }

  /** Whether recipes can run here, and why not. */
  available(): { ok: true; lust: string } | { ok: false; reason: string } {
    if (this.lust === undefined) this.lust = findLust();
    if (this.lust === null) return { ok: false, reason: "Recipes need lust, which is not installed here. Set LIME_LUST to the lust binary, or put lust on PATH." };
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
    let done: RunOutcome["done"];
    let queue: Promise<void> = Promise.resolve();
    return new Promise((resolve) => {
      const finish = (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const panic = panicOf(stderr);
        const lastRefused = refused[refused.length - 1];
        let reason = failure?.reason;
        let line = failure?.line;
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
        resolve({ ok: !reason && !!done, ...(done ? { done } : {}), calls, refused, ...(reason ? { reason } : {}), ...(line !== undefined ? { line } : {}), exitCode: code, stderr: stderr.slice(-4000), ms: Date.now() - started });
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
        if (failure || done || line.trim() === "") return;
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

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
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
