/**
 * The plate lives in the server process. A client that gives up on a long call may restart the server, and then the
 * plate is gone. So the session writes the plate, with every object's Model history, to `autosave-<pid>.lime` in the
 * workspace before a long call and shortly after each change. Each server writes its own file, so two clients that
 * share a workspace do not take each other's. A server that starts takes the newest file whose server has ended,
 * moves it to `autosave-previous.lime`, and offers it: project_open brings the last session back.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { workspaceRoot } from "./workspace.ts";

export const PREVIOUS_NAME = "autosave-previous.lime";
const OWN = /^autosave-(\d+)\.lime$/;

export interface PreviousAutosave {
  path: string;
  savedAt: string;
  objects: number;
  note: string;
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
    const ended = readdirSync(root)
      .map((name) => ({ name, pid: Number(OWN.exec(name)?.[1] ?? NaN) }))
      .filter((row) => Number.isInteger(row.pid) && row.pid !== process.pid && !alive(row.pid))
      .map((row) => ({ ...row, mtime: statSync(join(root, row.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (ended.length > 0) {
      renameSync(join(root, ended[0]!.name), previous);
      for (const row of ended.slice(1)) unlinkSync(join(root, row.name));
    }
    if (!existsSync(previous)) return null;
    const savedAt = statSync(previous).mtime.toISOString();
    let objects = 0;
    try {
      const doc = JSON.parse(readFileSync(previous, "utf8")) as { objects?: unknown[] };
      objects = Array.isArray(doc.objects) ? doc.objects.length : 1;
    } catch {
      return null;
    }
    return {
      path: previous,
      savedAt,
      objects,
      note: `A previous server's plate, saved ${savedAt}, is in ${previous} with ${objects} object${objects === 1 ? "" : "s"} and their Model history. If the server restarted mid-session, project_open that path to carry on.`,
    };
  } catch {
    return null;
  }
}

/** The text written whole to a side file, then moved over the autosave, so a kill mid-write leaves the last one. */
export async function writeAutosave(path: string, text: string): Promise<void> {
  const side = `${path}.part`;
  await writeFile(side, text);
  await rename(side, path);
}
