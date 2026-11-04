/**
 * The person's own fonts in the app (docs/plan-text-on-curves-and-fonts.md, milestone 4): Add font file… on the Text card's
 * font picker, the font library that keeps them for every project, the project's copies, and the CSS faces that draw
 * each name in itself. The engine reads the files; the shelf (`src/modeling/user-fonts.ts`) holds them.
 *
 * The library is `~/.lime-slice/fonts/` in the desktop app (`src-tauri/src/fonts.rs`). The browser build has none: a font
 * added there lives in the session and in the projects saved from it.
 */
import { bytesToBase64, base64ToBytes } from "../base64.ts";
import { isTauri } from "../platform.ts";
import { setUserFontLookup } from "../modeling/text-fonts.ts";
import { UserFontShelf, type FontFace as CollectionFace, type UserFont } from "../modeling/user-fonts.ts";
import { pushToast } from "../ui/toasts.ts";
import { treeCall } from "./step-solids.ts";

export const shelf = new UserFontShelf(treeCall);
setUserFontLookup((id) => shelf.fonts.get(id));

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface LibraryIo {
  list(): Promise<{ dir: string; files: { name: string; dataB64: string }[] }>;
  add(name: string, dataB64: string): Promise<void>;
  remove(name: string): Promise<boolean>;
}

let tauriInvoke: Promise<Invoke | null> | null = null;

async function invoker(): Promise<Invoke | null> {
  const hook = (globalThis as { __limeFontLibrary?: { invoke: Invoke } }).__limeFontLibrary?.invoke;
  if (hook) return hook;
  if (typeof window === "undefined" || !isTauri()) return null;
  tauriInvoke ??= import("@tauri-apps/api/core").then((m) => m.invoke as Invoke).catch(() => null);
  return tauriInvoke;
}

/** The font library's commands, or null where there is no desktop shell. */
async function libraryIo(): Promise<LibraryIo | null> {
  const invoke = await invoker();
  if (!invoke) return null;
  return {
    list: () => invoke("font_library_list"),
    add: (name, dataB64) => invoke("font_library_add", { name, dataB64 }),
    remove: (name) => invoke("font_library_remove", { name }),
  };
}

/** A library file name for a font: its SHA-256's first 16 digits, a safe form of its family, and the extension it came with. */
function libraryName(font: UserFont, original: string): string {
  const ext = /\.(ttf|otf|ttc)$/i.exec(original)?.[1]?.toLowerCase() ?? "ttf";
  const family = font.family.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "font";
  return `${font.sha256.slice(0, 16)}-${family}.${ext}`;
}

/** Library file names by font id, so a font can be taken out again. */
const libraryFiles = new Map<string, string>();

// --- The CSS faces: each font's name is drawn in itself.
const cssLoaded = new Set<string>();

function cssFamilyOf(font: UserFont): string {
  return `Lime User ${font.id.slice("user:".length).replace(/[^0-9a-f]/g, "-")}`;
}

async function loadCssFace(font: UserFont): Promise<void> {
  if (!font.bytes || cssLoaded.has(font.id) || typeof FontFace === "undefined" || typeof document === "undefined") return;
  cssLoaded.add(font.id);
  try {
    const family = cssFamilyOf(font);
    const copy = font.bytes.slice();
    const face = new FontFace(family, copy.buffer as ArrayBuffer, font.weight ? { weight: `${font.weight.min} ${font.weight.max}` } : {});
    await face.load();
    document.fonts.add(face);
    const held = shelf.fonts.get(font.id);
    if (held) held.cssFamily = family;
    notify();
  } catch {
    // A file the browser's own reader will not take (a collection, a rare format) is drawn in the interface font.
    cssLoaded.delete(font.id);
  }
}

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** The card repaints its picker when the fonts change. */
export function onUserFontsChange(listener: () => void): void {
  listeners.add(listener);
}

shelf.onChange(() => {
  for (const font of shelf.list()) void loadCssFace(font);
  notify();
});

let libraryRead: Promise<void> | null = null;

/** Read the font library into the shelf, once. A file the engine will not read is skipped. */
export function ensureLibrary(): Promise<void> {
  libraryRead ??= (async () => {
    const io = await libraryIo();
    if (!io) return;
    try {
      const listing = await io.list();
      for (const file of listing.files) {
        const bytes = base64ToBytes(file.dataB64);
        if (!bytes) continue;
        const added = await shelf.add(bytes, "library");
        if (added.ok) libraryFiles.set(added.font.id, file.name);
      }
    } catch {
      // No library folder to read: the picker lists the bundled fonts and this project's.
    }
  })();
  return libraryRead;
}

/** What Add font file… did, for the card to say. */
export type AddResult =
  | { ok: true; font: UserFont }
  | { ok: false; reason: string }
  /** The file is a collection: pick one of its faces, then add again with `face`. */
  | { ok: false; collection: CollectionFace[]; reason: string };

/** Add a font file the person picked. The engine reads it; the library keeps a copy; the card picks it. */
export async function addFontFile(file: File, face?: number): Promise<AddResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const added = await shelf.add(bytes, "added", face ?? 0);
  if (!added.ok) return { ok: false, reason: added.reason };
  if (added.faces.length > 1 && face === undefined) {
    // A collection: face 0 is not the person's choice, so it goes back off the shelf until they pick.
    shelf.remove(added.font.id);
    return { ok: false, collection: added.faces, reason: "This file holds several fonts. Pick one." };
  }
  const font = added.font;
  const io = await libraryIo();
  if (io) {
    const name = libraryName(font, file.name);
    try {
      await io.add(name, bytesToBase64(bytes));
      libraryFiles.set(font.id, name);
    } catch {
      pushToast(`‘${font.name}’ is added to this project, but could not be kept in your font library.`, "info");
    }
  }
  void loadCssFace(font);
  return { ok: true, font };
}

/**
 * Take a font out of the picker and the font library. A font a text of this project uses stays in the project (its
 * steps still rebuild and edit); it is only no longer in the library.
 */
export async function removeUserFont(id: string, usedByProject: boolean): Promise<void> {
  const io = await libraryIo();
  const name = libraryFiles.get(id);
  if (io && name) {
    try {
      await io.remove(name);
    } catch {
      pushToast("The font could not be removed from your font library.", "error");
      return;
    }
    libraryFiles.delete(id);
  }
  const font = shelf.fonts.get(id);
  if (!font) return;
  if (usedByProject) {
    font.from = "project";
    pushToast(`‘${font.name}’ is still used by this project, so it stays in the project.`, "info");
    notify();
    return;
  }
  shelf.remove(id);
}

/** A new project, or another one opened, leaves behind the fonts the last one brought that the person's library does not hold. */
export function dropProjectFonts(): void {
  for (const font of shelf.list()) if (font.from === "project" && !libraryFiles.has(font.id)) shelf.remove(font.id);
}

/** The fonts the picker lists after the bundled ones: the person's library and this project's, by name. */
export function listedFonts(): UserFont[] {
  return shelf.list().sort((a, b) => a.name.localeCompare(b.name));
}

/** Give the engine every font the shelf holds again, after it restarted and forgot them. */
export async function resyncFonts(): Promise<void> {
  for (const font of shelf.list()) {
    const bytes = shelf.bytesOf(font.id);
    if (bytes) await treeCall({ call: "textFontAdd", dataB64: bytesToBase64(bytes), ...(font.face > 0 ? { face: font.face } : {}) });
  }
}
