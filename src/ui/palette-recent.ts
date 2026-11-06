/** The commands this viewer ran last, newest first, kept in the saved preferences. A private window or blocked storage keeps none. */
import { prefs, prefsOver, type PrefStorage, type Prefs } from "../prefs.ts";

export const RECENT_KEY = "lime-slice-recent-commands";
export const RECENT_MAX = 5;

type Store = Pick<PrefStorage, "getItem" | "setItem">;

/** No store given means the app's preferences; `null` means no storage at all. */
function over(store: Store | null | undefined): Prefs {
  return store === undefined ? prefs : prefsOver(store);
}

export function loadRecent(store?: Store | null): string[] {
  try {
    const parsed = over(store).getJson(RECENT_KEY);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string"))].slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Puts `id` first, drops a repeat, keeps five. Returns the new list. */
export function pushRecent(id: string, store?: Store | null): string[] {
  const next = [id, ...loadRecent(store).filter((other) => other !== id)].slice(0, RECENT_MAX);
  over(store).setJson(RECENT_KEY, next); // blocked or full storage: the list lives for this window only
  return next;
}

/**
 * What the palette shows with an empty search: the recent commands that still exist and may be listed, then the rest in
 * registry order. The palette's own row and ids that are no longer commands never show as recent.
 */
export function withRecents<T extends { id: string }>(items: T[], recent: string[], skip: ReadonlySet<string> = new Set()): { top: T[]; rest: T[] } {
  const top: T[] = [];
  for (const id of recent) {
    const item = items.find((candidate) => candidate.id === id);
    if (item && !skip.has(id) && !top.includes(item)) top.push(item);
  }
  return { top, rest: items.filter((item) => !top.includes(item)) };
}
