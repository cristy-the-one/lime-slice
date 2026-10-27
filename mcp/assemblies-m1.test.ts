/**
 * Assemblies M1 (docs/plan-assemblies.md, the owner's gaps item 18), through the MCP server against real Open CASCADE.
 * model_place says which pose it set; plate_list reports the assembled box beside the print layout; re-centring and
 * Lay out leave the assembled pose alone; and a part-frame object keeps later Model numbers in its own frame, so a
 * probe, an edit and an apply after model_place do not refuse. Skips when LIME_OCCT_BRIDGE is unset, and fails in CI
 * when it is unset.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineCandidates, loadEngineWorker } from "./engine.ts";
import { TOOLS } from "./schema.ts";
import { Session } from "./session.ts";

const bridge = process.env.LIME_OCCT_BRIDGE ?? "";
const root = fileURLToPath(new URL("..", import.meta.url));
const addon = engineCandidates(root).find((path) => existsSync(path)) ?? "";
const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
if (!bridge || !existsSync(bridge) || !addon) {
  if (ci) {
    console.error("assemblies-m1: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("assemblies-m1: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-assemblies-m1-"));
process.env.LIME_MCP_WORKSPACE = workspace;
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
const near = (value: unknown, expected: number, tol = 1e-3) => typeof value === "number" && Math.abs(value - expected) < tol;

type Box = { min: number[]; max: number[] };
type Row = { object: string; bboxMm: Box; assembledMm?: Box; frame?: string };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;
const rows = async () => (await call("plate_list", {})).objects as Row[];
const rowOf = async (object: string) => (await rows()).find((row) => row.object === object)!;
const volume = async (object: string) => Number((await call("model_describe", { object, limit: 1 })).volumeMm3);

/** A 70 × 40 × 10 body with a 6 × 6 hook fused on its top, and a second object beside it so Lay out has work to do. */
async function bodyWithHook(): Promise<string> {
  await call("project_create", {});
  const made = await call("solid_new", { primitive: "box", dx: 70, dy: 40, dz: 10 });
  const object = String(made.object);
  const hook = { kind: "boolean", op: "fuse", primitive: "box", dx: 6, dy: 6, dz: 8, origin: [10, 5, 5] };
  const probed = await call("model_probe", { object, op: hook });
  const applied = await call("model_apply", { object, op: hook });
  check("the hook fuses onto the body", probed.ok === true && applied.ok === true && near(await volume(object), 28108, 0.5), JSON.stringify({ probed, applied }));
  return object;
}

const schemaText = JSON.stringify(TOOLS.find((tool) => tool.name === "model_place"));
check("the schema no longer says the bed moves at model_commit", !schemaText.includes("The bed moves at model_commit") && schemaText.includes("print layout does not move"));

// --- Item 18 as the owner hit it. In the default frame the numbers follow the pose, so after model_place the same
// hook is 200 mm from where it was typed and is refused as a separate body. That default is unchanged; the reply now
// says so and names the pose it set.
{
  const object = await bodyWithHook();
  const placed = await call("model_place", { object, x: 200 });
  check("model_place names the pose it set", placed.ok === true && placed.pose === "assembled" && placed.frame === "model", JSON.stringify(placed));
  check("and says the print layout is unchanged", String(placed.note).includes("The print layout is unchanged."), String(placed.note));
  check("and gives the part's box in model space", near(placed.assembledMm?.min?.[0], 165) && near(placed.assembledMm?.max?.[0], 235) && near(placed.assembledMm?.max?.[2], 13), JSON.stringify(placed.assembledMm));
  const refused = await call("model_probe", { object, op: { kind: "boolean", op: "fuse", primitive: "box", dx: 6, dy: 6, dz: 8, origin: [10, 5, 5] } });
  check("in the default frame the same hook is refused after the part moved", refused.ok === false && String(refused.reason).includes("separate body") && Number(refused.gapMm) > 100, JSON.stringify(refused));
  const typedInModel = await call("model_probe", { object, op: { kind: "boolean", op: "fuse", primitive: "box", dx: 6, dy: 6, dz: 8, origin: [210, 5, 5] } });
  check("and the model-space number is accepted", typedInModel.ok === true, JSON.stringify(typedInModel));
}

// --- The fix: frame "part". The same part-frame numbers keep working after the part is moved, for a probe, an edit and
// a new apply, and the reply says which frame they are read in.
{
  const object = await bodyWithHook();
  await call("model_commit", { object });
  const printBefore = (await rowOf(object)).bboxMm;
  const placed = await call("model_place", { object, x: 200, y: 30, z: 0, turnZ: 90, frame: "part" });
  check("frame part is echoed and explained", placed.ok === true && placed.frame === "part" && String(placed.note).includes("part's own frame"), JSON.stringify(placed));
  const row = await rowOf(object);
  check("the print layout box did not move", JSON.stringify(row.bboxMm) === JSON.stringify(printBefore), JSON.stringify({ was: printBefore, now: row.bboxMm }));
  check("plate_list reports the assembled box, turned and moved", near(row.assembledMm?.min[0], 180) && near(row.assembledMm?.max[0], 220) && near(row.assembledMm?.min[1], -5) && near(row.assembledMm?.max[1], 65), JSON.stringify(row.assembledMm));
  check("and the frame", row.frame === "part");

  const wider = { kind: "boolean", op: "fuse", primitive: "box", dx: 8, dy: 6, dz: 8, origin: [10, 5, 5] };
  const probed = await call("model_probe", { object, op: wider });
  check("the part-frame hook still probes after the move", probed.ok === true, JSON.stringify(probed));
  const edited = await call("model_edit", { object, node: "node_1", op: wider });
  check("model_edit accepts it", edited.ok === true, JSON.stringify(edited));
  check("the edit changed the solid: 8 mm wide hook", near(await volume(object), 28144, 0.5), String(await volume(object)));
  const second = { kind: "boolean", op: "fuse", primitive: "box", dx: 6, dy: 6, dz: 8, origin: [-20, 5, 5] };
  await call("model_probe", { object, op: second });
  const added = await call("model_apply", { object, op: second });
  check("a second hook applies in the part frame", added.ok === true, JSON.stringify(added));
  const sectioned = await call("render_view", { object, views: ["iso"], section: { normal: [0, -1, 0], point: [0, 0, 5] } });
  check("a section is read in the part frame too", sectioned.ok !== false, JSON.stringify(sectioned).slice(0, 200));

  // Back to model space: the same numbers are refused again, so the switch is real in both directions.
  const back = await call("model_place", { object, frame: "model" });
  check("frame model switches back and keeps the pose", back.frame === "model" && near(back.x, 200) && near(back.turnZ, 90), JSON.stringify(back));
  const refused = await call("model_probe", { object, op: { kind: "boolean", op: "fuse", primitive: "box", dx: 6, dy: 6, dz: 8, origin: [30, 5, 5] } });
  check("in model space a number typed from the drawing is refused again", refused.ok === false && String(refused.reason).includes("separate body"), JSON.stringify(refused));
}

// --- Re-centring and Lay out leave the assembled pose alone.
{
  const object = await bodyWithHook();
  await call("model_commit", { object });
  await call("model_place", { object, x: 200, y: -15, z: 4, turnX: 0, turnY: 0, turnZ: 30 });
  const pose = await call("model_place", { object });
  const assembled = (await rowOf(object)).assembledMm;
  const other = String((await call("solid_new", { primitive: "box", dx: 30, dy: 30, dz: 30 })).object);
  await call("model_commit", { object: other });
  await call("object_place", { object, centreX: 150, centreY: 150 });
  const printed = (await rowOf(object)).bboxMm;
  const arranged = await call("plate_arrange", { gapMm: 5 });
  check("Lay out ran", arranged.ok === true, JSON.stringify(arranged));
  const laid = await rowOf(object);
  check("Lay out moved the print layout", JSON.stringify(laid.bboxMm) !== JSON.stringify(printed));
  check("Lay out left the assembled box", JSON.stringify(laid.assembledMm) === JSON.stringify(assembled), JSON.stringify({ was: assembled, now: laid.assembledMm }));
  const centred = await call("object_place", { object, centreOnBed: true });
  const afterCentre = await call("model_place", { object });
  check("centring on the bed left the pose", centred.ok === true && JSON.stringify([afterCentre.x, afterCentre.y, afterCentre.z, afterCentre.turnZ]) === JSON.stringify([pose.x, pose.y, pose.z, pose.turnZ]), JSON.stringify({ centred, afterCentre }));
  await call("model_commit", { object });
  const committed = await call("model_place", { object });
  check("model_commit left the pose", JSON.stringify([committed.x, committed.y, committed.z, committed.turnZ]) === JSON.stringify([pose.x, pose.y, pose.z, pose.turnZ]));
  check("and the assembled box", JSON.stringify((await rowOf(object)).assembledMm) === JSON.stringify(assembled), JSON.stringify((await rowOf(object)).assembledMm));
}

// --- The frame is saved with the project and read back, and the saved file of a model-frame object has no key.
{
  const object = await bodyWithHook();
  await call("model_commit", { object });
  await call("model_place", { object, x: 120, frame: "part" });
  const named = "frame-roundtrip.lime";
  const saved = await call("project_save", { name: named });
  check("the project saves", saved.ok === true, JSON.stringify(saved));
  const file = JSON.parse(readFileSync(join(workspace, named), "utf8")) as { objects?: { frame?: string }[] };
  check("the file carries frame part", file.objects?.[0]?.frame === "part", JSON.stringify(file.objects?.[0]?.frame));
  const opened = await call("project_open", { path: join(workspace, named) });
  check("the project opens", opened.ok === true, JSON.stringify(opened));
  const back = (await rows())[0]!;
  check("the frame survives the round trip", back.frame === "part" && near(back.assembledMm?.min[0], 85), JSON.stringify(back));
  const probe = await call("model_probe", { object: back.object, op: { kind: "boolean", op: "fuse", primitive: "box", dx: 6, dy: 6, dz: 8, origin: [10, 5, 5] } });
  check("and a part-frame number still probes on the reopened part", probe.ok === true, JSON.stringify(probe));
  await call("model_place", { object: back.object, frame: "model" });
  await call("project_save", { name: "frame-model.lime" });
  const plain = JSON.parse(readFileSync(join(workspace, "frame-model.lime"), "utf8")) as { objects?: Record<string, unknown>[] };
  check("a model-frame object writes no frame key", !plain.objects?.some((row) => "frame" in row));
}

if (failed > 0) {
  console.error(`assemblies-m1: ${failed} failed`);
  process.exit(1);
}
console.log("assemblies-m1: ok");
process.exit(0);
