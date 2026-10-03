export type ProgressSource = "event" | "mock";

export interface SliceProgress {
  /** 0 means unknown, so the bar stays indeterminate. */
  fraction: number;
  etaSeconds: number | null;
  source: ProgressSource;
}

/** Real `slice-progress` fraction. ETA scales elapsed time by the remaining fraction. */
export function progressFromEvent(fraction: number, elapsedMs: number): SliceProgress {
  const p = Math.min(1, Math.max(0, fraction));
  const eta = p > 0.02 && p < 0.999 ? (elapsedMs / 1000) * ((1 - p) / p) : null;
  return { fraction: p, etaSeconds: eta, source: "event" };
}

/**
 * MOCK: the in-process invoke path has no job stream.
 * Hold indeterminate briefly, then ease toward 90% of a typical slice.
 * HTTP slices follow `/api/jobs` and do not call this.
 */
export const MOCK_PROGRESS_TYPICAL_MS = 12_000;
export const MOCK_PROGRESS_HOLD_MS = 400;

export function mockSliceProgress(elapsedMs: number, typicalMs = MOCK_PROGRESS_TYPICAL_MS): SliceProgress {
  if (elapsedMs < MOCK_PROGRESS_HOLD_MS) return { fraction: 0, etaSeconds: null, source: "mock" };
  const fraction = 0.9 * (1 - Math.exp(-elapsedMs / typicalMs));
  const eta = Math.max(0, (typicalMs - elapsedMs) / 1000);
  return { fraction, etaSeconds: eta, source: "mock" };
}

export function formatProgress(sample: SliceProgress, stage = ""): string {
  const name = stage.trim();
  if (!(sample.fraction > 0)) return name;
  const pct = Math.round(sample.fraction * 100);
  const eta = sample.etaSeconds == null ? "" : ` · ~${Math.max(1, Math.round(sample.etaSeconds))} s`;
  const prefix = sample.source === "mock" ? "est. " : "";
  const head = name ? `${name} · ` : "";
  return `${head}${prefix}${pct}%${eta}`;
}

/**
 * A reported fraction wins. `live` is an HTTP job or the synchronous slice fallback:
 * fraction 0 stays indeterminate instead of the mock curve. The invoke path leaves
 * `live` false, so `mockSliceProgress` still fills in until a Tauri event arrives.
 */
export function currentSliceProgress(reported: number, elapsedMs: number, live = false): SliceProgress {
  if (live || reported > 0) return progressFromEvent(reported, elapsedMs);
  return mockSliceProgress(elapsedMs);
}

/** Updates the banner bar and the status-line meter. No-op until those nodes exist. */
export function applySliceProgress(sample: SliceProgress, stage = "") {
  const bar = document.querySelector<HTMLElement>("[data-state=slicing]");
  if (bar) {
    const known = sample.fraction > 0 && sample.fraction < 1;
    bar.classList.toggle("indeterminate", !known);
    bar.setAttribute("aria-valuenow", known ? String(Math.round(sample.fraction * 100)) : "0");
    const span = bar.querySelector<HTMLElement>("span");
    if (span && known) span.style.width = `${Math.max(4, sample.fraction * 100)}%`;
    if (span && !known) span.style.width = "";
  }
  const meter = document.querySelector<HTMLElement>("#sliceMeter");
  if (!meter) return;
  const text = formatProgress(sample, stage);
  meter.textContent = text;
  meter.dataset.source = sample.source;
  meter.toggleAttribute("hidden", !text);
}
