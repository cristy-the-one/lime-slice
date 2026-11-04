/**
 * The person's own fonts for text (docs/plan-text-on-curves-and-fonts.md, milestone 4), through the MCP server against real Open
 * CASCADE: `fontFile` adds a font from the workspace to the project and a later `font` names it, the letters are the ones the file
 * draws (a copy of a bundled font builds the same solid as the bundled one), the project keeps the file (or only the outlines of the
 * letters used when its licence forbids embedding) and rebuilds from it, and every refusal is a sentence.
 *
 * The font files are a copy of IBM Plex Mono Regular (SIL OFL 1.1, bundled with the app) with the licence bits or a table tag
 * changed in the copy: no font of anyone's is in the repository.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { base64ToBytes, bytesToBase64 } from "../src/base64.ts";
import { decodeProject, encodeProject, plainDocument } from "../src/project-codec.ts";
import { meshRecord } from "../src/project.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("text-user-fonts: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("text-user-fonts: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-user-fonts-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "25";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const near = (value: unknown, expected: number, tol = 0.01) => typeof value === "number" && Math.abs(value - expected) < tol;

// --- The font files: copies of a bundled font with one thing changed in the copy.
const plex = new Uint8Array(readFileSync(join(root, "public", "fonts", "model", "IBMPlexMono-Regular.ttf")));
/** The offset of table `tag` in an sfnt's directory record, or -1. */
function tableRecord(bytes: Uint8Array, tag: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    if (String.fromCharCode(...bytes.subarray(at, at + 4)) === tag) return at;
  }
  return -1;
}
/** The font with its OS/2 fsType (the embedding bits) set to `value`. */
function withFsType(bytes: Uint8Array, value: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const os2 = view.getUint32(tableRecord(copy, "OS/2") + 8);
  view.setUint16(os2 + 8, value);
  return copy;
}
/** The font with its outline table renamed away, as a bitmap-only font has none. */
function withoutOutlines(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy.set(new TextEncoder().encode("glyx"), tableRecord(copy, "glyf"));
  return copy;
}
const fsTypeOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(new DataView(bytes.buffer, bytes.byteOffset).getUint32(tableRecord(bytes, "OS/2") + 8) + 8);
check("the test fonts are what they say", fsTypeOf(plex) === 0 && fsTypeOf(withFsType(plex, 2)) === 2 && tableRecord(withoutOutlines(plex), "glyf") === -1, String(fsTypeOf(plex)));

writeFileSync(join(workspace, "plex.ttf"), plex);
writeFileSync(join(workspace, "closed.ttf"), withFsType(plex, 2));
writeFileSync(join(workspace, "preview.ttf"), withFsType(plex, 4));
writeFileSync(join(workspace, "bitmaps.ttf"), withoutOutlines(plex));
writeFileSync(join(workspace, "junk.ttf"), "this is not a font file at all");
writeFileSync(join(workspace, "notes.txt"), "not a font either");

const engine = loadEngineWorker(root);
const session = new Session(engine);
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;
const refused = async (name: string, args: unknown) => (await call(name, args).catch((err: Error) => ({ ok: false, reason: err.message }))) as Record<string, any>;
const volume = async (object: string, s: Session = session) => Number(((await s.call("model_describe", { object, limit: 1 })) as Record<string, any>).volumeMm3);

/** A 40 × 20 × 10 block and its top face. */
async function block(s: Session = session): Promise<{ object: string; face: number; before: number }> {
  const made = (await s.call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 })) as Record<string, any>;
  const object = String(made.object);
  const top = (await s.call("faces_find", { object, normal: [0, 0, 1], limit: 1 })) as Record<string, any>;
  return { object, face: (top.faces as { index: number }[])[0]!.index, before: await volume(object, s) };
}
const text = (face: number, extra: Record<string, unknown>) => ({ kind: "text", faceIndex: face, text: "LOT 42", height: 5, depth: 0.8, ...extra });

// --- fontFile adds a font from the workspace; the letters are the file's, so a copy of a bundled font builds the bundled solid.
const bundled = await block();
const viaBundled = await call("model_apply", { object: bundled.object, op: text(bundled.face, { font: "mono" }) });
check("the bundled Plex Mono text applies", viaBundled.ok === true, JSON.stringify(viaBundled));
const bundledAdded = (await volume(bundled.object)) - bundled.before;

const first = await block();
const viaFile = await call("model_apply", { object: first.object, op: text(first.face, { fontFile: "plex.ttf" }) });
check("a text with fontFile applies", viaFile.ok === true, JSON.stringify(viaFile));
const fileAdded = (await volume(first.object)) - first.before;
check("and builds the solid the same font bundled builds", near(fileAdded, bundledAdded, 1e-6) && fileAdded > 5, `${fileAdded} against ${bundledAdded}`);
const history = await call("model_history", { object: first.object });
check("it is one history row named for the text", (history.nodes as { label: string }[]).length === 2 && (history.nodes as { label: string }[])[1]!.label === "Text LOT 42", JSON.stringify(history.nodes));

// --- Then the font is in the project: named by what it is called.
const guide = JSON.stringify(await call("guide", { kind: "text" }));
const name = /IBM Plex Mono[A-Za-z ]*(?=: your font)/.exec(guide)?.[0] ?? "";
check("guide {kind:\"text\"} lists the project's font by name and id", name !== "" && /Id user:[0-9a-f]{16}/.test(guide), guide.slice(0, 500));
const second = await block();
const byName = await call("model_apply", { object: second.object, op: text(second.face, { font: name }) });
check("a later text names the font by the name already in the project", byName.ok === true && near((await volume(second.object)) - second.before, fileAdded, 1e-6), JSON.stringify(byName));
const byFamily = await block();
const family = await call("model_apply", { object: byFamily.object, op: text(byFamily.face, { font: "IBM Plex Mono" }) });
check("or by its family", family.ok === true && near((await volume(byFamily.object)) - byFamily.before, fileAdded, 1e-6), JSON.stringify(family));
const engraved = await block();
const cut = await call("model_apply", { object: engraved.object, op: text(engraved.face, { font: name, op: "cut" }) });
check("engraved, it takes out what the raised one added", cut.ok === true && near(engraved.before - (await volume(engraved.object)), fileAdded, 0.01), JSON.stringify(cut));
const lines = await block();
const two = await call("model_apply", { object: lines.object, op: text(lines.face, { font: name, text: "LOT 42\nSN 7", align: "right", spacing: 0.2, lineSpacing: 1.6, style: "italic", height: 3 }) });
check("lines, alignment, spacing and an italic slant build in the added font", two.ok === true, JSON.stringify(two));

// --- The project keeps the file. Saved, a new session opens it and rebuilds the same solid, and edits with the same font.
const saved = await call("project_save", { name: "lettered" });
check("the project saves", saved.ok === true, JSON.stringify(saved));
const doc = (await plainDocument(readFileSync(join(workspace, "lettered.lime"), "utf8"))) as { fonts?: Record<string, { name: string; bytesBase64: string; byteLength: number }> };
const records = Object.entries(doc.fonts ?? {});
check("its fonts map holds one record, the file under its SHA-256", records.length === 1 && /^[0-9a-f]{64}$/.test(records[0]![0]) && records[0]![1].byteLength === plex.length, JSON.stringify(records.map(([k, r]) => [k, r.name, r.byteLength])));
check("whole, byte for byte, because its licence allows embedding", records.length === 1 && Buffer.from(base64ToBytes(records[0]![1].bytesBase64)!).equals(Buffer.from(plex)));

const reopened = new Session(engine);
const opened = (await reopened.call("project_open", { path: "lettered.lime" })) as Record<string, any>;
check("a new session opens it", opened.ok === true && !opened.fontNotes, JSON.stringify(opened));
const object = String((opened.objects as { object: string }[]).find((row) => row.object !== undefined)?.object);
check("and the lettered solid is as it was", near(await volume(object, reopened), first.before + fileAdded, 1e-6), `${await volume(object, reopened)}`);
const again = (await reopened.call("faces_find", { object, normal: [0, 0, 1], limit: 50 })) as Record<string, any>;
const biggest = (again.faces as { index: number; areaMm2: number }[]).reduce((a, b) => (b.areaMm2 > a.areaMm2 ? b : a));
const editAgain = (await reopened.call("model_apply", { object, op: text(biggest.index, { font: name, at: { u: -14, v: 0 }, text: "AB 1", height: 3 }) })) as Record<string, any>;
check("in the reopened project the font is there to name", editAgain.ok === true, JSON.stringify(editAgain));

// --- A font whose licence forbids embedding: the project keeps only the outlines of the letters used.
const alone = new Session(engine);
const closed = await block(alone);
const forbidden = (await alone.call("model_apply", { object: closed.object, op: text(closed.face, { fontFile: "closed.ttf", text: "LOT 42" }) })) as Record<string, any>;
check("a font with fsType restricted is still usable", forbidden.ok === true && near((await volume(closed.object, alone)) - closed.before, fileAdded, 1e-6), JSON.stringify(forbidden));
const savedClosed = (await alone.call("project_save", { name: "closed" })) as Record<string, any>;
check("it saves", savedClosed.ok === true, JSON.stringify(savedClosed));
const closedText = readFileSync(join(workspace, "closed.lime"), "utf8");
const closedDoc = (await plainDocument(closedText)) as { fonts?: Record<string, { name: string; bytesBase64: string; byteLength: number }> };
const closedRecords = Object.entries(closedDoc.fonts ?? {});
const packBytes = closedRecords.length === 1 ? base64ToBytes(closedRecords[0]![1].bytesBase64)! : new Uint8Array();
const pack = packBytes.length > 0 ? (JSON.parse(new TextDecoder().decode(packBytes)) as { id: string; instances: { glyphs: Record<string, unknown> }[]; meta: { embedding: string } }) : null;
check("the project holds a pack, not the file", closedRecords.length === 1 && packBytes[0] === 0x7b && packBytes.length < plex.length / 10, `${packBytes.length} bytes against ${plex.length}`);
const letters = pack ? Object.keys(pack.instances[0]!.glyphs).map((cp) => String.fromCodePoint(Number(cp))).sort().join("") : "";
check("of exactly the letters the text uses (and the space)", letters === " 24LOT", JSON.stringify(letters));
check("marked as outlines only", pack?.meta.embedding === "outlines");
// Preview-and-print embedding is restricted for a project too.
const printOnly = new Session(engine);
const preview = await block(printOnly);
await printOnly.call("model_apply", { object: preview.object, op: text(preview.face, { fontFile: "preview.ttf", text: "HI" }) });
const previewSaved = (await printOnly.call("project_save", { name: "preview" })) as Record<string, any>;
const previewDoc = (await plainDocument(readFileSync(join(workspace, "preview.lime"), "utf8"))) as { fonts?: Record<string, { bytesBase64: string }> };
const previewRecord = Object.values(previewDoc.fonts ?? {});
check("preview-and-print embedding is packed too", previewSaved.ok === true && previewRecord.length === 1 && base64ToBytes(previewRecord[0]!.bytesBase64)![0] === 0x7b);

// Another computer: the pack is all there is. The saved project's font id is rewritten to one the engine was never given.
const FOREIGN = "user:0000cafe0000cafe";
const project = await decodeProject(closedText);
if (!project.ok || !pack) throw new Error("the closed project did not open");
const oldId = pack.id;
const rewritten = JSON.parse(JSON.stringify(project.project).split(oldId).join(FOREIGN)) as typeof project.project;
const foreignPack = { ...pack, id: FOREIGN, sha256: "0".repeat(63) + "1" };
rewritten.fonts = { [foreignPack.sha256]: meshRecord("closed.limefont", new TextEncoder().encode(JSON.stringify(foreignPack))) };
writeFileSync(join(workspace, "elsewhere.lime"), await encodeProject(rewritten));
const elsewhere = new Session(engine);
const there = (await elsewhere.call("project_open", { path: "elsewhere.lime" })) as Record<string, any>;
check("a project with only the pack opens", there.ok === true && !there.fontNotes, JSON.stringify(there));
const thereObject = String((there.objects as { object: string }[])[0]!.object);
check("and rebuilds the lettered solid from the pack alone", near(await volume(thereObject, elsewhere), closed.before + fileAdded, 1e-6), `${await volume(thereObject, elsewhere)}`);
const thereFaces = (await elsewhere.call("faces_find", { object: thereObject, normal: [0, 0, 1], limit: 50 })) as Record<string, any>;
const thereTop = (thereFaces.faces as { index: number; areaMm2: number }[]).reduce((a, b) => (b.areaMm2 > a.areaMm2 ? b : a)).index;
const nameThere = /Id user:0000cafe0000cafe/.test(JSON.stringify(await elsewhere.call("guide", { kind: "text" })));
check("the font is listed by its id in the project", nameThere);
const sameLetters = (await elsewhere.call("model_apply", { object: thereObject, op: text(thereTop, { font: FOREIGN, text: "42 LOT", height: 3, at: { u: 0, v: -6.5 } }) })) as Record<string, any>;
check("the same letters can be typed again", sameLetters.ok === true, JSON.stringify(sameLetters));
const otherLetters = (await elsewhere.call("model_apply", { object: thereObject, op: text(thereTop, { font: FOREIGN, text: "LOT 4X", height: 3, at: { u: 0, v: 6.5 } }) })) as Record<string, any>;
check("a letter the project never used is named, with why", otherLetters.ok === false && /with only the letters it was used for/.test(JSON.stringify(otherLetters)) && /‘X’/.test(JSON.stringify(otherLetters)), JSON.stringify(otherLetters));

// --- Refusals are sentences, and change nothing.
const refusals = await block();
const op = (extra: Record<string, unknown>) => ({ object: refusals.object, op: text(refusals.face, extra) });
const unreadable = await refused("model_apply", op({ fontFile: "junk.ttf" }));
check("a file that is not a font", unreadable.ok === false && /This file is not a font Lime Slice can read\. Use a TrueType \(\.ttf\) or OpenType \(\.otf\) file\./.test(JSON.stringify(unreadable)), JSON.stringify(unreadable));
const notAFont = await refused("model_apply", op({ fontFile: "notes.txt" }));
check("a file with another extension", notAFont.ok === false && /not a font Lime Slice can read/.test(JSON.stringify(notAFont)), JSON.stringify(notAFont));
const missing = await refused("model_apply", op({ fontFile: "nothing-here.ttf" }));
check("a file that is not there", missing.ok === false && /was not found/.test(JSON.stringify(missing)), JSON.stringify(missing));
const bitmaps = await refused("model_apply", op({ fontFile: "bitmaps.ttf" }));
check("a font with no outlines", bitmaps.ok === false && /has only bitmap letters and no outlines\. Pick an outline font \(TrueType or OpenType\)\./.test(JSON.stringify(bitmaps)), JSON.stringify(bitmaps));
const lacking = await refused("model_apply", op({ font: name, text: "LOT 日本" }));
check("letters the font lacks are all named", lacking.ok === false && /This font has no ‘日’ and ‘本’\. Pick another font, or take them out\./.test(JSON.stringify(lacking)), JSON.stringify(lacking));
const noBold = await refused("model_apply", op({ font: name, style: "bold" }));
check("a bold the file does not have", noBold.ok === false && /has no bold\. Pick Regular, or another font\./.test(JSON.stringify(noBold)), JSON.stringify(noBold));
const weight = await refused("model_apply", op({ font: name, weight: 700 }));
check("a weight on a font that is not variable", weight.ok === false && /is not a variable font, so it has one weight/.test(JSON.stringify(weight)), JSON.stringify(weight));
const unknown = await refused("model_apply", op({ font: "Avenir Next" }));
check("a name the project does not have", unknown.ok === false && /There is no font called ‘Avenir Next’\./.test(JSON.stringify(unknown)) && /fontFile adds one|IBM Plex Mono/.test(JSON.stringify(unknown)), JSON.stringify(unknown));
const outside = await refused("model_apply", op({ weight: 1200, font: name }));
check("a weight outside 100 to 900 is turned away by the schema", outside.ok === false, JSON.stringify(outside));
check("every refusal left the block as it was", near(await volume(refusals.object), refusals.before, 1e-6));

if (failed > 0) {
  console.error(`${failed} text-user-fonts checks failed`);
  process.exit(1);
}
console.log("text-user-fonts: ok");
process.exit(0);
// Keep the helpers the type checker would call unused.
void bytesToBase64;
