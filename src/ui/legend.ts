import { FEATURE_LABEL, featureColor } from "../colors.ts";
import { formatDuration, formatMass, formatPercent } from "../format.ts";

/** One printed feature: what it is, what it cost, and whether the preview draws it. */
export interface FeatureRow {
  kind: string;
  label: string;
  color: string;
  /** Seconds from estimate.byFeature, when the slice reported them. */
  seconds: number | null;
  sharePct: number | null;
  /** Filament in millimetres, when the slice reported it. */
  filamentMm: number | null;
  /** The preview draws it, so it can be shown or hidden. */
  drawn: boolean;
  shown: boolean;
}

interface FeatureSource {
  /** Kinds the preview layers draw. */
  kinds: Iterable<string>;
  estimate?: { seconds: number; byFeature?: { kind: string; seconds: number; filamentMm: number }[] };
  hidden: ReadonlySet<string>;
  showTravel: boolean;
}

/**
 * The feature rows the Features flyout and the results share, so both read the same numbers.
 * Every kind the layers draw or the estimate times, in label order.
 */
export function featureRows(source: FeatureSource): FeatureRow[] {
  const est = source.estimate;
  const total = Math.max(0.001, est?.seconds ?? 1);
  const by = new Map((est?.byFeature ?? []).map((row) => [row.kind, row]));
  const drawn = new Set(source.kinds);
  const kinds = new Set([...drawn, ...by.keys()]);
  return [...kinds].map((kind) => {
    const row = by.get(kind);
    return {
      kind,
      label: FEATURE_LABEL[kind] ?? kind,
      color: featureColor(kind),
      seconds: row ? row.seconds : null,
      sharePct: row ? (row.seconds / total) * 100 : null,
      filamentMm: row ? row.filamentMm : null,
      drawn: drawn.has(kind),
      shown: kind === "travel" ? source.showTravel : !source.hidden.has(kind),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/** The Features flyout: a checkbox per feature, with its time and share. */
export function legendMarkup(rows: FeatureRow[], scarf: boolean): string {
  const drawn = rows.filter((row) => row.drawn);
  if (drawn.length === 0) return "";
  const body = drawn.map((row) => {
    const time = row.seconds == null ? "" : ` · ${formatDuration(row.seconds)}`;
    const share = row.sharePct == null ? "" : ` · ${formatPercent(row.sharePct)}`;
    const exact = row.seconds == null ? "" : ` data-seconds="${row.seconds.toFixed(1)}"`;
    return `<label${exact}>${toggle(row)}${escapeHtml(row.label)}${time}${share}</label>`;
  }).join("");
  const scarfMark = scarf ? `<span><i class="swatch" style="background:#fff"></i>Scarf ramp</span>` : "";
  return `<div class="legend-rows">${body}${scarfMark}</div>`;
}

/** The results rows: the same checkboxes, with a bar for the share, the time and the filament. */
export function featureTableMarkup(rows: FeatureRow[], grams: (filamentMm: number) => number): string {
  const timed = rows.filter((row) => (row.seconds ?? 0) > 0.05 || (row.filamentMm ?? 0) > 0.01);
  const longest = Math.max(0.001, ...timed.map((row) => row.seconds ?? 0));
  return timed.map((row) => {
    const width = Math.min(100, ((row.seconds ?? 0) / longest) * 100);
    return `<div class="est-row"><label class="est-label">${toggle(row)}${escapeHtml(row.label)}</label><div class="bar"><span style="width:${width}%;background:${escapeAttr(row.color)}"></span></div><span class="est-time">${formatDuration(row.seconds ?? 0)}</span><span class="est-mass">${formatMass(grams(row.filamentMm ?? 0))}</span></div>`;
  }).join("");
}

/** A drawn feature's show checkbox and swatch; a feature the preview does not draw gets the swatch alone. */
function toggle(row: FeatureRow) {
  const swatch = `<i class="swatch" style="background:${escapeAttr(row.color)}"></i>`;
  if (!row.drawn) return `<span class="est-check" aria-hidden="true"></span>${swatch}`;
  return `<input type="checkbox" data-kind="${escapeAttr(row.kind)}" ${row.shown ? "checked" : ""}/>${swatch}`;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function escapeAttr(text: string) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
