/**
 * Text on a cylinder and a cone (docs/plan-text-on-curves-and-fonts.md, milestone 2), through the MCP server against real Open
 * CASCADE: a `text` op on a round face is one lettering step wrapped along the surface, raised or engraved, centred on the
 * face's middle or on `point`, round the part or up it; the refusals are sentences and change nothing; the guide says how.
 * Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("text-curves: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("text-curves: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-text-curves-"));
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
const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);

/** A round part and its wall: the face of that kind. */
async function round(primitive: "cylinder" | "cone" | "sphere", extra: Record<string, unknown>, kind: string): Promise<{ object: string; face: number; before: number; radius: number }> {
  const made = await call("solid_new", { primitive, ...extra });
  const object = String(made.object);
  const found = await call("faces_find", { object, kind, limit: 1 });
  const row = (found.faces as { index: number; radiusMm?: number }[])[0]!;
  return { object, face: row.index, before: await volume(object), radius: row.radiusMm ?? 0 };
}
const cylinder = () => round("cylinder", { radius: 20, height: 40 }, "cylinder");
const cone = () => round("cone", { radius: 25, topRadius: 15, height: 40 }, "cone");

// --- Raised on a cylinder: one step, the wall's own letters added to it.
{
  const { object, face, before, radius } = await cylinder();
  check("the wall is a cylinder of radius 20", near(radius, 20, 1e-6), String(radius));
  const op = { kind: "text", faceIndex: face, text: "Lime 42", font: "sans", style: "bold", height: 5, depth: 0.8 };
  const reply = await call("model_apply", { object, op });
  check("Lime 42 in Sans Bold wraps round a cylinder", reply.ok === true, JSON.stringify(reply));
  const grew = (await volume(object)) - before;
  check("it adds the letters' ink times the depth, a little more for the curve", grew > 0.8 * 20 && grew < 0.8 * 90, String(grew));
  const history = await call("model_history", { object });
  const rows = history.nodes as { label: string }[];
  check("it is one history row named for the text", rows.length === 2 && rows[1]!.label === "Text Lime 42", JSON.stringify(rows));
}

// --- Engraved on a cylinder takes out a little less than raised adds; the same fields on a cone.
{
  const a = await cylinder();
  const raised = await call("model_apply", { object: a.object, op: { kind: "text", faceIndex: a.face, text: "AO8 gB", font: "sans", height: 4, depth: 0.8 } });
  const b = await cylinder();
  const cut = await call("model_apply", { object: b.object, op: { kind: "text", faceIndex: b.face, text: "AO8 gB", font: "sans", height: 4, depth: 0.8, op: "cut" } });
  check("raised and engraved both apply", raised.ok === true && cut.ok === true, JSON.stringify([raised, cut]).slice(0, 300));
  const added = (await volume(a.object)) - a.before;
  const taken = b.before - (await volume(b.object));
  // Raised letters widen towards their top and engraved narrow towards the floor: 1 + d/2R against 1 - d/2R.
  check("raised adds a little more than engraved takes", added > taken && near(added / taken, (1 + 0.8 / 40) / (1 - 0.8 / 40), 0.01), `${added} ${taken}`);
  const k = await cone();
  const onCone = await call("model_apply", { object: k.object, op: { kind: "text", faceIndex: k.face, text: "Lime 42", font: "mono", height: 4, depth: 0.6 } });
  check("the same text wraps a cone", onCone.ok === true, JSON.stringify(onCone).slice(0, 300));
  const engraved = await call("model_apply", { object: k.object, op: { kind: "text", faceIndex: k.face, text: "UP", font: "sans", height: 4, depth: 0.5, op: "cut", point: [-20, 0, 8], along: "axis" } });
  check("and one engraved up the cone, at a point", engraved.ok === true, JSON.stringify(engraved).slice(0, 300));
}

// --- Direction and flip: the same letters, so the same volume.
{
  const a = await cylinder();
  await call("model_apply", { object: a.object, op: { kind: "text", faceIndex: a.face, text: "LIME", font: "sans", height: 4, depth: 0.6 } });
  const around = (await volume(a.object)) - a.before;
  const b = await cylinder();
  const up = await call("model_apply", { object: b.object, op: { kind: "text", faceIndex: b.face, text: "LIME", font: "sans", height: 4, depth: 0.6, along: "axis", flip: true } });
  check("along the axis and flipped applies", up.ok === true, JSON.stringify(up).slice(0, 300));
  check("the same letters add the same material", near((await volume(b.object)) - b.before, around, 0.05), String((await volume(b.object)) - b.before - around));
}

// --- Refusals are sentences, and change nothing.
{
  const { object, face, before } = await cylinder();
  const text = (extra: Record<string, unknown>) => ({ kind: "text", faceIndex: face, text: "Lime", height: 4, depth: 0.5, font: "sans", ...extra });
  const stroke = await call("model_apply", { object, op: text({ font: "stroke" }) });
  check("the stroke font stays on flat faces", stroke.ok === false && /takes an outline font/.test(JSON.stringify(stroke)), JSON.stringify(stroke).slice(0, 300));
  const long = await call("model_apply", { object, op: text({ text: "LIME SLICE 2026 ".repeat(5) }) });
  check("text longer than the way round names the length", long.ok === false && /The text is longer than the way round this cylinder \(125\.7 mm\)\. Make it smaller or use two lines\./.test(JSON.stringify(long)), JSON.stringify(long).slice(0, 300));
  const off = await call("model_apply", { object, op: text({ point: [-20, 0, 39], height: 6 }) });
  check("text off the end of the wall", off.ok === false && /The text runs off this face\. Move it, make it smaller, or put it on one face\./.test(JSON.stringify(off)), JSON.stringify(off).slice(0, 300));
  const direction = await call("model_apply", { object, op: text({ along: "sideways" }) }).catch((err: Error) => ({ ok: false, reason: err.message }));
  check("a direction that is not one", (direction as Record<string, any>).ok === false, JSON.stringify(direction).slice(0, 300));
  check("a refusal leaves the solid as it was", near(await volume(object), before, 1e-6));
  const thin = await round("cylinder", { radius: 5, height: 20 }, "cylinder");
  const deep = await call("model_apply", { object: thin.object, op: { kind: "text", faceIndex: thin.face, text: "I", font: "sans", height: 3, depth: 4.6, op: "cut" } });
  check("letters too deep for a small cylinder name the depth that works", deep.ok === false && /Letters this deep would fold over inside this curve\. Use a depth under 4\.5 mm\./.test(JSON.stringify(deep)), JSON.stringify(deep).slice(0, 300));
  const ball = await round("sphere", { radius: 20 }, "sphere");
  const sphere = await call("model_apply", { object: ball.object, op: { kind: "text", faceIndex: ball.face, text: "Lime", font: "sans", height: 4, depth: 0.5 } });
  check("a sphere is turned away for now", sphere.ok === false && /Text goes on a flat face, a cylinder or a cone for now/.test(JSON.stringify(sphere)), JSON.stringify(sphere).slice(0, 300));
}

// --- The guide says how.
{
  const guide = JSON.stringify(await call("guide", { kind: "text" }));
  check("guide {kind:\"text\"} explains a cylinder and a cone", /faces_find/.test(guide) && /around/.test(guide) && /axis/.test(guide) && /flip/.test(guide) && /seam/.test(guide), guide.slice(0, 300));
  check("and the new refusals", /way round this cylinder/.test(guide) && /fold over/.test(guide), guide.slice(0, 300));
}

if (failed > 0) {
  console.error(`${failed} text-curves checks failed`);
  process.exit(1);
}
console.log("text-curves: ok");
process.exit(0);
