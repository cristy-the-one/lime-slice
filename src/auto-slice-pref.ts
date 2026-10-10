/** The gear's auto-slice switch is the user's preference, so it outlives a restart. Profiles and projects still carry their own. */
const AUTO_SLICE_KEY = "lime-slice-auto-slice";

export function loadAutoSlice(): boolean {
  try {
    return globalThis.localStorage?.getItem(AUTO_SLICE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveAutoSlice(on: boolean) {
  try {
    globalThis.localStorage?.setItem(AUTO_SLICE_KEY, on ? "1" : "0");
  } catch {
    // Storage can be off; the switch still works for this session.
  }
}
