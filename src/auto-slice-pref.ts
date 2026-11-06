import { prefs } from "./prefs.ts";

/** The gear's auto-slice switch is the user's preference, so it outlives a restart. Profiles and projects still carry their own. */
const AUTO_SLICE_KEY = "lime-slice-auto-slice";

export function loadAutoSlice(): boolean {
  try {
    return prefs.getBool(AUTO_SLICE_KEY);
  } catch {
    return true;
  }
}

export function saveAutoSlice(on: boolean) {
  try {
    prefs.setBool(AUTO_SLICE_KEY, on);
  } catch {
    // Storage can be off; the switch still works for this session.
  }
}
