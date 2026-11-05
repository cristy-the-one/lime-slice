/** The commands this viewer ran last, newest first, kept in localStorage. A private window or blocked storage keeps none. */
export const RECENT_KEY = "lime-slice-recent-commands";
export const RECENT_MAX = 5;

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadRecent(store: Store | null = defaultStore()): string[] {
  try {
    const parsed = JSON.parse(store?.getItem(RECENT_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string"))].slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Puts `id` first, drops a repeat, keeps five. Returns the new list. */
export function pushRecent(id: string, store: Store | null = defaultStore()): string[] {
  const next = [id, ...loadRecent(store).filter((other) => other !== id)].slice(0, RECENT_MAX);
  try {
    store?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage is blocked or full: the list lives for this window only.
  }
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
