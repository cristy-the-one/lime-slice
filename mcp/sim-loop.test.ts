/**
 * The sliced plan's L5 acceptance: a client follows the sim guide's loop
 * (set up, run, change, sweep, keep, run again) on a generated beam, an STL
 * and a STEP part. The beam and the STL need no OCCT; the STEP part runs
 * when the engine has it and says it was skipped when not.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeStl } from "../src/mesh-place.ts";
import { LABEL } from "../src/sim/label.ts";

import { loadNativeEngine } from "./engine.ts";
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
// layer_image writes its PNG into the workspace, as it does for a client.
process.env.LIME_MCP_WORKSPACE = mkdtempSync(join(tmpdir(), "lime-sim-loop-ws-"));
const engine = loadNativeEngine(root);

type Reply = Record<string, unknown>;
type Row = { ok?: boolean; met?: boolean; maxDisplacementMm?: number; slicerGrams?: number; reason?: string };

/** The guide is where a client starts; the loop below is the one it describes. */
async function readGuide(session: Session): Promise<string> {
  const guide = await session.call("guide", { topic: "sim" });
  return String(guide.text ?? "");
}

// ---- A generated beam: the smeared solve, the lime-sim binary, no OCCT ------
{
  const session = new Session(engine);
  const guide = await readGuide(session);
  check("beam: the guide names the loop", ["sim_setup", "sim_run", "sim_sweep"].every((tool) => guide.includes(tool)));
  const setup = await session.call("sim_setup", {
    beam: { lengthMm: 40, widthMm: 8, heightMm: 6 },
    hMm: 2,
    representation: "smear",
    fixtures: [{ kind: "faces", faces: [4] }],
    loads: [{ kind: "force", faces: [5], magnitude: 20, direction: [0, 0, -1] }],
    card: "inhouse-petg",
  });
  check("beam: set up", setup.ok === true, String(setup.reason ?? ""));
  const object = setup.object;
  const first = await session.call("sim_run", { object });
  check("beam: runs, labelled and trusted", first.ok === true && first.label === LABEL && typeof (first.trust as Reply | undefined)?.level === "string", String(first.reason ?? ""));
  const sweep = await session.call("sim_sweep", {
    object,
    variants: [{ walls: 2, infill: 0.2 }, { walls: 4, infill: 0.6 }],
    constraints: { maxDeflectionMm: 100 },
  });
  const rows = (sweep.variants ?? []) as Row[];
  check("beam: the sweep solves both variants", sweep.ok === true && rows.length === 2 && rows.every((row) => row.ok !== false), JSON.stringify(rows.map((row) => row.reason ?? "ok")));
  const kept = await session.call("sim_sweep", { object, variants: [{ walls: 4, infill: 0.6 }], commit: true });
  check("beam: a variant is kept", kept.ok === true && kept.committed === true, String(kept.reason ?? ""));
  const again = await session.call("sim_run", { object });
  check(
    "beam: the kept variant is what sim_run solves",
    again.ok === true && Math.abs((again.maxDisplacementMm as number) - (rows[1]?.maxDisplacementMm ?? NaN)) < 1e-9,
    `${again.maxDisplacementMm} vs ${rows[1]?.maxDisplacementMm}`,
  );
}

// ---- An imported STL: sliced, through the engine, no OCCT -------------------
function boxPositions(min: number[], max: number[]): Float32Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[4, 5, 6, 7], [0, 3, 2, 1], [1, 2, 6, 5], [0, 4, 7, 3], [3, 7, 6, 2], [0, 1, 5, 4]];
  const out = new Float32Array(quads.length * 18);
  quads.forEach((quad, face) => {
    const corner = (i: number) => c[quad[i]!]!;
    out.set([...corner(0), ...corner(1), ...corner(2)], face * 18);
    out.set([...corner(0), ...corner(2), ...corner(3)], face * 18 + 9);
  });
  return out;
}

async function slicedLoop(name: string, session: Session, object: string) {
  await session.call("settings_set", { object, values: { walls: 2, infill: 0.3 } });
  const setup = await session.call("sim_setup", {
    object,
    hMm: 2,
    fixtures: [{ kind: "bed" }],
    loads: [{ kind: "force", faces: [], magnitude: 5, direction: [0, 0, 1] }],
    card: "inhouse-petg",
    constraints: [{ kind: "minSafetyFactor", value: 1 }],
  });
  check(`${name}: set up, sliced by default`, setup.ok === true, String(setup.reason ?? ""));
  const first = await session.call("sim_run", { object, checkResolution: false });
  const margins = (first.margins ?? []) as { hotSpot?: { at?: number[]; layer?: number; role?: string } }[];
  check(
    `${name}: runs as sliced, with margins and a hot spot on a layer`,
    first.ok === true && first.representation === "sliced" && margins.length > 0 && Array.isArray(margins[0]?.hotSpot?.at) && typeof margins[0]?.hotSpot?.layer === "number",
    JSON.stringify(first.reason ?? first.margins),
  );
  const sweep = await session.call("sim_sweep", { object, reslice: true, variants: [{ infill: 0.3 }, { infill: 0.9 }] });
  const rows = (sweep.variants ?? []) as Row[];
  check(
    `${name}: the sweep reslices, and more infill weighs more and bends less`,
    sweep.ok === true
      && rows.length === 2
      && (rows[1]?.slicerGrams ?? 0) > (rows[0]?.slicerGrams ?? 0)
      && (rows[1]?.maxDisplacementMm ?? Infinity) < (rows[0]?.maxDisplacementMm ?? 0),
    JSON.stringify(rows.map((row) => ({ g: row.slicerGrams, mm: row.maxDisplacementMm, reason: row.reason }))),
  );
  const kept = await session.call("sim_sweep", { object, reslice: true, variants: [{ infill: 0.9 }], commit: true });
  check(`${name}: the stiffer variant is kept`, kept.ok === true && kept.committed === true, String(kept.reason ?? ""));
  const again = await session.call("sim_run", { object, checkResolution: false });
  check(`${name}: sim_run slices the kept setting`, again.ok === true && again.slicerGrams === rows[1]?.slicerGrams, `${again.slicerGrams} vs ${rows[1]?.slicerGrams}`);
  // The printed toolpaths, coloured by the stress under them.
  const started = await session.call("slice_start", {});
  let job = started;
  for (let i = 0; i < 60 && job.status !== "done" && job.ok !== false; i++) job = await session.call("slice_wait", { job: started.job });
  const image = await session.call("layer_image", { job: started.job, layer: 3, colourBy: "stress", inline: false });
  check(`${name}: a layer image coloured by stress`, image.ok === true && typeof image.bytes === "number", String(image.reason ?? ""));
}

{
  const session = new Session(engine);
  const dir = mkdtempSync(join(tmpdir(), "lime-sim-loop-"));
  const path = join(dir, "bar.stl");
  writeFileSync(path, Buffer.from(encodeStl(boxPositions([0, 0, 0], [30, 8, 6]), "bar")));
  const imported = await session.call("mesh_import", { path });
  check("STL: imports", imported.ok === true, String(imported.reason ?? ""));
  if (imported.ok === true) await slicedLoop("STL", session, String(imported.object));
}

// ---- A STEP part: the same loop, when the engine has OCCT -------------------
{
  // STEP import meshes through the engine's STEP mesher, which is separate
  // from the modelling bridge session_info reports; try the import itself.
  const session = new Session(engine);
  const imported = await session.call("mesh_import", { path: join(root, "samples", "step_cube.step") });
  const reason = String(imported.reason ?? "");
  if (imported.ok === true) await slicedLoop("STEP", session, String(imported.object));
  else if (/open cascade|occt|step mesher/i.test(reason)) console.log(`STEP: skipped, ${reason}`);
  else check("STEP: imports", false, reason);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sim-loop: ok");
