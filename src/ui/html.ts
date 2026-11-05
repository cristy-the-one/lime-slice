/**
 * Markup with escaped values. `html\`<b>${name}</b>\`` escapes every interpolated value (`& < > " '`), so a name from a
 * file, a plugin header, a preset, profile, printer or filament, a font, MCP or the engine shows as text and never
 * becomes an element or an attribute. Nested `html` fragments go in as they are; an array of values or fragments is
 * joined. `raw()` marks a string that is trusted markup already (a constant, or a fragment escaped elsewhere), and is
 * the only way to put unescaped text in. `setHtml` is the one place that writes `innerHTML` from such markup; the repo
 * check (src/ui/html-sinks.test.ts) fails on any other non-literal `innerHTML =`.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text safe inside an element or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** Markup built by `html` or marked by `raw`: interpolates as it is. */
export class Html {
  readonly markup: string;
  constructor(markup: string) {
    this.markup = markup;
  }
  toString(): string {
    return this.markup;
  }
}

/** Values `html` takes: text and numbers are escaped, fragments go in as they are, nothing renders as empty. */
export type HtmlValue = Html | string | number | boolean | null | undefined | readonly HtmlValue[];

function piece(value: HtmlValue): string {
  if (value instanceof Html) return value.markup;
  if (value === null || value === undefined || value === false || value === true) return "";
  if (Array.isArray(value)) return value.map(piece).join("");
  return escapeHtml(String(value));
}

/** The tagged template: every `${value}` is escaped unless it is an `Html` fragment. */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += piece(values[i]!) + strings[i + 1]!;
  return new Html(out);
}

/** Trusted markup, unescaped: a constant, or a fragment another builder escaped. Never a name or file text. */
export function raw(markup: string): Html {
  return new Html(markup);
}

/** Fragments joined with nothing between them, as one fragment. */
export function joinHtml(parts: readonly Html[], separator: Html = raw("")): Html {
  return new Html(parts.map((part) => part.markup).join(separator.markup));
}

/** Replace an element's children with escaped markup. */
export function setHtml(node: Element, markup: Html): void {
  node.innerHTML = markup.markup;
}

/** Insert escaped markup next to or inside an element. */
export function insertHtml(node: Element, where: InsertPosition, markup: Html): void {
  node.insertAdjacentHTML(where, markup.markup);
}
