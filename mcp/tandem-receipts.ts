/**
 * The window's answer to a plate snapshot, in the reply of the call that made it (Tandem feedback 2026-11-09, section 2:
 * a commit answered `ok:true` with "pending" while the window had held the change back, so the agent told the person it
 * was in the app). A call waits up to `RECEIPT_WAIT_MS` for the window's receipt; what has not come by then is given
 * with the next call's reply (`tandemEarlier`). A snapshot nothing received is `no-bridge`, never pending forever.
 *
 * `status` is one of:
 * - `applied`: the window shows MCP's change. `applied-replaced`: it does, over the window's own version of the parts in
 *   `replaced` (a person's edits, or a Model history MCP's does not continue); that version is one Ctrl+Z away there.
 * - `diverged`: applied, and the window kept a person's change to a part this snapshot did not touch.
 * - `waiting`: the person is editing (`reason`: gesture, typing, model-edit); it applies when they finish.
 * - `conflict` (`held`): an older window held parts back. `missing`: it lacked a mesh; the next call resends it.
 * - `failed`, `stale`: the window could not show it, or had newer.
 * - `no-bridge`: no window took the snapshot (`why`). `unconfirmed`: an older window that gives no receipts took it.
 * - `pending`: taken, no answer within the wait; the next reply gives it.
 */
import { bridgeDelivery, bridgeReceipts } from "./bridge-client.ts";

export const RECEIPT_WAIT_MS = 1500;
/** A snapshot the window took but never answered for this long counts as lost: the window went away. */
const LOST_AFTER_MS = 30_000;
const POLL_MS = 100;

interface ReceiptHost {
  readonly bridgeSession: string;
  readonly tandemPending: { seq: number; at: number }[];
}

type Receipt = { session?: unknown; seq?: unknown; outcome?: unknown; held?: unknown; replaced?: unknown; reason?: unknown };

/** The newest receipt the window wrote for `seq` of this session, or null. */
function receiptFor(receipts: readonly unknown[], session: string, seq: number): Receipt | null {
  for (let at = receipts.length - 1; at >= 0; at -= 1) {
    const row = receipts[at] as Receipt;
    if (row && row.session === session && row.seq === seq) return row;
  }
  return null;
}

/** A receipt as the reply gives it. */
function described(seq: number, row: Receipt): Record<string, unknown> {
  const replaced = Array.isArray(row.replaced) && row.replaced.length ? row.replaced : null;
  const held = Array.isArray(row.held) && row.held.length ? row.held : null;
  const outcome = String(row.outcome);
  const status = outcome === "applied" && replaced ? "applied-replaced" : outcome;
  const notes: Record<string, string> = {
    "applied-replaced": "Applied live. It replaced the window's own version of the parts in replaced; tell the person: Ctrl+Z in the window puts theirs back.",
    waiting: "The person is editing that part in the window; the change applies when they finish.",
    conflict: "This window held the parts in held back; the rest applied.",
    missing: "The window lacked a mesh; the next call sends it again.",
    failed: "The window could not show this change.",
  };
  return {
    seq,
    status,
    ...(replaced ? { replaced } : {}),
    ...(held ? { held } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(notes[status] ? { note: notes[status] } : {}),
  };
}

function settled(status: unknown): boolean {
  return status !== "pending" && status !== "waiting";
}

/**
 * The window's outcome for snapshot `seq`, waiting up to `waitMs` for it. `sent` says whether a window took it. What is
 * not settled by then (pending, waiting) is remembered for the next reply.
 */
export async function tandemOutcome(host: ReceiptHost, seq: number, sent: Promise<boolean>, waitMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + waitMs;
  const delivered = await Promise.race([sent, new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, waitMs)))]);
  if (delivered === false) return { seq, status: "no-bridge", why: bridgeDelivery().why || "no window took the snapshot" };
  let last: Record<string, unknown> = { seq, status: "pending" };
  while (delivered === true) {
    const receipts = await bridgeReceipts();
    if (receipts === null) {
      last = { seq, status: "unconfirmed", note: "The window took the change but gives no receipts (an older app)." };
      break;
    }
    const row = receiptFor(receipts, host.bridgeSession, seq);
    if (row) last = described(seq, row);
    if (settled(last.status) || Date.now() + POLL_MS > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (!settled(last.status)) {
    host.tandemPending.push({ seq, at: Date.now() });
    if (host.tandemPending.length > 16) host.tandemPending.shift();
    if (last.status === "pending") last.note = "The window has not answered yet; the next reply gives its outcome (tandemEarlier).";
  }
  return last;
}

/**
 * Outcomes of earlier snapshots that were not settled in their own reply, now settled: one receipts read, only while
 * some are open. `except` is this call's own snapshot. Older than `LOST_AFTER_MS` with no answer, or nothing answers:
 * `no-bridge`.
 */
export async function tandemEarlier(host: ReceiptHost, except: number | null): Promise<Record<string, unknown>[]> {
  const open = host.tandemPending.filter((row) => row.seq !== except);
  if (open.length === 0) return [];
  const receipts = await bridgeReceipts();
  const out: Record<string, unknown>[] = [];
  const keep: { seq: number; at: number }[] = host.tandemPending.filter((row) => row.seq === except);
  for (const pending of open) {
    const row = receipts ? receiptFor(receipts, host.bridgeSession, pending.seq) : null;
    const now = row ? described(pending.seq, row) : null;
    if (now && settled(now.status)) out.push(now);
    else if (!receipts || Date.now() - pending.at > LOST_AFTER_MS) out.push({ seq: pending.seq, status: "no-bridge", why: receipts ? "the window never answered for this change" : bridgeDelivery().why || "the window is not answering" });
    else keep.push(pending);
  }
  host.tandemPending.splice(0, host.tandemPending.length, ...keep);
  return out;
}
