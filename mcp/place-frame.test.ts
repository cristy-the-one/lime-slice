/**
 * Assemblies M11 (docs/plan-assemblies.md, section 4): the Place tool's "Part frame | Model frame" switch writes the
 * same field as model_place {frame}. The session sets the frame both ways and saves; the app reads each file, and its
 * switch (`withFrame`) on the other file's object gives the same object, the same saved row and the same pose.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assemblyOf } from "../src/assembly.ts";
import { withFrame, type PlateFileObject, type PlateObject, type PlateState } from "../src/plate.ts";
import { decodeProject } from "../src/project-codec.ts";
import { fakeEngine } from "./engine.ts";
import { Session } from "./session.ts";

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-"));
process.env.LIME_MCP_WORKSPACE = workspace;

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const session = new Session(fakeEngine());
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;

const cube = fileURLToPath(new URL("../samples/calibration_cube_20mm.stl", import.meta.url));
const body = String((await call("mesh_import", { path: cube })).object);
const hook = String((await call("mesh_import", { path: cube })).object);
check("two parts on the plate", body !== hook && ((await call("plate_list", {})).objects as unknown[]).length === 2);

// The hook sits on the body, turned a quarter: a member takes the part frame (D2).
const seated = await call("model_place", { object: hook, to: body, x: 30, turnZ: 90 });
check("the hook joins the body's assembly in the part frame", seated.ok === true && seated.frame === "part", JSON.stringify(seated));

/** The project as the app reads it: its rows by id, and which of them are in an assembly. */
async function saved(name: string): Promise<{ rows: Map<string, PlateFileObject>; members: Set<string>; text: string }> {
  check(`${name} saves`, (await call("project_save", { name })).ok === true);
  const text = readFileSync(join(workspace, name), "utf8");
  const read = await decodeProject(text);
  if (!read.ok) throw new Error(read.message);
  const rows = new Map((read.project.objects ?? []).map((row) => [row.id, row]));
  const members = new Set([...rows.keys()].filter((id) => !!assemblyOf(read.project.assemblies ?? [], id)));
  return { rows, members, text };
}

const partFile = await saved("part.lime");
const switched = await call("model_place", { object: hook, frame: "model" });
check("model_place {frame: model} answers the model frame", switched.ok === true && switched.frame === "model", JSON.stringify(switched));
const modelFile = await saved("model.lime");
check("model_place {frame} keeps the pose", JSON.stringify(partFile.rows.get(hook)?.modelPose) === JSON.stringify(modelFile.rows.get(hook)?.modelPose), `${JSON.stringify(partFile.rows.get(hook)?.modelPose)} vs ${JSON.stringify(modelFile.rows.get(hook)?.modelPose)}`);
check("the hook is still a member, so the app shows the switch", partFile.members.has(hook) && modelFile.members.has(hook) && !partFile.members.has("nobody"));
check("the part-frame file says part", partFile.rows.get(hook)?.frame === "part");
check("the model-frame file has no frame key, as the app writes model", !("frame" in modelFile.rows.get(hook)!), JSON.stringify(modelFile.rows.get(hook)?.frame));

/** The app's plate from a file's rows: the fields the switch and the project writer read. */
const plateOf = (rows: Map<string, PlateFileObject>): PlateState => ({
  objects: [...rows.values()].map((row) => ({ id: row.id, name: row.name, ...(row.modelPose ? { modelPose: row.modelPose } : {}), ...(row.frame ? { frame: row.frame } : {}) }) as unknown as PlateObject),
  selectedId: hook,
});
/** The `frame` key as the app's project writer writes it (`src/app/project-io.ts`): "part", or none. */
const writtenFrame = (obj: PlateObject | PlateFileObject | undefined) => (obj?.frame === "part" ? "part" : undefined);

const appToModel = withFrame(plateOf(partFile.rows), hook, "model").objects.find((obj) => obj.id === hook);
check("the app's Model frame on the part-frame file gives what model_place {frame: model} saved", writtenFrame(appToModel) === writtenFrame(modelFile.rows.get(hook)) && !("frame" in appToModel!));
check("and the same pose", JSON.stringify(appToModel?.modelPose) === JSON.stringify(modelFile.rows.get(hook)?.modelPose));
const appToPart = withFrame(plateOf(modelFile.rows), hook, "part").objects.find((obj) => obj.id === hook);
check("the app's Part frame on the model-frame file gives what model_place {frame: part} saved", writtenFrame(appToPart) === writtenFrame(partFile.rows.get(hook)) && appToPart?.frame === "part");
check("and the same pose", JSON.stringify(appToPart?.modelPose) === JSON.stringify(partFile.rows.get(hook)?.modelPose));
const bodyRow = withFrame(plateOf(partFile.rows), hook, "model").objects.find((obj) => obj.id === body);
check("the switch leaves the root alone", writtenFrame(bodyRow) === writtenFrame(partFile.rows.get(body)));

// Back the other way in the session: the file matches the first one, so the switch is a round trip in both places.
const again = await call("model_place", { object: hook, frame: "part" });
check("model_place {frame: part} answers the part frame", again.ok === true && again.frame === "part");
const partAgain = await saved("part-again.lime");
check("and saves the same row as before", JSON.stringify(partAgain.rows.get(hook)) === JSON.stringify(partFile.rows.get(hook)));
const listed = ((await call("plate_list", {})).objects as { object: string; frame?: string }[]).find((row) => row.object === hook);
check("plate_list reads the frame the switch shows", listed?.frame === "part", JSON.stringify(listed));

if (failed > 0) process.exit(1);
