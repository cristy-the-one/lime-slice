/**
 * The same ranges the settings panel uses. A profile file is not a way around them.
 */
import type { PresetSettings } from "../src/presets.ts";
import { CONTROLS, type ControlKind, type SchemaContext, type Settings } from "../src/ui/settings-schema.ts";

function limit(kind: ControlKind, ctx: SchemaContext): { min: number; max: number } | null {
  if (kind.type !== "number" && kind.type !== "range") return null;
  const max = typeof kind.max === "function" ? kind.max(ctx) : kind.max;
  return { min: kind.min, max };
}

function sentence(label: string, min: number, max: number): string {
  const unit = /mm\/s/i.test(label) ? " mm/s" : /%/.test(label) ? "%" : /\bmm\b/i.test(label) ? " mm" : "";
  const name = label.replace(/\s*mm\/s$/i, "").replace(/\s*mm$/i, "").replace(/\s*%$/i, "").trim();
  return `${name} must be from ${min}–${max}${unit}.`;
}

/** The value the panel shows. Some controls store a fraction and display a percent. */
function shownValue(control: (typeof CONTROLS)[number], settings: PresetSettings): unknown {
  if (!control.get) return control.preset ? settings[control.preset] : undefined;
  try {
    return control.get(settings as unknown as Settings);
  } catch {
    return control.preset ? settings[control.preset] : undefined;
  }
}

/** The first preset value outside its control, in the panel's words. */
export function settingsRangeError(settings: PresetSettings, ctx: SchemaContext = { belt: false, lineWidth: 0.45 }): string | null {
  for (const control of CONTROLS) {
    if (!control.preset) continue;
    const value = shownValue(control, settings);
    const span = limit(control.kind, ctx);
    if (span && typeof value === "number" && Number.isFinite(value) && (value < span.min || value > span.max)) {
      return sentence(control.label, span.min, span.max);
    }
    if ((control.kind.type === "select" || control.kind.type === "segmented") && typeof value === "string") {
      const options = typeof control.kind.options === "function" ? control.kind.options(ctx) : control.kind.options;
      if (!options.some(([id]) => id === value)) return `${control.label} must be one of ${options.map(([id]) => id).join(", ")}.`;
    }
  }
  return null;
}
