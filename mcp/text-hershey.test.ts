/**
 * The Hershey pen fonts through the MCP `text` op against real Open CASCADE (docs/plan-text-on-curves-and-fonts.md, "As built
 * (Hershey)"): each bundled one is one lettering step on a flat face and on a cylinder, names the font as the app's table does,
 * adds the ink times the depth, and the guide lists them. Skips when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { Session } from "./session.ts";
import { isHersheyFont, PEN_FONTS } from "../src/modeling/text-fonts.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("text-hershey: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("text-hershey: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-mcp-text-hershey-"));
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
const call = async (name: string, args: unknown = {}): Promise<Record<string, any>> => {
  try {
    return (await session.call(name, args)) as Record<string, any>;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
};
const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);

async function part(spec: Record<string, unknown>, kind: string): Promise<{ object: string; face: number; before: number }> {
  const made = await call("solid_new", spec);
  const object = String(made.object);
  const found = kind === "plane" ? await call("faces_find", { object, normal: [0, 0, 1], limit: 1 }) : await call("faces_find", { object, kind, limit: 1 });
  const row = (found.faces as { index: number }[] | undefined)?.[0];
  if (!row) throw new Error(`no ${kind} face in ${JSON.stringify(found).slice(0, 200)}`);
  return { object, face: row.index, before: await volume(object) };
}

const hershey = PEN_FONTS.filter((font) => isHersheyFont(font.id));
check("the app has five Hershey fonts", hershey.length === 5, hershey.map((f) => f.id).join());

for (const font of hershey) {
  for (const [name, make, surface] of [
    ["a flat face", () => part({ primitive: "box", dx: 80, dy: 30, dz: 10 }, "plane"), "plane"],
    ["a cylinder", () => part({ primitive: "cylinder", radius: 20, height: 40 }, "cylinder"), "cylinder"],
  ] as const) {
    const { object, face, before } = await make();
    const op = { kind: "text", faceIndex: face, text: "Lime 42", font: font.id, height: 6, depth: 0.5 };
    const probed = await call("model_probe", { object, op });
    const done = await call("model_apply", { object, op });
    const label = `${font.id} on ${name}`;
    check(`${label} probes and applies`, probed.ok === true && done.ok === true, JSON.stringify([probed, done]).slice(0, 300));
    if (done.ok !== true) continue;
    check(`${label} is one step in the engine's own id`, probed.text?.font === `${font.id}@${font.version}` && probed.text?.surface === surface && probed.text?.build === "direct", JSON.stringify(probed.text));
    const moved = (await volume(object)) - before;
    const expect = probed.inkMm2 * 0.5;
    check(`${label} adds the ink times the depth`, moved > 0.85 * expect && moved < 1.2 * expect, `${moved} against ${expect}`);
    const rows = (await call("model_history", { object })).nodes as unknown[];
    check(`${label} is one history row`, rows.length === 2, String(rows.length));
  }
}

// A font a Hershey table lacks letters of names them; Hershey takes no style.
{
  const { object, face, before } = await part({ primitive: "box", dx: 60, dy: 30, dz: 10 }, "plane");
  const lacks = await call("model_apply", { object, op: { kind: "text", faceIndex: face, text: "Lime ñ", font: "hershey-simplex", height: 6, depth: 0.5 } });
  check("a letter Hershey lacks is named", lacks.ok === false && /‘ñ’/.test(JSON.stringify(lacks)) && /ASCII/.test(JSON.stringify(lacks)), JSON.stringify(lacks).slice(0, 300));
  const bold = await call("model_apply", { object, op: { kind: "text", faceIndex: face, text: "Lime", font: "hershey-duplex", style: "bold", height: 6, depth: 0.5 } });
  check("Hershey has no bold", bold.ok === false && /one style/.test(JSON.stringify(bold)), JSON.stringify(bold).slice(0, 300));
  check("a refusal leaves the part as it was", Math.abs((await volume(object)) - before) < 1e-6);
}

// The guide lists each font, and an unknown name lists them as sentences do.
{
  const guide = JSON.stringify(await call("guide", { kind: "text" }));
  check("guide {kind:\"text\"} lists every Hershey font", hershey.every((font) => guide.includes(`${font.id}@${font.version}`)), guide.slice(0, 300));
  const { object, face } = await part({ primitive: "box", dx: 60, dy: 30, dz: 10 }, "plane");
  const unknown = await call("model_apply", { object, op: { kind: "text", faceIndex: face, text: "x", font: "hershey-nope", height: 6, depth: 0.5 } });
  check("an unknown font names the Hershey ones", unknown.ok === false && /hershey-simplex/.test(JSON.stringify(unknown)), JSON.stringify(unknown).slice(0, 300));
}

if (failed > 0) {
  console.error(`${failed} text-hershey checks failed`);
  process.exit(1);
}
console.log("text-hershey: ok");
process.exit(0);
