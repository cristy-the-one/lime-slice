/** Load and store the machine library through the UI adapter. */
import { localMachineStore, type MachineStore } from "../ui/machine-library-store.ts";
import { ensureBuiltins, heatFor, parseLibrary, resolvedAsks, selection, serializeLibrary, type Heat, type MachineLibrary } from "../ui/machine-library.ts";
import { saveProfile } from "../profiles.ts";
import { state } from "./state";

const store: MachineStore = localMachineStore();

export function loadMachineLibrary(): MachineLibrary {
  return ensureBuiltins(parseLibrary(store.read()));
}

export function storeMachineLibrary(library: MachineLibrary) {
  store.write(serializeLibrary(library));
}

export function machineLibraryStored(): boolean {
  return store.read() !== null;
}

/**
 * The temperatures the engine is asked for. A profile still on the PLA defaults
 * takes the selected filament's temperatures; either way the printer's limits hold them.
 * The profile keeps the ask, so a later project save does too.
 */
export function activeHeat(library: MachineLibrary = loadMachineLibrary()): Heat {
  const picked = selection(library);
  const asks = resolvedAsks(picked?.filament, state.profile.nozzleTemp, state.profile.bedTemp);
  if (state.profile.nozzleTemp !== asks.nozzleTemp || state.profile.bedTemp !== asks.bedTemp) {
    state.profile.nozzleTemp = asks.nozzleTemp;
    state.profile.bedTemp = asks.bedTemp;
    saveProfile(state.profile);
  }
  return heatFor(picked?.printer, asks.nozzleTemp, asks.bedTemp);
}
