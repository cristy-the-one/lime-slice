/** The Measure toggle: callouts, scale bar and bed numbers on or off together. A user preference, so it outlives a restart and is not part of a project. */
const MEASURE_KEY = "lime-slice-measure";

function load(): boolean {
  try {
    return globalThis.localStorage?.getItem(MEASURE_KEY) !== "0";
  } catch {
    return true;
  }
}

let on = load();
const listeners = new Set<() => void>();

export function measureOn(): boolean {
  return on;
}

export function setMeasureOn(next: boolean) {
  if (next === on) return;
  on = next;
  try {
    globalThis.localStorage?.setItem(MEASURE_KEY, next ? "1" : "0");
  } catch {
    // Storage can be off; the toggle still works for this session.
  }
  for (const listener of listeners) listener();
}

/** Called after the toggle changes, so a view can draw again. */
export function onMeasureChange(listener: () => void) {
  listeners.add(listener);
}
