/**
 * Settle on the bed: while a rotate gesture runs, the part snaps to the rest pose nearest the angle it is held at.
 * Off until chosen, so a typed or nudged angle stays exact. A user preference, so it outlives a restart and is not part of a project.
 */
const SETTLE_KEY = "lime-slice-settle";

function load(): boolean {
  try {
    return globalThis.localStorage?.getItem(SETTLE_KEY) === "1";
  } catch {
    return false;
  }
}

let on = load();

export function settleOn(): boolean {
  return on;
}

export function setSettleOn(next: boolean) {
  if (next === on) return;
  on = next;
  try {
    globalThis.localStorage?.setItem(SETTLE_KEY, next ? "1" : "0");
  } catch {
    // Storage can be off; the toggle still works for this session.
  }
}
