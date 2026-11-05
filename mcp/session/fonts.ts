/**
 * Fonts for text ops: a font file is added to the project, a font name is matched to one already there.
 * The methods run with this: Session; session.ts installs them on the Session prototype.
 */
import { readFileSync } from "node:fs";
import { savedTree } from "../../src/model-tree-file.ts";
import { resolveFont } from "../workspace.ts";
import { userFontUses } from "../../src/modeling/user-fonts.ts";
import type { Session } from "../session.ts";

/** The sentence for the first text whose font cannot be had, or null when every text names its font by id now. */
async function resolveTextFonts(this: Session, texts: Record<string, unknown>[]): Promise<string | null> {
  for (const op of texts) {
    if (typeof op.fontFile === "string") {
      const hashed = /^(.*)#(\d{1,3})$/.exec(op.fontFile);
      let bytes: Buffer;
      try {
        bytes = readFileSync(resolveFont(hashed ? hashed[1]! : op.fontFile));
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const added = await this.fonts.add(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), "added", hashed ? Number(hashed[2]) : 0);
      if (!added.ok) return added.reason;
      if (added.faces.length > 1 && !hashed) {
        this.fonts.remove(added.font.id);
        return `This file holds several fonts: ${added.faces.map((face) => `${face.index} ${face.name}`).join(", ")}. Name one as ${typeof op.fontFile === "string" ? op.fontFile : "file"}#<number>.`;
      }
      op.font = added.font.id;
      delete op.fontFile;
      await this.keepFontPack(added.font.id, op);
    } else if (typeof op.font === "string") {
      const found = this.fonts.find(op.font);
      if (!found) return `There is no font called ‘${op.font}’. The fonts are stroke, line, sans, mono, serif, stencil, and the project's own: ${this.fonts.list().map((font) => font.name).join(", ") || "none yet (fontFile adds one)"}.`;
      op.font = found.id;
      await this.keepFontPack(found.id, op);
    }
  }
  return null;
}

/** A restricted font's pack, cut for this project's texts as they stand and this one, so a save that cannot wait has it. */
async function keepFontPack(this: Session, id: string, op: Record<string, unknown>): Promise<void> {
  const font = this.fonts.fonts.get(id);
  if (!font?.restricted) return;
  const uses = this.fontUses(id);
  uses.push({ text: String(op.text ?? ""), ...(typeof op.style === "string" ? { style: op.style } : {}), ...(typeof op.weight === "number" ? { weight: op.weight } : {}) });
  await this.fonts.refreshPack(id, uses);
}

/** The texts the project's histories set in a font of the person's. */
function fontUses(this: Session, id: string): { text: string; style?: string; weight?: number }[] {
  const owner = (key: string) => this.byTreeKey(key)?.id;
  const objects = [...this.objects, ...this.toolsOffPlate].flatMap((obj) => (obj.tree ? [{ modelTree: savedTree(obj.tree, obj.tree.committed, owner) }] : []));
  return userFontUses({ objects }).get(id) ?? [];
}

/** The methods this module adds to Session. */
export const fontsMethods = {
  resolveTextFonts,
  keepFontPack,
  fontUses,
};
