/** Load and store the settings-profile library through the UI adapter. */
import { localSettingsProfileStore, type SettingsProfileStore } from "../ui/settings-profile-store.ts";
import { parseLibrary, serializeLibrary, type ProfileLibrary } from "../ui/settings-profiles.ts";

const store: SettingsProfileStore = localSettingsProfileStore();

export function loadProfileLibrary(): ProfileLibrary {
  return parseLibrary(store.read());
}

export function storeProfileLibrary(library: ProfileLibrary) {
  store.write(serializeLibrary(library));
}
