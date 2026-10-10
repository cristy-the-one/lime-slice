/** The rules for the printer and plate as they stand now. */
import { loadMachineLibrary } from "./machine-library.ts";
import { state } from "./state.ts";
import { selection, type MachineLibrary } from "../ui/machine-library.ts";
import { defaultBelt } from "../belt.ts";
import { settingsRules, type Rules } from "../settings-rules.ts";

export function currentRules(library: MachineLibrary = loadMachineLibrary()): Rules {
  const printer = selection(library)?.printer;
  const belt = printer?.belt ?? defaultBelt();
  return settingsRules({
    kind: printer?.kind ?? "cartesian",
    belt: { raftLayers: belt.raftLayers, maxLengthMm: belt.maxLengthMm },
    firmware: printer?.firmware ?? "klipper",
    objects: state.plate.objects.length,
  });
}
