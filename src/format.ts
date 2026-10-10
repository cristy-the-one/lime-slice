/**
 * Every number the app prints for a duration, mass, length, count, share or price. The unit follows the
 * size of the value, so a 17 h print reads "16 h 46 min" instead of "1006 min 11 s", and a column of them stays short.
 */

const MISSING = "—";

/** Round to `digits` places as a string, keeping trailing zeros. */
function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

const separated = new Map<string, Intl.NumberFormat>();
function grouped(value: number, digits: number, locale?: string): string {
  const key = `${locale ?? ""}:${digits}`;
  let format = separated.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    separated.set(key, format);
  }
  return format.format(value);
}

/**
 * "42 s", "5 min 34 s", "16 h 46 min", "2 d 3 h". Below ten seconds one decimal stays, so a layer
 * of 1.2 s does not read "1 s". Seconds stop once hours show, minutes stop once days show.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return MISSING;
  const total = Math.max(0, seconds);
  if (total === 0) return "0 s";
  if (total < 9.95) return `${fixed(total, 1)} s`;
  const whole = Math.round(total);
  if (whole < 60) return `${whole} s`;
  if (whole < 3600) return `${Math.floor(whole / 60)} min ${whole % 60} s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  const hours = Math.round(minutes / 60);
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** A duration as a big number and the unit under it, for a tile: "16:46" over "h:min". */
export function durationTile(seconds: number): { value: string; unit: string } {
  const total = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const whole = Math.round(total);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (whole < 60) return { value: String(whole), unit: "s" };
  if (whole < 3600) return { value: `${Math.floor(whole / 60)}:${pad(whole % 60)}`, unit: "min:s" };
  const minutes = Math.round(whole / 60);
  if (minutes < 1440) return { value: `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`, unit: "h:min" };
  const hours = Math.round(minutes / 60);
  return { value: `${Math.floor(hours / 24)}:${pad(hours % 24)}`, unit: "d:h" };
}

/** "2.59 g" under 10 g, "136.4 g" up to a kilogram, "1.24 kg" beyond. */
export function formatMass(grams: number): string {
  if (!Number.isFinite(grams)) return MISSING;
  const g = Math.max(0, grams);
  if (g < 10) return `${fixed(g, 2)} g`;
  if (Math.round(g * 10) / 10 < 1000) return `${fixed(g, 1)} g`;
  return `${fixed(g / 1000, 2)} kg`;
}

/** "843 mm" under a metre, "54.5 m" under a kilometre, "2.06 km" beyond. Under 10 mm one decimal stays. */
export function formatLength(mm: number): string {
  if (!Number.isFinite(mm)) return MISSING;
  const v = Math.max(0, mm);
  if (v < 10) return `${fixed(v, 1)} mm`;
  if (Math.round(v) < 1000) return `${Math.round(v)} mm`;
  if (Math.round(v / 100) / 10 < 1000) return `${fixed(v / 1000, 1)} m`;
  return `${fixed(v / 1_000_000, 2)} km`;
}

/** Filament length, always in metres: "0.87 m", "54.5 m", "1,234.5 m". */
export function formatMetres(mm: number, locale?: string): string {
  if (!Number.isFinite(mm)) return MISSING;
  const m = Math.max(0, mm) / 1000;
  return `${grouped(m, m < 10 ? 2 : 1, locale)} m`;
}

/** "87,113" in the viewer's locale, or "87.1k" / "2.1M" when `compact` and the number would be long. */
export function formatCount(n: number, locale?: string, compact = false): string {
  if (!Number.isFinite(n)) return MISSING;
  const v = Math.round(n);
  if (!compact || Math.abs(v) < 1000) return grouped(v, 0, locale);
  const [scaled, suffix] = Math.abs(v) < 1_000_000 ? [v / 1000, "k"] : [v / 1_000_000, "M"];
  const rounded = Math.round(scaled * 10) / 10;
  return `${grouped(rounded, rounded % 1 === 0 ? 0 : 1, locale)}${suffix}`;
}

/** A share of a whole, "24%". */
export function formatPercent(pct: number): string {
  return Number.isFinite(pct) ? `${Math.round(pct)}%` : MISSING;
}

const money = new Map<string, Intl.NumberFormat>();
/** A price in euro for the viewer's locale: "€3.41", "3,41 €". */
export function formatMoney(amount: number, locale?: string): string {
  if (!Number.isFinite(amount)) return MISSING;
  let format = money.get(locale ?? "");
  if (!format) {
    format = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
    money.set(locale ?? "", format);
  }
  return format.format(amount);
}

/** A stage time from the engine, "13.8 ms", with the seconds beside it from a second up. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return MISSING;
  const n = Math.max(0, ms);
  const text = n >= 100 ? `${n.toFixed(0)} ms` : `${n.toFixed(1)} ms`;
  if (n >= 1000) return `${text} · ${(n / 1000).toFixed(n >= 10000 ? 1 : 2)} s`;
  return text;
}
