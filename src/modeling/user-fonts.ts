/**
 * The person's own fonts for text (docs/plan-text-on-curves-and-fonts.md, milestone 4), the part the app and the MCP server
 * share: what the engine says a font file is, a shelf that holds the fonts of one project and session, and the records a
 * project keeps so it reopens anywhere (D5).
 *
 * The engine reads the file (`textFontAdd`) and keeps it by id (`user:` and 16 hex digits of the file's SHA-256, `.n` after
 * it for the n-th face of a collection). A text step names its font by that id. The project keeps the file itself in its
 * `fonts` map under the full SHA-256, unless the font's licence (`OS/2 fsType`) forbids embedding it: then it keeps only the
 * outlines of the letters its texts use (`textFontPack`), and the card says so.
 *
 * Nothing here reads a file or a path: the caller hands over bytes and a function that asks the engine.
 */
import { base64ToBytes, bytesToBase64 } from "../base64.ts";
import { meshRecord, type ProjectMesh } from "../project.ts";
import { fontById, isPenFont, isUserFont } from "./text-fonts.ts";

export { isUserFont, USER_FONT_PREFIX } from "./text-fonts.ts";

/** The sentence a project's text says when a font is neither in the project nor on this computer. */
export function missingFontSentence(name: string): string {
  return `The font ‘${name}’ is not on this computer. Add its file again, or pick another font to edit this step.`;
}

/** What the engine tells about a font file: the card's picker, the weight slider and the licence sentence read this. */
export interface UserFont {
  /** `user:` and 16 hex digits, `.n` for the n-th face of a collection. What a text step stores. */
  id: string;
  /** The file's SHA-256: the key of its record in a project. */
  sha256: string;
  face: number;
  /** The full name, as the picker draws it: "Source Code Pro Regular". */
  name: string;
  family: string;
  style: string;
  bold: boolean;
  italic: boolean;
  /** A variable font's weight axis. */
  weight: { min: number; default: number; max: number } | null;
  /** The licence forbids embedding the file: the project keeps only the outlines its texts use. */
  restricted: boolean;
  /** This engine holds only the saved letters of the font, not the file. */
  pack: boolean;
  /** The letters a pack holds. */
  letters?: string;
  /** Where this computer got it: the person's library, the project that came with it, or added in this session. */
  from: "library" | "project" | "added";
  /** The file as added, when this computer has it. A pack-only font has none. */
  bytes?: Uint8Array;
  /** The CSS family the picker draws the name in; set by the app when it loads the file. */
  cssFamily?: string;
}

export interface FontFace {
  index: number;
  name: string;
}

/** What a font file is, or the sentence that says why not. */
export type Added = { ok: true; font: UserFont; faces: FontFace[] } | { ok: false; reason: string };

export type EngineCall = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The key a project keeps a font's record under: its SHA-256, and `.n` for a face after the first. */
export function recordKey(font: Pick<UserFont, "sha256" | "face">): string {
  return font.face > 0 ? `${font.sha256}.${font.face}` : font.sha256;
}

/** The face a record's key names. */
export function faceOfKey(key: string): number {
  const dot = key.indexOf(".");
  return dot < 0 ? 0 : Number(key.slice(dot + 1)) || 0;
}

/** One text a project sets in a font, for the pack of the letters it needs. */
export interface FontUse {
  text: string;
  style?: string;
  weight?: number;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);

/** Every lettering step of `op`, looking inside groups. */
function eachLettering(op: unknown, visit: (step: Row) => void): void {
  if (!isRow(op)) return;
  if (op.kind === "lettering") visit(op);
  if (op.kind === "group" && Array.isArray(op.steps)) for (const step of op.steps) eachLettering(step, visit);
}

/** The saved trees of a project document: its objects' and its tools'. */
interface SavedTrees {
  objects?: readonly { modelTree?: { nodes?: readonly { op?: unknown }[] } }[];
  modelTools?: readonly { modelTree?: { nodes?: readonly { op?: unknown }[] } }[];
}

/** The texts of every lettering step that names a font of the person's, by font id, in the order the project has them. */
export function userFontUses(project: SavedTrees): Map<string, FontUse[]> {
  const out = new Map<string, FontUse[]>();
  for (const holder of [...(project.objects ?? []), ...(project.modelTools ?? [])]) {
    for (const node of holder.modelTree?.nodes ?? []) {
      eachLettering(node.op, (step) => {
        if (!isUserFont(step.font) || typeof step.text !== "string") return;
        const use: FontUse = { text: step.text };
        if (typeof step.style === "string") use.style = step.style;
        if (typeof step.weight === "number") use.weight = step.weight;
        const list = out.get(step.font) ?? [];
        list.push(use);
        out.set(step.font, list);
      });
    }
  }
  return out;
}

/**
 * The text ops inside a tool call's input (looking through arrays, a pattern's or mirror's `op`, and plan steps) that name
 * a font the engine has no id for yet: a `fontFile` to read, or a `font` that is a name in the project. The MCP session
 * resolves them to ids before the call runs. Each is the object itself, to be changed in place.
 */
export function textsNeedingFonts(input: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const row = value as Row;
    if (row.kind === "text" && (typeof row.fontFile === "string" || (typeof row.font === "string" && !isPenFont(row.font) && !fontById(row.font) && !isUserFont(row.font)))) out.push(row);
    for (const child of Object.values(row)) walk(child, depth + 1);
  };
  walk(input, 0);
  return out;
}

/** The ids of the fonts of the person's a typed op names, looking inside groups and the op a pattern repeats. */
export function userFontIdsOf(op: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (!isRow(value) || depth > 6) return;
    if (value.kind === "lettering" || value.kind === "text") if (isUserFont(value.font)) ids.add(value.font);
    if (Array.isArray(value.steps)) for (const step of value.steps) walk(step, depth + 1);
    walk(value.op, depth + 1);
    walk(value.source, depth + 1);
  };
  walk(op, 0);
  return [...ids];
}

function readFont(reply: Record<string, unknown>, bytes: Uint8Array | undefined, from: UserFont["from"], face: number): UserFont {
  const weight = isRow(reply.weight) ? { min: Number(reply.weight.min), default: Number(reply.weight.default), max: Number(reply.weight.max) } : null;
  return {
    id: String(reply.id),
    sha256: String(reply.sha256),
    face,
    name: String(reply.name),
    family: String(reply.family),
    style: String(reply.style),
    bold: reply.bold === true,
    italic: reply.italic === true,
    weight,
    restricted: reply.restricted === true,
    pack: reply.pack === true,
    ...(typeof reply.letters === "string" ? { letters: reply.letters } : {}),
    from,
    ...(bytes ? { bytes } : {}),
  };
}

/**
 * The fonts of one project and session. The app and the MCP session each hold one; `call` asks their engine.
 * Fonts stay on the shelf until removed, so a step built from one rebuilds for as long as the session lasts.
 */
export class UserFontShelf {
  readonly fonts = new Map<string, UserFont>();
  /** The pack last made for a restricted font, by id, so a save that cannot ask the engine still has one. */
  private readonly packs = new Map<string, ProjectMesh>();
  private readonly listeners = new Set<() => void>();

  private readonly call: EngineCall;

  constructor(call: EngineCall) {
    this.call = call;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  list(): UserFont[] {
    return [...this.fonts.values()];
  }

  /**
   * Give the engine a font file (or a pack of a restricted font's letters). A collection answers its faces; `face` picks one.
   * The font is on the shelf from now on, and the same file added again is the same font.
   */
  async add(bytes: Uint8Array, from: UserFont["from"] = "added", face = 0): Promise<Added> {
    const reply = await this.call({ call: "textFontAdd", dataB64: bytesToBase64(bytes), ...(face > 0 ? { face } : {}) });
    if (typeof reply.error === "string") return { ok: false, reason: reply.error };
    if (reply.ok !== true || typeof reply.id !== "string") return { ok: false, reason: "The font could not be read." };
    const isPack = reply.pack === true;
    const font = readFont(reply, isPack ? undefined : bytes, from, face);
    const held = this.fonts.get(font.id);
    // A pack never takes the place of the whole font already on the shelf; the file stays, the way the engine keeps it.
    if (held && !held.pack && font.pack) return { ok: true, font: held, faces: [] };
    if (isPack) this.packs.set(font.id, meshRecord(`${font.family}.limefont`, bytes));
    const faces = Array.isArray(reply.faces) ? (reply.faces as Row[]).map((row) => ({ index: Number(row.index), name: String(row.name) })) : [];
    this.fonts.set(font.id, { ...font, ...(held?.cssFamily ? { cssFamily: held.cssFamily } : {}) });
    this.changed();
    return { ok: true, font: this.fonts.get(font.id)!, faces };
  }

  /** A font by id, name, family or the file name the person typed, case and style words aside; undefined when none fits. */
  find(name: string): UserFont | undefined {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return undefined;
    const all = this.list();
    const byId = all.find((font) => font.id.toLowerCase() === wanted);
    if (byId) return byId;
    const full = all.find((font) => font.name.toLowerCase() === wanted);
    if (full) return full;
    const family = all.filter((font) => font.family.toLowerCase() === wanted);
    return family.find((font) => !font.bold && !font.italic) ?? family[0];
  }

  /** What the engine was given for a font: its file, or the pack it holds when this computer has no file. */
  bytesOf(id: string): Uint8Array | undefined {
    const font = this.fonts.get(id);
    if (font?.bytes) return font.bytes;
    const pack = this.packs.get(id);
    return pack ? (base64ToBytes(pack.bytesBase64) ?? undefined) : undefined;
  }

  /** Every font off the shelf: a new project, or another opened, starts with none. The engine keeps what it was given. */
  clear(): void {
    this.fonts.clear();
    this.packs.clear();
    this.changed();
  }

  remove(id: string): boolean {
    this.packs.delete(id);
    const gone = this.fonts.delete(id);
    if (gone) this.changed();
    return gone;
  }

  /**
   * Take a project's font records: each one is given to the engine, so its steps rebuild with the bytes they were made with.
   * Answers a note for every record the engine would not take.
   */
  async adopt(records: Record<string, ProjectMesh> | undefined): Promise<string[]> {
    const notes: string[] = [];
    for (const [key, record] of Object.entries(records ?? {})) {
      const bytes = base64ToBytes(record.bytesBase64);
      if (!bytes) {
        notes.push(`The font ${record.name} in this project is damaged.`);
        continue;
      }
      const added = await this.add(bytes, "project", faceOfKey(key));
      if (!added.ok) notes.push(`The font ${record.name} in this project could not be read: ${added.reason}`);
    }
    return notes;
  }

  /**
   * The records a project keeps for the fonts its texts use (D5). A font whose licence allows embedding keeps its file; one
   * that forbids it keeps the pack of the letters its texts use, which the engine cuts from the file now. A font this
   * computer has no file for (a pack from the project it came with) keeps the record it had. Undefined when no text uses one.
   */
  async recordsFor(project: SavedTrees, had?: Record<string, ProjectMesh>): Promise<Record<string, ProjectMesh> | undefined> {
    const uses = userFontUses(project);
    const out: Record<string, ProjectMesh> = {};
    for (const [id, list] of uses) {
      const font = this.fonts.get(id);
      if (!font) continue;
      const key = recordKey(font);
      if (!font.restricted && font.bytes) {
        out[key] = meshRecord(`${font.family}.font`, font.bytes);
      } else if (font.bytes) {
        const packed = await this.call({ call: "textFontPack", id, uses: list });
        if (typeof packed.dataB64 === "string") {
          const bytes = base64ToBytes(packed.dataB64);
          if (bytes) {
            const record = meshRecord(`${font.family}.limefont`, bytes);
            this.packs.set(id, record);
            out[key] = record;
          }
        }
      } else if (had?.[key]) {
        out[key] = had[key]!;
      } else if (this.packs.has(id)) {
        out[key] = this.packs.get(id)!;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** `recordsFor` without asking the engine: the packs made so far stand for the restricted fonts. For a save that cannot wait. */
  recordsNow(project: SavedTrees, had?: Record<string, ProjectMesh>): Record<string, ProjectMesh> | undefined {
    const out: Record<string, ProjectMesh> = {};
    for (const id of userFontUses(project).keys()) {
      const font = this.fonts.get(id);
      if (!font) continue;
      const key = recordKey(font);
      if (!font.restricted && font.bytes) out[key] = meshRecord(`${font.family}.font`, font.bytes);
      else if (this.packs.has(id)) out[key] = this.packs.get(id)!;
      else if (had?.[key]) out[key] = had[key]!;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Cut a restricted font's pack for the uses it has now, so `recordsNow` has it. */
  async refreshPack(id: string, uses: FontUse[]): Promise<void> {
    const font = this.fonts.get(id);
    if (!font || !font.restricted || !font.bytes) return;
    const packed = await this.call({ call: "textFontPack", id, uses });
    if (typeof packed.dataB64 !== "string") return;
    const bytes = base64ToBytes(packed.dataB64);
    if (bytes) this.packs.set(id, meshRecord(`${font.family}.limefont`, bytes));
  }
}

/** The one sentence the card shows under a restricted font. */
export function restrictedNote(font: Pick<UserFont, "name" | "restricted">): string | null {
  return font.restricted
    ? `‘${font.name}’ does not allow embedding, so this project keeps only the outlines of the letters you use.`
    : null;
}

/** Why a style cannot be had from `font`, in a sentence; null when it can (a missing italic is slanted, D7). */
export function userStyleRefusal(font: Pick<UserFont, "name" | "bold" | "weight">, style: string): string | null {
  const bold = style === "bold" || style === "bold-italic";
  return bold && !font.bold && !font.weight ? `${font.name} has no bold. Pick Regular, or another font.` : null;
}

/** Whether a style is drawn from the file itself (not slanted or, for a variable font, from the weight). */
export function userStyleHasFile(font: Pick<UserFont, "italic">, style: string): boolean {
  return style !== "italic" && style !== "bold-italic" ? true : font.italic;
}
