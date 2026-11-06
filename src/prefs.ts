/**
 * Every saved preference of the app lives behind this module. Nothing else touches localStorage or sessionStorage
 * (src/prefs.test.ts fails if it does). A blocked, full, throwing or missing storage never throws from here: a read
 * answers the default and a write does nothing, so startup never breaks on it.
 *
 * Add a key to PREF_REGISTRY (or PREF_FAMILIES for a prefix with a per-item tail) before you use it; the key types make
 * an unregistered name a compile error. Stored formats are the ones the app has always written, so saved settings load
 * unchanged: booleans are "1"/"0", lists and objects are JSON text, everything else is the plain string.
 */

export type PrefType = "string" | "bool" | "number" | "json";

export interface PrefDef {
  type: PrefType;
  /** What a read answers when nothing (or something unreadable) is stored. `null` means "not set". */
  default: string | number | boolean | null | unknown[] | Record<string, unknown>;
  purpose: string;
}

/** The single list of keys. Names are the stored keys, unchanged since the first release that wrote them. */
export const PREF_REGISTRY = {
  "lime-slice-theme": { type: "string", default: "system", purpose: "Colour theme: light, dark or system." },
  "lime-slice-layout": { type: "string", default: "auto", purpose: "Layout override: auto, desktop or compact." },
  "lime-slice-chrome": { type: "string", default: null, purpose: "Window frame choice on desktop: native or custom." },
  "lime-slice-settings-level": { type: "string", default: null, purpose: "Settings level (simple, advanced, expert); unset means a first run." },
  "lime-slice-closed-groups": { type: "json", default: null, purpose: "Settings groups the user closed (list of ids); unset means each group's default." },
  "lime-slice-settings-profiles": { type: "json", default: null, purpose: "Named settings profiles library (JSON text)." },
  "lime-slice-machines": { type: "json", default: null, purpose: "Printer, filament and nozzle library (JSON text)." },
  "lime-slice.profile.v1": { type: "json", default: null, purpose: "The current printer profile." },
  "lime-slice-auto-slice": { type: "bool", default: true, purpose: "Auto-slice switch in the gear menu." },
  "lime-slice-settle": { type: "bool", default: false, purpose: "Bed-rest settle switch." },
  "lime-slice-measure": { type: "bool", default: true, purpose: "Measure tool switch." },
  "lime-slice-grab-hint": { type: "bool", default: false, purpose: "The grab hint was shown once." },
  "lime-slice-open-subgroups": { type: "json", default: [], purpose: "Folded parts inside a settings card the user opened (list of ids), e.g. the Objects card's rotation and alignment." },
  "lime-slice-rail-captions": { type: "bool", default: true, purpose: "Short names under the Prepare and Preview rail icons." },
  "lime-slice-rail-labels": { type: "bool", default: false, purpose: "Rail buttons show text labels." },
  "lime-slice-api": { type: "string", default: "", purpose: "Engine URL override from the gear menu." },
  "lime-slice-api-token": { type: "string", default: "", purpose: "Shared engine token from the gear menu." },
  "lime-slice-dock-panes": { type: "json", default: {}, purpose: "Dock pane sizes by pane id." },
  "lime-slice-dock-last": { type: "string", default: null, purpose: "Which dock was open last." },
  "lime-slice-panel-left": { type: "string", default: null, purpose: "Left dock width in px (dragged)." },
  "lime-slice-panel-right": { type: "string", default: null, purpose: "Right dock width in px (dragged)." },
  "lime-slice-panel-left-collapsed": { type: "string", default: null, purpose: "Left dock collapsed state." },
  "lime-slice-panel-right-collapsed": { type: "string", default: null, purpose: "Right dock collapsed state." },
  "lime-slice-model-bed": { type: "bool", default: true, purpose: "Model view shows the bed." },
  "lime-slice-model-feature": { type: "string", default: "pocket", purpose: "Last feature tool picked in the Model menu." },
  "lime-slice-model-history-collapsed": { type: "bool", default: false, purpose: "Model history panel is collapsed." },
  "lime-slice-model-params-folded-order": { type: "string", default: null, purpose: "Projects that remember a parameters fold, oldest first, newline separated." },
  "lime-slice-recent-commands": { type: "json", default: [], purpose: "Command palette recents, newest first (list of ids)." },
  "lime-slice-plugins-approved": { type: "json", default: [], purpose: "SHA-256 of imported plugins the user approved." },
  "lime-slice-plugins-used": { type: "json", default: {}, purpose: "Plugin id to last-used time." },
  "lime-slice-plugins-live": { type: "bool", default: true, purpose: "Plugins panel live-preview switch." },
  "lime-slice-plugins-kind": { type: "string", default: null, purpose: "Plugins panel kind filter." },
  "lime-slice-plugin-author": { type: "string", default: "", purpose: "Plugin author name when the library has no settings.json." },
  "lime.stress.deformed": { type: "bool", default: false, purpose: "Stress view shows the deformed shape." },
  "lime-slice-presets": { type: "json", default: null, purpose: "Legacy presets store: read once, migrated to settings profiles, then removed." },
  "lime-slice-prusa-link": { type: "json", default: null, purpose: "Legacy Prusa Link host: read once, moved into the machine library, then removed." },
} as const satisfies Record<string, PrefDef>;

/** Keys with a per-item tail, e.g. `lime-slice-how-split-print`. */
export const PREF_FAMILIES = {
  "lime-slice-how-": { type: "number", default: 0, purpose: "How many times a how-to card opened (tail is the feature name)." },
  "lime-slice-model-params-folded:": { type: "bool", default: false, purpose: "Parameters section fold per project (tail is the project path)." },
} as const satisfies Record<string, PrefDef>;

export type PrefKey = keyof typeof PREF_REGISTRY;
export type PrefFamily = keyof typeof PREF_FAMILIES;
export type AnyPrefKey = PrefKey | `${PrefFamily}${string}`;

export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defOf(key: string): PrefDef | undefined {
  const exact = (PREF_REGISTRY as Record<string, PrefDef>)[key];
  if (exact) return exact;
  for (const prefix of Object.keys(PREF_FAMILIES)) if (key.startsWith(prefix)) return (PREF_FAMILIES as Record<string, PrefDef>)[prefix];
  return undefined;
}

export interface Prefs {
  /** The stored text, or null when unset or unreadable. */
  get(key: AnyPrefKey): string | null;
  /** True when the write went through. */
  set(key: AnyPrefKey, value: string): boolean;
  remove(key: AnyPrefKey): boolean;
  /** "1" is true, "0" is false, anything else answers the registered default. */
  getBool(key: AnyPrefKey): boolean;
  setBool(key: AnyPrefKey, on: boolean): boolean;
  /** A finite stored number, else `fallback`, else the registered default. */
  getNumber(key: AnyPrefKey, fallback?: number): number;
  setNumber(key: AnyPrefKey, value: number): boolean;
  /** Parsed JSON, or the registered default when unset or not JSON. The caller still checks the shape. */
  getJson(key: AnyPrefKey): unknown;
  setJson(key: AnyPrefKey, value: unknown): boolean;
}

/** A prefs object over any storage; `getStorage` may throw or answer null (no storage). The app uses `prefs` below. */
export function createPrefs(getStorage: () => PrefStorage | null | undefined): Prefs {
  const read = (key: string): string | null => {
    try {
      return getStorage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): boolean => {
    try {
      const storage = getStorage();
      if (!storage) return false;
      storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  };
  const fresh = (key: string): unknown => {
    const base = defOf(key)?.default ?? null;
    return base !== null && typeof base === "object" ? structuredClone(base) : base;
  };
  return {
    get: read,
    set: write,
    remove(key) {
      try {
        const storage = getStorage();
        if (!storage) return false;
        storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
    getBool(key) {
      const raw = read(key);
      if (raw === "1") return true;
      if (raw === "0") return false;
      return defOf(key)?.default === true;
    },
    setBool: (key, on) => write(key, on ? "1" : "0"),
    getNumber(key, fallback) {
      const raw = read(key);
      if (raw !== null) {
        const value = Number(raw);
        if (Number.isFinite(value)) return value;
      }
      if (fallback !== undefined) return fallback;
      const base = defOf(key)?.default;
      return typeof base === "number" ? base : 0;
    },
    setNumber: (key, value) => write(key, String(value)),
    getJson(key) {
      const raw = read(key);
      if (raw === null) return fresh(key);
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return fresh(key);
      }
    },
    setJson(key, value) {
      try {
        return write(key, JSON.stringify(value));
      } catch {
        return false;
      }
    },
  };
}

/** Prefs over a given storage object (tests, injected stores). Missing removeItem is a no-op. */
export function prefsOver(storage: (Pick<PrefStorage, "getItem" | "setItem"> & Partial<Pick<PrefStorage, "removeItem">>) | null): Prefs {
  return createPrefs(() =>
    storage
      ? { getItem: (key) => storage.getItem(key), setItem: (key, value) => storage.setItem(key, value), removeItem: (key) => storage.removeItem?.(key) }
      : null,
  );
}

/** The app's preferences, over `localStorage` when it exists and works. */
export const prefs: Prefs = createPrefs(() => globalThis.localStorage);
