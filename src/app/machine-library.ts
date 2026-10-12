/** Load and store the machine library through the UI adapter. */
import { localMachineStore, type MachineStore } from "../ui/machine-library-store.ts";
import { ensureBuiltins, heatFor, parseLibrary, selection, serializeLibrary, type Heat, type MachineLibrary } from "../ui/machine-library.ts";
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

/** The temperatures the engine is asked for: the profile's, held at the active printer's limits. */
export function activeHeat(library: MachineLibrary = loadMachineLibrary()): Heat {
  return heatFor(selection(library)?.printer, state.profile.nozzleTemp, state.profile.bedTemp);
}
