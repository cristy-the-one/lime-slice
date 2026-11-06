import { prefs } from "./prefs.ts";

/** The Measure toggle: callouts, scale bar and bed numbers on or off together. A user preference, so it outlives a restart and is not part of a project. */
const MEASURE_KEY = "lime-slice-measure";

function load(): boolean {
  try {
    return prefs.getBool(MEASURE_KEY);
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
    prefs.setBool(MEASURE_KEY, next);
  } catch {
    // Storage can be off; the toggle still works for this session.
  }
  for (const listener of listeners) listener();
}

/** Called after the toggle changes, so a view can draw again. */
export function onMeasureChange(listener: () => void) {
  listeners.add(listener);
}
