/**
 * Named settings profiles live in the browser.
 * The slicer engine accepts a printer profile on each slice request and has no
 * API for listing, saving, or switching named settings profiles.
 * `localSettingsProfileStore` is the UI adapter for that missing API.
 */
import { prefs, prefsOver, type PrefStorage } from "../prefs.ts";

export const SETTINGS_PROFILE_KEY = "lime-slice-settings-profiles";

export interface SettingsProfileStore {
  read(): string | null;
  write(text: string): void;
}

export function localSettingsProfileStore(storage?: Pick<PrefStorage, "getItem" | "setItem">): SettingsProfileStore {
  const store = storage ? prefsOver(storage) : prefs;
  return {
    read: () => store.get(SETTINGS_PROFILE_KEY),
    write: (text) => {
      store.set(SETTINGS_PROFILE_KEY, text);
    },
  };
}
