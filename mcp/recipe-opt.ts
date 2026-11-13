/**
 * Optimised recipe builds: lust's `--opt=bg` with the zig the installers bundle beside lust (lust-lang docs/opt.md).
 *
 * lust links the fast tcc build for the run at hand and compiles the same sandboxed C with `zig cc -O2` (strict
 * floating point, libm calls kept as calls) in the background; a later build of the same source installs that cached
 * binary. The calls a recipe sends are the same bytes either way (mcp/plugin-corpus.test.ts runs with `now`).
 *
 * - zig: `LIME_ZIG` (a zig binary), else `zig/zig` in the bundled lust's folder (`mcp/lust/zig`, tools/lust/stage.sh).
 *   Without one, builds stay tcc: a checkout without zig never fails a recipe because of this.
 * - `LIME_LUST_OPT`: `0` turns it off (tcc only, for debugging); `now` builds with `--opt` in the foreground (tests and
 *   the bench: every run is the optimised binary); `1` (or `bg`) is `--opt=bg` on any platform. Unset, `--opt=bg` is
 *   on where it is proven to send tcc's bytes, Windows and macOS (`OPT_BY_DEFAULT`), and builds are tcc elsewhere.
 * - zig's own cache (its libc and compiler_rt, built once per machine, about a minute) is Lime Slice's
 *   (`lustOptCacheRoot`), shared by the app and every MCP server. Until a one-shot warm-up build has filled it, builds
 *   stay tcc and the warm-up runs in the background on its own, without lust's daemon: the first `--opt` build in a
 *   cold cache would hold the daemon, and every recipe build waiting on it, for that minute.
 * - lust's own cache (LUST_CACHE_DIR, with `opt/`) stays the host's (`<root>/cache`): lust keys an optimised binary by
 *   the slot's file path, so a cache shared across hosts would not hit anyway.
 *
 * The app's runner does the same in Rust (crates/lime-recipe-runner `OptBuild`).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type OptMode = "off" | "bg" | "now";

/** What a host passes to lust for one build. */
export interface OptBuild {
  mode: OptMode;
  /** Extra `lust build` arguments: `--opt=bg`, `--opt`, or none. */
  args: string[];
  /** The environment additions: zig's folder first on PATH, zig's cache dirs. Empty when off. */
  env: Record<string, string>;
}

const exe = process.platform === "win32" ? ".exe" : "";

/** The zig `lust` would use: `LIME_ZIG`, else the one bundled beside lust (`<lust>/../../zig/zig`). */
export function zigFor(lust: string): string | null {
  const named = process.env.LIME_ZIG;
  if (named) return existsSync(named) ? named : null;
  const bundled = join(dirname(dirname(lust)), "zig", `zig${exe}`);
  return existsSync(bundled) ? bundled : null;
}

/**
 * Lime Slice's own cache folder, for zig's cache: `%LOCALAPPDATA%\Lime Slice\cache`, `~/Library/Caches/lime-slice`,
 * `$XDG_CACHE_HOME/lime-slice`. Off Windows the path has no space in it: lust splits a path at a space there (the
 * recipe roots under `~/Library/Caches/Lime Slice` failed every build on macOS), and the optimised build is on by
 * default on macOS, so its cache must be a path lust and zig both take.
 */
export function lustOptCacheRoot(): string {
  if (process.env.LIME_LUST_OPT_CACHE) return process.env.LIME_LUST_OPT_CACHE;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || tmpdir(), "Lime Slice", "cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "lime-slice");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lime-slice");
}

/**
 * Where `--opt=bg` is on by default: where the optimised program is proven to send the same bytes as tcc's. Windows,
 * and macOS on Apple silicon since lust 0.3.0 (it builds without LTO under zig cc there): CI's macOS job runs the
 * proof Windows has (the float maths, the native geometry bytes and the corpus with every build `--opt`), it passed
 * on the pull request that added it and on main, and it now stops the job when it fails. Not Linux: zig's default
 * glibc target (2.28) links the old `log@GLIBC_2.2.5`, whose NaN for a negative input has the other sign bit than
 * the `log@GLIBC_2.29` tcc and rustc link (recipe-floatmath's `ln`, still failing in CI under `--opt`).
 */
export const OPT_BY_DEFAULT = process.platform === "win32" || process.platform === "darwin";

/** `LIME_LUST_OPT`: `0` off, `now` foreground `--opt`, `1` (or `bg`) `--opt=bg` anywhere, unset the platform's default. */
export function optMode(): OptMode {
  const v = (process.env.LIME_LUST_OPT ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false") return "off";
  if (v === "now") return "now";
  if (v === "") return OPT_BY_DEFAULT ? "bg" : "off";
  return "bg";
}

/**
 * What a lust daemon started by this process would carry for the optimised build: the zig it finds on its PATH and
 * zig's cache folder, or "" when the optimised build is off or there is no zig. lust's daemon does the compiling
 * with the environment it was started in, and outlives the server that started it; a server that reuses a daemon
 * started without zig gets "no C compiler" (or whatever compiler that machine's PATH has) for every `--opt` build.
 * So servers share a recipe root, and with it a daemon, only when this is the same (mcp/recipe-root.ts).
 */
export function daemonEnvTag(lust: string): string {
  const zig = optMode() === "off" ? null : zigFor(lust);
  return zig ? `${zig}|${join(lustOptCacheRoot(), "zig")}` : "";
}

/** The warm-up's marker: one per lust and zig pair (their paths and sizes). */
function warmMarker(cache: string, lust: string, zig: string): string {
  const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
  const id = [lust, zig].map((p) => `${p}:${size(p)}`).join("|");
  return join(cache, `warm-mcp-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`);
}

let warming: Promise<boolean> | null = null;

/**
 * A one-shot `lust build --sandbox --opt` of a small program with no daemon (LUST_NO_DAEMON=1) and its own lust
 * cache, into zig's shared cache: zig builds its libc and compiler_rt for this target there once. Writes the marker on
 * success. One at a time per process; never throws.
 */
function warmUp(lust: string, env: Record<string, string>, marker: string): Promise<boolean> {
  warming ??= new Promise<boolean>((resolve) => {
    try {
      const dir = join(tmpdir(), `lime-lust-warm-${process.pid}`);
      mkdirSync(dir, { recursive: true });
      const main = join(dir, "main.rs");
      writeFileSync(main, 'fn main() {\n    let mut s = 0.0f64;\n    for i in 0..1000 { s += (i as f64).sin() * (i as f64).sqrt(); }\n    println!("{}", s.to_bits());\n}\n');
      const child = spawn(lust, ["build", "--sandbox", "--opt", main, "-o", join(dir, `warm${exe}`)], {
        env: withEnv(process.env, { ...env, LUST_NO_DAEMON: "1", LUST_CACHE_DIR: join(dir, "cache") }),
        stdio: "ignore",
        windowsHide: true,
      });
      const limit = setTimeout(() => child.kill(), 15 * 60_000);
      limit.unref();
      child.unref();
      child.on("error", () => { clearTimeout(limit); resolve(false); });
      child.on("exit", (code) => {
        clearTimeout(limit);
        if (code === 0) {
          try { writeFileSync(marker, `${new Date().toISOString()}\n`); } catch { /* the next process tries again */ }
        }
        rmSync(dir, { recursive: true, force: true });
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  }).finally(() => { warming = null; });
  return warming;
}

/**
 * How the next build runs. `bg` turns into tcc (no extra arguments) until zig's cache is warm, and starts the warm-up.
 */
export function optBuild(lust: string): OptBuild {
  const mode = optMode();
  const zig = mode === "off" ? null : zigFor(lust);
  if (!zig) return { mode: "off", args: [], env: {} };
  const cache = lustOptCacheRoot();
  const zigCache = join(cache, "zig");
  try { mkdirSync(zigCache, { recursive: true }); } catch { return { mode: "off", args: [], env: {} }; }
  const env = { PATH: `${dirname(zig)}${delimiter}${process.env.PATH ?? ""}`, ZIG_GLOBAL_CACHE_DIR: zigCache, ZIG_LOCAL_CACHE_DIR: zigCache };
  if (mode === "now") return { mode, args: ["--opt"], env };
  const marker = warmMarker(cache, lust, zig);
  if (!existsSync(marker)) {
    void warmUp(lust, env, marker);
    return { mode: "off", args: [], env };
  }
  return { mode, args: ["--opt=bg"], env };
}

/**
 * `base` with `extra` over it. On Windows a variable's name has no case: the parent's `Path` and our `PATH` must not
 * both reach the child.
 */
export function withEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const key = (k: string) => (process.platform === "win32" ? k.toUpperCase() : k);
  const over = new Set(Object.keys(extra).map(key));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!over.has(key(k))) out[k] = v;
  return { ...out, ...extra };
}

/** Which program a finished build left: the optimised one (lust said it installed it, or `--opt` built it) or tcc's. */
export function builtWith(opt: OptBuild, stderr: string): "opt" | "tcc" {
  if (opt.mode === "now") return "opt";
  return opt.mode === "bg" && /^opt: cached optimised build/m.test(stderr) ? "opt" : "tcc";
}

/**
 * lust's background build reads the slot's files when it runs, not when it was asked for, and keys what it builds by
 * the text it was asked for. A slot written while one runs could leave a binary under the old text's key. So before a
 * slot's file changes while background builds are in flight, those are marked untrusted (a file of the build's name
 * in `opt-untrusted/` beside the cache), and once they end their binaries are removed (`dropUntrusted`, before each
 * build). One file a mark, made and removed whole: the servers that share a root (mcp/recipe-root.ts) share this
 * cache, and a list they each read and wrote back could lose a mark.
 */
export function distrustRunning(cacheDir: string): void {
  const opt = join(cacheDir, "opt");
  let names: string[];
  try { names = readdirSync(opt).filter((n) => n.endsWith(".lock") && n !== "running.lock").map((n) => n.slice(0, -".lock".length)); } catch { return; }
  if (names.length === 0) return;
  const marks = join(cacheDir, "opt-untrusted");
  mkdirSync(marks, { recursive: true });
  for (const name of names) writeFileSync(join(marks, name), "");
}

/** Removes the untrusted binaries whose background build has ended (`distrustRunning`). */
export function dropUntrusted(cacheDir: string): void {
  const marks = join(cacheDir, "opt-untrusted");
  let names: string[];
  try { names = readdirSync(marks); } catch { return; }
  const opt = join(cacheDir, "opt");
  for (const name of names) {
    if (existsSync(join(opt, `${name}.lock`))) continue;
    rmSync(join(opt, `${name}.ok`), { force: true });
    rmSync(join(opt, name), { force: true });
    rmSync(join(marks, name), { force: true });
  }
}
