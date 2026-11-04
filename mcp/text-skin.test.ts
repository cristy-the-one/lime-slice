/**
 * Text on a sphere, a torus and a freeform face (docs/plan-text-on-curves-and-fonts.md, milestone 3), through the MCP server against
 * real Open CASCADE: a `text` op on such a face is one lettering step walked along the surface at true size, raised or engraved,
 * centred on the face's middle or on `point`, starting along u or v, wrapped or projected; the refusals are sentences and change
 * nothing; the guide says how. Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
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
    console.error("text-skin: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("text-skin: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-text-skin-"));
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

const engine = loadEngineWorker(root);
const session = new Session(engine);
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;
const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);

/** A curved part and its face of that kind. */
async function part(extra: Record<string, unknown>, kind: string): Promise<{ object: string; face: number; before: number }> {
  const made = await call("solid_new", extra);
  const object = String(made.object);
  const found = await call("faces_find", { object, kind, limit: 1 });
  const row = (found.faces as { index: number }[])[0];
  if (!row) throw new Error(`no ${kind} face in ${JSON.stringify(found).slice(0, 200)}`);
  return { object, face: row.index, before: await volume(object) };
}
const ball = () => part({ primitive: "sphere", radius: 20 }, "sphere");
const ring = () => part({ primitive: "torus", radius: 30, tubeRadius: 10 }, "other");
const egg = () => part({ primitive: "ellipsoid", dx: 80, dy: 60, dz: 50 }, "other");
const text = (face: number, extra: Record<string, unknown> = {}) => ({ kind: "text", faceIndex: face, text: "Lime 42", font: "sans", style: "bold", height: 4, depth: 0.6, ...extra });

// --- Raised on a sphere: one step, the letters' ink added.
{
  const { object, face, before } = await ball();
  const reply = await call("model_apply", { object, op: text(face, { height: 5, depth: 0.8 }) });
  check("Lime 42 in Sans Bold walks round a sphere", reply.ok === true, JSON.stringify(reply).slice(0, 300));
  const grew = (await volume(object)) - before;
  check("it adds the letters' ink times the depth, a little more for the curve", grew > 0.8 * 20 && grew < 0.8 * 90, String(grew));
  const rows = (await call("model_history", { object })).nodes as { label: string }[];
  check("it is one history row named for the text", rows.length === 2 && rows[1]!.label === "Text Lime 42", JSON.stringify(rows));
}

// --- Engraved takes out a little less than raised adds, on the sphere (1 + d/R against 1 - d/R); a torus and a freeform face take it too.
{
  const a = await ball();
  const raised = await call("model_apply", { object: a.object, op: text(a.face, { text: "AO8 gB", depth: 0.8 }) });
  const b = await ball();
  const cut = await call("model_apply", { object: b.object, op: text(b.face, { text: "AO8 gB", depth: 0.8, op: "cut" }) });
  check("raised and engraved both apply", raised.ok === true && cut.ok === true, JSON.stringify([raised, cut]).slice(0, 300));
  const added = (await volume(a.object)) - a.before;
  const taken = b.before - (await volume(b.object));
  check("raised adds a little more than engraved takes", added > taken && Math.abs(added / taken - (1 + 0.8 / 20) / (1 - 0.8 / 20)) < 0.02, `${added} ${taken}`);
  const t = await ring();
  const onTorus = await call("model_apply", { object: t.object, op: text(t.face, { text: "Lime 42", height: 3 }) });
  check("the same text walks round a torus", onTorus.ok === true, JSON.stringify(onTorus).slice(0, 300));
  const f = await egg();
  const onEgg = await call("model_apply", { object: f.object, op: text(f.face, { text: "UP", op: "cut", depth: 0.5 }) });
  check("and is engraved on a freeform face", onEgg.ok === true, JSON.stringify(onEgg).slice(0, 300));
}

// --- Along v, project and flip: the same letters, so about the same ink (a projection stretches a little on a ball).
{
  const a = await ball();
  await call("model_apply", { object: a.object, op: text(a.face, { text: "LIME", depth: 0.6 }) });
  const wrapped = (await volume(a.object)) - a.before;
  for (const extra of [{ along: "v" }, { flip: true }, { angleDeg: 30 }, { wrap: "project" }]) {
    const b = await ball();
    const reply = await call("model_apply", { object: b.object, op: text(b.face, { text: "LIME", depth: 0.6, ...extra }) });
    check(`${JSON.stringify(extra)} applies`, reply.ok === true, JSON.stringify(reply).slice(0, 300));
    const grew = (await volume(b.object)) - b.before;
    check(`${JSON.stringify(extra)} adds about the same material`, Math.abs(grew - wrapped) < 0.06 * wrapped, `${grew} ${wrapped}`);
  }
}

// --- Refusals are sentences, and change nothing.
{
  const { object, face, before } = await ball();
  const fail = async (extra: Record<string, unknown>) => (await call("model_apply", { object, op: text(face, extra) }).catch((err: Error) => ({ ok: false, reason: err.message }))) as Record<string, any>;
  const stroke = await fail({ font: "stroke", style: "bold" });
  check("the pen fonts take no style", stroke.ok === false && /one style/.test(JSON.stringify(stroke)), JSON.stringify(stroke).slice(0, 300));
  const long = await fail({ text: "LIME SLICE 2026 ".repeat(8), height: 6 });
  check("text longer than the way round names the length", long.ok === false && /The text is longer than the way round this sphere \(125\.7 mm\)\. Make it smaller or use two lines\./.test(JSON.stringify(long)), JSON.stringify(long).slice(0, 300));
  const big = await fail({ text: "LI", height: 30 });
  check("letters too big for the curve are refused by their size", big.ok === false && /too big for this curve/.test(JSON.stringify(big)), JSON.stringify(big).slice(0, 300));
  const around = await fail({ along: "around" });
  check("a sphere starts along u or v, not around", around.ok === false && /along is u or v on this face/.test(JSON.stringify(around)), JSON.stringify(around).slice(0, 300));
  const deep = await fail({ text: "I", height: 2, depth: 19.5, op: "cut" });
  check("an engraving deeper than the curve names the depth that works", deep.ok === false && /Letters this deep would fold over inside this curve\. Use a depth under [\d.]+ mm\./.test(JSON.stringify(deep)), JSON.stringify(deep).slice(0, 300));
  check("a refusal leaves the solid as it was", Math.abs((await volume(object)) - before) < 1e-6);
  const cylinder = await part({ primitive: "cylinder", radius: 20, height: 40 }, "cylinder");
  const projected = await call("model_apply", { object: cylinder.object, op: text(cylinder.face, { wrap: "project" }) }).catch((err: Error) => ({ ok: false, reason: err.message }));
  check("project is for sphere, torus and freeform faces", (projected as Record<string, any>).ok === false && /Project is for a sphere/.test(JSON.stringify(projected)), JSON.stringify(projected).slice(0, 300));
}

// --- The guide says how.
{
  const guide = JSON.stringify(await call("guide", { kind: "text" }));
  check("guide {kind:\"text\"} explains a sphere, a torus and a freeform face", /sphere/.test(guide) && /torus/.test(guide) && /freeform/.test(guide) && /wrap/.test(guide) && /project/.test(guide), guide.slice(0, 300));
  check("and the new refusals", /pole of this sphere/.test(guide) && /too big for this curve/.test(guide), guide.slice(0, 300));
}

if (failed > 0) {
  console.error(`${failed} text-skin checks failed`);
  process.exit(1);
}
console.log("text-skin: ok");
process.exit(0);
