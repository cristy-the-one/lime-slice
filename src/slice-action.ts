/**
 * Slice-button state. The label is whatever the next request will actually do.
 *
 * `slice_payload` drops `reslice`, then hashes the rest with `feed` (sorted
 * object keys). A matching entry is reused. `reslice: true` plans again and
 * replaces that entry. `feed` here copies that layout so two recipes compare
 * equal exactly when the slicer would reuse one.
 */

export type SliceActionState = "none" | "cached" | "changed" | "force";

export interface SliceActionInput {
  /** A finished slice for this exact recipe is already in the cache. */
  cached: boolean;
  /** The result on screen was planned for a different recipe. */
  settingsChanged: boolean;
  /** Plan again even when the cache would serve this recipe. */
  force: boolean;
}

export interface SliceAction {
  state: SliceActionState;
  label: "Slice" | "Show result" | "Re-slice" | "Force re-slice";
  /** Tooltip. The control's accessible name is `label`. */
  detail: string;
  /** Sent as `reslice`. True only when a cached recipe is forced. */
  reslice: boolean;
  /** The engine will plan. False when the cached result is used. */
  recompute: boolean;
}

export const FORCE_LABEL = "Force re-slice" as const;

/**
 * none: nothing cached for this recipe, so the next request plans it ("Slice").
 * cached: this recipe is already stored, so the next request shows it ("Show result").
 * changed: settings differ and this recipe is not stored, so the next request plans it ("Re-slice").
 * force: the user asked to plan a stored recipe again ("Force re-slice").
 */
export function sliceAction(input: SliceActionInput): SliceAction {
  if (input.force && input.cached) {
    return {
      state: "force",
      label: FORCE_LABEL,
      detail: "Plan this slice again instead of showing the saved one.",
      reslice: true,
      recompute: true,
    };
  }
  if (input.cached) {
    return {
      state: "cached",
      label: "Show result",
      detail: "Show the saved slice for these settings. Nothing is recomputed.",
      reslice: false,
      recompute: false,
    };
  }
  if (input.settingsChanged) {
    return {
      state: "changed",
      label: "Re-slice",
      detail: "Settings changed. Plan this slice again.",
      reslice: false,
      recompute: true,
    };
  }
  return {
    state: "none",
    label: "Slice",
    detail: "Plan this slice.",
    reslice: false,
    recompute: true,
  };
}

export function sliceBusyLabel(recompute: boolean): "Slicing…" | "Loading…" {
  return recompute ? "Slicing…" : "Loading…";
}

export function sliceBusyStatus(meshName: string, recompute: boolean): string {
  return recompute ? `Slicing ${meshName}…` : `Loading saved slice for ${meshName}…`;
}

export function cacheStatus(blend: string, when: string): string {
  return `${blend} · Loaded from cache, sliced ${when}. Force re-slice to plan it again.`;
}

export function staleSliceCopy(state: SliceActionState): { banner: string; status: string } {
  if (state === "cached") {
    return {
      banner: "Settings changed since this slice. Export stays off until you show the saved result.",
      status: "This preview is stale. Show the saved result before export.",
    };
  }
  if (state === "changed" || state === "force") {
    return {
      banner: "Settings changed since this slice. Export stays off until you re-slice.",
      status: "This preview is stale. Re-slice before export.",
    };
  }
  return {
    banner: "Settings changed since this slice. Export stays off until you slice.",
    status: "This preview is stale. Slice before export.",
  };
}

/** One banner line for the overhang patches the supports leave unheld, or `null` when there are none. */
export function coverageWarning(gaps: readonly { areaMm2: number }[]): string | null {
  if (!gaps.length) return null;
  const total = gaps.reduce((sum, g) => sum + g.areaMm2, 0);
  const patches = gaps.length === 1 ? "1 overhang patch" : `${gaps.length} overhang patches`;
  return `Supports leave ${patches} unheld, ${total.toFixed(1)} mm² in all.`;
}

/** One banner line for what prints over air with supports off, or `null` when nothing does. */
export function inAirWarning(air: { islands: number; overhangs: number } | undefined): string | null {
  if (!air) return null;
  const count = (n: number, one: string) => (n === 0 ? [] : [n === 1 ? `1 ${one}` : `${n} ${one}s`]);
  const parts = [...count(air.islands, "island"), ...count(air.overhangs, "overhang")];
  if (!parts.length) return null;
  return `Supports are off. ${parts.join(" and ")} would print in the air. Tick Smart supports to hold them up.`;
}

/** Fields the slicer strips or that the UI replaces before comparing recipes. */
const SKIPPED = new Set(["reslice", "dataB64"]);

/**
 * Identity of one slice request. `meshFingerprint` stands in for `dataB64`:
 * the slicer hashes those bytes inside the request, and the same bytes must
 * keep the same key. `reslice` is omitted, matching `slice_payload`.
 */
export function recipeKey(request: unknown, meshFingerprint: string): string {
  const body =
    request && typeof request === "object" && !Array.isArray(request)
      ? Object.fromEntries(Object.entries(request as Record<string, unknown>).filter(([key, value]) => !SKIPPED.has(key) && value !== undefined))
      : request;
  return `${feed(body)}\n${meshFingerprint}`;
}

/**
 * Canonical layout of `lime_slice_core::slice_cache::feed`.
 * Objects sort their keys and write no commas. Arrays keep order and a trailing comma.
 */
export function feed(value: unknown): string {
  if (Array.isArray(value)) {
    let out = "[";
    for (const item of value) out += `${feed(item)},`;
    return `${out}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    let out = "{";
    for (const key of keys) out += `${feed(key)}:${feed(obj[key])}`;
    return `${out}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** FNV-1a 64-bit, hex. Same bytes in, same fingerprint out. */
export function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
