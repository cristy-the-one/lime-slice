/**
 * The fonts that ship with the app for modelling text (docs/plan-text-on-curves-and-fonts.md D2), by id. The engine reads
 * the same files compiled into it (`crates/lime-model-occt/src/text/fonts.rs`, which `mcp/text-fonts.test.ts` compares
 * this table with); the UI loads them from `public/fonts/model/` to draw the picker and the sample line.
 *
 * `stroke` is today's single-stroke grid font, kept for engraving-style lettering: a step without a font, or with
 * `stroke`, builds exactly as every text step did before fonts.
 */

export type TextStyle = "regular" | "bold" | "italic" | "bold-italic";

export interface TextFont {
  /** The id a step names it by, without the version. */
  id: string;
  /** The version of the files: `sans@4.0`. A new release of a font is a new version, never a change in place. */
  version: string;
  /** What the picker shows. */
  name: string;
  /** One line for the picker and the guide. */
  about: string;
  /** The CSS family the UI draws it in. */
  family: string;
  /** The style files the app has; a missing italic is made with a slant. */
  has: Record<TextStyle, boolean>;
  /** The file of each style the font has, under `/fonts/model/`. */
  files: Partial<Record<TextStyle, string>>;
}

export const STROKE_FONT = "stroke";

/** --- Text milestone 4. A font the person added has an id of its own: `user:` and 16 hex digits of the file's SHA-256. */
export const USER_FONT_PREFIX = "user:";

/** Whether a step's `font` names a font the person added. */
export function isUserFont(font: unknown): font is string {
  return typeof font === "string" && font.startsWith(USER_FONT_PREFIX);
}

/** What the card needs to know of a font the person added: its name, which styles it has, its weight axis, its licence. */
export interface UserFontView {
  id: string;
  name: string;
  family: string;
  bold: boolean;
  italic: boolean;
  weight: { min: number; default: number; max: number } | null;
  restricted: boolean;
  pack: boolean;
  /** The CSS family the picker draws the name in. */
  cssFamily?: string;
}

let userFontLookup: (id: string) => UserFontView | undefined = () => undefined;

/** The app gives its shelf of fonts here, so the pure card code can ask about one. */
export function setUserFontLookup(lookup: (id: string) => UserFontView | undefined): void {
  userFontLookup = lookup;
}

export function userFontView(id: unknown): UserFontView | undefined {
  return isUserFont(id) ? userFontLookup(id) : undefined;
}

/** The font a new text step starts in (D4): a clear sans that prints at 3 mm, in bold. */
export const DEFAULT_TEXT_FONT = "sans";
export const DEFAULT_TEXT_STYLE: TextStyle = "bold";

/** The most characters one outline-font text step takes. The stroke font keeps its 80. */
export const MAX_OUTLINE_CHARS = 400;
export const MAX_STROKE_CHARS = 80;

export const TEXT_FONTS: readonly TextFont[] = [
  {
    id: "sans",
    version: "4.0",
    name: "Inter",
    about: "A clear sans with even strokes. It prints small. The default.",
    family: "Lime Model Sans",
    has: { regular: true, bold: true, italic: true, "bold-italic": true },
    files: { regular: "Inter-Regular.ttf", bold: "Inter-Bold.ttf", italic: "Inter-Italic.ttf", "bold-italic": "Inter-BoldItalic.ttf" },
  },
  {
    id: "mono",
    version: "1",
    name: "IBM Plex Mono",
    about: "Every letter the same width: serial numbers, codes and labels that line up.",
    family: "Lime Model Mono",
    has: { regular: true, bold: true, italic: false, "bold-italic": false },
    files: { regular: "IBMPlexMono-Regular.ttf", bold: "IBMPlexMono-Bold.ttf" },
  },
  {
    id: "serif",
    version: "1",
    name: "IBM Plex Serif",
    about: "A serif with sturdy strokes. Still, thin ones show a warning at small sizes.",
    family: "Lime Model Serif",
    has: { regular: true, bold: true, italic: false, "bold-italic": false },
    files: { regular: "IBMPlexSerif-Regular.ttf", bold: "IBMPlexSerif-Bold.ttf" },
  },
  {
    id: "stencil",
    version: "1",
    name: "Allerta Stencil",
    about: "Letters with bridges, for text cut through a wall without losing the middle of O, A and 8. Regular only.",
    family: "Lime Model Stencil",
    has: { regular: true, bold: false, italic: false, "bold-italic": false },
    files: { regular: "AllertaStencil-Regular.ttf" },
  },
];

/** The font `id` names, with or without its version. */
export function fontById(id: unknown): TextFont | undefined {
  if (typeof id !== "string") return undefined;
  const [name, version] = id.split("@");
  return TEXT_FONTS.find((font) => font.id === name && (version === undefined || font.version === version));
}

/** The id as a step stores it, with its version: `sans@4.0`. */
export function versionedId(font: TextFont): string {
  return `${font.id}@${font.version}`;
}

/**
 * --- Text milestone 5. The pen fonts: letters drawn as lines with a pen width, built through the same step as an outline font. The
 * engine reads their strokes (`crates/lime-model-occt/src/text/pen.rs`, which `mcp/text-fonts.test.ts` compares this list with).
 * `stroke` is the 4 × 6 grid font (a lowercase letter is drawn as its capital); `line` has lowercase of its own.
 */
export interface PenFont {
  id: "stroke" | "line";
  version: string;
  name: string;
  about: string;
}

export const PEN_FONTS: readonly PenFont[] = [
  { id: "stroke", version: "1", name: "Stroke", about: "Single-stroke capitals and digits on a 4 × 6 grid, for engraving. A lowercase letter is drawn as its capital." },
  { id: "line", version: "1", name: "Line", about: "Single-stroke letters with lowercase, for engraving and pen-like text." },
];

/** The pen font a font id names (`stroke`, `line@1`), or undefined. */
export function penFontOf(font: unknown): PenFont | undefined {
  if (typeof font !== "string") return undefined;
  const [name, version] = font.split("@");
  return PEN_FONTS.find((pen) => pen.id === name && (version === undefined || version === pen.version));
}

/** The pen font's id as a step stores it, with its version: `stroke@1`. */
export function penVersionedId(pen: PenFont): string {
  return `${pen.id}@${pen.version}`;
}

/** Whether a step's font is a pen font. */
export function isPenFont(font: unknown): boolean {
  return penFontOf(font) !== undefined;
}

/**
 * Whether a step's font is drawn from outlines, not strokes. A step with no font is the old stroke font's boxes; `stroke` and
 * `line` are pen fonts, which a card step and an MCP op may name and which build as one lettering step.
 */
export function isOutlineFont(font: unknown): boolean {
  return typeof font === "string" && font !== "" && !isPenFont(font);
}

/** Bold, italic or neither, as the style words say. */
export function styleFlags(style: TextStyle): { bold: boolean; italic: boolean } {
  return { bold: style === "bold" || style === "bold-italic", italic: style === "italic" || style === "bold-italic" };
}

export function styleOf(value: unknown): TextStyle {
  return value === "bold" || value === "italic" || value === "bold-italic" ? value : "regular";
}

/** Why the font cannot take `style`, in a sentence; null when it can, or makes it (an italic by slant). */
export function styleRefusal(font: TextFont, style: TextStyle): string | null {
  const bold = style === "bold" || style === "bold-italic";
  return bold && !font.has.bold ? `${font.name} has no bold. Pick Regular, or another font.` : null;
}

/** Whether the style is drawn from a file of its own (not slanted or refused). */
export function styleHasFile(font: TextFont, style: TextStyle): boolean {
  return font.has[style];
}
