/**
 * Text with real fonts (docs/plan-text-on-curves-and-fonts.md, milestone 1), through the MCP server against real Open
 * CASCADE: the bundled fonts the engine reads are the ones the app's picker lists, a text op with a font is one lettering
 * step raised or engraved by the ink times the depth, the refusals are sentences, a text with no font is the stroke font's boxes
 * as ever, and the guide lists the fonts.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { TEXT_FONTS, versionedId } from "../src/modeling/text-fonts.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("text-fonts: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("text-fonts: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-text-fonts-"));
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
const near = (value: unknown, expected: number, tol = 0.02) => typeof value === "number" && Math.abs(value - expected) < tol;

const engine = loadEngineWorker(root);
const session = new Session(engine);
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;
/** A call the schema may turn away by throwing: its sentence, as a refusal. */
const refused = async (name: string, args: unknown) => (await call(name, args).catch((err: Error) => ({ ok: false, reason: err.message }))) as Record<string, any>;
const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);

/** A 40 × 20 × 10 block and its top face. */
async function block(): Promise<{ object: string; face: number; before: number }> {
  const made = await call("solid_new", { primitive: "box", dx: 40, dy: 20, dz: 10 });
  const object = String(made.object);
  const top = await call("faces_find", { object, normal: [0, 0, 1], limit: 1 });
  return { object, face: (top.faces as { index: number }[])[0]!.index, before: await volume(object) };
}

// --- The fonts the engine has are the ones the app's picker lists.
{
  const reply = JSON.parse(await engine.modelTree(JSON.stringify({ call: "textFonts" }))) as { fonts: { id: string; name: string; regular: boolean; bold: boolean; italic: boolean; boldItalic: boolean }[] };
  check("the engine's bundled fonts are the app's table", JSON.stringify(reply.fonts.map((f) => f.id)) === JSON.stringify(TEXT_FONTS.map(versionedId)), JSON.stringify(reply.fonts.map((f) => f.id)));
  check("with the same names and styles", reply.fonts.every((f, i) => f.name === TEXT_FONTS[i]!.name && f.regular === TEXT_FONTS[i]!.has.regular && f.bold === TEXT_FONTS[i]!.has.bold && f.italic === TEXT_FONTS[i]!.has.italic && f.boldItalic === TEXT_FONTS[i]!.has["bold-italic"]));
}

// --- A text with a font is one step: raised by ink × depth.
{
  const { object, face, before } = await block();
  const raised = await call("model_apply", { object, op: { kind: "text", faceIndex: face, text: "Lime 42", font: "sans", style: "bold", height: 5, depth: 0.8 } });
  check("a text in Sans Bold applies", raised.ok === true, JSON.stringify(raised));
  const after = await volume(object);
  check("it adds material, about what the letters' ink is", after - before > 0.8 * 25 && after - before < 0.8 * 90, String(after - before));
  const history = await call("model_history", { object });
  const rows = history.nodes as { label: string }[];
  check("it is one history row named for the text", rows.length === 2 && rows[1]!.label === "Text Lime 42", JSON.stringify(rows));
  // Engraved, the same text takes out as much as it raised.
  const second = await block();
  const cut = await call("model_apply", { object: second.object, op: { kind: "text", faceIndex: second.face, text: "Lime 42", font: "sans", style: "bold", height: 5, depth: 0.8, op: "cut" } });
  check("the same text engraves", cut.ok === true, JSON.stringify(cut));
  check("and takes out what the raised one added", near(second.before - (await volume(second.object)), after - before, 0.01), String(second.before - (await volume(second.object))));
}

// --- Lines, alignment, spacing, style: every field of the op builds.
{
  const { object, face } = await block();
  const op = { kind: "text", faceIndex: face, text: "LOT 42\nSN 7", font: "mono", height: 3, depth: 0.5, align: "right", spacing: 0.2, lineSpacing: 1.6, angleDeg: 10, style: "bold-italic", at: { u: 12, v: 0 } };
  const reply = await call("model_apply", { object, op });
  check("two lines, right-aligned, spaced, turned and slanted, build", reply.ok === true, JSON.stringify(reply));
  const guide = await call("guide", { kind: "text" });
  const text = JSON.stringify(guide);
  check("guide {kind:\"text\"} lists the fonts and the pen fonts", ["Inter", "IBM Plex Mono", "IBM Plex Serif", "Allerta Stencil", "stroke", "line"].every((word) => text.includes(word)), text.slice(0, 300));
  check("and says what a text refuses", /no bold/.test(text) && /fall out/.test(text) && /runs off/.test(text), text.slice(0, 300));
}

// --- Refusals are the sentences, and change nothing.
{
  const { object, face, before } = await block();
  const text = (extra: Record<string, unknown>) => ({ kind: "text", faceIndex: face, text: "Lime", height: 4, depth: 0.5, ...extra });
  const bad = await call("model_apply", { object, op: text({ font: "comic" }) });
  check("an unknown font is refused before it is built", bad.ok === false && /font/.test(JSON.stringify(bad)), JSON.stringify(bad));
  const noBold = await call("model_apply", { object, op: text({ font: "stencil", style: "bold" }) });
  check("a bold the family lacks", noBold.ok === false && /Allerta Stencil has no bold\. Pick Regular, or another font\./.test(JSON.stringify(noBold)), JSON.stringify(noBold));
  const lacking = await call("model_apply", { object, op: text({ font: "sans", text: "Lime 日" }) });
  check("a letter the font lacks is named", lacking.ok === false && /This font has no ‘日’\. Pick another font, or take it out\./.test(JSON.stringify(lacking)), JSON.stringify(lacking));
  const deep = await call("model_apply", { object, op: text({ font: "sans", text: "O", height: 6, depth: 12, op: "cut" }) });
  check("an O engraved through the wall would lose its middle", deep.ok === false && /The middle of ‘O’ would fall out\. Use the Stencil font, or engrave less deep\./.test(JSON.stringify(deep)), JSON.stringify(deep));
  const through = await call("model_apply", { object, op: text({ font: "stencil", text: "O", height: 6, depth: 12, op: "cut" }) });
  check("the stencil O cuts through", through.ok === true, JSON.stringify(through));
  const object2 = (await block());
  const off = await call("model_apply", { object: object2.object, op: { kind: "text", faceIndex: object2.face, text: "THIS RUNS OFF THE FACE", font: "sans", height: 6, depth: 1 } });
  check("text that runs off the face", off.ok === false && /The text runs off this face\. Move it, make it smaller, or put it on one face\./.test(JSON.stringify(off)), JSON.stringify(off));
  const long = await refused("model_apply", { object: object2.object, op: { kind: "text", faceIndex: object2.face, text: "A".repeat(401), font: "sans", height: 1, depth: 1 } });
  check("more than 400 characters is turned away by the schema", long.ok === false && /too long/.test(JSON.stringify(long)), JSON.stringify(long));
  check("a refusal leaves the solid as it was", near(await volume(object2.object), object2.before, 1e-6));
  check("and the first block still has only the stencil cut", (await volume(object)) < before);
}

// --- A text with no font is the boxes it always was. (font "stroke" is the one-step pen font since milestone 5: mcp/text-pen.test.ts.)
{
  const { object, face, before } = await block();
  const old = await call("model_apply", { object, op: { kind: "text", faceIndex: face, text: "LIME", height: 6, depth: 1 } });
  check("a text with no font still applies as the stroke font", old.ok === true, JSON.stringify(old));
  const grew = (await volume(object)) - before;
  const stroked = await block();
  const explicit = await call("model_apply", { object: stroked.object, op: { kind: "text", faceIndex: stroked.face, text: "LIME", height: 6, depth: 1, font: "stroke" } });
  const strokedRows = (await call("model_history", { object: stroked.object })).nodes as { label: string }[];
  check("font stroke is the same letters as one step, round-ended, so a little more ink", explicit.ok === true && strokedRows.length === 2 && (await volume(stroked.object)) - stroked.before > grew * 0.8 && (await volume(stroked.object)) - stroked.before < grew * 1.3, JSON.stringify(explicit));
  // The boxes' volume, which no line of this change touches (textStrokes, the boolean pieces, the kernel's boolean).
  check("single-stroke LIME 6 mm × 1 mm adds the volume it always did", near(grew, 53.331247, 0.0005), String(grew));
  const many = await call("model_apply", { object: stroked.object, op: { kind: "text", faceIndex: stroked.face, text: "L".repeat(81), height: 3, depth: 1 } });
  check("the stroke font keeps its 80 characters", many.ok === false && /at most 80 characters/.test(JSON.stringify(many)), JSON.stringify(many).slice(0, 200));
}

if (failed > 0) {
  console.error(`${failed} text-fonts checks failed`);
  process.exit(1);
}
console.log("text-fonts: ok");
process.exit(0);
