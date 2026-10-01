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
 * MOCK/TODO: the HTTP slice API does not stream progress or an ETA.
 * Hold indeterminate briefly, then ease toward 90% of a typical slice.
 * Replace this with `progressFromEvent` when a request reports real fractions.
 */
export const MOCK_PROGRESS_TYPICAL_MS = 12_000;
export const MOCK_PROGRESS_HOLD_MS = 400;

export function mockSliceProgress(elapsedMs: number, typicalMs = MOCK_PROGRESS_TYPICAL_MS): SliceProgress {
  if (elapsedMs < MOCK_PROGRESS_HOLD_MS) return { fraction: 0, etaSeconds: null, source: "mock" };
  const fraction = 0.9 * (1 - Math.exp(-elapsedMs / typicalMs));
  const eta = Math.max(0, (typicalMs - elapsedMs) / 1000);
  return { fraction, etaSeconds: eta, source: "mock" };
}

export function formatProgress(sample: SliceProgress): string {
  if (!(sample.fraction > 0)) return "";
  const pct = Math.round(sample.fraction * 100);
  const eta = sample.etaSeconds == null ? "" : ` · ~${Math.max(1, Math.round(sample.etaSeconds))} s`;
  const prefix = sample.source === "mock" ? "est. " : "";
  return `${prefix}${pct}%${eta}`;
}

export function currentSliceProgress(reported: number, elapsedMs: number): SliceProgress {
  if (reported > 0) return progressFromEvent(reported, elapsedMs);
  return mockSliceProgress(elapsedMs);
}

/** Updates the banner bar and the status-line meter. No-op until those nodes exist. */
export function applySliceProgress(sample: SliceProgress) {
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
  const text = formatProgress(sample);
  meter.textContent = text;
  meter.dataset.source = sample.source;
  meter.toggleAttribute("hidden", !text);
}
