/**
 * Named settings profiles live in the browser.
 * The slicer engine accepts a printer profile on each slice request and has no
 * API for listing, saving, or switching named settings profiles.
 * `localSettingsProfileStore` is the UI adapter for that missing API.
 */
export const SETTINGS_PROFILE_KEY = "lime-slice-settings-profiles";

export interface SettingsProfileStore {
  read(): string | null;
  write(text: string): void;
}

export function localSettingsProfileStore(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): SettingsProfileStore {
  return {
    read: () => storage.getItem(SETTINGS_PROFILE_KEY),
    write: (text) => storage.setItem(SETTINGS_PROFILE_KEY, text),
  };
}
