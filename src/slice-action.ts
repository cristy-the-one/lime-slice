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

/**
 * Whether sending the same request again could work. The engine refuses a bad
 * request with an error that names the field, and refuses it the same way
 * every time. Only a server failure or an unreadable reply is worth a retry.
 */
export function sliceErrorRetryable(message: string): boolean {
  return /^slice failed \(5\d\d\)/.test(message) || /^(Unexpected (token|end)|JSON)/.test(message);
}

export function sliceBusyLabel(recompute: boolean): "Slicing…" | "Loading…" {
  return recompute ? "Slicing…" : "Loading…";
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
  return `Supports are off. ${parts.join(" and ")} would print in the air.`;
}

/** Fields the slicer strips or that the UI replaces before comparing recipes. */
const SKIPPED = new Set(["reslice", "dataB64", "meshRef", "previewBase"]);

/**
 * Identity of one slice request. `meshFingerprint` stands in for `dataB64`
 * or `meshRef`: the same bytes keep the same key however they are sent.
 * `reslice` is omitted, matching `slice_payload`.
 */
export function recipeKey(request: unknown, meshFingerprint: string): string {
  const body =
    request && typeof request === "object" && !Array.isArray(request)
      ? Object.fromEntries(Object.entries(request as Record<string, unknown>).filter(([key, value]) => !SKIPPED.has(key) && value !== undefined))
      : request;
  return `${feed(body)}\n${meshFingerprint}`;
}

/**
 * `recipeKey` without the X/Y translation of the pose, or of every plate
 * object's pose. The engine slices each posed part in its own frame
 * (`docs/part-frame.md`), so two requests with one part-frame key differ at
 * most by bed moves of any of their objects, which only re-emit the G-code.
 */
export function partFrameKey(request: Record<string, unknown>, meshFingerprint: string): string {
  type Posed = { pose?: { translation: number[] } };
  const inFrame = <T extends Posed>(item: T): T =>
    item.pose ? { ...item, pose: { ...item.pose, translation: [item.pose.translation[2]] } } : item;
  const objects = request.objects as Posed[] | undefined;
  return recipeKey({ ...inFrame(request as Posed), ...(objects ? { objects: objects.map(inFrame) } : {}) }, meshFingerprint);
}

/** A plate whose last slice took longer than this waits for the user instead of re-slicing after each edit. */
export const AUTO_SLICE_MAX_MS = 20_000;

/** Before any slice there is no time to go by, so the mesh size stands in for it. */
const AUTO_SLICE_FIRST_TRIANGLES = 200_000;

/** Whether auto-slice re-slices after a change: by the engine time of the last slice, or by mesh size before one. */
export function autoSliceAllowed(input: { lastSliceMs: number | null; triangles: number }): boolean {
  return input.lastSliceMs === null ? input.triangles < AUTO_SLICE_FIRST_TRIANGLES : input.lastSliceMs <= AUTO_SLICE_MAX_MS;
}

/**
 * A stale result the engine refreshes without planning: a stored recipe, or a
 * move in X/Y only. Those run by themselves after a pause, even with auto-slice off.
 * After a result loaded from the disk cache, the engine plans it again in the
 * background, so a move re-emits from that plan once it is ready.
 */
export function quietRefresh(input: { stale: boolean; cached: boolean; sameFrame: boolean }): boolean {
  return input.stale && (input.cached || input.sameFrame);
}

/**
 * Whether the engine keeps the reply to `next` on disk. It skips a request that
 * only moves the one before it on the bed: the same part frame, another recipe.
 */
export function storesReply(prev: { frame: string; recipe: string } | null, next: { frame: string; recipe: string }): boolean {
  return !prev || prev.frame !== next.frame || prev.recipe === next.recipe;
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

/** FNV-1a 64-bit, hex. Same bytes in, same fingerprint out. Saved projects carry it. */
export function fnv1aHex(bytes: Uint8Array): string {
  const h = fnvStart();
  fnvFold(h, bytes, 0, bytes.length);
  return fnvHex(h);
}

/**
 * The same hash folded four bytes at a time, then the tail bytes: a quarter of the steps, 21 ms on 24 MB.
 * Recipe keys and mesh refs only live in this session, so they use this; a saved project keeps `fnv1aHex`.
 */
export function meshKeyHex(bytes: Uint8Array): string {
  const words = bytes.length >>> 2;
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  const h = fnvStart();
  fnvFold(h, new Uint32Array(aligned.buffer, aligned.byteOffset, words), 0, words);
  fnvFold(h, bytes, words * 4, bytes.length);
  return fnvHex(h);
}

function fnvStart(): Uint32Array {
  return Uint32Array.of(0xcbf29ce4, 0x84222325);
}

/**
 * Two 32-bit halves: a BigInt per byte took 0.4 s on a 24 MB mesh.
 * The prime is 2^40 + 0x1b3, so a product is h * 0x1b3 plus the low half shifted 8 into the high one.
 */
function fnvFold(h: Uint32Array, values: Uint8Array | Uint32Array, from: number, to: number): void {
  let hi = h[0]!;
  let lo = h[1]!;
  for (let i = from; i < to; i++) {
    lo ^= values[i]!;
    const low = (lo >>> 0) * 0x1b3;
    hi = (Math.imul(hi, 0x1b3) + Math.floor(low / 0x100000000) + (lo << 8)) >>> 0;
    lo = low >>> 0;
  }
  h[0] = hi;
  h[1] = lo;
}

function fnvHex(h: Uint32Array): string {
  return h[0]!.toString(16).padStart(8, "0") + h[1]!.toString(16).padStart(8, "0");
}
