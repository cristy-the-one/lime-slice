/** Load the saved Prusa Link host. Sending a print is `prusa-actions.ts`. */
import { localPrusaLinkStore } from "../ui/prusa-link-store.ts";
import { parsePrusaLink, serializePrusaLink, type PrusaLinkStore } from "../ui/prusa-link-store.ts";
import type { PrusaLinkSettings } from "../ui/prusa-link.ts";

const store: PrusaLinkStore = localPrusaLinkStore();

export function loadPrusaLink(): PrusaLinkSettings {
  return parsePrusaLink(store.read());
}

export function storePrusaLink(settings: PrusaLinkSettings) {
  store.write(serializePrusaLink(settings));
}
