/** Load and store the machine library through the UI adapter. */
import { localMachineStore, type MachineStore } from "../ui/machine-library-store.ts";
import { ensureBuiltins, parseLibrary, serializeLibrary, type MachineLibrary } from "../ui/machine-library.ts";

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
