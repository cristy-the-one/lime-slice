/**
 * Assemblies M4 (docs/plan-assemblies.md, the owner's gaps items 18 and 19), through the MCP server against real Open
 * CASCADE: the owner's LED cover in one session. model_place {to} seats hooks on a body by expressions of rimL and
 * bodyH, a parameter change moves them, the root carries the assembly, refusals name the frame, a member's typed
 * numbers stay in its own frame, and plate_arrange {assembly} lays out the members only. Skips when LIME_OCCT_BRIDGE is
 * unset, and fails in CI when it is unset.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
    console.error("assembly: LIME_OCCT_BRIDGE and the MCP addon are required");
    process.exit(1);
  }
  console.log("assembly: skipped (set LIME_OCCT_BRIDGE and build lime-mcp-engine)");
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "lime-mcp-assembly-"));
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Box = { min: number[]; max: number[] };
type Row = { object: string; bboxMm: Box; assembledMm?: Box; frame?: string; assembly?: string };
const session = new Session(loadEngineWorker(root));
const call = async (name: string, args: unknown = {}) => (await session.call(name, args)) as Record<string, any>;
const rows = async () => (await call("plate_list", {})).objects as Row[];
const rowOf = async (object: string) => (await rows()).find((row) => row.object === object)!;
const solid = async (dx: number, dy: number, dz: number) => {
  const object = String((await call("solid_new", { primitive: "box", dx, dy, dz })).object);
  await call("model_commit", { object });
  return object;
};

await call("project_create", {});
const body = await solid(70, 40, 10);
const hookA = await solid(6, 6, 8);
const hookB = await solid(6, 6, 8);
const clip = await solid(4, 4, 4);
const lid = await solid(20, 20, 2);
await call("model_params", { set: { rimL: 30, bodyH: 10 } });
const bodyBox = (await rowOf(body)).assembledMm!;
const printed = Object.fromEntries(await Promise.all([body, hookA, hookB, clip, lid].map(async (id) => [id, (await rowOf(id)).bboxMm])));

// --- Place by a relative offset, typed as expressions.
const placedA = await call("model_place", { object: hookA, to: body, x: "rimL - 5", y: 0, z: "bodyH", assembly: "LED cover" });
check("a hook sits on the body by rimL and bodyH", placedA.ok === true && placedA.assembly === "LED cover" && placedA.parent === body && same(placedA.offset, [25, 0, 10]), JSON.stringify(placedA));
check("the reply keeps the expressions", same(placedA.exprs, { offset: ["rimL - 5", null, "bodyH"] }), JSON.stringify(placedA.exprs));
check("a member defaults to the part frame", placedA.frame === "part", String(placedA.frame));
check("the hook's assembled box is on the rim", near(placedA.assembledMm?.min[0], bodyBox.min[0] + 35 + 25 - 3) && near(placedA.assembledMm?.min[2], bodyBox.min[2] + 10), JSON.stringify({ bodyBox, hook: placedA.assembledMm }));
const placedB = await call("model_place", { object: hookB, to: body, x: "-(rimL - 5)", z: "bodyH" });
check("a second hook joins the same assembly", placedB.ok === true && placedB.assembly === "LED cover" && same(placedB.offset, [-25, 0, 10]), JSON.stringify(placedB));
const placedClip = await call("model_place", { object: clip, to: hookA, z: 8 });
check("a clip sits on a hook", placedClip.ok === true && placedClip.parent === hookA && near(placedClip.assembledMm?.min[2], bodyBox.min[2] + 18), JSON.stringify(placedClip));

const listed = await rows();
check("plate_list names the assembly on every member", [body, hookA, hookB, clip].every((id) => listed.find((row) => row.object === id)?.assembly === "LED cover") && listed.find((row) => row.object === lid)?.assembly === undefined, JSON.stringify(listed.map((row) => [row.object, row.assembly])));
const info = await call("session_info", {});
check("session_info lists the assembly", same(info.assemblies, [{ assembly: "LED cover", members: [body, hookA, hookB, clip] }]), JSON.stringify(info.assemblies));

// --- The owner's scenario: rimL changes and the hooks follow, with the clip on hook A.
const beforeA = (await rowOf(hookA)).assembledMm!;
const beforeB = (await rowOf(hookB)).assembledMm!;
const beforeClip = (await rowOf(clip)).assembledMm!;
const longer = await call("model_params", { set: { rimL: 60 } });
check("rimL 60 moves both hooks and the clip", same((longer.moved ?? []).map((row: { object: string }) => row.object), [hookA, hookB, clip]), JSON.stringify(longer.moved));
check("hook A moved +30 mm, hook B -30 mm, the clip with hook A", near((await rowOf(hookA)).assembledMm!.min[0] - beforeA.min[0], 30) && near((await rowOf(hookB)).assembledMm!.min[0] - beforeB.min[0], -30) && near((await rowOf(clip)).assembledMm!.min[0] - beforeClip.min[0], 30));
check("the print layout did not move", (await Promise.all(Object.entries(printed).map(async ([id, box]) => same((await rowOf(id)).bboxMm, box)))).every(Boolean));

// --- D9: moving the root moves the assembly.
const rootMove = await call("model_place", { object: body, x: 100 });
check("the root's reply says it carries the assembly", rootMove.ok === true && rootMove.root === true && rootMove.assembly === "LED cover" && String(rootMove.note).includes("moves with its root"), JSON.stringify(rootMove));
check("and lists the members that followed", same((rootMove.moved ?? []).map((row: { object: string }) => row.object), [hookA, hookB, clip]), JSON.stringify(rootMove.moved));
const shift = 100 - (bodyBox.min[0] + 35);
check("hook A followed the body", near((await rowOf(hookA)).assembledMm!.min[0] - beforeA.min[0], 30 + shift), JSON.stringify((await rowOf(hookA)).assembledMm));

// --- A member placed without to: its offset from its parent.
const raised = await call("model_place", { object: clip, z: 12 });
check("model_place on a member sets its offset from its parent", raised.ok === true && raised.parent === hookA && same(raised.offset, [0, 0, 12]) && near(raised.assembledMm?.min[2], bodyBox.min[2] + 22), JSON.stringify(raised));
const kept = await call("model_place", { object: hookA, z: 11 });
check("a number replaces only its own expression", same(kept.exprs, { offset: ["rimL - 5", null, null] }) && same(kept.offset, [55, 0, 11]), JSON.stringify(kept));
check("and the clip on it followed", same((kept.moved ?? []).map((row: { object: string }) => row.object), [clip]), JSON.stringify(kept.moved));

// --- Refusals.
const loop = await call("model_place", { object: hookA, to: clip });
check("a loop is refused", loop.ok === false && String(loop.reason).includes("loop"), JSON.stringify(loop));
const rootOn = await call("model_place", { object: body, to: hookB });
check("the root cannot sit on its member", rootOn.ok === false && String(rootOn.reason).includes("root"), JSON.stringify(rootOn));
const badText = await call("model_place", { object: hookB, x: "rimLength - 5" });
check("an expression that does not evaluate is refused and names the field", badText.ok === false && String(badText.reason).startsWith("x:"), JSON.stringify(badText));
const unknown = await call("model_place", { object: lid, to: "obj_999" });
check("an unknown to is refused", unknown.ok === false && String(unknown.reason).startsWith("to:"), JSON.stringify(unknown));
const self = await call("model_place", { object: lid, to: lid });
check("a part cannot sit on itself", self.ok === false && String(self.reason).includes("itself"), JSON.stringify(self));
const lonelyName = await call("model_place", { object: lid, assembly: "Lid" });
check("a name without to and outside an assembly is refused", lonelyName.ok === false && String(lonelyName.reason).includes("to"), JSON.stringify(lonelyName));
const cap = await solid(5, 5, 5);
const second = await call("model_place", { object: cap, to: lid, z: 2, assembly: "Lid" });
check("a second assembly starts with its own root", second.ok === true && second.assembly === "Lid", JSON.stringify(second));
const pin = await solid(3, 3, 3);
await call("model_place", { object: pin, x: 5, y: 7, turnZ: 30 });
const pinBox = (await rowOf(pin)).assembledMm;
const asBuilt = await call("model_place", { object: pin, to: lid });
check("to with no numbers keeps the part where it stands", asBuilt.ok === true && same(asBuilt.assembledMm, pinBox) && near(asBuilt.offset?.[0], 5) && near(asBuilt.turn?.[2], 30), JSON.stringify(asBuilt));
const across = await call("model_place", { object: cap, to: body });
check("a part in one assembly cannot sit on a part of another", across.ok === false && String(across.reason).includes("one assembly"), JSON.stringify(across));

// --- A free part: an expression is read once.
const once = await call("model_place", { object: lid, x: "rimL * 2" });
check("a free part's expression is read once", once.ok === true && near(once.x, 120) && String(once.note).includes("read once"), JSON.stringify(once));

// --- The part frame keeps a typed step stable when the assembly moves, and refusals name the frame.
const onHook = { kind: "boolean", op: "fuse", primitive: "box", dx: 2, dy: 2, dz: 2, origin: [0, 0, 7] };
const firstProbe = await call("model_probe", { object: hookB, op: onHook });
check("a step typed in hook B's own frame probes", firstProbe.ok === true, JSON.stringify(firstProbe));
await call("model_params", { set: { rimL: 90 } });
const again = await call("model_probe", { object: hookB, op: onHook });
check("the same numbers probe after rimL moved the hook", again.ok === true, JSON.stringify(again));
const described = await call("model_describe", { object: hookB, limit: 1 });
check("model_describe says the frame", described.frame === "part", String(described.frame));
const far = await call("model_probe", { object: hookB, op: { ...onHook, origin: [200, 0, 0] } });
check("a refusal of a member names the part frame and where the part sits", far.ok === false && far.frame === "part" && String(far.reason).includes("in the part frame") && String(far.reason).includes("sits at ("), JSON.stringify(far));
const farModel = await call("model_probe", { object: lid, op: { ...onHook, origin: [0, 0, 200] } });
check("a refusal of a moved model-frame part names model space", farModel.ok === false && farModel.frame === "model" && String(farModel.reason).includes("model space"), JSON.stringify(farModel));

// --- Lay out one assembly around the others.
const lidPrint = (await rowOf(lid)).bboxMm;
const arranged = await call("plate_arrange", { assembly: "LED cover", gapMm: 5 });
check("plate_arrange {assembly} moves only its members", arranged.ok === true && same((arranged.moved as { object: string }[]).map((row) => row.object).sort(), [body, hookA, hookB, clip].sort()), JSON.stringify(arranged));
check("and leaves the others", same((await rowOf(lid)).bboxMm, lidPrint));
check("Lay out leaves the assembled poses", near((await rowOf(hookA)).assembledMm!.min[0] - beforeA.min[0], 60 + shift), JSON.stringify((await rowOf(hookA)).assembledMm));
const noSuch = await call("plate_arrange", { assembly: "Nope" });
check("an unknown assembly is refused with the names", noSuch.ok === false && String(noSuch.reason).includes("LED cover"), JSON.stringify(noSuch));

// --- render_view {view} draws several parts.
const shotAssembly = await call("render_view", { object: hookA, view: "assembly", camera: "front", inline: false, name: "led-assembly.png" });
const shotPrint = await call("render_view", { object: hookA, view: "print", camera: "top", inline: false, name: "led-print.png" });
check("render_view draws the assembly and the print layout", shotAssembly.ok !== false && shotPrint.ok !== false && existsSync(join(workspace, "led-assembly.png")) && existsSync(join(workspace, "led-print.png")), JSON.stringify({ shotAssembly, shotPrint }).slice(0, 300));
const shotBad = await call("render_view", { object: hookA, view: "assembly", section: { normal: [0, -1, 0] } });
check("a view with a section is refused", shotBad.ok === false && String(shotBad.reason).includes("one part"), JSON.stringify(shotBad));

// --- The guide.
const guided = await call("guide", { kind: "assembly" });
check("guide {kind:\"assembly\"} answers", guided.ok === true && String(guided.text).includes("model_place {object:<hook>, to:<body>"), JSON.stringify(guided).slice(0, 200));
const place = await call("guide", { kind: "place" });
check("guide {kind:\"place\"} answers", place.ok === true && String(place.text).includes("object_place"));
check("an op kind still gets its schema", (await call("guide", { kind: "fillet" })).schema !== undefined);

// --- The file keeps both assemblies and the text.
check("the project saves", (await call("project_save", { name: "led.lime" })).ok === true);
const file = JSON.parse(readFileSync(join(workspace, "led.lime"), "utf8")) as { assemblies?: { name: string; members: { object: string; exprs?: unknown }[] }[]; objects: { id: string; frame?: string }[] };
check("the file has both assemblies", same(file.assemblies?.map((row) => row.name), ["LED cover", "Lid"]), JSON.stringify(file.assemblies));
check("hook B keeps its text", same(file.assemblies?.[0]?.members.find((row) => row.object === hookB)?.exprs, { offset: ["-(rimL - 5)", null, "bodyH"] }));
check("members are saved in the part frame", file.objects.find((row) => row.id === hookB)?.frame === "part" && file.objects.find((row) => row.id === body)?.frame === undefined);

if (failed > 0) {
  console.error(`assembly: ${failed} failed`);
  process.exit(1);
}
console.log("assembly: ok");
process.exit(0);
