/**
 * S4. The generated beam is solved by the lime-sim binary. No Open CASCADE.
 */
import { LABEL } from "../src/sim/label.ts";
import { beltLayerNormal } from "../src/sim/study.ts";

import { fakeEngine } from "./engine.ts";
import { OPEN_MESH, SOLVER_STAND_IN, SWEEP_REFUSAL, representationOf } from "./sim.ts";
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

function hasKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  return Object.entries(value as Record<string, unknown>).some(([name, item]) => name === key || hasKey(item, key));
}

const beam = { lengthMm: 100, widthMm: 10, heightMm: 10 };
const setupInput = {
  beam,
  hMm: 20,
  element: "tet10",
  fixtures: [{ kind: "faces", faces: [0] }],
  loads: [{ kind: "force", faces: [1], magnitude: 10, direction: [0, 0, -1] }],
  card: "inhouse-petg",
};

const engine = fakeEngine();
const session = new Session(engine);

const guide = await session.call("guide", { topic: "sim" });
const guideText = String(guide.text ?? "");
check("the sim guide runs the beam sequence", guide.ok === true && guideText.includes("sim_setup") && guideText.includes("sim_run") && guideText.includes("sim_sweep") && guideText.includes("includePrintTime defaults to false"));
check("a sliced part sweeps by reslicing", guideText.includes("A sliced part: sim_sweep {reslice:true") && guideText.includes("slicerSeconds and slicerGrams"));
check("the guide says rough is not a reason to change the solid", guideText.includes("not a reason to change the solid") && guideText.includes("None of the three is a promise"));
check(
  "the guide maps governs to a change",
  guideText.includes("across-layers") && guideText.includes("interlayer-shear") && guideText.includes("workplane_print_up")
    && guideText.includes("across-bead") && guideText.includes("settings_set")
    && guideText.includes("along-bead") && guideText.includes("reinforce_add") && guideText.includes("model_apply"),
);
check("a beam stays a smear", representationOf({ beam: true, printerId: "lime-220", fileName: "beam.stl" }) === "smear");
check("an STL with a printer is sliced", representationOf({ printerId: "lime-220", fileName: "part.stl" }) === "sliced");
check("a STEP with a printer is sliced", representationOf({ printerId: "lime-220", fileName: "part.step" }) === "sliced");
check("an stp with a printer is sliced", representationOf({ printerId: "lime-220", fileName: "part.stp" }) === "sliced");
check("no printer stays a smear", representationOf({ printerId: "", fileName: "part.stl" }) === "smear");
check("a 3mf stays a smear", representationOf({ printerId: "lime-220", fileName: "part.3mf" }) === "smear");
check("an explicit smear stays a smear", representationOf({ asked: "smear", printerId: "lime-220", fileName: "part.stl" }) === "smear");
check("an explicit sliced beam is sliced", representationOf({ asked: "sliced", beam: true, printerId: "lime-220", fileName: "beam.stl" }) === "sliced");

const setup = await session.call("sim_setup", setupInput);
check("sim_setup writes the study and does not solve", setup.ok === true && String(setup.sentence).includes("Held 1 face") && String(setup.sentence).includes("10 N on face 1") && String(setup.sentence).includes("provisional PETG"), String(setup.sentence ?? setup.reason));
const bridge = session.bridgeSnapshot();
const plate = (bridge?.plate as { sim?: { beam?: { lengthMm?: number } } }[] | undefined) ?? [];
check("the bridge snapshot carries sim", plate.some((row) => row.sim?.beam?.lengthMm === 100));

const beforeHistory = JSON.stringify(await session.call("model_history", { object: String(setup.object) }));
const beforePlate = JSON.stringify(session.bridgeSnapshot()?.plate);

const run = await session.call("sim_run", {});
check("sim_run is labelled In-house estimate", run.ok === true && run.label === LABEL, JSON.stringify(run.reason ?? run.label));
check(
  "sim_run has the summary and no triangles",
  run.ok === true
    && typeof run.maxVonMisesMPa === "number"
    && Array.isArray(run.maxVonMisesAt)
    && typeof run.maxDisplacementMm === "number"
    && Array.isArray(run.maxDisplacementAt)
    && "minSafetyFactor" in run
    && run.criterion === "max-stress"
    && typeof run.massG === "number"
    && typeof run.solidMassG === "number"
    && run.stale === false
    && !("triangles" in run)
    && !("stiffness" in run)
    && !Array.isArray(run.nodes),
  JSON.stringify(run.reason ?? Object.keys(run)),
);
const trust = run.trust as { level?: string; element?: string; nodes?: number; dofs?: number } | undefined;
check("the provisional beam is rough tet10", trust?.level === "rough" && trust.element === "tet10" && typeof trust.nodes === "number" && typeof trust.dofs === "number" && !("slicerGrams" in run));

const page = await session.call("sim_field", { field: "von_mises", stride: 1, limit: 1 });
const pageRows = page.rows as unknown[] | undefined;
check("sim_field pages one row and names the next", page.ok === true && pageRows?.length === 1 && page.nextCursor === "1", JSON.stringify({ ok: page.ok, n: pageRows?.length, cursor: page.nextCursor, reason: page.reason }));
const hundred = await session.call("sim_field", { field: "von_mises", stride: 1, limit: 100, cursor: page.nextCursor });
const hundredRows = hundred.rows as unknown[] | undefined;
check("sim_field pages at 100", hundred.ok === true && !!hundredRows && hundredRows.length <= 100);

const unknown = await session.call("sim_field", { field: "temperature", stride: 1 });
check("an unknown field lists the names", unknown.ok === false && String(unknown.reason).includes("von_mises") && String(unknown.reason).includes("safety_factor"));

const swept = await session.call("sim_sweep", {
  variants: [{ loadScale: 1 }],
  constraints: { maxDeflectionMm: 100 },
  commit: false,
});
const sweptRows = swept.variants as { met?: boolean; reason?: string; slicerSeconds?: number }[] | undefined;
check("a row inside its limits is met, rough or not", swept.ok === true && swept.committed === false && sweptRows?.[0]?.met === true && sweptRows[0]?.reason === "", JSON.stringify(sweptRows?.[0] ?? swept.reason));
check("a sweep does not slice by default", sweptRows?.[0]?.slicerSeconds === undefined);
const afterHistory = JSON.stringify(await session.call("model_history", { object: String(setup.object) }));
check("commit false leaves the history cursor", beforeHistory === afterHistory);
check("commit false leaves the saved study", JSON.stringify(session.bridgeSnapshot()?.plate) === beforePlate);

const refused = await session.call("sim_sweep", { variants: Array.from({ length: 17 }, () => ({ loadScale: 1 })) });
check("a 17th variant is refused", refused.ok === false && refused.reason === SWEEP_REFUSAL, String(refused.reason));

const started = await session.call("slice_start", {});
check("a slice starts", started.ok === true, String(started.reason ?? ""));
let sliced: unknown = null;
try {
  sliced = JSON.parse(engine.lastSlice);
} catch {
  sliced = null;
}
check("a slice of that plate does not carry sim", sliced !== null && !hasKey(sliced, "sim"));

const back = await session.call("plate_undo", {});
const empty = await session.call("plate_list", {});
check("commit false does not add a plate step", back.ok === true && back.label === "Stress" && ((empty.objects as unknown[] | undefined)?.length ?? 1) === 0, JSON.stringify({ label: back.label, left: (empty.objects as unknown[] | undefined)?.length }));

const plain = new Session(fakeEngine());
const solid = await plain.call("solid_new", { primitive: "box", dx: 20, dy: 10, dz: 10 });
check("a solid opens without a beam", solid.ok === true, String(solid.reason ?? ""));
const plainSetup = await plain.call("sim_setup", {
  object: solid.object,
  fixtures: [{ kind: "bed" }],
  loads: [{ kind: "force", faces: [1], magnitude: 1, direction: [0, 0, -1] }],
});
check("a study can be recorded on a part with no beam", plainSetup.ok === true, String(plainSetup.reason ?? ""));
const plainRun = await plain.call("sim_run", { object: solid.object, checkResolution: false });
check("a solid with a printer solves as sliced", plainRun.ok === false && plainRun.reason === SOLVER_STAND_IN, String(plainRun.reason));
const smearSetup = await plain.call("sim_setup", {
  object: solid.object,
  representation: "smear",
  fixtures: [{ kind: "bed" }],
  loads: [{ kind: "force", faces: [1], magnitude: 1, direction: [0, 0, -1] }],
});
check("an explicit smear can be recorded", smearSetup.ok === true, String(smearSetup.reason ?? ""));
const smearRun = await plain.call("sim_run", { object: solid.object });
check("an explicit smear of a part with no beam is refused", smearRun.ok === false && smearRun.reason === OPEN_MESH, String(smearRun.reason));

const ir3 = new Session(fakeEngine());
const selected = await ir3.call("machine_select", { printerId: "ideaformer-ir3-v2", filamentId: "lime-pla" });
check("the IR3 is selected", selected.ok === true, String(selected.reason ?? ""));
const tilted = await ir3.call("sim_setup", { ...setupInput, printer: true });
const got = (tilted.study as { buildAxis?: number[] } | undefined)?.buildAxis ?? [];
const want = beltLayerNormal(45);
check(
  "printer true on an IR3 writes the belt axis",
  tilted.ok === true && got.length === 3 && got.every((value, index) => Math.abs(value - want[index]!) < 1e-12),
  JSON.stringify(got),
);

const kept = new Session(fakeEngine());
const made = await kept.call("sim_setup", setupInput);
const committed = await kept.call("sim_sweep", { object: made.object, variants: [{ loadScale: 2, parameters: { span: 100 } }], commit: true });
check("commit true applies one variant", committed.ok === true && committed.committed === true, JSON.stringify(committed.reason ?? committed));
const params = await kept.call("model_params", { set: {} });
check("commit true sets the parameter", (params.params as { span?: number } | undefined)?.span === 100, JSON.stringify(params));
const undone = await kept.call("plate_undo", {});
check("commit true is one undo", undone.ok === true && undone.label === "Sweep", String(undone.label ?? undone.reason));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("sim: ok");
