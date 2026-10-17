/**
 * The plate lives in the server process. A client that gives up on a long call may restart the server, and then the
 * plate is gone. So the session writes the plate, with every object's Model history, to `autosave.lime` in the
 * workspace before each change and shortly after it. A server that starts and finds one moves it to
 * `autosave-previous.lime` and offers it: project_open brings the last session back.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { workspaceRoot } from "./workspace.ts";

export const AUTOSAVE_NAME = "autosave.lime";
export const PREVIOUS_NAME = "autosave-previous.lime";

export interface PreviousAutosave {
  path: string;
  savedAt: string;
  objects: number;
  note: string;
}

/** Where this session autosaves, or null without a workspace. */
export function autosavePath(): string | null {
  const root = workspaceRoot();
  return root ? join(root, AUTOSAVE_NAME) : null;
}

/**
 * At a server's first call: the autosave a previous server left, moved aside so this session's own saves do not
 * replace it. Null when there is none.
 */
export function takePreviousAutosave(): PreviousAutosave | null {
  const root = workspaceRoot();
  if (!root) return null;
  const current = join(root, AUTOSAVE_NAME);
  const previous = join(root, PREVIOUS_NAME);
  try {
    if (existsSync(current)) renameSync(current, previous);
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
export function writeAutosave(path: string, text: string): void {
  const side = `${path}.part`;
  writeFileSync(side, text);
  renameSync(side, path);
}
