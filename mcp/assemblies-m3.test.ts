/**
 * Assemblies M2 and M3 (docs/plan-assemblies.md, the owner's gaps item 19), through the MCP server against real Open
 * CASCADE. A project file with an assembly opens with it; model_params moves the members whose offsets read a changed
 * name, and only those; the print layout stays; and a save writes the assembly back with the solved numbers. Skips
 * when LIME_OCCT_BRIDGE is unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    console.error("assemblies-m3: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("assemblies-m3: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-assemblies-m3-"));
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
type Row = { object: string; bboxMm: Box; assembledMm?: Box };
type Pose = { m: number[]; t: number[] };
type FileDoc = { objects: { id: string; modelPose?: Pose }[]; assemblies?: { id?: string; name?: string; members: { object: string; parent?: string | null; offset: number[]; turn?: number[]; exprs?: unknown }[] }[] };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;
const rowOf = async (object: string) => ((await call("plate_list", {})).objects as Row[]).find((row) => row.object === object)!;
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// The owner's LED cover in small: a 70 × 40 × 10 body, a hook on its rim at x = rimL - 5, z = bodyH, and a clip on the hook.
await call("project_create", {});
const body = String((await call("solid_new", { primitive: "box", dx: 70, dy: 40, dz: 10 })).object);
const hook = String((await call("solid_new", { primitive: "box", dx: 6, dy: 6, dz: 8 })).object);
const clip = String((await call("solid_new", { primitive: "box", dx: 4, dy: 4, dz: 4 })).object);
for (const object of [body, hook, clip]) await call("model_commit", { object });
await call("model_params", { set: { rimL: 30, bodyH: 10, unused: 1 } });
check("the plain project saves", (await call("project_save", { name: "plain.lime" })).ok === true);

const doc = JSON.parse(readFileSync(join(workspace, "plain.lime"), "utf8")) as FileDoc;
const bodyPose = doc.objects.find((row) => row.id === body)?.modelPose ?? { m: identity, t: [0, 0, 0] };
const at = (dx: number, dy: number, dz: number): Pose => ({ m: identity, t: [bodyPose.t[0]! + dx, bodyPose.t[1]! + dy, bodyPose.t[2]! + dz] });
check("the body is not turned, so offsets add", JSON.stringify(bodyPose.m) === JSON.stringify(identity), JSON.stringify(bodyPose));
for (const row of doc.objects) {
  if (row.id === hook) row.modelPose = at(25, 0, 10);
  if (row.id === clip) row.modelPose = at(25, 0, 18);
}
doc.assemblies = [{
  id: "a1",
  name: "LED cover",
  members: [
    { object: body, parent: null, offset: [0, 0, 0], turn: [0, 0, 0] },
    { object: hook, parent: body, offset: [25, 0, 10], turn: [0, 0, 0], exprs: { offset: ["rimL - 5", null, "bodyH"] } },
    { object: clip, parent: hook, offset: [0, 0, 8], turn: [0, 0, 0] },
  ],
}];
writeFileSync(join(workspace, "assembled.lime"), JSON.stringify(doc));

const opened = await call("project_open", { path: join(workspace, "assembled.lime") });
check("a project with an assembly opens", opened.ok === true, JSON.stringify(opened));
const before = { body: await rowOf(body), hook: await rowOf(hook), clip: await rowOf(clip) };
check("the hook opens at its saved pose", near(before.hook.assembledMm?.min[0], before.body.assembledMm!.min[0] + 35 + 25 - 3), JSON.stringify({ body: before.body.assembledMm, hook: before.hook.assembledMm }));

const unrelated = await call("model_params", { set: { unused: 2 } });
check("a name no offset reads moves nothing", unrelated.ok === true && unrelated.moved === undefined, JSON.stringify(unrelated));

const longer = await call("model_params", { set: { rimL: 60 } });
check("rimL 60 answers ok", longer.ok === true, JSON.stringify(longer));
const movedIds = ((longer.moved ?? []) as { object: string }[]).map((row) => row.object);
check("the reply names the hook and the clip that sits on it", JSON.stringify(movedIds) === JSON.stringify([hook, clip]), JSON.stringify(longer.moved));
const after = { body: await rowOf(body), hook: await rowOf(hook), clip: await rowOf(clip) };
check("the hook moved 30 mm along the body's X", near(after.hook.assembledMm!.min[0] - before.hook.assembledMm!.min[0], 30), JSON.stringify(after.hook.assembledMm));
check("the clip followed the hook", near(after.clip.assembledMm!.min[0] - before.clip.assembledMm!.min[0], 30) && near(after.clip.assembledMm!.min[2], before.clip.assembledMm!.min[2]));
check("the reply's box is plate_list's", JSON.stringify(longer.moved[0].assembledMm) === JSON.stringify(after.hook.assembledMm));
check("the body did not move", JSON.stringify(after.body.assembledMm) === JSON.stringify(before.body.assembledMm));
check("the print layout did not move", ["body", "hook", "clip"].every((key) => JSON.stringify(after[key as "body"].bboxMm) === JSON.stringify(before[key as "body"].bboxMm)));

const taller = await call("model_params", { set: { bodyH: 14 } });
const lifted = await rowOf(clip);
check("bodyH 14 lifts the hook and the clip 4 mm", JSON.stringify(((taller.moved ?? []) as { object: string }[]).map((row) => row.object)) === JSON.stringify([hook, clip]) && near(lifted.assembledMm!.min[2] - after.clip.assembledMm!.min[2], 4), JSON.stringify(taller));

const steady = (await rowOf(hook)).assembledMm;
const bad = await call("model_params", { set: { rimL: "nope + 1" } });
check("a parameter that does not evaluate is refused before anything moves", bad.ok === false && JSON.stringify((await rowOf(hook)).assembledMm) === JSON.stringify(steady), JSON.stringify(bad));

check("the project saves again", (await call("project_save", { name: "assembled-after.lime" })).ok === true);
const saved = JSON.parse(readFileSync(join(workspace, "assembled-after.lime"), "utf8")) as FileDoc;
const savedHook = saved.assemblies?.[0]?.members.find((member) => member.object === hook);
check("the file keeps the assembly with the solved offset", JSON.stringify(savedHook?.offset) === JSON.stringify([55, 0, 14]), JSON.stringify(saved.assemblies));
const savedPose = saved.objects.find((row) => row.id === hook)?.modelPose;
check("and the hook's model pose is the solved one", near(savedPose?.t[0], bodyPose.t[0]! + 55) && near(savedPose?.t[2], bodyPose.t[2]! + 14), JSON.stringify(savedPose));

await call("object_remove", { object: hook });
check("the project saves without the hook", (await call("project_save", { name: "no-hook.lime" })).ok === true);
const noHook = JSON.parse(readFileSync(join(workspace, "no-hook.lime"), "utf8")) as FileDoc;
const reseated = noHook.assemblies?.[0]?.members.find((member) => member.object === clip);
check("removing the hook seats the clip on the body where it stood", reseated?.parent === body && JSON.stringify(reseated.offset) === JSON.stringify([55, 0, 22]), JSON.stringify(noHook.assemblies));

await call("project_create", {});
check("a new project has no assembly to follow", (await call("model_params", { set: { rimL: 10 } })).moved === undefined);

if (failed > 0) {
  console.error(`assemblies-m3: ${failed} failed`);
  process.exit(1);
}
console.log("assemblies-m3: ok");
process.exit(0);
