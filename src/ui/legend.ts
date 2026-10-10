import { formatDuration, formatPercent } from "../format";

export interface LegendRow {
  kind: string;
  label: string;
  color: string;
  /** Seconds from estimate.byFeature, when the slice reported them. */
  seconds: number | null;
  sharePct: number | null;
  shown: boolean;
}

export function mountLegend() {
  document.querySelector("#legend")?.addEventListener("click", (ev) => {
    const button = (ev.target as Element | null)?.closest<HTMLButtonElement>(".legend-toggle");
    if (!button) return;
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", open ? "true" : "false");
    document.querySelector("#legendRows")?.toggleAttribute("hidden", !open);
  });
}

export function legendMarkup(rows: LegendRow[], scarf: boolean): string {
  if (rows.length === 0) return "";
  const host = document.querySelector("#legend");
  const expanded = host?.querySelector(".legend-toggle")?.getAttribute("aria-expanded") !== "false";
  const body = rows.map((row) => {
    const time = row.seconds == null ? "" : ` · ${formatDuration(row.seconds)}`;
    const share = row.sharePct == null ? "" : ` · ${formatPercent(row.sharePct)}`;
    const exact = row.seconds == null ? "" : ` data-seconds="${row.seconds.toFixed(1)}"`;
    return `<label${exact}><input type="checkbox" data-kind="${escapeAttr(row.kind)}" ${row.shown ? "checked" : ""}/><i class="swatch" style="background:${escapeAttr(row.color)}"></i>${escapeHtml(row.label)}${time}${share}</label>`;
  }).join("");
  const scarfMark = scarf ? `<span><i class="swatch" style="background:#fff"></i>Scarf ramp</span>` : "";
  return `<button class="btn legend-toggle" type="button" aria-expanded="${expanded ? "true" : "false"}" aria-controls="legendRows">Features</button><div id="legendRows" class="legend-rows"${expanded ? "" : " hidden"}>${body}${scarfMark}</div>`;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function escapeAttr(text: string) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
