/**
 * SR-12. A sliced box is solved by the engine's simStudy, in process.
 * The generated-beam smear stays on the lime-sim binary, covered by mcp/sim.test.ts.
 */
import { fileURLToPath } from "node:url";

import { LABEL } from "../src/sim/label.ts";

import { fakeEngine, loadNativeEngine } from "./engine.ts";
import { Session } from "./session.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const native = loadNativeEngine(root);
const engine = fakeEngine();
engine.simStudy = (body: string) => native.simStudy(body);

const session = new Session(engine);
const setup = await session.call("sim_setup", {
  beam: { lengthMm: 8, widthMm: 6, heightMm: 4 },
  hMm: 2,
  representation: "sliced",
  fixtures: [{ kind: "bed" }],
  loads: [{ kind: "force", faces: [1], magnitude: 2, direction: [0, 0, 1] }],
  card: "inhouse-petg",
  constraints: [{ kind: "minSafetyFactor", value: 1 }],
});
check("a sliced box is set up", setup.ok === true && (setup.study as { representation?: string } | undefined)?.representation === "sliced", String(setup.reason ?? ""));

const printed = await session.call("settings_set", { object: setup.object, values: { infill: 1, walls: 2 } });
check("the box is printed solid", printed.ok === true, String(printed.reason ?? ""));

const run = await session.call("sim_run", { object: setup.object });
const margins = run.margins as { kind?: string; hotSpot?: { at?: number[]; role?: string; governs?: string } }[] | undefined;
const spot = margins?.[0]?.hotSpot;
check(
  "sim_run reads margins and a hot spot",
  run.ok === true
    && run.label === LABEL
    && run.representation === "sliced"
    && Array.isArray(margins)
    && margins.length > 0
    && margins[0]?.kind === "minSafetyFactor"
    && Array.isArray(spot?.at)
    && spot.at.length === 3
    && spot.at.every((value) => typeof value === "number" && Number.isFinite(value))
    && !("surface" in run)
    && !("triangles" in run)
    && !("nodes" in run)
    && !("stiffness" in run),
  JSON.stringify(run.reason ?? { keys: Object.keys(run), margins }),
);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sim-sliced: ok");
