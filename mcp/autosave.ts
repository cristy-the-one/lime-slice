/**
 * The plate lives in the server process. A client that gives up on a long call may restart the server, and then the
 * plate is gone. So the session writes the plate, with every object's Model history, to `autosave-<pid>.lime` in the
 * workspace before a long call and shortly after each change. Each server writes its own file, so two clients that
 * share a workspace do not take each other's. A server that starts takes the newest file whose server has ended,
 * moves it to `autosave-previous.lime`, and offers it: project_open brings the last session back.
 *
 * An autosave never replaces a file that belongs to another project. Each file records `mcpAutosave: {project,
 * source?}`: an id the session mints for its plate (it carries on when the previous plate is opened again), and the
 * .lime the plate was opened from. Two files are one project when the ids match or the sources do. A file that a
 * rotation or a new plate would have replaced, and that belongs to another project, is kept as
 * `autosave-previous-<project>.lime`; a file of the same project is the older copy and is replaced.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { workspaceRoot } from "./workspace.ts";
import { checkpointRecords, type RecipeCheckpoint } from "./recipe-checkpoint.ts";

export const PREVIOUS_NAME = "autosave-previous.lime";
/** The workspace folder shelved autosaves (another project's, kept out of the way of a write) live in. */
export const SHELF_DIR = "autosaves";
/** A shelved autosave of a project that was never saved goes after this many days, from when it was written. */
export const SHELF_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHELVED = /^autosave-previous-.+\.lime$/;
const OWN = /^autosave-(\d+)\.lime$/;

/** What tells one project's autosaves from another's. Both fields are optional: a file from an older server has neither. */
export interface AutosaveIdentity {
  project?: string;
  source?: string;
  /** When the autosave was written, in ms since the epoch. Files from before the cleanup rule have none. */
  writtenAt?: number;
}

/** The identity an autosave file records, or {} when it has none or cannot be read. */
export function readIdentity(path: string): AutosaveIdentity {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { mcpAutosave?: { project?: unknown; source?: unknown; writtenAt?: unknown } };
    const mark = doc.mcpAutosave;
    return {
      ...(typeof mark?.project === "string" && /^[0-9a-f]{4,32}$/.test(mark.project) ? { project: mark.project } : {}),
      ...(typeof mark?.source === "string" && mark.source ? { source: mark.source } : {}),
      ...(typeof mark?.writtenAt === "number" && Number.isFinite(mark.writtenAt) && mark.writtenAt > 0 ? { writtenAt: mark.writtenAt } : {}),
    };
  } catch {
    return {};
  }
}

/** The same project: the ids match, or the plates were opened from the same file. Files with no identity match nothing. */
export function sameProject(a: AutosaveIdentity, b: AutosaveIdentity): boolean {
  return (!!a.project && a.project === b.project) || (!!a.source && a.source === b.source);
}

/** The file name part for a project's shelved autosave. */
function shelfKey(id: AutosaveIdentity, mtimeMs: number): string {
  if (id.project) return id.project;
  if (id.source) return `src-${createHash("sha256").update(id.source).digest("hex").slice(0, 12)}`;
  return `old-${Math.round(mtimeMs)}`;
}

/**
 * Keep an autosave that belongs to another project out of the way of a write or a rotation: renamed to
 * autosave-previous-<project>.lime. An older shelved copy of the same project is replaced; a newer one stays and this
 * one goes. Never throws.
 */
export function shelveAutosave(path: string, id: AutosaveIdentity = readIdentity(path)): void {
  try {
    const root = workspaceRoot();
    if (!root || !existsSync(path)) return;
    const mtime = statSync(path).mtimeMs;
    const shelf = join(root, SHELF_DIR);
    mkdirSync(shelf, { recursive: true });
    const target = join(shelf, `autosave-previous-${shelfKey(id, mtime)}.lime`);
    if (existsSync(target) && statSync(target).mtimeMs > mtime) unlinkSync(path);
    else renameSync(path, target);
  } catch {
    // A file that cannot be moved stays where it is; the rotation then leaves the newer one in place too.
  }
}

export interface PreviousAutosave {
  path: string;
  savedAt: string;
  objects: number;
  note: string;
  plan?: PlanRecovery;
  checkpoints?: Record<string, RecipeCheckpoint>;
  identity?: AutosaveIdentity;
}

/** Only completed step names and numbers: no arguments, results or client data. */
export interface PlanRecovery {
  job: string;
  total: number;
  completed: { step: number; tool: string }[];
}

/** Where this server autosaves, or null without a workspace. */
export function autosavePath(pid = process.pid): string | null {
  const root = workspaceRoot();
  return root ? join(root, `autosave-${pid}.lime`) : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * At a server's first call: the newest autosave a server that has ended left, moved to autosave-previous.lime so this
 * session's own saves never replace it. Older ended ones go. Files of servers still running are left alone. Null when
 * there is none.
 */
export function takePreviousAutosave(): PreviousAutosave | null {
  const root = workspaceRoot();
  if (!root) return null;
  const previous = join(root, PREVIOUS_NAME);
  try {
    moveRootShelved(root);
    const ended = readdirSync(root)
      .map((name) => ({ name, pid: Number(OWN.exec(name)?.[1] ?? NaN) }))
      .filter((row) => Number.isInteger(row.pid) && row.pid !== process.pid && !alive(row.pid))
      .map((row) => ({ ...row, mtime: statSync(join(root, row.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (ended.length > 0) {
      const newest = join(root, ended[0]!.name);
      const incoming = readIdentity(newest);
      // The file this one replaces is kept when it is another project's.
      if (existsSync(previous) && !sameProject(readIdentity(previous), incoming)) shelveAutosave(previous);
      renameSync(newest, previous);
      // Older files of the same project are superseded; another project's are shelved, not deleted.
      for (const row of ended.slice(1)) {
        const file = join(root, row.name);
        const id = readIdentity(file);
        if (sameProject(id, incoming)) unlinkSync(file);
        else shelveAutosave(file, id);
      }
      // A shelved copy of the project that is now the previous plate is the older one.
      const key = incoming.project ? incoming.project : incoming.source ? shelfKey(incoming, 0) : "";
      const shelved = key ? join(root, SHELF_DIR, `autosave-previous-${key}.lime`) : "";
      if (shelved && existsSync(shelved) && statSync(shelved).mtimeMs <= ended[0]!.mtime) unlinkSync(shelved);
    }
    tidyShelf(root);
    if (!existsSync(previous)) return null;
    const savedAt = statSync(previous).mtime.toISOString();
    let objects = 0;
    let plan: PlanRecovery | undefined;
    let checkpoints: Record<string, RecipeCheckpoint> = {};
    try {
      const doc = JSON.parse(readFileSync(previous, "utf8")) as { objects?: unknown[]; mcpPlanRecovery?: PlanRecovery; mcpRecipeCheckpoints?: unknown };
      objects = Array.isArray(doc.objects) ? doc.objects.length : 1;
      checkpoints = checkpointRecords(doc.mcpRecipeCheckpoints);
      const p = doc.mcpPlanRecovery;
      if (p && typeof p.job === "string" && /^job_\d+$/.test(p.job) && Number.isInteger(p.total) && p.total > 0 && p.total <= 250 && Array.isArray(p.completed) && p.completed.length <= p.total && p.completed.every((step) => !!step && typeof step === "object" && Number.isInteger(step.step) && step.step > 0 && step.step <= p.total && typeof step.tool === "string" && step.tool.length <= 80)) plan = p;
    } catch {
      return null;
    }
    const identity = readIdentity(previous);
    const result: PreviousAutosave = {
      path: previous,
      savedAt,
      objects,
      ...(plan ? { plan } : {}),
      note: `A previous server's plate, saved ${savedAt}, is in ${previous} with ${objects} object${objects === 1 ? "" : "s"} and their Model history. If the server restarted mid-session, project_open that path to carry on.${shelfNote(root)}`,
    };
    // Journals can include source and data values. Keep them internal; callers only need their names.
    if (Object.keys(checkpoints).length) Object.defineProperty(result, "checkpoints", { value: checkpoints, enumerable: false });
    Object.defineProperty(result, "identity", { value: identity, enumerable: false });
    return result;
  } catch {
    return null;
  }
}

/** The file's recorded mark and modification time, or null when it does not parse or is not one of our autosaves. */
function readMark(path: string): { mark: AutosaveIdentity; mtimeMs: number } | null {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { mcpAutosave?: unknown };
    if (!doc || typeof doc !== "object" || !doc.mcpAutosave || typeof doc.mcpAutosave !== "object") return null;
    return { mark: readIdentity(path), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/** A name that is free in the folder: autosave-previous-<key>.lime, or -2, -3 ... when taken. Still a shelved name. */
function freeName(dir: string, name: string): string {
  let target = join(dir, name);
  for (let n = 2; existsSync(target) && n < 1000; n += 1) target = join(dir, name.replace(/\.lime$/, `-${n}.lime`));
  return target;
}

/**
 * Shelved files an older server left in the workspace root go to autosaves/. Only files whose name is a shelved name and
 * that record `mcpAutosave` are touched, and nothing is overwritten: a taken name keeps both. Never throws.
 */
export function moveRootShelved(root: string): void {
  try {
    const found = readdirSync(root).filter((name) => SHELVED.test(name));
    for (const name of found) {
      const from = join(root, name);
      if (!readMark(from)) continue;
      const dir = join(root, SHELF_DIR);
      mkdirSync(dir, { recursive: true });
      renameSync(from, freeName(dir, name));
    }
  } catch {
    // A file that cannot be moved stays where it was.
  }
}

/** One shelved file with what was read from it. `mark` is null for a file that does not parse or has no `mcpAutosave`. */
export interface ShelfCandidate {
  path: string;
  mark: AutosaveIdentity | null;
  /** The autosave file's own modification time: the written time of a file that records none. */
  mtimeMs: number;
  /** Modification time of the file at mark.source, null when there is none or it does not exist. */
  sourceMtimeMs: number | null;
}

/** A project just written to its own .lime: its id (when the session has one), the path, and when. */
export interface JustSaved {
  project?: string;
  source: string;
  savedAtMs: number;
}

/**
 * Which shelved autosaves the rules delete, and why. Pure: no disk, no clock. A file with no mark is never listed. A
 * project that was never saved has no source and only ever goes by age.
 *  1. Saved since: its project was written to its .lime after the autosave was written. Either the file just saved
 *     (`saved`: same project id or same source), or its recorded source exists with a newer modification time.
 *  2. Otherwise older than SHELF_MAX_AGE_DAYS, from when it was written.
 * "Written" is the recorded `writtenAt`, else the file's own modification time.
 */
export function decideShelfDeletions(candidates: ShelfCandidate[], now: number, saved?: JustSaved): { path: string; reason: string }[] {
  const out: { path: string; reason: string }[] = [];
  for (const c of candidates) {
    if (!c.mark) continue;
    const written = c.mark.writtenAt ?? c.mtimeMs;
    if (saved && sameProject(c.mark, { project: saved.project, source: saved.source }) && saved.savedAtMs >= written) {
      out.push({ path: c.path, reason: "its project was saved to its own file since" });
    } else if (c.mark.source && c.sourceMtimeMs !== null && c.sourceMtimeMs >= written) {
      out.push({ path: c.path, reason: "its project was saved to its own file since" });
    } else if (now - written > SHELF_MAX_AGE_DAYS * DAY_MS) {
      out.push({ path: c.path, reason: `older than ${SHELF_MAX_AGE_DAYS} days` });
    }
  }
  return out;
}

/** Read every shelved file in autosaves/ and delete the ones decideShelfDeletions names, those exact paths only. Never throws. */
function tidyShelf(root: string, saved?: JustSaved): void {
  try {
    const dir = join(root, SHELF_DIR);
    if (!existsSync(dir)) return;
    const candidates: ShelfCandidate[] = readdirSync(dir)
      .filter((name) => SHELVED.test(name))
      .map((name) => {
        const path = join(dir, name);
        const read = readMark(path);
        let sourceMtimeMs: number | null = null;
        try {
          if (read?.mark.source) sourceMtimeMs = statSync(read.mark.source).mtimeMs;
        } catch {
          sourceMtimeMs = null;
        }
        return { path, mark: read?.mark ?? null, mtimeMs: read?.mtimeMs ?? 0, sourceMtimeMs };
      });
    for (const row of decideShelfDeletions(candidates, Date.now(), saved)) {
      if (dirname(row.path) !== dir || !SHELVED.test(row.path.slice(dir.length + 1))) continue;
      try {
        unlinkSync(row.path);
      } catch {
        // Left for the next start.
      }
    }
  } catch {
    // The shelf is a courtesy; never fail a call for it.
  }
}

/** At project_save: the shelved autosaves of the project just written to `source` are no longer needed. Never throws. */
export function tidyShelfAfterSave(project: string, source: string): void {
  try {
    const root = workspaceRoot();
    if (root) tidyShelf(root, { ...(project ? { project } : {}), source, savedAtMs: Date.now() });
  } catch {
    // As above.
  }
}

/** One plain sentence when shelved autosaves exist, empty otherwise. */
function shelfNote(root: string): string {
  try {
    const dir = join(root, SHELF_DIR);
    const n = existsSync(dir) ? readdirSync(dir).filter((name) => SHELVED.test(name)).length : 0;
    if (n === 0) return "";
    return n === 1 ? ` An autosave of 1 other project is in ${SHELF_DIR}/.` : ` Autosaves of ${n} other projects are in ${SHELF_DIR}/.`;
  } catch {
    return "";
  }
}

/** The text written whole to a side file, then moved over the autosave, so a kill mid-write leaves the last one. */
export async function writeAutosave(path: string, text: string): Promise<void> {
  const side = `${path}.part`;
  await writeFile(side, text);
  await rename(side, path);
}
