/**
 * HTTP slice jobs. `POST /api/jobs` is the same body as `POST /api/slice`.
 * The invoke path does not use this module; it still falls back to `mockSliceProgress`.
 */
import { authHeaders } from "./api-base.ts";
import { progressFromEvent } from "./slice-progress.ts";

export type JobStatus = "running" | "done" | "cancelled" | "error";

export interface JobSnapshot {
  id: string;
  stage: string;
  done: number;
  total: number;
  fraction: number;
  status: JobStatus;
}

/** Names for the stage budget in docs/slice-progress.md. */
const STAGE_NAMES: Record<string, string> = {
  load: "Loading mesh",
  cut: "Slicing layers",
  part: "Walls and infill",
  travel: "Travel",
  supports: "Supports",
  assemble: "Assembling",
  emit: "Writing G-code",
};

export function stageLabel(stage: string): string {
  return STAGE_NAMES[stage] ?? (stage || "Slicing");
}

export function formatStageLine(snap: Pick<JobSnapshot, "stage" | "done" | "total">): string {
  const name = stageLabel(snap.stage);
  if (snap.total > 0) return `${name} ${snap.done}/${snap.total}`;
  return name;
}

/** ETA from a job fraction and the time since the slice started. */
export function jobEtaSeconds(fraction: number, elapsedMs: number): number | null {
  return progressFromEvent(fraction, elapsedMs).etaSeconds;
}

export function parseJobSnapshot(text: string): JobSnapshot | null {
  let raw: Partial<JobSnapshot>;
  try {
    raw = JSON.parse(text) as Partial<JobSnapshot>;
  } catch {
    return null;
  }
  if (!raw || typeof raw.id !== "string" || typeof raw.fraction !== "number" || !Number.isFinite(raw.fraction)) return null;
  if (raw.status !== "running" && raw.status !== "done" && raw.status !== "cancelled" && raw.status !== "error") return null;
  return {
    id: raw.id,
    stage: typeof raw.stage === "string" ? raw.stage : "",
    done: typeof raw.done === "number" && Number.isFinite(raw.done) ? raw.done : 0,
    total: typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : 0,
    fraction: raw.fraction,
    status: raw.status,
  };
}

/**
 * Pull complete SSE events out of a byte stream. A partial event stays in `rest`.
 * Each event is the joined `data:` payload, which is one JSON snapshot.
 */
export function takeSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  for (;;) {
    const split = rest.indexOf("\n\n");
    if (split < 0) break;
    const block = rest.slice(0, split);
    rest = rest.slice(split + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) events.push(data);
  }
  return { events, rest };
}

export function jobEventsUrl(base: string, id: string, token: string): string {
  const url = `${base}/api/jobs/${encodeURIComponent(id)}/events`;
  if (!token) return url;
  return `${url}?token=${encodeURIComponent(token)}`;
}

export interface HttpText {
  status: number;
  text: string;
}

/** `404` (and a connection failure) means this engine has no job routes. */
export async function beginSliceJob(
  post: (body: string) => Promise<HttpText>,
  body: unknown,
): Promise<{ unsupported: true } | { id: string }> {
  let res: HttpText;
  try {
    res = await post(JSON.stringify(body));
  } catch (err) {
    if (err instanceof TypeError) return { unsupported: true };
    throw err;
  }
  if (res.status === 404) return { unsupported: true };
  if (res.status !== 202) throw new Error(errorText(res.text, res.status));
  let id = "";
  try {
    const parsed = JSON.parse(res.text) as { id?: unknown };
    if (typeof parsed.id === "string") id = parsed.id;
  } catch {
    id = "";
  }
  if (!id) throw new Error("The engine did not start a slice job.");
  return { id };
}

export function errorText(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    /* the body is not JSON */
  }
  return `slice failed (${status})`;
}

export interface EventHandlers {
  onMessage: (data: string) => void;
  onError: () => void;
}

export interface FollowArgs {
  eventsUrl: string;
  /** Null when `EventSource` cannot be constructed. A throw or `onError` starts polling. */
  openEvents: ((url: string, handlers: EventHandlers) => { close(): void }) | null;
  poll: () => Promise<JobSnapshot>;
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  onUpdate: (snap: JobSnapshot) => void;
}

/** Follow SSE until a terminal snapshot. If the stream fails, poll `GET /api/jobs/<id>`. */
export async function followJobProgress(args: FollowArgs): Promise<JobSnapshot> {
  if (args.shouldStop()) throw new Error("cancelled");
  if (args.openEvents) {
    const fromEvents = await readEvents(args);
    if (fromEvents !== "fallback") return fromEvents;
    if (args.shouldStop()) throw new Error("cancelled");
  }
  for (;;) {
    if (args.shouldStop()) throw new Error("cancelled");
    const snap = await args.poll();
    args.onUpdate(snap);
    if (snap.status !== "running") return snap;
    await args.sleep(250);
  }
}

async function readEvents(args: FollowArgs): Promise<JobSnapshot | "fallback"> {
  return new Promise((resolve) => {
    let settled = false;
    let source: { close(): void } | null = null;
    const finish = (value: JobSnapshot | "fallback") => {
      if (settled) return;
      settled = true;
      source?.close();
      resolve(value);
    };
    try {
      source = args.openEvents!(args.eventsUrl, {
        onMessage: (data) => {
          const snap = parseJobSnapshot(data);
          if (!snap) return;
          args.onUpdate(snap);
          if (snap.status !== "running" || args.shouldStop()) finish(args.shouldStop() ? "fallback" : snap);
        },
        onError: () => finish("fallback"),
      });
    } catch {
      finish("fallback");
    }
  });
}

export function browserJobEvents(url: string, handlers: EventHandlers): { close(): void } {
  const source = new EventSource(url);
  source.onmessage = (ev) => handlers.onMessage(ev.data);
  source.onerror = () => handlers.onError();
  return { close: () => source.close() };
}

export async function postJson(base: string, token: string, path: string, body: string): Promise<HttpText> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body,
  });
  return { status: res.status, text: await res.text() };
}

export async function getText(base: string, token: string, path: string): Promise<HttpText> {
  const res = await fetch(`${base}${path}`, { headers: authHeaders(token) });
  return { status: res.status, text: await res.text() };
}

export async function cancelJob(base: string, token: string, id: string): Promise<void> {
  await fetch(`${base}/api/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: authHeaders(token),
  });
}
