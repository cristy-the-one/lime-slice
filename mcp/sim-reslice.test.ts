/**
 * L5. A sliced study's sweep reslices: each variant is one slice of the object
 * alone and one solve, and its row carries that slice's time and grams.
 */
import { fileURLToPath } from "node:url";

import { fakeEngine, loadNativeEngine } from "./engine.ts";
import { Session } from "./session.ts";
import { RESLICE_BEAM, RESLICE_PARAMETERS, RESLICE_PATTERN_KEEP, SLICED_SWEEP } from "./sim.ts";

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
  beam: { lengthMm: 20, widthMm: 8, heightMm: 4 },
  hMm: 2,
  representation: "sliced",
  fixtures: [{ kind: "bed" }],
  loads: [{ kind: "force", faces: [1], magnitude: 5, direction: [0, 0, 1] }],
  card: "inhouse-petg",
  constraints: [{ kind: "minSafetyFactor", value: 1 }],
});
check("a sliced bar is set up", setup.ok === true, String(setup.reason ?? ""));
const object = setup.object;
await session.call("settings_set", { object, values: { walls: 2, infill: 0.2 } });

const refused = await session.call("sim_sweep", { object, variants: [{ walls: 3 }] });
check("a sliced sweep without reslice says how", refused.ok === false && refused.reason === SLICED_SWEEP, String(refused.reason));

const base = await session.call("sim_run", { object, checkResolution: false });
check("the base solves", base.ok === true && typeof base.maxDisplacementMm === "number", String(base.reason ?? ""));
check("sim_run carries its slice's time and grams", typeof base.slicerSeconds === "number" && typeof base.slicerGrams === "number", JSON.stringify(Object.keys(base)));

type Row = { ok?: boolean; maxDisplacementMm?: number; slicerSeconds?: number; slicerGrams?: number; margins?: unknown[]; reason?: string };
const sweep = await session.call("sim_sweep", {
  object,
  reslice: true,
  variants: [{ walls: 2, infill: 0.2 }, { walls: 4 }, { infill: 0.8 }, { loadScale: 2 }, { pattern: "gyroid" }],
});
const rows = (sweep.variants ?? []) as Row[];
check("every variant is sliced and solved", sweep.ok === true && rows.length === 5 && rows.every((row) => row.ok !== false), JSON.stringify(rows.map((row) => row.reason ?? "ok")));
check("each row carries its own slice", rows.every((row) => typeof row.slicerSeconds === "number" && typeof row.slicerGrams === "number"));
check(
  "more infill prints heavier",
  (rows[2]?.slicerGrams ?? 0) > (rows[0]?.slicerGrams ?? 0) * 1.1,
  `${rows[0]?.slicerGrams} g at 20%, ${rows[2]?.slicerGrams} g at 80%`,
);
check(
  "more infill bends less",
  (rows[2]?.maxDisplacementMm ?? 1) < (rows[0]?.maxDisplacementMm ?? 0),
  `${rows[0]?.maxDisplacementMm} mm at 20%, ${rows[2]?.maxDisplacementMm} mm at 80%`,
);
// The solve is linear: twice the load is twice the deflection, on the same slice.
const ratio = (rows[3]?.maxDisplacementMm ?? 0) / (base.maxDisplacementMm as number);
check("twice the load deflects twice as far", Math.abs(ratio - 2) < 1e-6, String(ratio));
check("the load variant's slice is the base's", rows[3]?.slicerGrams === base.slicerGrams);
check("each row has margins", rows.every((row) => Array.isArray(row.margins) && row.margins.length > 0));

const params = await session.call("sim_sweep", { object, reslice: true, variants: [{ parameters: { width: 10 } }] });
check("a parameter variant is refused", params.ok === false && params.reason === RESLICE_PARAMETERS, String(params.reason));
const keepPattern = await session.call("sim_sweep", { object, reslice: true, variants: [{ pattern: "grid" }], commit: true });
check("a pattern variant is not kept per object", keepPattern.ok === false && keepPattern.reason === RESLICE_PATTERN_KEEP, String(keepPattern.reason));
const keepWalls = await session.call("sim_sweep", { object, reslice: true, variants: [{ walls: 4 }], commit: true });
check("a walls variant is kept", keepWalls.ok === true && keepWalls.committed === true, String(keepWalls.reason ?? ""));
const after = await session.call("sim_run", { object, checkResolution: false });
check("the kept walls are what sim_run slices", after.ok === true && after.slicerGrams === rows[1]?.slicerGrams, `${after.slicerGrams} vs ${rows[1]?.slicerGrams}`);

const beam = await session.call("sim_setup", {
  beam: { lengthMm: 20, widthMm: 8, heightMm: 4 },
  hMm: 2,
  representation: "smear",
  fixtures: [{ kind: "faces", faces: [4] }],
  loads: [{ kind: "force", faces: [5], magnitude: 5, direction: [0, 0, -1] }],
  card: "inhouse-petg",
});
const beamSweep = await session.call("sim_sweep", { object: beam.object, reslice: true, variants: [{ walls: 3 }] });
check("reslice on a generated beam is refused", beamSweep.ok === false && beamSweep.reason === RESLICE_BEAM, String(beamSweep.reason));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sim-reslice: ok");
