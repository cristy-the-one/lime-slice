/**
 * recipe_run's host (docs/plan-recipes.md): builds a recipe with lust and runs it over protocol v1.
 *
 * A recipe is a short Rust program written against crates/lime-recipe. The host writes it into a warm slot (a crate
 * directory whose session the lust daemon keeps), builds it with `lust build --sandbox --json`, applies lust's `auto`
 * fix edits when asked and builds again, then runs the program: one start line on stdin, then one call per line from
 * the recipe and one reply per line back, until `done`. The calls themselves are the caller's (`RecipeCall`): the
 * session sends each through the same path as the MCP tool of that name.
 *
 * The protocol itself is `src/recipe/host.ts`, which the app shares (docs/plan-recipe-plugins.md D16); this file is the
 * Node side of it: slots, lust, child processes, and the workspace's recipe files and data.
 *
 * Nothing here knows the plate. Rollback and commit belong to the caller, which sees every call.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRecipe, DEFAULT_LIMITS, lfOnly, runRecipe, type BuildResult, type RecipeCall, type RecipeLimits, type RecipeSpawn, type RunOutcome } from "../src/recipe/host.ts";
import { workspaceRoot } from "./workspace.ts";
import { refuse } from "./refusals.ts";

export { applyAutoEdits, buildRecipe, DEFAULT_LIMITS, lfOnly, parseDiagnostics, RECIPE_TOOLS, runRecipe } from "../src/recipe/host.ts";
export type { BuildResult, RecipeCall, RecipeCallSite, RecipeDiagnostic, RecipeLimits, RecipeReply, RunOutcome } from "../src/recipe/host.ts";

const SLOTS = 4;
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
      return refuse("recipe-unavailable", `Recipes need lust, which is not installed here.${why} Set LIME_LUST to the lust binary, or put lust on PATH.`);
    }
    if (!existsSync(join(this.crateDir, "src", "lib.rs"))) return refuse("recipe-unavailable", `The lime-recipe crate is missing (${this.crateDir}).`);
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

  /**
   * Builds `source` in its slot. With `autofix`, applies lust's `auto` edits and builds again, up to three rounds.
   * `suffix` (the recipe's ingredients, I10) is built after the source on lines of its own; lust's edits never reach
   * it, and `source` in the result is the recipe without it. `limitMs` stops one lust build that runs longer (D11.3: an
   * imported plugin's build is held to 30 s).
   */
  async build(name: string, source: string, autofix: boolean, suffix = "", limitMs = BUILD_LIMIT_MS): Promise<BuildResult> {
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
    return buildRecipe(async (text) => {
      writeFileSync(main, text);
      const r = await run(avail.lust, ["build", "--sandbox", "--json", main, "--manifest-path", join(slot, "Cargo.toml"), "-o", exe], this.lustEnv(), limitMs);
      return { ...r, exe, main };
    }, source, autofix, suffix);
  }

  /**
   * Runs a built recipe: the start line, then each call through `call`, until `done`, an exit, or a limit. The
   * program runs with an empty environment (SystemRoot only on Windows, which a process needs to start).
   */
  run(exe: string, start: Record<string, unknown>, call: RecipeCall, limits: RecipeLimits = DEFAULT_LIMITS, signal?: AbortSignal): Promise<RunOutcome> {
    return runRecipe(nodeSpawn(exe, this.root), start, call, limits, signal);
  }

  /** The slot directories that exist, for tests. */
  slots(): string[] {
    return existsSync(this.root) ? readdirSync(this.root).filter((n) => n.startsWith("slot-")) : [];
  }
}

/**
 * A built recipe as a Node child process, with an empty environment (SystemRoot only on Windows, which a process needs
 * to start). The run ends at `close`, when its output has been read.
 */
export function nodeSpawn(exe: string, cwd: string): RecipeSpawn {
  return (events) => {
    const env: NodeJS.ProcessEnv = process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(exe, [], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.on("error", (err) => events.error(err.message));
    child.on("close", (code) => events.exit(code));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => events.stderr(chunk));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => events.stdout(chunk));
    child.stdin.on("error", () => {});
    return {
      write: (line) => {
        if (!child.stdin.destroyed) child.stdin.write(`${line}\n`);
      },
      closeInput: () => child.stdin.end(),
      kill: () => child.kill(),
    };
  };
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

/**
 * Writes recipe data: `<name>.json` in the MCP workspace (parent folders made), through a temporary file and a rename.
 * The same names and limit as `data {name}` reads. The reply is its path in the workspace, size, and SHA-256.
 */
export function writeRecipeData(name: string, value: unknown): { path: string; bytes: number; sha256: string } | { reason: string } {
  const bare = name.toLowerCase().endsWith(".json") ? name.slice(0, -5) : name;
  if (!DATA_NAME.test(bare) || bare.split("/").includes("..") || bare.toLowerCase().endsWith(".csv")) return { reason: `${name || "(no name)"} is not a data name: letters, digits, _ . - and / between parts.` };
  const root = workspaceRoot();
  if (!root) return { reason: "Recipe data is written to LIME_MCP_WORKSPACE, which this server does not have." };
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > RECIPE_FILE_MAX_BYTES) return { reason: `This answer is ${Math.round(bytes / 1024)} KB, over the ${RECIPE_FILE_MAX_BYTES / (1024 * 1024)} MB a recipe can read. Cut fewer planes, pass resample, or a larger chordMm.` };
  const rel = `${bare}.json`;
  const full = resolve(root, rel);
  const back = relative(root, full);
  if (back.startsWith("..") || isAbsolute(back)) return { reason: `${name} leaves the workspace.` };
  mkdirSync(dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, full);
  return { path: rel, bytes, sha256: createHash("sha256").update(text).digest("hex") };
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
