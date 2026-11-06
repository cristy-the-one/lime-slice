/**
 * Pen fonts and the MCP's text polish (docs/plan-text-on-curves-and-fonts.md, milestone 5), through the MCP server against real Open
 * CASCADE: `stroke` and `line` are one lettering step on a flat face and on a cylinder, a cone, a sphere, a torus and a freeform
 * face, raised and engraved; a project saved before this (a text of boxes, no font) opens and rebuilds the same solid; model_probe of
 * a text answers `inkMm2` and `thin`; the guide lists the fonts.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { PEN_FONTS } from "../src/modeling/text-fonts.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("text-pen: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("text-pen: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-text-pen-"));
process.env.LIME_MCP_WORKSPACE = workspace;
process.env.LIME_MCP_MODEL_TIMEOUT_S = process.env.LIME_MCP_MODEL_TIMEOUT_S ?? "40";

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
type Reply = { [key: string]: unknown; volumeMm3?: number; fingerprint?: { faces?: number; edges?: number }; text?: { font?: string; build?: string; surface?: string }; inkMm2?: number };
const session = new Session(engine);
const call = async (name: string, args: unknown = {}, on = session): Promise<Reply> => {
  try {
    return (await on.call(name, args)) as Reply;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};
const volume = async (object: string, on = session) => Number((await call("model_describe", { object, limit: 1 }, on)).volumeMm3);

/** A solid and its first face of a kind (a flat one: the top). */
async function part(spec: Record<string, unknown>, kind: string): Promise<{ object: string; face: number; before: number }> {
  const made = await call("solid_new", spec);
  const object = String(made.object);
  const found = kind === "plane" ? await call("faces_find", { object, normal: [0, 0, 1], limit: 1 }) : await call("faces_find", { object, kind, limit: 1 });
  const row = (found.faces as { index: number }[] | undefined)?.[0];
  if (!row) throw new Error(`no ${kind} face in ${JSON.stringify(found).slice(0, 200)}`);
  return { object, face: row.index, before: await volume(object) };
}
const block = () => part({ primitive: "box", dx: 60, dy: 30, dz: 10 }, "plane");
const cylinder = () => part({ primitive: "cylinder", radius: 20, height: 40 }, "cylinder");
const cone = () => part({ primitive: "cone", radius: 25, topRadius: 15, height: 40 }, "cone");
const ball = () => part({ primitive: "sphere", radius: 25 }, "sphere");
const ring = () => part({ primitive: "torus", radius: 30, tubeRadius: 10 }, "other");
const egg = () => part({ primitive: "ellipsoid", dx: 80, dy: 60, dz: 50 }, "other");
const text = (face: number, extra: Record<string, unknown> = {}) => ({ kind: "text", faceIndex: face, text: "Lime 42", font: "stroke", height: 4, depth: 0.5, ...extra });

// --- A project saved before pen fonts: a text of boxes with no font. It opens and rebuilds the same solid, and says what it is.
{
  copyFileSync(join(root, "mcp", "fixtures", "text-stroke-boxes-5.1.lime"), join(workspace, "old.lime"));
  const old = new Session(engine);
  const opened = await call("project_open", { path: "old.lime" }, old);
  check("a project saved with stroke text opens", opened.ok === true, JSON.stringify(opened).slice(0, 300));
  const object = String((opened.objects as { object: string }[])[0]!.object);
  const described = await call("model_describe", { object, limit: 1 }, old);
  check("with the volume it was saved with", near(described.volumeMm3, 18076.082766, 1e-3), String(described.volumeMm3));
  const history = (await call("model_history", { object }, old)) as { nodes: { id?: string; node?: string; label: string; kind?: string }[] };
  check("its history has the two texts as groups, as it was", history.nodes.filter((n) => /^Text /.test(n.label)).length === 2, JSON.stringify(history.nodes.map((n) => n.label)));
  // Rebuild: step back to the root, forward to the end; the engine builds every box again from the saved steps.
  const ids = history.nodes.map((n) => String(n.id ?? n.node));
  await call("model_goto", { object, node: ids[0] }, old);
  const rootVolume = await volume(object, old);
  await call("model_goto", { object, node: ids[ids.length - 1] }, old);
  const again = await call("model_describe", { object, limit: 1 }, old);
  check("rebuilt from its steps it is the same solid", near(rootVolume, 18000, 1e-6) && near(again.volumeMm3, 18076.082766, 1e-3) && again.fingerprint?.faces === 300 && again.fingerprint?.edges === 710, JSON.stringify(again.fingerprint));
  const raw = JSON.stringify(await call("model_history", { object }, old));
  check("and holds no lettering step: the boxes are still boxes", !/lettering/.test(raw) && history.nodes.length >= 3);
}

// --- Stroke and line on a flat face: one history row, raised by the ink times the depth, which model_probe now reports.
{
  const { object, face, before } = await block();
  const op = text(face, { text: "Lime 42 gy", font: "line", height: 5, depth: 0.8 });
  const probed = await call("model_probe", { object, op });
  check("model_probe of a text in Line answers", probed.ok === true, JSON.stringify(probed).slice(0, 300));
  check("with the ink area, and no thin letter at the default pen", typeof probed.inkMm2 === "number" && probed.inkMm2 > 10 && Array.isArray(probed.thin) && probed.thin.length === 0, JSON.stringify(probed).slice(0, 300));
  check("and how it was built", probed.text?.font === "line@1" && probed.text?.build === "direct" && probed.text?.surface === "plane", JSON.stringify(probed.text));
  const applied = await call("model_apply", { object, op });
  check("the same text applies", applied.ok === true, JSON.stringify(applied).slice(0, 300));
  check("it adds the ink times the depth", near((await volume(object)) - before, (probed.inkMm2 ?? NaN) * 0.8, 0.02 * (probed.inkMm2 ?? NaN) * 0.8), String((await volume(object)) - before));
  const rows = (await call("model_history", { object })).nodes as { label: string }[];
  check("one history row, named for the text", rows.length === 2 && rows[1]!.label === "Text Lime 42 gy", JSON.stringify(rows));
  // A thin pen: letters named, and the sentence.
  const thin = await call("model_probe", { object: (await block()).object, op: text(face, { text: "Il", strokeWidth: 0.2, height: 6 }) });
  check("a pen thinner than the nozzle names its letters", thin.ok === true && (thin.thin as { char: string }[]).map((t) => t.char).join("") === "Il" && /thinner than your 0\.4 mm line/.test(String(thin.reason)), JSON.stringify(thin).slice(0, 300));
  check("each with the share lost", (thin.thin as { lostPct: number }[]).every((t) => t.lostPct >= 10 && t.lostPct <= 100));
  // An outline font's small letters, as the plan's table says.
  const serif = await call("model_probe", { object: (await block()).object, op: text(face, { text: "emi2", font: "serif", height: 2.5, style: "regular" }) });
  check("a serif at 2.5 mm shows letters that will not print", serif.ok === true && (serif.thin as unknown[]).length > 0, JSON.stringify(serif).slice(0, 300));
  const boxes = await call("model_probe", { object, op: { kind: "text", faceIndex: face, text: "LIME", height: 5, depth: 1 } });
  check("a text with no font is boxes and is applied, not probed", boxes.ok === false && /box for every stroke/.test(String(boxes.reason)), JSON.stringify(boxes).slice(0, 300));
}

// --- On every kind of face, raised and engraved, one step each.
for (const [name, make, surface] of [["a cylinder", cylinder, "cylinder"], ["a cone", cone, "cone"], ["a sphere", ball, "sphere"], ["a torus", ring, "torus"], ["a freeform face", egg, "freeform"]] as const) {
  for (const font of ["stroke", "line"]) {
    for (const cut of [false, true]) {
      const { object, face, before } = await make();
      // The cone's middle by the part's own measure sits near its top: anchor the text halfway up it.
      const op = text(face, { font, height: surface === "torus" ? 3 : 4, ...(surface === "cone" ? { point: [-20, 0, 20] } : {}), ...(cut ? { op: "cut" } : {}) });
      const probed = await call("model_probe", { object, op });
      const done = await call("model_apply", { object, op });
      const label = `${font} ${cut ? "engraved" : "raised"} on ${name}`;
      check(`${label} applies as one step`, done.ok === true && probed.ok === true, JSON.stringify([probed, done]).slice(0, 300));
      if (done.ok !== true) continue;
      check(`${label} is built as ${surface}, without a boolean`, probed.text?.surface === surface && probed.text?.build === "direct", JSON.stringify(probed.text));
      if (surface !== "freeform") {
        const moved = (cut ? -1 : 1) * ((await volume(object)) - before);
        const expect = (probed.inkMm2 ?? NaN) * 0.5;
        check(`${label} moves the ink times the depth, within the curve's share`, moved > 0.85 * expect && moved < 1.2 * expect, `${moved} against ${expect}`);
      }
      const rows = (await call("model_history", { object })).nodes as unknown[];
      check(`${label} is one history row`, rows.length === 2, String(rows.length));
    }
  }
}

// --- A text with no font on a curved face is the stroke font as a pen: it applies, as one step.
{
  const { object, face, before } = await cylinder();
  const bare = await call("model_apply", { object, op: { kind: "text", faceIndex: face, text: "LOT 7", height: 4, depth: 0.5 } });
  const rows = (await call("model_history", { object })).nodes as unknown[];
  check("no font on a cylinder is the stroke pen, one step", bare.ok === true && rows.length === 2 && (await volume(object)) > before, JSON.stringify(bare).slice(0, 300));
}

// --- What a pen font refuses, in sentences.
{
  const { object, face, before } = await cylinder();
  const bold = await call("model_apply", { object, op: text(face, { style: "bold" }) });
  check("a pen font has no bold", bold.ok === false && /Stroke has one style/.test(JSON.stringify(bold)), JSON.stringify(bold).slice(0, 300));
  const wide = await call("model_apply", { object, op: text(face, { strokeWidth: 3 }) });
  check("a pen wider than half the height", wide.ok === false && /strokeWidth is above 0 and at most half the height/.test(JSON.stringify(wide)), JSON.stringify(wide).slice(0, 300));
  const lacks = await call("model_apply", { object, op: text(face, { text: "Lime ñ" }) });
  check("a letter a pen font lacks is named, with what it has", lacks.ok === false && /‘ñ’/.test(JSON.stringify(lacks)) && /A-Z/.test(JSON.stringify(lacks)), JSON.stringify(lacks).slice(0, 300));
  check("a refusal leaves the part as it was", near(await volume(object), before, 1e-6));
}

// --- The guide lists the pen fonts, and the engine's version of them is the app's table.
{
  const guide = JSON.stringify(await call("guide", { kind: "text" }));
  check("guide {kind:\"text\"} lists stroke and line", PEN_FONTS.every((font) => guide.includes(`${font.id}@${font.version}`) || guide.includes(`${font.id}:`)) && /lowercase/.test(guide) && /Hershey/.test(guide), guide.slice(0, 300));
  check("and says what model_probe answers for a text", /inkMm2/.test(JSON.stringify(await call("guide", { kind: "text" }))), guide.slice(0, 200));
  const laid = JSON.parse(await engine.modelTree(JSON.stringify({ call: "textLayout", text: "Ab", font: "line", height: 5 }))) as { ok: boolean; font: string };
  check("the engine names the pen fonts as the app does", laid.ok && laid.font === `line@${PEN_FONTS.find((f) => f.id === "line")!.version}`, JSON.stringify(laid).slice(0, 200));
  const lines = JSON.parse(await engine.modelTree(JSON.stringify({ call: "textLayout", text: "Ab", font: "stroke", height: 5 }))) as { ok: boolean; font: string };
  check("stroke too", lines.ok && lines.font === `stroke@${PEN_FONTS.find((f) => f.id === "stroke")!.version}`, JSON.stringify(lines).slice(0, 200));
}

if (failed > 0) {
  console.error(`${failed} text-pen checks failed`);
  process.exit(1);
}
console.log("text-pen: ok");
process.exit(0);
