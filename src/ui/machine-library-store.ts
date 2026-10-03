/**
 * Printer, filament, and nozzle profiles live in the browser.
 * The slicer engine accepts one printer on each slice request and has no API
 * for a filament catalog, a nozzle list, or start and end G-code.
 * `localMachineStore` is the UI adapter for that missing API.
 * Start and end G-code stay in this store. They are not added to the slice request.
 */
export const MACHINE_LIBRARY_KEY = "lime-slice-machines";

export interface MachineStore {
  read(): string | null;
  write(text: string): void;
}

export function localMachineStore(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): MachineStore {
  return {
    read: () => storage.getItem(MACHINE_LIBRARY_KEY),
    write: (text) => storage.setItem(MACHINE_LIBRARY_KEY, text),
  };
}
