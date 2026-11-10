/**
 * Where an MCP server's recipes build: one root per lust and crate, kept between servers and shared by them.
 *
 * The root used to be `lime-recipes-<pid>` in the temp folder: every server started cold (lust's daemon, then the
 * lime-recipe crate once per slot, about a second each), and nothing removed the folder. Now it is
 * `<Lime Slice's cache>/recipes/<key>`, where the key is a hash of lust (its path and `--version`) and of every crate
 * it builds against, so a new lust or a new crate gets a root of its own and an old one is simply not used again. The
 * crate copies, lust's cache and its daemon (one socket under the root; it exits by itself after 30 idle minutes) are
 * shared. A slot is not: a server writes a slot's `main.rs`, builds it and runs the program, so it holds the slot.
 *
 * Holding a slot (`claimSlot`). `locks/<slot>.g<N>` holds the pid of the slot's N-th holder; the holder is the highest
 * N. A process takes a free slot by creating `g1`, and a slot whose holder's process is gone by creating `g<N+1>`. Both
 * are exclusive creates of one name, so of the processes that saw the same state exactly one succeeds. No lock file is
 * ever deleted, so a name once used is never free again: a process that read an old state finds its next name taken.
 * (They are a few bytes each, one per takeover, and a new lust or crate starts a new root.) A live process is never
 * seen as gone, so it holds its slots until it ends; a pid the system gave to another program keeps that slot held,
 * and the next one is used. Nothing has to be released: a server that is killed leaves its files, and its slots are
 * free the moment it is gone.
 *
 * Inside one process the hosts of a root share one table of slots and one record of what each slot's program was built
 * from (`rootState`), so a session's host never reads another's slot as its own.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { lustOptCacheRoot } from "./recipe-opt.ts";

/** Bump when what a root holds changes shape, so servers of both kinds never share one. */
const LAYOUT = "1";
/** The most slots of one API major a root holds; past it a process builds in slots of its own. */
export const POOL_SLOTS = 32;
/** A lock file with no pid in it this long after it was made was left by a process that died while writing it. */
const UNWRITTEN_MS = 60_000;

/** Whether a process with this id is running. A pid we may not signal is running. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The folder the roots are in: `LIME_RECIPE_CACHE`, else `recipes` in Lime Slice's cache folder. */
export function recipeCacheDir(): string {
  if (process.env.LIME_RECIPE_CACHE) return process.env.LIME_RECIPE_CACHE;
  const dir = join(lustOptCacheRoot(), "recipes");
  // lust on macOS and Linux splits a build's path at a space ("lust failed: /Users/…/Library/Caches/Lime: No such
  // file or directory" for `~/Library/Caches/Lime Slice`); on Windows a path with a space builds. So there the roots
  // go where the path has none.
  if (process.platform !== "win32" && /\s/.test(dir)) return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lime-slice", "recipes");
  return dir;
}

/** A root's key: lust (where it is and what `--version` says) and each crate's `lib.rs`, by API major. */
export function rootKey(lust: string, lustVersion: string, crateLibs: readonly { major: number; lib: string }[]): string {
  const crates = [...crateLibs].sort((a, b) => a.major - b.major).map((row) => [row.major, createHash("sha256").update(row.lib).digest("hex")]);
  return createHash("sha256").update(JSON.stringify([LAYOUT, lust, lustVersion, crates])).digest("hex").slice(0, 16);
}

/** What `lust --version` prints, or "" when it does not answer. */
export function lustVersion(lust: string): string {
  const r = spawnSync(lust, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  return r.status === 0 ? String(r.stdout ?? "").trim() : "";
}

/**
 * The shared root for this lust and these crates, made if it is not there, or null when it cannot be made or written
 * (the caller then builds in a folder of its own in the temp folder, as before).
 */
export function sharedRoot(lust: string, crateLibs: readonly { major: number; lib: string }[]): string | null {
  let real = lust;
  try { real = realpathSync(lust); } catch { /* A lust on PATH is named as it was found. */ }
  const root = join(recipeCacheDir(), rootKey(real, lustVersion(lust), crateLibs));
  // A home folder or a chosen cache with a space in it: build in the temp folder, as before.
  if (process.platform !== "win32" && /\s/.test(root)) return null;
  try {
    mkdirSync(join(root, "locks"), { recursive: true });
    const probe = join(root, "locks", `.probe-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return root;
  } catch {
    return null;
  }
}

/** `text` at `path`, whole or not at all: other servers read these files while they build. */
export function writeWhole(path: string, text: string): boolean {
  const same = () => { try { return readFileSync(path, "utf8") === text; } catch { return false; } };
  if (same()) return false;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    // Another server put the same file there first, or holds it open (Windows): the same text is what was wanted.
    if (!same()) throw err;
  }
  return true;
}

/**
 * Takes `slot` in `locksDir` for this process: true when this process now holds it. See the file's comment for why
 * two processes never both get true. `alive` is injectable for tests.
 */
export function claimSlot(locksDir: string, slot: string, pid = process.pid, alive: (pid: number) => boolean = pidAlive): boolean {
  mkdirSync(locksDir, { recursive: true });
  const mark = `${resolve(locksDir)}|${slot}|${pid}`;
  if (held.has(mark)) return false;
  const prefix = `${slot}.g`;
  const create = (n: number): boolean => {
    try {
      writeFileSync(join(locksDir, `${prefix}${n}`), `${pid}\n`, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const gens = readdirSync(locksDir).flatMap((name) => {
      if (!name.startsWith(prefix)) return [];
      const n = Number(name.slice(prefix.length));
      return Number.isInteger(n) && n > 0 && String(n) === name.slice(prefix.length) ? [n] : [];
    });
    if (gens.length === 0) {
      if (!create(1)) continue;
      held.add(mark);
      return true;
    }
    const top = Math.max(...gens);
    const file = join(locksDir, `${prefix}${top}`);
    let holder: number;
    try {
      holder = Number(readFileSync(file, "utf8").trim());
      if (!Number.isInteger(holder) || holder <= 0) {
        // Being written right now, or left unwritten by a process that died there.
        if (Date.now() - statSync(file).mtimeMs < UNWRITTEN_MS) return false;
        holder = 0;
      }
    } catch {
      continue; // It went between the listing and the read: a newer holder removed it. Look again.
    }
    // Our own pid in a file this process did not write is an earlier process's: it is gone, and we have its pid.
    if (holder !== 0 && holder !== pid && alive(holder)) return false;
    if (!create(top + 1)) continue;
    held.add(mark);
    return true;
  }
  return false;
}

/** The slots this process holds, by locks folder, slot and pid: a second table of the same root never takes one again. */
const held = new Set<string>();

/** What the hosts of one root share inside a process. */
export interface RootState {
  /** Per API major: recipe names in use order, most recent last, and the slot index (0..SLOTS-1) each holds. */
  slotUse: Map<number, { order: string[]; of: Map<string, number> }>;
  /** The slot folder this process holds for an API major's index, by `<major>:<index>`. */
  dirs: Map<string, string>;
  /** The last good build of each slot's program, by its program path: the text and the lust that made it. */
  built: Map<string, { key: string; result: unknown }>;
}

const states = new Map<string, RootState>();

/** The state every host of `root` in this process shares. */
export function rootState(root: string): RootState {
  let state = states.get(root);
  if (!state) states.set(root, (state = { slotUse: new Map(), dirs: new Map(), built: new Map() }));
  return state;
}

/**
 * The folder name of this process's slot `index` of API `major` in `root`: the first of the root's slots it holds or
 * can take (`slot-<n>`, or `slot-<major>-<n>` for an older major), else one of its own (`own-<pid>-...`), which no
 * other process names.
 */
export function slotDir(root: string, state: RootState, major: number, index: number, current: boolean): string {
  const key = `${major}:${index}`;
  const held = state.dirs.get(key);
  if (held) return held;
  const mine = new Set(state.dirs.values());
  const name = (n: number) => (current ? `slot-${n}` : `slot-${major}-${n}`);
  let found: string | null = null;
  for (let n = 0; n < POOL_SLOTS && !found; n += 1) {
    if (mine.has(name(n))) continue;
    try {
      if (claimSlot(join(root, "locks"), name(n))) found = name(n);
    } catch {
      break; // The locks cannot be written: build in a slot of our own.
    }
  }
  const dir = found ?? `own-${process.pid}-${name(index)}`;
  state.dirs.set(key, dir);
  return dir;
}

/**
 * Removes the roots older servers left in the temp folder (`lime-recipes-<pid>`) whose process is gone. A root's
 * socket file goes first: lust's daemon stops when its socket file is deleted, and it may still be running after the
 * server that started it. A root whose pid is running is left (that server, or an unrelated program with its pid). A
 * folder that cannot be removed now (the daemon is still closing its files) is tried again by the next server.
 */
export async function sweepStaleRoots(dir = tmpdir(), alive: (pid: number) => boolean = pidAlive): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = /^lime-recipes-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || alive(pid)) continue;
    const root = join(dir, name);
    try {
      if (!statSync(root).isDirectory()) continue;
      rmSync(join(root, "lust.sock"), { force: true });
      await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      if (!existsSync(root)) removed.push(name);
    } catch {
      /* Still in use: the next server tries again. */
    }
  }
  return removed;
}

let swept = false;

/** `sweepStaleRoots` once a process, a little after its first build, off the build's path. */
export function sweepStaleRootsOnce(): void {
  if (swept || process.env.LIME_RECIPE_SWEEP === "0") return;
  swept = true;
  const timer = setTimeout(() => void sweepStaleRoots().catch(() => []), 3000);
  timer.unref();
}
