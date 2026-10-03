/**
 * Prusa Link URL and API key live in the browser.
 * The slicer engine has no printer-host API. `localPrusaLinkStore` is the UI adapter for that.
 * The key is not sent to the slicer. It is only sent to the printer as the X-Api-Key header.
 */
import { emptyPrusaLink, type PrusaLinkSettings } from "./prusa-link.ts";

export const PRUSA_LINK_KEY = "lime-slice-prusa-link";

export interface PrusaLinkStore {
  read(): string | null;
  write(text: string): void;
}

export function localPrusaLinkStore(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): PrusaLinkStore {
  return {
    read: () => storage.getItem(PRUSA_LINK_KEY),
    write: (text) => storage.setItem(PRUSA_LINK_KEY, text),
  };
}

export function serializePrusaLink(settings: PrusaLinkSettings): string {
  return JSON.stringify(settings);
}

export function parsePrusaLink(text: string | null): PrusaLinkSettings {
  if (!text) return emptyPrusaLink();
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyPrusaLink();
    const row = raw as Record<string, unknown>;
    if (row.version !== 1) return emptyPrusaLink();
    return {
      version: 1,
      url: typeof row.url === "string" ? row.url : "",
      apiKey: typeof row.apiKey === "string" ? row.apiKey : "",
      startPrint: row.startPrint === true,
    };
  } catch {
    return emptyPrusaLink();
  }
}
