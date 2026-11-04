// The person's own fonts (docs/plan-text-on-curves-and-fonts.md, milestone 4): the shelf that holds a project's fonts, what the
// project keeps of them (the file, or only the letters used when the licence forbids embedding), the text ops that need a font
// resolved, and the project file round trip. The engine is a fake that reads small JSON "fonts", so nothing here needs a kernel
// or a font file; the real engine is `mcp/text-user-fonts.test.ts` and the engine's own tests.
import { base64ToBytes, bytesToBase64 } from "../base64.ts";
import { defaultProfile } from "../profiles.ts";
import { DEFAULT_PRESET } from "../presets.ts";
import { meshRecord, parseProject, readFonts, serializeProject, type LimeProject } from "../project.ts";
import { decodeProject, encodeProject, ENCODING_GZIP } from "../project-codec.ts";
import { isUserFont } from "./text-fonts.ts";
import { faceOfKey, recordKey, restrictedNote, textsNeedingFonts, UserFontShelf, userFontIdsOf, userFontUses, userStyleRefusal, type EngineCall } from "./user-fonts.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : `\n  ${JSON.stringify(detail)}`}`);
}
function eq(name: string, got: unknown, want: unknown) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// --- A fake engine. A "font file" is JSON: {name, family, restricted?, weight?, bold?, faces?, letters?}; a pack is {pack: true, ...}.
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hex = (text: string) => {
  let out = "";
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  while (out.length < 64) {
    h = Math.imul(h ^ out.length, 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
};
interface Fake {
  call: EngineCall;
  calls: Record<string, unknown>[];
}
function fakeEngine(): Fake {
  const calls: Record<string, unknown>[] = [];
  const shaById = new Map<string, string>();
  const call: EngineCall = async (request) => {
    calls.push(request);
    if (request.call === "textFontAdd") {
      const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(String(request.dataB64))!)) as Record<string, unknown>;
      if (parsed.broken) return { error: "This file is not a font Lime Slice can read. Use a TrueType (.ttf) or OpenType (.otf) file." };
      const face = typeof request.face === "number" ? request.face : 0;
      const sha = parsed.pack ? String(parsed.sha256) : hex(String(parsed.name));
      const id = `user:${sha.slice(0, 16)}${face > 0 ? `.${face}` : ""}`;
      if (!parsed.pack) shaById.set(id, sha);
      return {
        ok: true,
        id: parsed.pack ? String(parsed.id) : id,
        sha256: sha,
        name: String(parsed.name),
        family: String(parsed.family),
        style: "Regular",
        bold: parsed.bold === true,
        italic: false,
        weight: parsed.weight ?? null,
        restricted: parsed.restricted === true || parsed.pack === true,
        ...(parsed.pack ? { pack: true, letters: parsed.letters } : {}),
        ...(Array.isArray(parsed.faces) ? { faces: parsed.faces } : {}),
      };
    }
    if (request.call === "textFontPack") {
      const uses = request.uses as { text: string }[];
      const letters = [...new Set(uses.flatMap((use) => [...use.text]).filter((ch) => ch.trim()))].sort().join("");
      return { ok: true, id: request.id, dataB64: bytesToBase64(enc({ pack: true, id: request.id, sha256: shaById.get(String(request.id)), name: "Closed Serif Regular", family: "Closed Serif", letters })) };
    }
    return { error: "unknown call" };
  };
  return { call, calls };
}
const fontFile = (extra: Record<string, unknown> = {}) => enc({ name: "Fake Sans Regular", family: "Fake Sans", ...extra });

const lettering = (font: string, text: string, extra: Record<string, unknown> = {}) => ({ kind: "lettering", op: "fuse", origin: [0, 0, 0], turn: [0, 0, 0], text, font, height: 5, depth: 1, ...extra });
const group = (...steps: unknown[]) => ({ kind: "group", label: "Text", steps });
const treesOf = (...ops: unknown[]) => ({ objects: [{ modelTree: { nodes: ops.map((op) => ({ op })) } }] });

// --- Text ops that need their font found.
{
  const plain = { op: { kind: "text", text: "A", font: "sans" } };
  eq("a bundled font, the stroke font and none need nothing", textsNeedingFonts([plain, { kind: "text", text: "A", font: "stroke" }, { kind: "text", text: "A" }, { kind: "text", text: "A", font: "mono@1" }]).length, 0);
  eq("a font id the engine already knows needs nothing", textsNeedingFonts({ kind: "text", text: "A", font: "user:0123456789abcdef" }).length, 0);
  const byFile = { kind: "text", text: "A", fontFile: "my.ttf" };
  const byName = { kind: "text", text: "A", font: "Avenir Next" };
  const found = textsNeedingFonts({ ops: [{ op: byFile }, { op: { kind: "pattern", op: byName } }], other: { kind: "boolean" } });
  check("a fontFile and a font name are found, in arrays and inside a pattern's op", found.length === 2 && found[0] === byFile && found[1] === byName, found);
  eq("a text op with a font file but no other change", textsNeedingFonts({ kind: "text", text: "A", fontFile: "a.otf#2" }).length, 1);
}

// --- Which fonts a project's steps use, and the letters.
{
  const trees = {
    objects: [{ modelTree: { nodes: [{ op: null }, { op: group(lettering("user:aaaaaaaaaaaaaaaa", "LOT 1", { style: "bold" })) }, { op: lettering("sans@4.0", "x") }] } }],
    modelTools: [{ modelTree: { nodes: [{ op: group(lettering("user:aaaaaaaaaaaaaaaa", "SN 2", { weight: 650 }), lettering("user:bbbbbbbbbbbbbbbb", "Z")) }] } }],
  };
  const uses = userFontUses(trees);
  eq("only fonts of the person's are listed", [...uses.keys()], ["user:aaaaaaaaaaaaaaaa", "user:bbbbbbbbbbbbbbbb"]);
  eq("each use keeps its text, style and weight, in order, tools included", uses.get("user:aaaaaaaaaaaaaaaa"), [{ text: "LOT 1", style: "bold" }, { text: "SN 2", weight: 650 }]);
  eq("the ids a typed op names, through a group's steps and a pattern", userFontIdsOf({ kind: "pattern", op: group(lettering("user:cccccccccccccccc", "A")) }), ["user:cccccccccccccccc"]);
  eq("a text op typed with a font id names it too", userFontIdsOf({ kind: "text", font: "user:dddddddddddddddd" }), ["user:dddddddddddddddd"]);
  check("isUserFont", isUserFont("user:abc") && !isUserFont("sans@4.0") && !isUserFont(undefined));
}

// --- The shelf.
{
  const engine = fakeEngine();
  const shelf = new UserFontShelf(engine.call);
  let changes = 0;
  shelf.onChange(() => (changes += 1));
  const added = await shelf.add(fontFile());
  check("a font file is added", added.ok && added.font.name === "Fake Sans Regular" && added.font.id.startsWith("user:") && added.font.from === "added" && !added.font.restricted, added);
  if (added.ok) {
    check("the shelf holds it with its bytes", shelf.fonts.get(added.font.id)?.bytes?.length === fontFile().length);
    eq("the project keeps it under its SHA-256", recordKey(added.font), added.font.sha256);
    eq("a collection's face has its number in the key", recordKey({ sha256: "ab".repeat(32), face: 2 }), `${"ab".repeat(32)}.2`);
    eq("and the key says the face", [faceOfKey(`${"ab".repeat(32)}.2`), faceOfKey("ab".repeat(32))], [2, 0]);
    check("the same file added again is the same font, once", (await shelf.add(fontFile())).ok && shelf.list().length === 1);
    check("the shelf told its listeners", changes >= 1);
  }
  const bad = await shelf.add(enc({ broken: true }));
  check("a file the engine will not read is its sentence", !bad.ok && bad.reason === "This file is not a font Lime Slice can read. Use a TrueType (.ttf) or OpenType (.otf) file.", bad);
  check("and is not on the shelf", shelf.list().length === 1);
  const second = await shelf.add(enc({ name: "Fake Sans Bold", family: "Fake Sans", bold: true }), "library");
  check("a second style of a family is a second font", second.ok && shelf.list().length === 2);
  // Names: id, full name, then the family's regular.
  const byFull = shelf.find("fake sans bold");
  eq("a font is found by its full name, in any case", byFull?.name, "Fake Sans Bold");
  eq("a family name finds its regular", shelf.find("Fake Sans")?.bold, false);
  eq("an id finds it", shelf.find(shelf.list()[0]!.id)?.id, shelf.list()[0]!.id);
  eq("a name nobody has finds nothing", shelf.find("Avenir Next"), undefined);
  // A collection answers its faces.
  const ttc = await shelf.add(enc({ name: "Face Zero", family: "Collection", faces: [{ index: 0, name: "Face Zero" }, { index: 1, name: "Face One" }] }));
  check("a collection lists its faces", ttc.ok && ttc.faces.length === 2 && ttc.faces[1]!.name === "Face One", ttc);
  const face1 = await shelf.add(enc({ name: "Face One", family: "Collection" }), "added", 1);
  check("the engine is told which face", face1.ok && engine.calls.some((call) => call.face === 1) && face1.font.id.endsWith(".1"), face1);
  check("removing takes it off", shelf.remove(face1.ok ? face1.font.id : "") && !shelf.list().some((font) => font.name === "Face One"));
  shelf.clear();
  eq("clear empties the shelf", shelf.list().length, 0);
}

// --- What a project keeps (D5).
{
  const engine = fakeEngine();
  const shelf = new UserFontShelf(engine.call);
  const whole = await shelf.add(fontFile({ name: "Open Sans Regular", family: "Open Sans" }));
  const closed = await shelf.add(fontFile({ name: "Closed Serif Regular", family: "Closed Serif", restricted: true }));
  const unused = await shelf.add(fontFile({ name: "Unused Mono Regular", family: "Unused Mono" }));
  if (!whole.ok || !closed.ok || !unused.ok) throw new Error("fonts");
  check("the licence is read from the engine's answer", !whole.font.restricted && closed.font.restricted, [whole.font.restricted, closed.font.restricted]);
  check("a restricted font says so in one sentence", restrictedNote(closed.font) === "‘Closed Serif Regular’ does not allow embedding, so this project keeps only the outlines of the letters you use." && restrictedNote(whole.font) === null);
  const trees = treesOf(group(lettering(whole.font.id, "Hello")), group(lettering(closed.font.id, "LOT 42")), group(lettering(closed.font.id, "7", { style: "bold" })));
  const records = await shelf.recordsFor(trees);
  check("a font that may be embedded keeps its file", !!records && base64ToBytes(records[recordKey(whole.font)]!.bytesBase64)!.length === fontFile({ name: "Open Sans Regular", family: "Open Sans" }).length, records && Object.keys(records));
  const packCall = engine.calls.find((call) => call.call === "textFontPack");
  check("a restricted font is packed with the texts that use it", packCall?.id === closed.font.id && (packCall?.uses as unknown[]).length === 2, packCall);
  const packed = records?.[recordKey(closed.font)];
  const packBody = packed ? (JSON.parse(new TextDecoder().decode(base64ToBytes(packed.bytesBase64)!)) as { pack: boolean; letters: string }) : null;
  check("and keeps the pack, not the file", packBody?.pack === true && packBody.letters === "247LOT", packBody);
  check("a font no text uses is not kept", !records?.[recordKey(unused.font)]);
  eq("a project with no text in a font of the person's keeps none", await shelf.recordsFor(treesOf(lettering("sans@4.0", "x"))), undefined);
  // The synchronous version stands on the packs made so far.
  const now = shelf.recordsNow(trees);
  check("a save that cannot wait has the same records", !!now && Object.keys(now).sort().join() === Object.keys(records!).sort().join(), now && Object.keys(now));
  // A font this computer has only as a pack keeps the record the project had.
  const reopened = new UserFontShelf(fakeEngine().call);
  const notes = await reopened.adopt(records);
  eq("a project's records are given to the engine", notes, []);
  const got = reopened.find("Closed Serif Regular");
  check("the pack is a font on the shelf, marked as the project's, with no file", !!got && got.from === "project" && got.restricted && got.bytes === undefined, got);
  const again = await reopened.recordsFor(trees, records);
  check("saved again, a pack-only font keeps its record", !!again && again[recordKey(closed.font)]!.hash === records![recordKey(closed.font)]!.hash);
  const damaged = await new UserFontShelf(fakeEngine().call).adopt({ [whole.font.sha256]: { name: "Bad", bytesBase64: "!!!", byteLength: 3, hash: "00" } });
  check("a damaged record is a note, not a failure", damaged.length === 1 && /damaged/.test(damaged[0]!), damaged);
  const refused = await new UserFontShelf(fakeEngine().call).adopt({ [whole.font.sha256]: meshRecord("x", enc({ broken: true })) });
  check("a record the engine will not read is a note with its sentence", refused.length === 1 && /not a font Lime Slice can read/.test(refused[0]!), refused);
}

// --- A pack never takes the place of the whole font.
{
  const shelf = new UserFontShelf(fakeEngine().call);
  const whole = await shelf.add(fontFile({ name: "Both Regular", family: "Both", restricted: true }));
  const pack = await shelf.add(enc({ pack: true, id: whole.ok ? whole.font.id : "", sha256: whole.ok ? whole.font.sha256 : "", name: "Both Regular", family: "Both", letters: "AB" }), "project");
  check("the file stays when its pack arrives", pack.ok && !pack.font.pack && !!pack.font.bytes, pack);
}

// --- Styles of a font of the person's.
{
  const font = { name: "Plain", bold: false, weight: null };
  eq("a font with no bold refuses bold and bold italic", [userStyleRefusal(font, "bold"), userStyleRefusal(font, "bold-italic")], ["Plain has no bold. Pick Regular, or another font.", "Plain has no bold. Pick Regular, or another font."]);
  eq("it makes an italic by slant, and regular is as it is", [userStyleRefusal(font, "italic"), userStyleRefusal(font, "regular")], [null, null]);
  eq("a bold file takes bold", userStyleRefusal({ name: "Heavy", bold: true, weight: null }, "bold"), null);
  eq("a variable font takes bold as a weight", userStyleRefusal({ name: "Var", bold: false, weight: { min: 300, default: 400, max: 700 } }, "bold"), null);
}

// --- The project file: the fonts map is packed like a brep and comes back byte for byte; a project without one has no key.
{
  const file = fontFile({ name: "Round Trip Regular", family: "Round Trip" });
  const sha = "ab".repeat(32);
  const project: LimeProject = {
    version: 2,
    mesh: meshRecord("part.stl", new Uint8Array([1, 2, 3, 4])),
    placement: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.05 },
    settings: { ...DEFAULT_PRESET },
    preset: null,
    profile: defaultProfile(),
    level: "simple",
    supportEdits: [],
    objects: [{ id: "part", name: "part.stl", mesh: meshRecord("part.stl", new Uint8Array([1, 2, 3, 4])), placement: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], scale: 1, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.05 }, supportEdits: [] }],
    fonts: { [sha]: meshRecord("Round Trip.font", file), [`${"cd".repeat(32)}.2`]: meshRecord("Face Two.font", file) },
  };
  const text = await encodeProject(project);
  const wire = JSON.parse(text) as { fonts: Record<string, Record<string, unknown>> };
  check("fonts are on the wire, packed like a solid", Object.values(wire.fonts).every((row) => row.encoding === ENCODING_GZIP && typeof row.data === "string" && row.bytesBase64 === undefined), wire.fonts);
  check("a record keeps its name and length", wire.fonts[sha]!.name === "Round Trip.font" && wire.fonts[sha]!.byteLength === file.length);
  const opened = await decodeProject(text);
  check("the project opens", opened.ok, opened);
  if (opened.ok) {
    const back = opened.project.fonts?.[sha];
    check("the font file comes back byte for byte", !!back && Buffer.from(base64ToBytes(back.bytesBase64)!).equals(Buffer.from(file)), back);
    check("a collection's face keeps its key", Object.keys(opened.project.fonts ?? {}).includes(`${"cd".repeat(32)}.2`), Object.keys(opened.project.fonts ?? {}));
    check("a save of what opened is the same save", (await encodeProject(opened.project)) === text);
    const plain = parseProject(serializeProject(opened.project));
    check("and the plain reader keeps them", plain.ok && Object.keys(plain.project.fonts ?? {}).length === 2);
  }
  const without = await encodeProject({ ...project, fonts: undefined });
  check("a project that uses none has no fonts key", !("fonts" in JSON.parse(without)), Object.keys(JSON.parse(without)));
  // Damaged or oddly keyed records are left out, so the project still opens.
  const junk = readFonts({ [sha]: meshRecord("ok", file), "not-a-hash": meshRecord("x", file), [`${"ef".repeat(32)}`]: { name: "x", bytesBase64: "AAAA", byteLength: 9, hash: "00" }, [`${"12".repeat(32)}.x`]: meshRecord("y", file) });
  eq("only a good record under a good key is read", Object.keys(junk ?? {}), [sha]);
  eq("none is none", readFonts({ nope: 1 }), undefined);
}

if (failed > 0) {
  console.error(`${failed} user-font checks failed`);
  process.exit(1);
}
console.log("user-fonts: ok");
