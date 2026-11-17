/**
 * The step guard at the session, against the stand-in engine: a cut Open CASCADE builds wrong (LIME_MCP_FAKE_DAMAGE,
 * a result with blocks meeting only along edges) is refused by model_probe and model_apply alike, an extrude-cut as
 * well as a box Boolean, and leaves no step behind. The real-kernel side is in step-guard-occt.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-step-guard-"));

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const session = new Session(fakeEngine());
const extrudeCut = { kind: "extrude", op: "cut", origin: [0, 0, 20], turn: [0, 0, 0], profile: [[-4, -4], [4, -4], [4, 4], [-4, 4]], depth: -2 };
const boxCut = { kind: "boolean", op: "cut", primitive: "box", origin: [-4, -4, 18], dx: 8, dy: 8, dz: 2 };
const damaged = /^Open CASCADE returned a damaged solid for this step: 5 new edges where pieces meet only along a line, the first at \(/;

{
  const made = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  const object = String(made.object);
  process.env.LIME_MCP_FAKE_DAMAGE = "1";
  for (const [name, op] of [["an extrude-cut", extrudeCut], ["a box cut", boxCut]] as const) {
    const probe = await session.call("model_probe", { object, op });
    const apply = await session.call("model_apply", { object, probe: true, op });
    check(`model_probe refuses ${name} whose result is damaged`, probe.ok === false && probe.code === "step-guard" && probe.damaged === true && damaged.test(String(probe.reason)), JSON.stringify(probe));
    check(`model_apply refuses ${name} whose result is damaged`, apply.ok === false && apply.code === "step-guard" && apply.damaged === true && damaged.test(String(apply.reason)), JSON.stringify(apply));
    check(`model_probe and model_apply give ${name} the same reason`, probe.reason === apply.reason, `${String(probe.reason)} | ${String(apply.reason)}`);
  }
  delete process.env.LIME_MCP_FAKE_DAMAGE;
  const history = await session.call("model_history", { object });
  const steps = Array.isArray(history.steps) ? history.steps.length : Array.isArray(history.nodes) ? history.nodes.length : -1;
  check("a refused step leaves no trace in the history", steps === 1, JSON.stringify(history).slice(0, 400));
  const sound = await session.call("model_apply", { object, probe: true, op: extrudeCut });
  check("the same extrude-cut built soundly is applied", sound.ok === true, JSON.stringify(sound));
}

// A section that never comes back is stopped at the section's budget (here the modeler's 0.3 s; never more than 30 s
// whatever LIME_MCP_MODEL_TIMEOUT_S says) with a sentence, and the modeler is restarted, not left holding every part.
{
  const made = await session.call("solid_new", { primitive: "box", dx: 20, dy: 20, dz: 20 });
  process.env.LIME_MCP_HANG_SECTION = "1";
  process.env.LIME_MCP_MODEL_TIMEOUT_S = "0.3";
  const started = Date.now();
  const cut = await session.call("section", { object: made.object, planes: [{ origin: [0, 0, 10], normal: [0, 0, 1] }] });
  delete process.env.LIME_MCP_HANG_SECTION;
  delete process.env.LIME_MCP_MODEL_TIMEOUT_S;
  check(
    "a section that hangs is refused in time, saying the solid is likely damaged",
    cut.ok === false && cut.code === "model-runaway" && cut.treeLost === true && String(cut.reason).startsWith("This section did not finish in 1 s, so it was stopped.") && Date.now() - started < 5000,
    JSON.stringify(cut),
  );
}

if (failed > 0) {
  console.error(`${failed} step guard check(s) failed`);
  process.exit(1);
}
